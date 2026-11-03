import type { Store } from '../storage/index.js';
import { collaborationTool } from '../messaging/index.js';
import { deliverableStatus } from './deliverables.js';
import type { DeliverableStatus } from './deliverables.js';
import type { Call, Run } from './types.js';

/** Label that marks the runtime block inside a summary marker. */
export const deliveryStatePrefix = '[Runtime delivery state — generated from durable records and the workspace; authoritative over the summary text]';

const fileWrites = new Set(['file.apply_patch', 'file.patch', 'file.rename', 'file.delete', 'file.mkdir']);
const commandTools = new Set(['process.exec', 'process.run', 'shell.exec']);
const maxChars = 6_000;

export interface DeliveryState {
  objective: string;
  deliverables: DeliverableStatus[];
  filesChanged: string[];
  commands: { command: string; exitCode: number | null; status: Call['status'] }[];
  unresolvedFailures: { tool: string; error: string }[];
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function requestArgs(store: Store, call: Call): Record<string, unknown> | undefined {
  try { return JSON.parse(store.readBlob<{ arguments: string }>(call.requestRef).arguments) as Record<string, unknown>; }
  catch { return undefined; }
}

function result(store: Store, call: Call): Record<string, unknown> {
  if (!call.resultRef) return {};
  try {
    const value = store.readBlob<unknown>(call.resultRef);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function commandText(name: string, args: Record<string, unknown>): string {
  if (name === 'shell.exec') return clip(String(args.command ?? ''), 160);
  const argv = Array.isArray(args.args) ? args.args.map(String) : [];
  return clip([String(args.program ?? ''), ...argv].join(' '), 160);
}

/** Successful file-tool targets, newest last and deduplicated. */
function changedFiles(store: Store, calls: Call[]): string[] {
  const seen = new Map<string, string>();
  for (const call of calls) {
    if (call.status !== 'succeeded' || !fileWrites.has(call.name)) continue;
    const args = requestArgs(store, call);
    if (!args) continue;
    const target = call.name === 'file.rename' ? `${String(args.path)} -> ${String(args.destination)}` : String(args.path ?? '');
    const label = call.name === 'file.delete' ? `${target} (deleted)` : target;
    seen.delete(label);
    seen.set(label, label);
  }
  return [...seen.values()].slice(-20);
}

/**
 * Failed tool calls whose tool and arguments never later succeeded. A later
 * success with the same arguments resolves the failure.
 */
function unresolved(store: Store, calls: Call[]): DeliveryState['unresolvedFailures'] {
  const failures = new Map<string, { tool: string; error: string }>();
  for (const call of calls) {
    if (collaborationTool(call.name) || !['succeeded', 'failed'].includes(call.status)) continue;
    const key = `${call.name}:${store.readBlob<{ arguments: string }>(call.requestRef).arguments}`;
    const value = result(store, call);
    const failedProcess = commandTools.has(call.name) && typeof value.exitCode === 'number' && value.exitCode !== 0;
    if (call.status === 'failed' || failedProcess) {
      const error = typeof value.error === 'string' ? value.error : failedProcess ? `exit ${String(value.exitCode)}` : 'failed';
      failures.delete(key);
      failures.set(key, { tool: call.name, error: clip(error, 200) });
    } else failures.delete(key);
  }
  return [...failures.values()].slice(-5);
}

/** Builds the deterministic delivery state of a main run from durable calls and the workspace. */
export function deliveryState(store: Store, run: Run): DeliveryState {
  const workspace = store.session(run.sessionId).workspace;
  const calls = store.calls(run.id).filter(call => call.kind === 'tool');
  const commands = calls.filter(call => commandTools.has(call.name) && ['succeeded', 'failed', 'unknown', 'cancelled'].includes(call.status)).slice(-5).map(call => {
    const value = result(store, call);
    return { command: commandText(call.name, requestArgs(store, call) ?? {}), exitCode: typeof value.exitCode === 'number' ? value.exitCode : null, status: call.status };
  });
  return {
    objective: clip(run.objective, 600),
    deliverables: deliverableStatus(workspace, run.deliverables, Date.parse(run.createdAt)),
    filesChanged: changedFiles(store, calls),
    commands,
    unresolvedFailures: unresolved(store, calls),
  };
}

/** Renders the delivery state as a bounded plain-text block for the summary marker. */
export function renderDeliveryState(state: DeliveryState): string {
  const lines = [deliveryStatePrefix, `Objective (excerpt): ${state.objective}`];
  if (state.deliverables.length) {
    lines.push('Deliverables (checked against the workspace now):');
    for (const item of state.deliverables) lines.push(`- ${item.label}: ${item.status}${item.status === 'missing' ? '' : `, ${item.bytes} bytes${item.matches.length ? ` (${item.matches.join(', ')})` : ''}`}${item.status === 'empty' ? `, needs at least ${item.minBytes}` : ''}`);
  }
  lines.push(`Files changed with file tools: ${state.filesChanged.length ? state.filesChanged.join(', ') : 'none'}`);
  lines.push(state.commands.length ? 'Last commands:' : 'Last commands: none');
  for (const command of state.commands) lines.push(`- ${command.command} => ${command.exitCode === null ? command.status : `exit ${command.exitCode}`}`);
  if (state.unresolvedFailures.length) {
    lines.push('Unresolved failures (not yet followed by a success with the same arguments):');
    for (const failure of state.unresolvedFailures) lines.push(`- ${failure.tool}: ${failure.error}`);
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
