import path from 'node:path';
import { errorText, KodoError } from '../runtime/types.js';
import type { Permission } from '../runtime/types.js';
import { actualPath } from '../runtime/scope.js';
import type { BoundaryCall, ToolBoundary, ToolContext, ToolDefinition } from '../plugins/tool.js';
import type { InputFlag } from '../tools/registry.js';
import type { ToolApprovalHandler, ToolApprovalRequest } from '../tools/index.js';
import { acquirePathLock } from '../tools/write-locks.js';
import type { LockEvent } from '../tools/write-locks.js';
import { captureEffects, reconcileEffects } from '../tools/effect-scan.js';
import type { EffectEvidence } from '../tools/effect-scan.js';
import { whenAborted } from '../tools/background.js';

// Layer 2 execution boundary, moved from `Tools.execute` (src/tools/index.ts). Per-tool
// branches (process, shell, file paging) stay with their tool plugins; only the checks
// shared by every call live here. Dedupe with `Tools` once phase2b lands.

/** Host-supplied facts and policy for one runtime. Every callback receives the tool context. */
export interface ToolBoundaryOptions {
  /** Absolute workspace of the call's run. */
  workspace(context: ToolContext): string;
  /** Effective permissions of the call's run (session grant ∩ run grant). Omitted: no permission check. */
  permissions?(context: ToolContext): readonly Permission[];
  /** Consent for reviewed calls; only an explicit `true` allows the call. */
  approve?: ToolApprovalHandler;
  /** Which calls need consent. Default: writes, exec tools, `web.fetch` and `mcp.*`. */
  review?(definition: ToolDefinition, effect: 'read' | 'write'): boolean;
  /** IDs of unresolved earlier effects that overlap `roots`; any result blocks the write. */
  unresolvedEffects?(context: ToolContext, roots: readonly string[]): readonly string[];
  /** Cross-process lock directory; false (default) keeps locks in this process. */
  lockDirectory?: string | false;
  lockTimeoutMs?: number;
  /** Take read locks for read calls. Default true. */
  readLocks?: boolean;
  /**
   * Snapshot write roots before the call and compare after an uncertain failure.
   * `observesAll` is true only when an OS sandbox confines the tool to its roots.
   */
  reconcile?: { observesAll: boolean; exclude?: readonly string[] };
  /** Lock waits, effect starts and reconciliation evidence, for persistence by the host. */
  onEvent?(context: ToolContext, type: string, data: Record<string, unknown>): void;
}

/** Thrown when a write fails after its effect started; `evidence` says whether anything changed. */
export class UncertainEffectError extends KodoError {
  override readonly cause: unknown;
  readonly evidence: EffectEvidence | undefined;
  constructor(cause: unknown, evidence: EffectEvidence | undefined) {
    super('UNKNOWN_WRITE', `${errorText(cause)}; the effect may be partial${evidence?.verified ? ` (verified: ${evidence.outcome})` : ''}, do not repeat this write before reconciliation`);
    this.cause = cause;
    this.evidence = evidence;
  }
}

const evaluates = (flag: InputFlag | undefined, args: Record<string, unknown>): boolean => typeof flag === 'function' ? flag(Object.freeze(structuredClone(args))) === true : flag === true;
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
const defaultReview = (definition: ToolDefinition, effect: 'read' | 'write'): boolean =>
  effect === 'write' || definition.permission === 'exec' || definition.name === 'web.fetch' || definition.name.startsWith('mcp.');

/** Implements the shared boundary. Missing policy fields take the conservative path: write, approval, whole-workspace lock. */
export class IsolationBoundary implements ToolBoundary {
  constructor(private readonly options: ToolBoundaryOptions) {}

  /** 'read' only when the definition declares it or its `readOnly` flag holds for these arguments. */
  effect(definition: ToolDefinition, args: Record<string, unknown>): 'read' | 'write' {
    return definition.effect === 'read' || evaluates(definition.readOnly, args) ? 'read' : 'write';
  }

  /** Canonical absolute roots a call may touch: its declared `writeScope`, otherwise the whole workspace. */
  roots(definition: ToolDefinition, args: Record<string, unknown>, workspace: string): string[] {
    if (!definition.writeScope) return [actualPath(workspace)];
    const roots = definition.writeScope(Object.freeze(structuredClone(args)));
    if (!Array.isArray(roots) || roots.length > 128 || roots.some(root => typeof root !== 'string' || !root || path.isAbsolute(root) || /^[a-z]:/i.test(root))) throw new KodoError('TOOL_SCOPE', 'writeScope must return at most 128 relative workspace roots');
    return roots.map(root => {
      const target = path.resolve(workspace, root);
      const relative = path.relative(workspace, target);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new KodoError('PATH_DENIED', 'writeScope leaves the workspace');
      return actualPath(target);
    });
  }

