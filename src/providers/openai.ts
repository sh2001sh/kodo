import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ModelResponse, Provider, ToolRequest } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';
import { providerError, providerFetch, streamError, usageCounter } from './errors.js';
import { validateImageInput } from '../tools/image.js';
import type { ImageInput } from '../tools/image.js';
import { providerProgress } from './transport.js';

export class ChatCompletionsProvider implements Provider {
  async complete(request: Parameters<Provider['complete']>[0], signal: AbortSignal, onText: (text: string) => void): Promise<ModelResponse> {
    const key = process.env[request.binding.apiKeyEnv];
    if (!key) throw new KodoError('MODEL_CREDENTIAL', `set ${request.binding.apiKeyEnv} in the local environment`, { usageKnownZero: true });
    // Transport bounds first-byte/idle silence; caller owns total time. Avoid an SDK total-generation cutoff.
    const client = new OpenAI({ apiKey: key, baseURL: request.binding.baseURL, maxRetries: 0, timeout: 2_147_483_647, fetch: providerFetch });
    // Public tool IDs use dots; Chat Completions function names permit underscores instead.
    const wireName = (name: string): string => name.replaceAll('.', '_');
    const logicalNames = new Map(request.tools.map(tool => [wireName(tool.name), tool.name]));
    if (logicalNames.size !== request.tools.length) throw new KodoError('MODEL_PROTOCOL', 'tool names collide after protocol conversion');
    const pendingImages: { type: 'image_url'; image_url: { url: string } }[] = [];
    const messages: ChatCompletionMessageParam[] = request.messages.flatMap((message, index): ChatCompletionMessageParam[] => {
      const images = (message as { images?: ImageInput[] }).images;
      if (images !== undefined && (!Array.isArray(images) || images.length > 8 || !['user', 'tool'].includes(message.role))) throw new KodoError('MODEL_PROTOCOL', 'images require a user or tool message and at most 8 attachments');
      const parts = images?.map(image => { validateImageInput(image); return { type: 'image_url' as const, image_url: { url: `data:${image.mimeType};base64,${image.data}` } }; });
      if (message.role === 'tool') {
        pendingImages.push(...(parts ?? []));
        // Complete every adjacent tool result before adding the user image turn.
        const attachments = request.messages[index + 1]?.role !== 'tool' ? pendingImages.splice(0) : [];
        return [{ role: 'tool', content: message.content, tool_call_id: message.tool_call_id }, ...(attachments.length ? [{ role: 'user' as const, content: attachments }] : [])];
      }
      if (message.role === 'user') return [{ role: 'user', content: parts?.length ? [{ type: 'text', text: message.content }, ...parts] : message.content }];
      if (message.role === 'system') return [{ role: 'system', content: message.content }];
      if (message.role !== 'assistant') throw new KodoError('MODEL_PROTOCOL', 'unsupported message role');
      if (message.providerData && message.providerData.protocol !== 'chat-completions') throw new KodoError('MODEL_PROTOCOL', 'assistant history belongs to another provider protocol');
      if (message.providerData && typeof message.providerData.reasoningContent !== 'string') throw new KodoError('MODEL_PROTOCOL', 'invalid assistant reasoning history');
      return [{ role: message.role, content: message.content,
        ...(message.providerData ? { reasoning_content: message.providerData.reasoningContent } : {}),
        tool_calls: message.tool_calls?.map(call => ({ id: call.id, type: 'function' as const, function: { name: wireName(call.name), arguments: call.arguments } })) }];
    });
    let content = '';
    let reasoningContent: string | undefined;
    const calls = new Map<number, ToolRequest>();
    let finish: string | null = null;
    let usage: ModelResponse['usage'];
    let partialResponse = false;
    let refused = false;
    let responseHeaders: Headers | undefined;
    const progress = providerProgress(signal);
    try {
      // The caller controls output through max_completion_tokens, not an unrelated SSE byte cap.
      const { data: stream, response } = await client.chat.completions.create({
        model: request.binding.model, messages, stream: true,
        stream_options: { include_usage: true }, max_completion_tokens: request.maxOutputTokens,
        ...(request.binding.promptCache === 'session' && request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
        ...(request.toolChoice === 'none' ? { tool_choice: 'none' as const } : {}),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function' as const, function: { ...tool, name: wireName(tool.name) } })) } : {}),
      }, { signal: progress.signal }).withResponse();
      responseHeaders = response.headers;
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const failure = streamError(chunk, responseHeaders);
        if (failure) throw failure;
        if (chunk.usage || chunk.choices?.length) partialResponse = true;
        // Some gateways attach partial usage (cache details only) to every chunk; only counters make it final usage.
        if (chunk.usage && (chunk.usage.prompt_tokens != null || chunk.usage.completion_tokens != null)) {
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
          if (choice.delta.refusal) refused = true;
          this.collectCalls(calls, choice.delta.tool_calls);
          if (reasoning || choice.delta.content || choice.delta.refusal || choice.delta.tool_calls?.some(call => call.function?.name || call.function?.arguments)) progress.advance();
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      }
      signal.throwIfAborted();
      if (finish === 'length') throw new KodoError('MODEL_INCOMPLETE', 'response stopped at the output token limit; no tools from this response were executed', { outputLimit: true, ...(usage ? { usage } : {}) });
      if (finish !== 'stop' && finish !== 'tool_calls') throw new KodoError('MODEL_INCOMPLETE', 'response did not end normally; no tools from this response were executed', {
        ...(finish === null && !refused ? { incompleteStream: true } : {}), ...(usage ? { usage } : {}),
      });
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => ({ ...value, name: logicalNames.get(value.name) ?? value.name }));
      if ((finish === 'tool_calls') !== Boolean(toolCalls.length)) throw new KodoError('MODEL_PROTOCOL', 'tool calls and finish reason disagree');
      const ids = new Set(toolCalls.map(x => x.id));
      if (ids.size !== toolCalls.length || toolCalls.some(x => !x.id || x.id.length > 256 || !x.name)) throw new KodoError('MODEL_PROTOCOL', 'missing, oversized or duplicate tool call identity');
      if (usage && [usage.input, usage.output].some(x => !Number.isSafeInteger(x) || x < 0)) throw new KodoError('MODEL_PROTOCOL', 'invalid usage counters');
      return { message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        // DeepSeek tool continuations require this private history; never send it through onText.
        ...(reasoningContent !== undefined ? { providerData: { protocol: 'chat-completions' as const, reasoningContent } } : {}),
      }, finishReason: finish, usage };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const cause: unknown = progress.signal.aborted ? progress.signal.reason : error;
      const failure = cause instanceof KodoError ? cause : providerError(cause, undefined, responseHeaders);
      throw partialResponse || usage ? new KodoError(failure.code, failure.message, {
        ...failure.metadata, ...(usage ? { usage } : {}), ...(partialResponse ? { partialResponse: true, usageKnownZero: false } : {}),
      }) : failure;
    } finally {
      progress.close();
    }
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
