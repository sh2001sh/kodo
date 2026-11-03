import { activeMethod, effectiveMethodRun, methodControlTools } from '../extensions/methods.js';
import type { Store } from '../storage/index.js';
import type { Tools } from '../tools/index.js';
import type { Mailbox } from '../messaging/index.js';
import type { ProjectKnowledge } from '../knowledge/index.js';
import type { AssemblyPolicy, CompactionPolicy } from './context.js';
import type { CompletionValidator, Provider, Run, Session, ToolSpec } from './types.js';
import type { RecoveryManager } from './recovery.js';
import type { HostHooks } from './hooks.js';
import { runBudget } from './run-budget.js';
import { contextOutputReserve } from '../providers/model-limits.js';
import { roleAllows } from './role-view.js';
import { isLeanProfile, leanChildRole, leanToolSpecs, viewExec } from './tool-view.js';

/** Coordinator capabilities shared by the step modules; durable state stays in the store. */
export interface StepHost {
  readonly store: Store;
  readonly tools: Tools;
  readonly mailbox: Mailbox;
  readonly provider: Provider;
  readonly recovery: RecoveryManager;
  readonly knowledge?: ProjectKnowledge;
  readonly compaction?: CompactionPolicy;
  readonly assembly?: AssemblyPolicy;
  readonly exploreNudge: number | false;
  readonly hooks?: HostHooks;
  /** Controllers of in-flight tool calls per run; a parallel batch has several. */
  readonly toolControllers: Map<string, Set<AbortController>>;
  readonly completionValidators: Map<string, CompletionValidator>;
  onText(runId: string, text: string): void;
  acquireModel(run: Run, signal: AbortSignal): Promise<() => void>;
}

/** Effective permissions of a run: the session grant narrowed by the run's own list. */
export function effectiveSession(run: Run, session: Session): Session {
  return { ...session, permissions: session.permissions.filter(permission => (run.permissions ?? session.permissions).includes(permission)) };
}

const ablationCoreTools = ['shell.exec', 'file.read', 'file.list', 'file.search', 'file.patch', 'file.apply_patch', 'file.mkdir', 'file.rename', 'file.delete', 'process.exec', 'process.read', 'artifact.read'];

/** Every tool the run may call this step: native and extension tools plus collaboration tools. */
export function toolSpecs(host: StepHost, run: Run, session: Session): ToolSpec[] {
  if (session.inlineMethods && !run.parentId) {
    run = session.methodToolView === 'active' ? effectiveMethodRun(host.store, run) : { ...run, card: { ...run.card, tools: [...new Set([...run.card.tools, ...(session.methodTools ?? [])])] } };
  }
  if (run.toolChoice === 'none') return [];
  const budget = runBudget(run, session);
  const capacity = Math.min(run.modelLimits?.input ?? session.modelLimits?.input ?? Infinity, budget.maxContextTokens - contextOutputReserve(budget));
  const native = host.tools.requestSpecs(run, effectiveSession(run, session), capacity);
  const collaboration = host.mailbox.specs(run).filter(spec => session.methodToolView !== 'active' || !activeMethod(host.store, run.id) || methodControlTools.includes(spec.name));
  const all = [...native, ...collaboration].filter(spec => roleAllows(run, session, spec.name));
  if (isLeanProfile(session.toolProfile) && (!run.parentId || session.toolProfile === 'lean-team')) return leanToolSpecs(all, viewExec(run, effectiveSession(run, session)), leanChildRole(run));
  // Benchmark-only ablation (KODO_ABLATION=small-tools): expose just the file and process tools.
  return process.env.KODO_ABLATION === 'small-tools' ? all.filter(spec => ablationCoreTools.includes(spec.name)) : all;
}

/** Races an action against cancellation; host callbacks may ignore the signal. */
export async function abortable<T>(action: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return action(); }), aborted]);
  } finally { signal.removeEventListener('abort', abort); }
}
