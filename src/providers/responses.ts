import OpenAI from 'openai';
import type { Response, ResponseInputItem, ResponseReasoningItem } from 'openai/resources/responses/responses';
import type { Message, ModelResponse, Provider, ToolRequest } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';
import { providerError, providerFetch, streamError, usageCounter } from './errors.js';

/** Stateless Responses requests replay the local history; provider-side storage is disabled. */
export class ResponsesProvider implements Provider {
  async complete(request: Parameters<Provider['complete']>[0], signal: AbortSignal, onText: (text: string) => void): Promise<ModelResponse> {
    const key = process.env[request.binding.apiKeyEnv];
    if (!key) throw new KodoError('MODEL_CREDENTIAL', `set ${request.binding.apiKeyEnv} in the local environment`);
    const wireName = (name: string): string => name.replaceAll('.', '_');
    const logicalNames = new Map(request.tools.map(tool => [wireName(tool.name), tool.name]));
    if (logicalNames.size !== request.tools.length) throw new KodoError('MODEL_PROTOCOL', 'tool names collide after protocol conversion');
    // The caller owns the execution deadline; the SDK still requires a finite platform timer.
    const client = new OpenAI({ apiKey: key, baseURL: request.binding.baseURL, maxRetries: 0, timeout: 2_147_483_647, fetch: providerFetch });
    let completed: Response | undefined;
    let responseHeaders: Headers | undefined;
    const doneReasoning = new Map<string, ResponseReasoningItem>();
    try {
      const { data: stream, response } = await client.responses.create({
        model: request.binding.model, input: this.input(request.messages, wireName),
        stream: true, store: false, max_output_tokens: request.maxOutputTokens,
        include: ['reasoning.encrypted_content'],
        ...(request.binding.promptCache === 'session' && request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function' as const, ...tool, name: wireName(tool.name), strict: false })) } : {}),
      }, { signal }).withResponse();
      responseHeaders = response.headers;
      for await (const event of stream) {
        signal.throwIfAborted();
        const failure = streamError(event, responseHeaders);
        if (failure) throw failure;
        if (event.type === 'response.output_text.delta') onText(event.delta);
        if (event.type === 'response.output_item.done' && event.item.type === 'reasoning') doneReasoning.set(event.item.id, event.item);
        if (event.type === 'response.incomplete' || event.type === 'response.failed') {
          if (event.response.error && (event.response.error.code || /get_channel_failed|new_api_error/.test(event.response.error.message ?? ''))) throw providerError(event.response.error, undefined, responseHeaders, 'provider response failed');
          throw new KodoError('MODEL_INCOMPLETE', 'response did not end normally; no tools from this response were executed');
        }
        if (event.type === 'response.completed') {
          if (completed) throw new KodoError('MODEL_PROTOCOL', 'duplicate response completion');
          if (event.response.status !== 'completed') throw new KodoError('MODEL_INCOMPLETE', 'response did not end normally; no tools from this response were executed');
          completed = event.response;
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof KodoError) throw error;
      throw providerError(error, undefined, responseHeaders);
    }
    signal.throwIfAborted();
    if (!completed) throw new KodoError('MODEL_INCOMPLETE', 'response did not end normally; no tools from this response were executed');
    if (!Array.isArray(completed.output)) throw new KodoError('MODEL_PROTOCOL', 'missing response output');
    let content = '';
    const toolCalls: ToolRequest[] = [];
    const output: Record<string, unknown>[] = [];
    for (const item of completed.output) {
      if ('status' in item && item.status && item.status !== 'completed') throw new KodoError('MODEL_INCOMPLETE', 'response output item did not complete');
      if (item.type === 'message') {
        if (!Array.isArray(item.content)) throw new KodoError('MODEL_PROTOCOL', 'missing message content');
        for (const part of item.content) {
          if (part.type === 'output_text') content += part.text;
          else if (part.type === 'refusal') content += part.refusal;
          else throw new KodoError('MODEL_PROTOCOL', 'unsupported response content');
        }
      } else if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') throw new KodoError('MODEL_PROTOCOL', 'invalid function call');
        toolCalls.push({ id: item.call_id, name: logicalNames.get(item.name) ?? item.name, arguments: item.arguments });
      } else if (item.type !== 'reasoning') throw new KodoError('MODEL_PROTOCOL', 'unsupported response output item');
      // Stateless replay must preserve each item's position, ID, phase and payload.
      // Some gateways omit encrypted reasoning in response.completed while retaining it in output_item.done.
      output.push(item.type === 'reasoning' && !item.encrypted_content
        ? { ...item, ...doneReasoning.get(item.id) } : { ...item });
    }
    const ids = new Set(toolCalls.map(call => call.id));
    if (toolCalls.length > 32 || ids.size !== toolCalls.length || toolCalls.some(call => !call.id || call.id.length > 256 || !call.name)) throw new KodoError('MODEL_PROTOCOL', 'missing, oversized or duplicate tool call identity');
    const cached = completed.usage?.input_tokens_details?.cached_tokens;
    const usage: ModelResponse['usage'] = completed.usage ? { input: usageCounter(completed.usage.input_tokens), output: usageCounter(completed.usage.output_tokens),
      ...(cached != null ? { cacheRead: usageCounter(cached) } : {}) } : undefined;
    if (usage && (usage.cacheRead ?? 0) > usage.input) throw new KodoError('MODEL_PROTOCOL', 'cached input exceeds total input usage');
    return {
      message: { role: 'assistant', content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(output.length ? { providerData: { protocol: 'responses' as const, output } } : {}),
      },
      finishReason: toolCalls.length ? 'tool_calls' : 'stop', usage,
    };
  }

  private input(messages: Message[], wireName: (name: string) => string): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
      if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }];
      if (message.role !== 'assistant') return [{ role: message.role, content: message.content }];
      if (message.providerData) {
        if (message.providerData.protocol !== 'responses') throw new KodoError('MODEL_PROTOCOL', 'assistant history belongs to another provider protocol');
        return message.providerData.output as unknown as ResponseInputItem[];
      }
      const input: ResponseInputItem[] = [];
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls ?? []) input.push({ type: 'function_call', call_id: call.id, name: wireName(call.name), arguments: call.arguments });
      return input;
    });
  }
}
