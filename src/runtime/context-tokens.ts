import { attachmentKind } from './attachments.js';
import { digest, Store } from '../storage/index.js';
import { recoveryHistoryRuns } from './history.js';
import type { Message, ModelResponse, Provider, Run, ToolSpec } from './types.js';
import { imageMetadata, validateImageInput } from '../tools/image.js';

const framing = 256;
const messageOverhead = 16;
const toolOverhead = 64;
// Integer twelfths avoid accumulating rounding error and allow exact composition
// of serialized messages without repeatedly scanning their text.
function textWeight(text: string): number {
  let weight = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 128) {
      weight += (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 32 || (code >= 9 && code <= 13) ? 4 : 6;
    } else if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3041 && code <= 0x3096) || (code >= 0x30a1 && code <= 0x30fa)) weight += 15;
    else if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x1100 && code <= 0x11ff)) weight += 18;
    else {
      const point = text.codePointAt(index)!;
      const character = String.fromCodePoint(point);
      if (point > 0xffff) index++;
      // Rare scripts and supplementary Han retain Unicode classification.
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) weight += 15;
      else if (/\p{Script=Hangul}/u.test(character)) weight += 18;
      else weight += (point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4) * 6;
    }
  }
  return weight;
}
const tokens = (weight: number): number => Math.ceil(weight * 11 / 120);
/** Tokenizer-independent estimate with headroom; provider usage remains authoritative. */
export function estimateTextTokens(text: string): number { return tokens(textWeight(text)); }
/** Prefix of the legacy per-step state system message, still found in recorded requests. */
const legacyStatePrefix = 'Kernel execution state: ';
interface Calibration { input: number; binding: string; tools: string; messages: string[] }
type RecordedMessage = { role?: unknown; content?: unknown };
/**
 * The trailing kernel-state message is replaced on every step, so an exact prefix
 * match never survives it. Its tokens are already in the measured input, so matching
 * the shorter prefix can only overstate the reused part, never undercount new text.
 */
function calibratedMessages(messages: RecordedMessage[]): RecordedMessage[] {
  const last = messages.at(-1);
  if (!last || typeof last.content !== 'string') return messages;
  const state = last.role === 'system' ? last.content.startsWith(legacyStatePrefix) : last.role === 'user' && attachmentKind({ role: 'user', content: last.content }) === 'state';
  return state ? messages.slice(0, -1) : messages;
}
// Immutable blob references allow a bounded cache without trusting stale mutable Calls.
const calibrations = new WeakMap<Store, Map<string, Calibration | null>>();
function calibration(store: Store, requestRef: string, resultRef: string): Calibration | null {
  let cache = calibrations.get(store);
  if (!cache) { cache = new Map(); calibrations.set(store, cache); }
  const key = `${requestRef}:${resultRef}`;
  if (cache.has(key)) return cache.get(key)!;
  const response = store.readBlob<Partial<ModelResponse>>(resultRef);
  const input = response.usage?.input;
  let value: Calibration | null = null;
  if (Number.isSafeInteger(input) && input! >= 0) {
    const request = store.readBlob<Partial<Parameters<Provider['complete']>[0]>>(requestRef);
    if (Array.isArray(request.messages) && Array.isArray(request.tools)) value = { input: input!, binding: JSON.stringify(request.binding), tools: JSON.stringify(request.tools), messages: calibratedMessages(request.messages as RecordedMessage[]).map(message => digest(JSON.stringify(message))) };
  }
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/** Scoped to one immutable context build; never cache mutable messages across steps. */
export function createInputTokenEstimator(store: Store, run: Run, tools: ToolSpec[]): { estimate(messages: Message[]): number; size(messages: Message[]): number } {
  const toolText = JSON.stringify(tools);
  const bindingText = JSON.stringify(run.binding);
  const candidates: { requestRef: string; resultRef: string; measured?: Calibration | null }[] = [];
  // Usage is already durable in successful Calls. Only reuse a measured prefix with the
  // same model, endpoint and schemas; compacted/edited prefixes cannot inherit its discount.
  for (const owner of recoveryHistoryRuns(store, run)) {
    for (const call of store.recentModelCalls(owner.id)) {
      if (!call.resultRef) continue;
      candidates.push({ requestRef: call.requestRef, resultRef: call.resultRef });
    }
  }
  const cache = new WeakMap<Message, { text: string; hash?: string; weight?: number; imageTokens?: number }>();
  const serialized = (message: Message) => {
    let value = cache.get(message);
    if (!value) { value = { text: JSON.stringify(message) }; cache.set(message, value); }
    return value;
  };
  const weight = (message: Message): number => {
    const value = serialized(message);
    return value.weight ??= textWeight('images' in message && message.images?.length ? JSON.stringify({ ...message, images: undefined }) : value.text);
  };
  const imageTokens = (messages: Message[]): number => messages.reduce((sum, message) => {
    const value = serialized(message);
    if (value.imageTokens === undefined) value.imageTokens = ('images' in message ? message.images ?? [] : []).reduce((cost, image) => {
      validateImageInput(image);
      const size = imageMetadata(Buffer.from(image.data, 'base64'));
      // Provider vision accounting varies; use a conservative patch budget, not base64 tokenization.
      return cost + 1024 + 3 * Math.ceil(size.width / 32) * Math.ceil(size.height / 32);
    }, 0);
    return sum + value.imageTokens;
  }, 0);
  const arrayWeight = (messages: Message[]): number => textWeight('[]') + Math.max(0, messages.length - 1) * 6 + messages.reduce((sum, message) => sum + weight(message), 0);
  const wrapper = { weight: textWeight('{"messages":,"tools":}') + textWeight(toolText), chars: '{"messages":,"tools":}'.length + toolText.length };
  return {
    size: messages => wrapper.chars + 2 + Math.max(0, messages.length - 1) + messages.reduce((sum, message) => sum + serialized(message).text.length, 0),
    estimate: messages => {
      for (const candidate of candidates) {
        // Load evidence lazily: a matching newest prefix must not parse older large requests.
        const measured = candidate.measured === undefined ? candidate.measured = calibration(store, candidate.requestRef, candidate.resultRef) : candidate.measured;
        if (!measured || measured.binding !== bindingText || measured.tools !== toolText || measured.messages.length > messages.length || !measured.messages.every((hash, index) => { const value = serialized(messages[index]!); return hash === (value.hash ??= digest(value.text)); })) continue;
        const added = messages.slice(measured.messages.length);
        // Estimate only new text; never extrapolate a measured ratio across unseen evidence.
        return measured.input + tokens(arrayWeight(added)) + imageTokens(added) + added.length * messageOverhead + framing;
      }
      // An older prefix beyond the bounded lookup cannot discount an unmeasured request.
      return tokens(wrapper.weight + arrayWeight(messages)) + imageTokens(messages) + framing + messages.length * messageOverhead + tools.length * toolOverhead;
    },
  };
}

/** Weighted estimate, not an exact model tokenizer. Includes protocol framing headroom. */
export function estimateInputTokens(store: Store, run: Run, messages: Message[], tools: ToolSpec[]): number {
  return createInputTokenEstimator(store, run, tools).estimate(messages);
}
