import path from 'node:path';
import type { Store } from '../storage/index.js';
import { digest } from '../storage/index.js';
import { contextOutputReserve } from '../providers/model-limits.js';
import { attachment } from './attachments.js';
import { chainBudgetBytes, discoverInstructions, globalLabel, instructionCapacityShare, instructionSourceDigest } from './project-instructions.js';
import type { InstructionChain } from './project-instructions.js';
import { runBudget } from './run-budget.js';
import type { Budget, FileScope, Message, Run, Session, ToolRequest } from './types.js';
import { KodoError } from './types.js';
import { initialContext } from './context.js';
import { normalizeAgentFactors } from './agent-factors.js';
import { estimateTextTokens } from './context-tokens.js';
import type { DiscoveryInput } from './project-instructions.js';
import { executionSession } from './execution-workspace.js';

export type RunInstructions = NonNullable<Run['instructions']>;
/** Includes wrapper and message protocol fields, not raw source byte counts. */
const instructionMessageTokens = (message?: Message): number => message ? estimateTextTokens(JSON.stringify(message)) : 0;
/** Conservative bytes per estimated token when converting the capacity share. */
const bytesPerToken = 3;
/** Native tools whose `path` (and `destination`) argument touches a workspace location. */
const touchingTools = new Set(['file.read', 'file.list', 'file.search', 'file.apply_patch', 'file.patch', 'file.mkdir', 'file.rename', 'file.delete', 'image.read']);
const directoryTools = new Set(['file.list', 'file.search', 'file.mkdir']);

/** Byte budget for all instructions of one run: a share of its input capacity. */
export function instructionCapacityBytes(budget: Pick<Budget, 'maxContextTokens' | 'maxOutputTokens'>, inputLimit?: number): number {
  const capacity = Math.min(inputLimit ?? Infinity, budget.maxContextTokens - contextOutputReserve(budget as Budget));
  return Math.max(0, Math.floor(Math.max(0, capacity) * instructionCapacityShare * bytesPerToken));
}
export function runInstructionCapacity(run: Run, session: Session): number {
  return instructionCapacityBytes(runBudget(run, session), run.modelLimits?.input ?? session.modelLimits?.input);
}

const writeDirectories = (scope?: FileScope): string[] => (scope?.write ?? []).filter(root => root !== '.');

/** Directories and rules a loaded chain covers, so children and follow-ups can rebuild it. */
function coverage(loaded: string[]): { directories: string[]; rules: string[] } {
  const directories = loaded.filter(label => label !== globalLabel && !label.startsWith('.kodo/rules/') && !label.startsWith('.kodo/memory/') && label.includes('/')).map(label => path.posix.dirname(label));
  return { directories: [...new Set(directories)], rules: loaded.filter(label => label.startsWith('.kodo/rules/')) };
}

/**
 * Initial chain of a new run: global and workspace root files, unconditional
 * rules, the write-scope directories, and whatever the inherited chain covered.
 */
export function initialInstructions(workspace: string, options: { global: string | false; capacityBytes: number; scope?: FileScope; inherited?: RunInstructions; memory?: boolean; cardRules?: string[]; capacityTokens?: number; trigger?: string }): { chain: InstructionChain; state: RunInstructions } {
  const inherited = options.inherited ? coverage(options.inherited.loaded) : { directories: [], rules: [] };
  const global = options.inherited ? options.inherited.global ?? false : options.global;
  const cardRules = [...new Set(options.cardRules ?? options.inherited?.cardRules ?? [])];
  const trigger = options.trigger ?? 'initial';
  const chain = discoverWithinTokens({
    workspace, includeRoot: true, global, loaded: new Set(),
    directories: [...inherited.directories, ...writeDirectories(options.scope)], rules: inherited.rules,
    maxBytes: Math.min(chainBudgetBytes, options.capacityBytes), includeMemory: options.memory ?? options.inherited?.memory, cardRules,
  }, options.capacityTokens, trigger);
  return { chain, state: { loaded: chain.files.filter(file => !file.includedBy).map(file => file.path), sources: Object.fromEntries(chain.files.map(file => [file.path, file.digest])), bytes: chain.bytes, ...(global ? { global } : {}), ...((options.memory ?? options.inherited?.memory) ? { memory: true } : {}), ...(cardRules.length ? { cardRules } : {}), ...(options.capacityTokens === undefined ? {} : { tokenBudget: options.inherited?.tokenBudget ?? options.capacityTokens, reservedTokens: options.inherited?.reservedTokens ?? 0, tokens: instructionMessageTokens(instructionMessage(chain, trigger)) }) } };
}

