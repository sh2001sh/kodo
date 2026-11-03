import type { Store } from '../storage/index.js';
import { digest } from '../storage/index.js';
import { KodoError, terminal } from '../runtime/types.js';
import type { Call, Card, CardReference, FileScope, Permission, Run, Session } from '../runtime/types.js';
import { intersectFileScopes, resolveScopeVariables } from '../runtime/scope.js';
import type { ToolRegistration } from '../tools/registry.js';

/** Stable per-version handles, distinct from ordinary Skill names. */
export const methodSkillId = (card: Card): string => `card-method/${digest(JSON.stringify([card.id, card.version, card.digest]))}`;
interface MethodIdentity { id: string; card: CardReference; }
export interface MethodContract { tools: string[]; skills: string[]; permissions: Permission[]; scope: FileScope }
interface MethodState extends MethodIdentity { callId: string; contract?: MethodContract; nodeId?: string; generation?: number }

export const methodControlTools = ['skill.list', 'skill.load', 'task', 'ask_user', 'inspect_run', 'artifact.read', 'artifact.write', 'process.read', 'update_progress', 'history.read', 'history.search', 'knowledge.browse', 'knowledge.search', 'knowledge.read', 'knowledge.publish'];

/** Digest of the session method catalog; the publication precondition shown to hosts. */
export const methodCatalogDigest = (cards: readonly CardReference[] | undefined): string => digest(JSON.stringify([...(cards ?? [])].map(card => [card.id, card.version, card.digest]).sort((left, right) => left[0]! < right[0]! ? -1 : left[0]! > right[0]! ? 1 : 0)));

/** Session method cards resolved from the registry; unavailable versions stay visible with a reason. */
export function sessionMethodCards(store: Store, session: Session): { ref: CardReference; card?: Card; reason?: string }[] {
  return (session.methodCards ?? []).map(ref => {
    const card = store.card(ref.id, ref.version);
    if (!card || card.digest !== ref.digest) return { ref, reason: 'this session method version is no longer registered' };
    return { ref, card };
  });
}

/** A method can narrow the host-approved resource pool, never grant new resources. */
export function methodContract(run: Run, session: Session, card: Card): MethodContract {
  const approved = new Set([...run.card.tools, ...(session.methodTools ?? [])]);
  const needed = [...card.tools, ...(card.mcp ?? []).flatMap(server => server.tools.map(tool => `mcp.${server.server}.${tool}`))];
  if (needed.some(name => !approved.has(name))) throw new KodoError('METHOD_INCOMPATIBLE', 'required tools are outside the host-approved pool');
  const permissions = (run.permissions ?? session.permissions).filter(permission => session.permissions.includes(permission) && (!card.constraints?.permissions || card.constraints.permissions.includes(permission)) && (card.routing?.mode !== 'read' && card.routing?.mode !== 'review' || permission === 'read'));
  return { tools: [...new Set([...needed, ...methodControlTools.filter(name => approved.has(name))])], skills: card.skills ?? [], permissions,
    scope: intersectFileScopes(run.scope, resolveScopeVariables(card.constraints?.scope, session.projectRoots)) };
}

/** Ephemeral execution view; the original main card and authorization remain unchanged. */
export function effectiveMethodRun(store: Store, run: Run): Run {
  if (!store.session(run.sessionId).inlineMethods || run.parentId) return run;
  const contract = activeMethod(store, run.id)?.contract;
  if (!contract) return run;
  const session = store.session(run.sessionId);
  return { ...run, card: { ...run.card, tools: contract.tools, skills: [...new Set([...(run.card.skills ?? []), ...contract.skills])] },
    permissions: contract.permissions.filter(permission => session.permissions.includes(permission) && (run.permissions ?? session.permissions).includes(permission)),
    scope: intersectFileScopes(run.scope, contract.scope) };
}

/** Persisted events, not process-local state, determine the current method. */
export function activeMethod(store: Store, runId: string): MethodState | undefined {
  const event = store.latestEvent(runId, { types: ['method.loaded', 'method.ended'] });
  if (event) return event.type === 'method.loaded' ? event.data as unknown as MethodState : undefined;
  const run = store.run(runId);
  const source = run.historyFrom ?? (run.continuationOf && store.hasEvent(run.continuationOf, { types: ['recovery.continued'], match: { runId } }) ? run.continuationOf : undefined);
  if (source) {
    return activeMethod(store, source);
  }
  return;
}

function incompatibility(card: Card, run: Run, session: Session, tools: readonly string[]): string | undefined {
  const needed = [...card.tools, ...(card.mcp ?? []).flatMap(server => server.tools.map(tool => `mcp.${server.server}.${tool}`))];
  if (needed.some(name => !tools.includes(name))) return 'required tools are not in the current run';
  if (card.skills?.some(id => ![...(run.card.skills ?? []), ...(session.methodSkills ?? [])].includes(id))) return 'required Skills are not in the current run';
  if (card.inputs?.some(input => input.required) || card.report?.length) return 'named inputs and report contracts require task activate';
  if (card.model) return 'requires a separate model binding';
  if (card.constraints?.rules?.length || card.members?.length) return 'rule-file contracts require task activate; member contracts require child execution';
  try {
    methodContract(run, session, card);
  } catch (error) {
    if (!(error instanceof KodoError)) throw error;
    return error.message;
  }
  return;
}

