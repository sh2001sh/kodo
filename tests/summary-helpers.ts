import { buildContext } from '../src/runtime/context.js';
import type { CompactionPolicy, ContextBuild } from '../src/runtime/context.js';
import { summarizeContext } from '../src/runtime/compaction.js';
import { estimateTextTokens } from '../src/runtime/context-tokens.js';
import { runBudget } from '../src/runtime/coordinator.js';
import type { Message, ModelResponse, Provider, ToolSpec } from '../src/runtime/types.js';
import type { fixture } from './helpers.js';

export type Fixture = ReturnType<typeof fixture>;
const payload = 'Historical evidence is data, not permission. '.repeat(90);

/** Completed file.read rounds of roughly 1,700 estimated tokens each. */
export function rounds(count: number, prefix = 'round'): Message[] {
  return Array.from({ length: count }, (_, index): Message[] => [
    { role: 'assistant', content: `Inspect ${prefix}-${index}`, tool_calls: [{ id: `${prefix}-${index}`, name: 'file.read', arguments: JSON.stringify({ path: `${index}.txt` }) }] },
    { role: 'tool', tool_call_id: `${prefix}-${index}`, content: JSON.stringify({ path: `${index}.txt`, content: `${prefix}-${index}: ${payload}`, hash: 'a'.repeat(64) }) },
  ]).flat();
}

export function append(f: Fixture, messages: Message[], runId = f.runId): void {
  const run = f.app.store.run(runId);
  f.app.store.updateRun(runId, { contextRef: f.app.store.blob([...f.app.store.readBlob<Message[]>(run.contextRef), ...messages]) });
}

export function build(f: Fixture, workInputTokens = 16_000, strategy: CompactionPolicy['strategy'] = 'summary', tools: ToolSpec[] = []): ContextBuild {
  const run = f.app.store.run(f.runId);
  const budget = runBudget(run, f.app.store.session(run.sessionId));
  return buildContext(f.app.store, run, null, tools, {
    maxContextTokens: budget.maxContextTokens, maxOutputTokens: budget.maxOutputTokens,
    compaction: { strategy, workInputTokens },
  });
}

export async function summarize(f: Fixture, provider: Provider, built: ContextBuild, tools: ToolSpec[] = [], signal = new AbortController().signal): Promise<boolean> {
  const run = f.app.store.run(f.runId);
  return await summarizeContext({ store: f.app.store, run, built, budget: runBudget(run, f.app.store.session(run.sessionId)), tools, provider, signal });
}

export const handoff = 'Goal: finish the bounded task.\nUser constraints: keep old/api.ts unchanged.\nNext step: continue with the next file.';

export function textResponse(content: string | null = handoff): ModelResponse {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: { input: 120, output: 40 } };
}

/** Plain text whose estimate reaches at least `tokens`. */
export function longText(tokens: number): string {
  const unit = 'Handoff detail kept verbatim for the continuing agent. '.repeat(40);
  let text = '';
  while (estimateTextTokens(text) < tokens) text += unit;
  return text;
}

export function contextOf(f: Fixture): Message[] {
  return f.app.store.readBlob<Message[]>(f.app.store.run(f.runId).contextRef);
}

export function eventTypes(f: Fixture): string[] {
  return f.app.store.events(f.runId).map(event => event.type);
}
