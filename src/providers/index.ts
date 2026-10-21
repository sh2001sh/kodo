import { KodoError } from '../runtime/types.js';
import type { Provider } from '../runtime/types.js';
import { ChatCompletionsProvider } from './openai.js';
import { ResponsesProvider } from './responses.js';
import { AnthropicProvider } from './anthropic.js';

/** Protocol is part of the durable model binding; never retry through a different API format. */
export class ModelProvider implements Provider {
  private readonly chat = new ChatCompletionsProvider();
  private readonly responses = new ResponsesProvider();
  private readonly anthropic = new AnthropicProvider();

  complete(...args: Parameters<Provider['complete']>): ReturnType<Provider['complete']> {
    const protocol = args[0].binding.protocol ?? 'chat-completions';
    if (protocol === 'chat-completions') return this.chat.complete(...args);
    if (protocol === 'responses') return this.responses.complete(...args);
    if (protocol === 'anthropic') return this.anthropic.complete(...args);
    throw new KodoError('MODEL_PROTOCOL', 'protocol must be chat-completions, responses or anthropic');
  }
}

export { ChatCompletionsProvider, ResponsesProvider, AnthropicProvider };
