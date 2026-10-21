import type { Message, ModelResponse, Provider, ToolRequest } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';
import { object, providerError, providerFetch, streamError } from './errors.js';

type ObjectValue = Record<string, unknown>;
type Thinking = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string };
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: ObjectValue }
  | { type: 'tool_result'; tool_use_id: string; content: string } | Thinking;
type WireMessage = { role: 'user' | 'assistant'; content: Block[] };
type StreamBlock = { type: 'text'; text: string; raw: ObjectValue; closed: boolean }
  | { type: 'tool_use'; id: string; name: string; input: ObjectValue; json: string; raw: ObjectValue; closed: boolean }
  | { type: 'thinking' | 'redacted_thinking'; raw: ObjectValue; closed: boolean };
const protocol = (message: string): never => { throw new KodoError('MODEL_PROTOCOL', message); };
const counter = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return protocol('invalid usage counters');
  return value;
};
const wireName = (name: string): string => name.replaceAll('.', '_');

function history(messages: Message[]): { system: string; messages: WireMessage[] } {
  const system: string[] = [];
  const wire: WireMessage[] = [];
  const append = (role: WireMessage['role'], content: Block[]): void => {
    const previous = wire.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else wire.push({ role, content });
  };
  for (const message of messages) {
    if (message.role === 'system') system.push(message.content);
    else if (message.role === 'user') append('user', [{ type: 'text', text: message.content }]);
    else if (message.role === 'tool') append('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]);
    else if (message.role === 'assistant') {
      const blocks: Block[] = [];
      if (message.providerData) {
        if (message.providerData.protocol !== 'anthropic') return protocol('assistant history belongs to another provider protocol');
        for (const block of message.providerData.blocks) {
          if (block.type === 'thinking' && typeof block.thinking === 'string' && typeof block.signature === 'string' && block.signature) blocks.push(block as Thinking);
          else if (block.type === 'redacted_thinking' && typeof block.data === 'string') blocks.push(block as Thinking);
          else if (block.type === 'text' && typeof block.text === 'string') blocks.push(block as Block);
          else if (block.type === 'tool_use' && typeof block.id === 'string' && block.id && typeof block.name === 'string' && block.name && object(block.input)) blocks.push(block as Block);
          else return protocol('invalid stored assistant content block');
        }
      } else {
        if (message.content) blocks.push({ type: 'text', text: message.content });
        for (const call of message.tool_calls ?? []) {
          let input: unknown;
          try { input = JSON.parse(call.arguments); } catch { return protocol('stored tool arguments are not valid JSON'); }
          if (!object(input)) return protocol('stored tool arguments must be an object');
          blocks.push({ type: 'tool_use', id: call.id, name: wireName(call.name), input });
        }
      }
      if (!blocks.length) return protocol('empty assistant history message');
      append('assistant', blocks);
    }
  }
  return { system: system.join('\n\n'), messages: wire };
}

/** Anthropic Messages streaming; preserves signed thinking without enabling it by default. */
export class AnthropicProvider implements Provider {
  async complete(request: Parameters<Provider['complete']>[0], signal: AbortSignal, onText: (text: string) => void): Promise<ModelResponse> {
    const key = process.env[request.binding.apiKeyEnv];
    if (!key) throw new KodoError('MODEL_CREDENTIAL', `set ${request.binding.apiKeyEnv} in the local environment`);
    const logicalNames = new Map(request.tools.map(tool => [wireName(tool.name), tool.name]));
    if (logicalNames.size !== request.tools.length) return protocol('tool names collide after provider encoding');
    const converted = history(request.messages);
    // Cache hints are opt-in because compatible gateways do not all support them.
    const system = request.binding.promptCache === 'session' && request.cacheKey && converted.system
      ? [{ type: 'text', text: converted.system, cache_control: { type: 'ephemeral' } }] : converted.system;
    const blocks = new Map<number, StreamBlock>();
    let content = '';
    let started = false;
    let stopped = false;
    let stopReason: unknown;
    let usage: ModelResponse['usage'];
    let uncachedInput = 0;
    let responseHeaders: Headers | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const accept = (data: string, event: string): void => {
      let value: unknown;
      try { value = JSON.parse(data); } catch { return protocol('provider sent invalid event JSON'); }
      const failure = streamError(value, responseHeaders, 'provider returned a stream error');
      if (failure) throw failure;
      if (event === 'error') throw providerError(value, undefined, responseHeaders, 'provider returned a stream error');
      if (!object(value) || typeof value.type !== 'string' || (event && event !== value.type)) return protocol('invalid stream event');
      const type = value.type;
      if (type === 'ping') return;
      if (stopped) return protocol('provider sent events after message completion');
      if (type === 'message_start') {
        if (started || !object(value.message) || value.message.role !== 'assistant') return protocol('invalid message start');
        if (!Array.isArray(value.message.content) || value.message.content.length || value.message.stop_reason != null) return protocol('message start contains unstreamed content or a stop reason');
        started = true;
        const initial = value.message.usage;
        if (!object(initial)) return protocol('message start is missing usage');
        uncachedInput = counter(initial.input_tokens);
        const input = uncachedInput + counter(initial.cache_creation_input_tokens ?? 0) + counter(initial.cache_read_input_tokens ?? 0);
        if (!Number.isSafeInteger(input)) return protocol('invalid usage counters');
        usage = { input, output: counter(initial.output_tokens),
          ...(initial.cache_read_input_tokens !== undefined ? { cacheRead: counter(initial.cache_read_input_tokens) } : {}),
          ...(initial.cache_creation_input_tokens !== undefined ? { cacheWrite: counter(initial.cache_creation_input_tokens) } : {}) };
        return;
      }
      if (['content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].includes(type) && !started) return protocol('stream event precedes message start');
      if (type === 'content_block_start' || type === 'content_block_delta' || type === 'content_block_stop') {
        const index = value.index;
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= 64) return protocol('invalid content block index');
        const previous = blocks.get(index);
        if (type === 'content_block_start') {
          if (previous || index !== blocks.size || stopReason !== undefined || [...blocks.values()].some(block => !block.closed)) return protocol('invalid content block order');
          const block = value.content_block;
          if (!object(block)) return protocol('invalid content block');
          if (block.type === 'text' && typeof block.text === 'string') {
            blocks.set(index, { type: 'text', text: block.text, raw: { ...block }, closed: false });
            if (block.text) { content += block.text; onText(block.text); }
          } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && object(block.input)) {
            if ([...blocks.values()].filter(item => item.type === 'tool_use').length >= 32) return protocol('too many tool calls');
            blocks.set(index, { type: 'tool_use', id: block.id, name: block.name, input: block.input, json: '', raw: { ...block }, closed: false });
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && (block.signature === undefined || typeof block.signature === 'string')) {
            blocks.set(index, { type: 'thinking', raw: { ...block, signature: block.signature ?? '' }, closed: false });
          } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
            blocks.set(index, { type: 'redacted_thinking', raw: { ...block }, closed: false });
          } else return protocol('unsupported content block');
        } else {
          if (!previous || previous.closed || stopReason !== undefined) return protocol('content event has no open block');
          if (type === 'content_block_stop') {
            if (previous.type === 'thinking' && !previous.raw.signature) return protocol('thinking block is missing its signature');
            previous.closed = true;
          }
          else {
            const delta = value.delta;
            if (!object(delta)) return protocol('invalid content delta');
            if (previous.type === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') {
              previous.text += delta.text; content += delta.text; onText(delta.text);
            } else if (previous.type === 'tool_use' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') previous.json += delta.partial_json;
            else if (previous.type === 'thinking' && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') previous.raw.thinking = String(previous.raw.thinking) + delta.thinking;
            else if (previous.type === 'thinking' && delta.type === 'signature_delta' && typeof delta.signature === 'string') previous.raw.signature = String(previous.raw.signature) + delta.signature;
            else return protocol('content delta does not match its block');
          }
        }
      } else if (type === 'message_delta') {
        if ([...blocks.values()].some(block => !block.closed) || !object(value.delta) || !object(value.usage)) return protocol('invalid message completion delta');
        if (value.delta.stop_reason != null) {
          if (typeof value.delta.stop_reason !== 'string' || (stopReason !== undefined && stopReason !== value.delta.stop_reason)) return protocol('conflicting message stop reason');
          stopReason = value.delta.stop_reason;
        }
        const output = counter(value.usage.output_tokens);
        if (!usage || output < usage.output) return protocol('usage counters decreased');
        usage.output = output;
        const input = value.usage.input_tokens === undefined ? uncachedInput : counter(value.usage.input_tokens);
        const cacheRead = value.usage.cache_read_input_tokens === undefined ? usage.cacheRead : counter(value.usage.cache_read_input_tokens);
        const cacheWrite = value.usage.cache_creation_input_tokens === undefined ? usage.cacheWrite : counter(value.usage.cache_creation_input_tokens);
        if (input < uncachedInput || (cacheRead ?? 0) < (usage.cacheRead ?? 0) || (cacheWrite ?? 0) < (usage.cacheWrite ?? 0)) return protocol('usage counters decreased');
        uncachedInput = input;
        usage.input = input + (cacheRead ?? 0) + (cacheWrite ?? 0);
        if (!Number.isSafeInteger(usage.input)) return protocol('invalid usage counters');
        if (cacheRead !== undefined) usage.cacheRead = cacheRead;
        if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
      } else if (type === 'message_stop') {
        if (stopReason === undefined || [...blocks.values()].some(block => !block.closed)) return protocol('message stopped before completion');
        stopped = true;
      }
      // Anthropic may add event types; unknown events do not establish completion.
    };
    try {
      signal.throwIfAborted();
      const response = await providerFetch(`${request.binding.baseURL.replace(/\/+$/, '')}/messages`, {
        method: 'POST', signal, redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: request.binding.model, ...converted, system, max_tokens: request.maxOutputTokens, stream: true,
          ...(request.tools.length ? { tools: request.tools.map(tool => ({ name: wireName(tool.name), description: tool.description, input_schema: tool.parameters })) } : {}) }),
      });
      responseHeaders = response.headers;
      if (!response.ok) {
        const payload = await errorPayload(response);
        throw providerError(payload, response.status, response.headers);
      }
      if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        await response.body?.cancel();
        return protocol('provider did not return an event stream');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffer = '';
      let data: string[] = [];
      let event = '';
      const line = (text: string): void => {
        if (!text) {
          if (data.length) accept(data.join('\n'), event);
          data = []; event = '';
        } else if (!text.startsWith(':')) {
          const colon = text.indexOf(':');
          const name = colon < 0 ? text : text.slice(0, colon);
          const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '');
          if (name === 'data') data.push(value);
          else if (name === 'event') event = value;
        }
      };
      while (!stopped) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) { buffer += decoder.decode(); break; }
        buffer += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          line(buffer.slice(0, newline).replace(/\r$/, ''));
          buffer = buffer.slice(newline + 1);
        }
      }
      signal.throwIfAborted();
      if (!stopped || !['end_turn', 'stop_sequence', 'tool_use'].includes(String(stopReason))) throw new KodoError('MODEL_INCOMPLETE', 'response did not end normally; no tools from this response were executed');
      const calls: ToolRequest[] = [];
      const completedBlocks: ObjectValue[] = [];
      for (const block of blocks.values()) {
        if (block.type === 'text') { completedBlocks.push({ ...block.raw, text: block.text }); continue; }
        if (block.type !== 'tool_use') { completedBlocks.push(block.raw); continue; }
        let input: unknown = block.input;
        if (block.json) {
          if (Object.keys(block.input).length) return protocol('tool input mixed initial and streamed arguments');
          try { input = JSON.parse(block.json); } catch { return protocol('tool arguments are not valid JSON'); }
        }
        if (!object(input)) return protocol('tool arguments must be an object');
        calls.push({ id: block.id, name: logicalNames.get(block.name) ?? block.name, arguments: JSON.stringify(input) });
        completedBlocks.push({ ...block.raw, input });
      }
      if ((stopReason === 'tool_use') !== Boolean(calls.length)) return protocol('tool calls and stop reason disagree');
      if (new Set(calls.map(call => call.id)).size !== calls.length || calls.some(call => !call.id || call.id.length > 256 || !call.name)) return protocol('missing, oversized or duplicate tool call identity');
      return { message: { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}), ...(completedBlocks.length ? { providerData: { protocol: 'anthropic' as const, blocks: completedBlocks } } : {}) }, finishReason: calls.length ? 'tool_calls' : 'stop', usage };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof KodoError) throw error;
      throw providerError(error, undefined, responseHeaders);
    } finally {
      if (reader) { try { await reader.cancel(); } catch { /* Cancellation after a stream transport failure is best effort. */ } reader.releaseLock(); }
    }
  }
}

/** Read only a bounded diagnostic for classification; discard it after constructing the safe error. */
async function errorPayload(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16_384) return undefined;
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { return undefined; }
  } finally {
    try { await reader.cancel(); } catch { /* A failed diagnostic read must not disclose or retain the body. */ }
    reader.releaseLock();
  }
}