/** Load bounded sources, then fit the actual rendered block including its wrapper. */
function discoverWithinTokens(input: DiscoveryInput, tokens?: number, trigger = 'initial', attributes: Record<string, string> = {}): InstructionChain {
  let bytes = input.maxBytes;
  let chain = discoverInstructions(input);
  if (tokens === undefined) return chain;
  const allowance = Math.max(0, tokens);
  while (chain.text && instructionMessageTokens(attachment('project-instructions', chain.text, { trigger, ...attributes })) > allowance) {
    const observed = instructionMessageTokens(attachment('project-instructions', chain.text, { trigger, ...attributes }));
    bytes = Math.max(0, Math.min(bytes - 1, Math.floor(bytes * allowance / observed) - 32));
    chain = discoverInstructions({ ...input, maxBytes: bytes });
  }
  return chain;
}

/** Initial assembly after the session and provisional run have been stored. */
export function prepareInstructionContext(store: Store, run: Run, session: Session, options: { global: string | false; memory?: boolean; inherited?: RunInstructions }): { messages: Message[]; instructions: RunInstructions } {
  session = executionSession(store, run);
  const factors = normalizeAgentFactors(session.agentFactors);
  const permissions = session.permissions.filter(permission => (run.permissions ?? session.permissions).includes(permission));
  const base = initialContext(session.workspace, permissions, run.card, run.objective, run, undefined, { factors, taskProtocol: session.taskProtocol, toolProfile: session.toolProfile });
  // B/C alone leave instruction allocation unchanged.
  const enabled = factors.A;
  const budgetTokens = enabled ? Math.floor(runInstructionCapacity(run, session) / bytesPerToken) : undefined;
  const methodTokens = enabled ? instructionMessageTokens(base[1]) : 0;
  if (budgetTokens !== undefined && methodTokens > budgetTokens) throw new KodoError('CARD_INSTRUCTION_BUDGET', `card method needs ${methodTokens} estimated tokens but the shared instruction allowance is ${budgetTokens}; shorten the card method or select a larger input capacity`);
  // Project/card instructions take priority over optional session method detail. Both
  // share the same allowance with the mandatory method configuration.
  const loaded = initialInstructions(session.workspace, { ...options, capacityBytes: runInstructionCapacity(run, session), scope: run.scope,
    cardRules: run.card.constraints?.rules ?? [], capacityTokens: budgetTokens === undefined ? undefined : Math.max(0, budgetTokens - methodTokens) });
  const block = instructionMessage(loaded.chain, enabled ? 'initial' : undefined);
  const ruleTokens = instructionMessageTokens(block);
  const instructions: RunInstructions = { ...loaded.state, ...(budgetTokens === undefined ? {} : { tokenBudget: budgetTokens, reservedTokens: methodTokens, tokens: ruleTokens }) };
  recordInstructions(store, run.id, options.inherited ? 'inherited' : 'initial', loaded.chain);
  return { messages: initialContext(session.workspace, permissions, run.card, run.objective, run, block, { factors, taskProtocol: session.taskProtocol, toolProfile: session.toolProfile }), instructions };
}

export function instructionMessage(chain: InstructionChain, trigger?: string): Message | undefined {
  return chain.text ? attachment('project-instructions', chain.text, trigger ? { trigger } : {}) : undefined;
}

/** Durable record of what was loaded; caller runs inside the run's transaction. */
export function recordInstructions(store: Store, runId: string, trigger: 'initial' | 'inherited' | 'follow_up' | 'touch' | 'before_write' | 'changed' | 'compaction', chain: InstructionChain): void {
  if (!chain.files.length && !chain.notes.length) return;
  store.event(runId, 'context.instructions_loaded', { trigger, files: chain.files, bytes: chain.bytes, digest: digest(chain.text), ...(chain.notes.length ? { notes: chain.notes } : {}) });
}

function touchedPath(workspace: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value.includes('\0')) return;
  const input = path.isAbsolute(value) ? path.relative(workspace, value) : value;
  if (path.isAbsolute(input) || /^[a-z]:/i.test(input)) return;
  const normalized = path.posix.normalize(input.replaceAll('\\', '/')).replace(/^\.\//, '');
  return normalized === '..' || normalized.startsWith('../') ? undefined : normalized;
}

/**
 * Instructions newly reachable through successful tool calls of this batch.
 * Returns the delta block to append after the tool results, or undefined.
 */
