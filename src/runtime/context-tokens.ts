import { Store } from '../storage/index.js';
import { recoveryHistoryRuns } from './history.js';
import type { Message, ModelResponse, Provider, Run, ToolSpec } from './types.js';

const framing = 256;
const messageOverhead = 16;
const toolOverhead = 64;
/** Tokenizer-independent estimate with headroom; provider usage remains authoritative. */
export function estimateTextTokens(text: string): number {
  let tokens = 0;
  for (const character of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) tokens += 1.25;
    else if (/\p{Script=Hangul}/u.test(character)) tokens += 1.5;
    else if (character.codePointAt(0)! < 128) tokens += /[a-z0-9\s]/i.test(character) ? 1 / 3 : 0.5;
    else tokens += Buffer.byteLength(character, 'utf8') / 2;
  }
  return Math.ceil(tokens * 1.1);
}
const estimate = (value: unknown): number => estimateTextTokens(JSON.stringify(value));

/** Weighted estimate, not an exact model tokenizer. Includes protocol framing headroom. */
export function estimateInputTokens(store: Store, run: Run, messages: Message[], tools: ToolSpec[]): number {
  const serialized = messages.map(message => JSON.stringify(message));
  const toolText = JSON.stringify(tools);
  const bindingText = JSON.stringify(run.binding);
  const uncalibrated = estimate({ messages, tools }) + framing + messages.length * messageOverhead + tools.length * toolOverhead;
  // Usage is already durable in successful Calls. Only reuse a measured prefix with the
  // same model, endpoint and schemas; compacted/edited prefixes cannot inherit its discount.
  for (const owner of recoveryHistoryRuns(store, run)) {
    for (const call of store.calls(owner.id).toReversed()) {
      if (call.kind !== 'model' || call.status !== 'succeeded' || !call.resultRef) continue;
      const response = store.readBlob<Partial<ModelResponse>>(call.resultRef);
      const input = response.usage?.input;
      if (!Number.isSafeInteger(input) || input! < 0) continue;
      const request = store.readBlob<Partial<Parameters<Provider['complete']>[0]>>(call.requestRef);
      if (!Array.isArray(request.messages) || !Array.isArray(request.tools) || JSON.stringify(request.binding) !== bindingText || JSON.stringify(request.tools) !== toolText || request.messages.length > messages.length) continue;
      if (!request.messages.every((message, index) => JSON.stringify(message) === serialized[index])) continue;
      const added = messages.slice(request.messages.length);
      // Estimate only new text; never extrapolate a measured ratio across unseen evidence.
      return input! + estimate(added) + added.length * messageOverhead + framing;
    }
  }
  return uncalibrated;
}