  async execute(call: BoundaryCall, invoke: (context: ToolContext) => Promise<unknown>): Promise<unknown> {
    const { definition, context } = call;
    const options = this.options;
    if (definition.available === false) throw new KodoError('TOOL_UNAVAILABLE', `${definition.name} is unavailable on this host`);
    const args = (call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? structuredClone(call.args) : {}) as Record<string, unknown>;
    const check = definition.validate?.(Object.freeze(structuredClone(args)));
    if (check === false || typeof check === 'string') throw new KodoError('TOOL_ARGUMENTS', typeof check === 'string' ? check : `arguments rejected by ${definition.name}`);
    this.assertPermission(definition, context);
    const effect = this.effect(definition, args);
    const workspace = options.workspace(context);
    const roots = effect === 'write' ? this.roots(definition, args, workspace) : [];
    if (effect === 'write') this.assertResolved(context, roots);

    if (options.approve && (options.review ?? defaultReview)(definition, effect)) {
      await this.consent(options.approve, freeze({ runId: context.runId, name: definition.name, arguments: structuredClone(args), effect }), context.signal);
      // Grants may change while consent is pending; re-check before taking any lock.
      this.assertPermission(definition, context);
      if (effect === 'write') this.assertResolved(context, roots);
    }

    const onEvent = (event: LockEvent): void => options.onEvent?.(context, event.type, event.data);
    const lock = { directory: options.lockDirectory ?? false, timeoutMs: options.lockTimeoutMs ?? 600_000, signal: context.signal, onEvent };
    const release = effect === 'write' ? await acquirePathLock(workspace, roots, 'write', lock)
      : options.readLocks !== false ? await acquirePathLock(workspace, [actualPath(workspace)], 'read', lock) : undefined;
    try {
      context.signal.throwIfAborted();
      // Re-check under the lock: a peer may have left an unresolved effect while this call queued.
      if (effect === 'write') this.assertResolved(context, roots);
      const before = effect === 'write' && options.reconcile ? await captureEffects(workspace, roots, [...options.reconcile.exclude ?? []], options.reconcile.observesAll) : undefined;
      let started = false;
      const markEffectStarted = (): void => {
        if (started) return;
        started = true;
        context.markEffectStarted();
        options.onEvent?.(context, 'tool.effect_started', { name: definition.name, effect, roots });
      };
      try { return await invoke({ ...context, markEffectStarted }); }
      catch (error) {
        if (effect !== 'write' || !started) throw error;
        // Still under the write lock, so no peer write can blur the comparison.
        const evidence = options.reconcile && before ? await reconcileEffects(workspace, roots, before, [...options.reconcile.exclude ?? []], options.reconcile.observesAll) : undefined;
        if (evidence) options.onEvent?.(context, 'tool.reconciled', { name: definition.name, ...evidence });
        if (evidence?.verified && evidence.outcome === 'not_applied') throw error;
        throw new UncertainEffectError(error, evidence);
      }
    } finally { release?.(); }
  }

  private assertPermission(definition: ToolDefinition, context: ToolContext): void {
    const granted = this.options.permissions?.(context);
    if (granted && !granted.includes(definition.permission ?? 'write')) throw new KodoError('TOOL_DENIED', `${definition.name} requires ${definition.permission ?? 'write'} permission`);
  }

  private assertResolved(context: ToolContext, roots: readonly string[]): void {
    const blocking = this.options.unresolvedEffects?.(context, roots) ?? [];
    if (blocking.length) throw new KodoError('UNKNOWN_WRITE', `an unresolved effect (${blocking.slice(0, 3).join(', ')}) may have changed paths this write touches; reconcile it before writing there`);
  }

  private async consent(approve: ToolApprovalHandler, request: Readonly<ToolApprovalRequest>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const stopped = whenAborted(signal);
    let allowed: boolean;
    try {
      allowed = await Promise.race([
        Promise.resolve().then(() => { signal.throwIfAborted(); return approve(request, signal); }),
        stopped.promise.then(() => { throw signal.reason; }),
      ]);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw new KodoError('TOOL_APPROVAL_FAILED', `tool approval failed: ${errorText(error)}`);
    } finally { stopped.dispose(); }
    signal.throwIfAborted();
    if (allowed !== true) throw new KodoError('TOOL_APPROVAL_DENIED', 'not started: the user did not approve this tool call');
  }
}

/** Convenience for `createRuntime({ boundary: createToolBoundary({...}) })`. */
export function createToolBoundary(options: ToolBoundaryOptions): IsolationBoundary { return new IsolationBoundary(options); }
