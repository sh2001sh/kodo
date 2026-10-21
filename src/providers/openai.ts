import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ModelResponse, Provider, ToolRequest } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';
import { providerError, providerFetch, streamError, usageCounter } from './errors.js';

export class ChatCompletionsProvider implements Provider {
  async complete(request: Parameters<Provider['complete']>[0], signal: AbortSignal, onText: (text: string) => void): Promise<ModelResponse> {
    const key = process.env[request.binding.apiKeyEnv];
    if (!key) throw new KodoError('MODEL_CREDENTIAL', `set ${request.binding.apiKeyEnv} in the local environment`);
    // Use the largest Node timer; the caller signal/session budget owns earlier cancellation.
    const client = new OpenAI({ apiKey: key, baseURL: request.binding.baseURL, maxRetries: 0, timeout: 2_147_483_647, fetch: providerFetch });
    // Public tool IDs use dots; Chat Completions function names permit underscores instead.
    const wireName = (name: string): string => name.replaceAll('.', '_');
    const logicalNames = new Map(request.tools.map(tool => [wireName(tool.name), tool.name]));
    if (logicalNames.size !== request.tools.length) throw new KodoError('MODEL_PROTOCOL', 'tool names collide after protocol conversion');
    const messages: ChatCompletionMessageParam[] = request.messages.map(message => {
      if (message.role !== 'assistant') return message;
      if (message.providerData && message.providerData.protocol !== 'chat-completions') throw new KodoError('MODEL_PROTOCOL', 'assistant history belongs to another provider protocol');
      if (message.providerData && typeof message.providerData.reasoningContent !== 'string') throw new KodoError('MODEL_PROTOCOL', 'invalid assistant reasoning history');
      return { role: message.role, content: message.content,
        ...(message.providerData ? { reasoning_content: message.providerData.reasoningContent } : {}),
        tool_calls: message.tool_calls?.map(call => ({ id: call.id, type: 'function' as const, function: { name: wireName(call.name), arguments: call.arguments } })) };
    });
    let content = '';
    let reasoningContent: string | undefined;
    const calls = new Map<number, ToolRequest>();
    let finish: string | null = null;
    let usage: ModelResponse['usage'];
    let responseHeaders: Headers | undefined;
    try {
      // The caller controls output through max_completion_tokens, not an unrelated SSE byte cap.
      const { data: stream, response } = await client.chat.completions.create({
        model: request.binding.model, messages, stream: true,
        stream_options: { include_usage: true }, max_completion_tokens: request.maxOutputTokens,
        ...(request.binding.promptCache === 'session' && request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function' as const, function: { ...tool, name: wireName(tool.name) } })) } : {}),
      }, { signal }).withResponse();
      responseHeaders = response.headers;
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const failure = streamError(chunk, responseHeaders);
        if (failure) throw failure;
        if (chunk.usage) {
          const cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens;
          usage = { input: usageCounter(chunk.usage.prompt_tokens), output: usageCounter(chunk.usage.completion_tokens),
            ...(cacheRead != null ? { cacheRead: usageCounter(cacheRead) } : {}) };
          if ((usage.cacheRead ?? 0) > usage.input) throw new KodoError('MODEL_PROTOCOL', 'cached input exceeds total input usage');
        }
        if (!Array.isArray(chunk.choices)) throw new KodoError('MODEL_PROTOCOL', 'missing completion choices');
        for (const choice of chunk.choices) {
          if (choice.index !== 0) throw new KodoError('MODEL_PROTOCOL', 'only one completion choice is supported');
          const reasoning = (choice.delta as ChatCompletionChunk.Choice.Delta & { reasoning_content?: unknown }).reasoning_content;
          if (reasoning != null) {
            if (typeof reasoning !== 'string') throw new KodoError('MODEL_PROTOCOL', 'invalid reasoning content delta');
            reasoningContent = (reasoningContent ?? '') + reasoning;
          }
          if (choice.delta.content) { content += choice.delta.content; onText(choice.delta.content); }
          this.collectCalls(calls, choice.delta.tool_calls);
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof KodoError) throw error;
      throw providerError(error, undefined, responseHeaders);
    }
    signal.throwIfAborted();
    if (finish !== 'stop' && finish !== 'tool_calls') throw new KodoError('MODEL_INCOMPLETE', 'response did not end normally; no tools from this response were executed');
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => ({ ...value, name: logicalNames.get(value.name) ?? value.name }));
    if ((finish === 'tool_calls') !== Boolean(toolCalls.length)) throw new KodoError('MODEL_PROTOCOL', 'tool calls and finish reason disagree');
    const ids = new Set(toolCalls.map(x => x.id));
    if (ids.size !== toolCalls.length || toolCalls.some(x => !x.id || x.id.length > 256 || !x.name)) throw new KodoError('MODEL_PROTOCOL', 'missing, oversized or duplicate tool call identity');
    if (usage && [usage.input, usage.output].some(x => !Number.isSafeInteger(x) || x < 0)) throw new KodoError('MODEL_PROTOCOL', 'invalid usage counters');
    return { message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      // DeepSeek tool continuations require this private history; never send it through onText.
      ...(reasoningContent !== undefined ? { providerData: { protocol: 'chat-completions' as const, reasoningContent } } : {}),
    }, finishReason: finish, usage };
  }
  private collectCalls(calls: Map<number, ToolRequest>, deltas: ChatCompletionChunk.Choice.Delta.ToolCall[] | undefined): void {
    for (const delta of deltas ?? []) {
      if (!Number.isSafeInteger(delta.index) || delta.index < 0 || delta.index >= 32) throw new KodoError('MODEL_PROTOCOL', 'invalid tool call index or too many tool calls');
      const call = calls.get(delta.index) ?? { id: '', name: '', arguments: '' };
      if (delta.id) call.id = delta.id;
      if (delta.function?.name) call.name += delta.function.name;
      if (delta.function?.arguments) call.arguments += delta.function.arguments;
      calls.set(delta.index, call);
    }
  }
}