export function touchedInstructions(store: Store, run: Run, session: Session, requests: { request: ToolRequest; succeeded: boolean }[], trigger: 'touch' | 'before_write' = 'touch'): Message | undefined {
  session = executionSession(store, run);
  const files: string[] = [];
  const directories: string[] = [];
  for (const { request, succeeded } of requests) {
    if (!succeeded || !touchingTools.has(request.name)) continue;
    let args: Record<string, unknown>;
    try { args = JSON.parse(request.arguments) as Record<string, unknown>; } catch { continue; }
    for (const value of [args.path, args.destination]) {
      const target = touchedPath(session.workspace, value);
      if (target === undefined) continue;
      if (directoryTools.has(request.name)) directories.push(target === '.' ? '' : target);
      else { files.push(target); directories.push(path.posix.dirname(target) === '.' ? '' : path.posix.dirname(target)); }
    }
  }
  if (!files.length && !directories.some(Boolean)) return;
  const state = run.instructions ?? { loaded: [], bytes: 0 };
  const room = Math.max(0, runInstructionCapacity(run, session) - state.bytes);
  const tokens = state.tokenBudget === undefined ? undefined : Math.max(0, state.tokenBudget - (state.reservedTokens ?? 0) - (state.tokens ?? 0));
  const chain = discoverWithinTokens({ workspace: session.workspace, includeRoot: false, global: false, directories: directories.filter(Boolean), touched: files, loaded: new Set(state.loaded), maxBytes: Math.min(chainBudgetBytes, room) }, tokens, trigger);
  const loaded = [...state.loaded, ...chain.files.filter(file => !file.includedBy).map(file => file.path)];
  if (chain.files.length) store.updateRun(run.id, { instructions: { ...state, loaded: [...new Set(loaded)], sources: { ...state.sources, ...Object.fromEntries(chain.files.map(file => [file.path, file.digest])) }, bytes: state.bytes + chain.bytes, ...(tokens === undefined ? {} : { tokens: (state.tokens ?? 0) + instructionMessageTokens(instructionMessage(chain, trigger)) }) } });
  recordInstructions(store, run.id, trigger, chain);
  return instructionMessage(chain, trigger);
}

/**
 * Discover instructions before an admitted write is dispatched. A returned delta
 * must be delivered to the model with a not-started result; it replans the write
 * on its next turn. The caller passes only validated write requests.
 */
export function beforeWriteInstructions(store: Store, run: Run, session: Session, requests: ToolRequest[]): Message | undefined {
  return touchedInstructions(store, run, session, requests.map(request => ({ request, succeeded: true })), 'before_write');
}

/** Changed files append one replacement revision; the frozen prefix remains byte-identical. */
export function refreshInstructions(store: Store, run: Run, session: Session): Message | undefined {
  session = executionSession(store, run);
  const state = run.instructions;
  if (!state?.sources) return;
  const changed = Object.entries(state.sources).filter(([label, hash]) => instructionSourceDigest(session.workspace, label, state.global) !== hash).map(([label]) => label);
  const covered = coverage(state.loaded);
  const room = Math.max(0, runInstructionCapacity(run, session) - state.bytes);
  const tokens = state.tokenBudget === undefined ? undefined : Math.max(0, state.tokenBudget - (state.reservedTokens ?? 0) - (state.tokens ?? 0));
  const attributes: Record<string, string> = changed.length ? { replaces: 'previous project instruction revision', changed: changed.join(', ') } : {};
  const chain = discoverWithinTokens({ workspace: session.workspace, includeRoot: true, global: state.global ?? false, includeMemory: state.memory, directories: covered.directories, rules: covered.rules, cardRules: state.cardRules, loaded: new Set(changed.length ? [] : state.loaded), maxBytes: Math.min(chainBudgetBytes, room) }, tokens, 'changed', attributes);
  if (!changed.length && !chain.files.length) return;
  if (!chain.text && changed.length) {
    const notice = 'Previously loaded project instructions were removed; the earlier revision no longer applies.';
    if (Buffer.byteLength(notice) > room) throw new KodoError('INSTRUCTION_BUDGET', 'changed project instructions cannot fit within the remaining instruction budget; start a follow-up run with the current instructions');
    chain.text = notice;
    chain.bytes = Buffer.byteLength(notice);
    chain.notes.push(`removed or unavailable sources: ${changed.join(', ')}`);
  }
  const message = chain.text ? attachment('project-instructions', chain.text, { trigger: 'changed', ...attributes }) : undefined;
  if (tokens !== undefined && instructionMessageTokens(message) > tokens) throw new KodoError('INSTRUCTION_BUDGET', 'changed project instructions cannot fit within the remaining instruction token budget; start a follow-up run');
  const sources = Object.fromEntries(chain.files.map(file => [file.path, file.digest]));
  const loaded = chain.files.filter(file => !file.includedBy).map(file => file.path);
  store.updateRun(run.id, { instructions: { ...state, loaded: changed.length ? loaded : [...new Set([...state.loaded, ...loaded])], sources: changed.length ? sources : { ...state.sources, ...sources }, bytes: state.bytes + chain.bytes, ...(tokens === undefined ? {} : { tokens: (state.tokens ?? 0) + instructionMessageTokens(message) }) } });
  recordInstructions(store, run.id, 'changed', chain);
  return message;
}
