import OpenAI from 'openai';
import type { Response, ResponseInputItem, ResponseReasoningItem } from 'openai/resources/responses/responses';
import type { Message, ModelResponse, Provider, ToolRequest } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';
import { providerError, providerFetch, streamError, usageCounter } from './errors.js';
import { validateImageInput } from '../tools/image.js';
import type { ImageInput } from '../tools/image.js';
import { providerProgress } from './transport.js';

/** Counters reported on a completed or incomplete response; an incomplete response can still be billed exactly. */
function responseUsage(response: Response): ModelResponse['usage'] {
  if (!response.usage) return undefined;
  const cached = response.usage.input_tokens_details?.cached_tokens;
  const usage = { input: usageCounter(response.usage.input_tokens), output: usageCounter(response.usage.output_tokens), ...(cached != null ? { cacheRead: usageCounter(cached) } : {}) };
  if ((usage.cacheRead ?? 0) > usage.input) throw new KodoError('MODEL_PROTOCOL', 'cached input exceeds total input usage');
  return usage;
}

/** Stateless Responses requests replay the local history; provider-side storage is disabled. */
export class ResponsesProvider implements Provider {
  async complete(request: Parameters<Provider['complete']>[0], signal: AbortSignal, onText: (text: string) => void): Promise<ModelResponse> {
    const key = process.env[request.binding.apiKeyEnv];
    if (!key) throw new KodoError('MODEL_CREDENTIAL', `set ${request.binding.apiKeyEnv} in the local environment`, { usageKnownZero: true });
    const wireName = (name: string): string => name.replaceAll('.', '_');
    const logicalNames = new Map(request.tools.map(tool => [wireName(tool.name), tool.name]));
    if (logicalNames.size !== request.tools.length) throw new KodoError('MODEL_PROTOCOL', 'tool names collide after protocol conversion');
    // Transport bounds first-byte/idle silence; caller owns total time. The SDK requires a finite timer.
    const client = new OpenAI({ apiKey: key, baseURL: request.binding.baseURL, maxRetries: 0, timeout: 2_147_483_647, fetch: providerFetch });
    let completed: Response | undefined;
    let responseHeaders: Headers | undefined;
    let partialResponse = false;
    let reportedUsage: ModelResponse['usage'];
    const doneReasoning = new Map<string, ResponseReasoningItem>();
    const progress = providerProgress(signal);
    try {
      const { data: stream, response } = await client.responses.create({
        model: request.binding.model, input: this.input(request.messages, wireName),
        stream: true, store: false, max_output_tokens: request.maxOutputTokens,
        include: ['reasoning.encrypted_content'],
        ...(request.binding.promptCache === 'session' && request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
        ...(request.toolChoice === 'none' ? { tool_choice: 'none' as const } : {}),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function' as const, ...tool, name: wireName(tool.name), strict: false })) } : {}),
      }, { signal: progress.signal }).withResponse();
      responseHeaders = response.headers;
      for await (const event of stream) {
        signal.throwIfAborted();
        const failure = streamError(event, responseHeaders);
        if (failure) throw failure;
        partialResponse = true;
        if ((event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta'
          || event.type === 'response.function_call_arguments.delta' || event.type === 'response.reasoning_text.delta'
          || event.type === 'response.reasoning_summary_text.delta') && event.delta) progress.advance();
        if (event.type === 'response.output_text.delta') onText(event.delta);
        if (event.type === 'response.output_item.done' && event.item.type === 'reasoning') doneReasoning.set(event.item.id, event.item);
        if (event.type === 'response.incomplete' || event.type === 'response.failed' || event.type === 'response.completed') reportedUsage = responseUsage(event.response);
        if (event.type === 'response.incomplete' || event.type === 'response.failed') {
          const usage = responseUsage(event.response);
          if (event.type === 'response.incomplete' && event.response.incomplete_details?.reason === 'max_output_tokens') throw new KodoError('MODEL_INCOMPLETE', 'response stopped at the output token limit; no tools from this response were executed', { outputLimit: true, ...(usage ? { usage } : {}) });
          if (event.response.error && (event.response.error.code || /get_channel_failed|new_api_error/.test(event.response.error.message ?? ''))) throw providerError(event.response.error, undefined, responseHeaders, 'provider response failed');
          throw new KodoError('MODEL_INCOMPLETE', 'response did not end normally; no tools from this response were executed', usage ? { usage } : undefined);
        }
        if (event.type === 'response.completed') {
          if (completed) throw new KodoError('MODEL_PROTOCOL', 'duplicate response completion');
          if (event.response.status !== 'completed') throw new KodoError('MODEL_INCOMPLETE', 'response did not end normally; no tools from this response were executed');
          completed = event.response;
        }
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
      const usage = responseUsage(completed);
      return {
        message: { role: 'assistant', content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(output.length ? { providerData: { protocol: 'responses' as const, output } } : {}),
        },
        finishReason: toolCalls.length ? 'tool_calls' : 'stop', usage,
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const cause: unknown = progress.signal.aborted ? progress.signal.reason : error;
      const failure = cause instanceof KodoError ? cause : providerError(cause, undefined, responseHeaders);
      throw partialResponse || reportedUsage ? new KodoError(failure.code, failure.message, {
        ...failure.metadata, ...(reportedUsage ? { usage: reportedUsage } : {}), ...(partialResponse ? { partialResponse: true, usageKnownZero: false } : {}),
      }) : failure;
    } finally {
      progress.close();
    }
  }

  private input(messages: Message[], wireName: (name: string) => string): ResponseInputItem[] {
    const pendingImages: { type: 'input_image'; detail: 'auto'; image_url: string }[] = [];
    return messages.flatMap((message, index): ResponseInputItem[] => {
      const images = (message as { images?: ImageInput[] }).images;
      if (images !== undefined && (!Array.isArray(images) || images.length > 8 || !['user', 'tool'].includes(message.role))) throw new KodoError('MODEL_PROTOCOL', 'images require a user or tool message and at most 8 attachments');
      const parts = images?.map(image => { validateImageInput(image); return { type: 'input_image' as const, detail: 'auto' as const, image_url: `data:${image.mimeType};base64,${image.data}` }; });
      if (message.role === 'tool') {
        pendingImages.push(...(parts ?? []));
        const attachments = messages[index + 1]?.role !== 'tool' ? pendingImages.splice(0) : [];
        return [{ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }, ...(attachments.length ? [{ role: 'user' as const, content: attachments }] : [])];
      }
      if (message.role === 'user') return [{ role: 'user', content: parts?.length ? [{ type: 'input_text', text: message.content }, ...parts] : message.content }];
      if (message.role === 'system') return [{ role: 'system', content: message.content }];
      if (message.role !== 'assistant') throw new KodoError('MODEL_PROTOCOL', 'unsupported message role');
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