/** Extend the host Skill catalog; successful method loads bind the execution contract. */
export function withCardMethods(store: Store, definitions: ToolRegistration[], available: (run: Run, session: Session) => readonly string[]): ToolRegistration[] {
  return definitions.map(definition => ({ ...definition, execute: async (context, args) => {
    const { session, signal } = context;
    const run = store.run(context.run.id);
    if (!session.inlineMethods || run.parentId) return definition.execute(context, args);
    const entries = sessionMethodCards(store, session);
    const current = activeMethod(store, run.id);
    if (current) {
      const index = entries.findIndex(entry => methodSkillId(entry.card!) === current.id);
      if (index >= 0) {
        if (entries[index]!.reason) entries[index] = { ...entries[index]!, reason: undefined };
      } else {
        const card = store.card(current.card.id, current.card.version);
        if (card.digest !== current.card.digest) throw new KodoError('METHOD_IDENTITY', 'the active method version is no longer available');
        entries.push({ ref: { id: card.id, version: card.version, digest: card.digest }, card });
      }
    }
    const tools = available(run, session);
    const methods = entries.map(entry => ({ entry, id: entry.card ? methodSkillId(entry.card) : `card-method/${entry.ref.id}@${entry.ref.version}`, reason: entry.reason ?? (entry.card ? incompatibility(entry.card, run, session, tools) : undefined) }));
    if (methods.some(method => method.entry.card && run.card.skills?.includes(method.id))) throw new KodoError('SKILL_DUPLICATE', 'a card method handle collides with a registered Skill');
    signal.throwIfAborted();
    if (definition.name === 'skill.list') {
      const result = await definition.execute(context, args) as { skills: unknown[] };
      return { ...result, skills: [...result.skills, ...methods.filter(method => !method.reason && method.entry.card).map(({ id, entry: { card } }) => ({ id, description: card!.description ?? card!.name, digest: digest(card!.prompt), kind: 'card-method', card: { id: card!.id, version: card!.version, digest: card!.digest } }))],
        unavailableMethods: methods.filter(method => method.reason).map(method => ({ id: method.id, card: { id: method.entry.ref.id, version: method.entry.ref.version }, reason: method.reason, inputs: method.entry.card?.inputs ?? [], report: method.entry.card?.report ?? [] })) };
    }
    const method = methods.find(method => method.id === args.id);
    if (!method) return definition.execute(context, args);
    if (method.reason) throw new KodoError('METHOD_INCOMPATIBLE', method.reason);
    if (current?.nodeId && current.id !== method.id) throw new KodoError('METHOD_ACTIVE', 'finish or drop the explicit stage before switching its method');
    const card = method.entry.card!;
    const offset = (args.offset as number | undefined) ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > card.prompt.length || offset > 0 && /[\uD800-\uDBFF]/.test(card.prompt[offset - 1]!) && /[\uDC00-\uDFFF]/.test(card.prompt[offset] ?? '')) throw new KodoError('SKILL_CURSOR', 'invalid method content cursor');
    let end = Math.min(card.prompt.length, offset + ((args.maxChars as number | undefined) ?? 8000));
    if (end < card.prompt.length && /[\uD800-\uDBFF]/.test(card.prompt[end - 1]!)) end--;
    return { id: method.id, description: card.description ?? card.name, digest: digest(card.prompt), content: card.prompt.slice(offset, end), next: end < card.prompt.length ? { offset: end } : null,
      method: { id: method.id, card: { id: card.id, version: card.version, digest: card.digest } }, requiredSkills: card.skills ?? [],
      note: 'This method binds its declared tool and scope contract; task acceptance is separate. Read any remaining pages before treating the method as complete.' };
  } }));
}

/** Called in the successful tool-result transaction, in request order. */
export function recordMethodLoad(store: Store, run: Run, call: Call, result: unknown): unknown {
  if (call.name !== 'skill.load' || !store.session(run.sessionId).inlineMethods || run.parentId || !result || typeof result !== 'object' || !('method' in result)) return result;
  const method = result.method as MethodIdentity;
  const session = store.session(run.sessionId);
  const entry = sessionMethodCards(store, session).find(item => item.card && methodSkillId(item.card) === method?.id);
  const running = activeMethod(store, run.id);
  const card = entry?.card ?? (running?.id === method?.id ? store.card(running.card.id, running.card.version) : undefined);
  if (!card?.execution?.modes.includes('inline') || method.card?.digest !== card.digest) throw new KodoError('METHOD_IDENTITY', 'method result does not match the session method catalog');
  if (store.hasEvent(run.id, { types: ['method.loaded'], match: { callId: call.id } })) return store.readBlob(store.call(call.id).resultRef!);
  const previous = activeMethod(store, run.id);
  if (previous?.id === method.id) return { ...result, methodInstance: previous.callId };
  if (previous?.nodeId) throw new KodoError('METHOD_ACTIVE', 'finish or drop the explicit stage before switching its method');
  if (previous) store.event(run.id, 'method.ended', { ...previous, reason: 'replaced', replacedBy: method.id });
  store.event(run.id, 'method.loaded', { ...method, callId: call.id, contract: methodContract(run, session, card) });
  return { ...result, contract: methodContract(run, session, card), methodInstance: call.id, methodNotice: previous
    ? `Method ${previous.id} is no longer the active work method; use ${method.id} now. Preserve project facts, user requirements and all work history. This switch does not complete or accept the previous task, remove context, or accept task results.`
    : `Active work method: ${method.id}. Only this method’s declared tool and scope contract is executable; task acceptance is separate.` };
}

/** Questions, waiting and interruptions do not finish a method. */
export function endMethod(store: Store, run: Run): void {
  if (!terminal(run.status) || !store.session(run.sessionId).inlineMethods || run.parentId) return;
  const current = activeMethod(store, run.id);
  if (current) store.event(run.id, 'method.ended', { ...current, reason: run.status });
}
