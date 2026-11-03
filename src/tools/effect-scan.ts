import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';

/** Effect settlement is separate from command success: applied can be partial. */
export type EffectEvidence =
  | { verified: true; outcome: 'applied' | 'not_applied'; changed: string[]; changedCount: number; roots: string[]; beforeHash: string; afterHash: string; exitConfirmation: 'process-tree'; note: string }
  | { verified: true; outcome: 'not_applied'; changed: []; changedCount: 0; roots: []; beforeHash?: never; afterHash?: never; exitConfirmation: 'process-tree'; basis: 'read-only-command'; note: string }
  | { verified: true; outcome: 'applied' | 'not_applied'; changed: string[]; changedCount: number; roots: string[]; beforeHash?: never; afterHash: string; exitConfirmation: 'process-tree'; basis: 'workspace-change-time'; unobserved: 'outside-roots'; note: string }
  | { verified: false; reason: string; roots: string[] };
export interface ScanLimits { entries: number; ms: number; quietMs: number }
export const defaultScanLimits: ScanLimits = { entries: 20_000, ms: 2_000, quietMs: 500 };
/** One post-timeout scan may cover a whole repository; it runs once per stopped call, not per dispatch. */
export const stoppedScanLimits: ScanLimits = { entries: 200_000, ms: 15_000, quietMs: 500 };
/** Coarse filesystem timestamps (FAT, SMB) round to 2 s; earlier entries are reported as changed, never hidden. */
const timestampSlackMs = 2_000;

/** `tool.reconciled` event payload, including how the outcome was established. */
export function reconciledEvent(callId: string, evidence: EffectEvidence): Record<string, unknown> {
  if (!evidence.verified) return { callId, verified: false, roots: evidence.roots, reason: evidence.reason };
  return { callId, verified: true, roots: evidence.roots, outcome: evidence.outcome, changedCount: evidence.changedCount, beforeHash: evidence.beforeHash, afterHash: evidence.afterHash, exitConfirmation: evidence.exitConfirmation,
    basis: 'basis' in evidence ? evidence.basis : 'manifest-diff', ...('unobserved' in evidence ? { unobserved: evidence.unobserved } : {}) };
}
type Entry = { size: number; mtime: number; ctime: number; inode: number; mode: number };
export type EffectSnapshot = { complete: true; entries: Record<string, Entry>; hash: string; roots: string[] }
  | { complete: false; reason: string; roots: string[] };
const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Called with the write lock held. Symlinks are observed as entries, never followed. */
async function scan(workspace: string, roots: string[], exclude: string[], limits: ScanLimits): Promise<EffectSnapshot> {
  const deadline = Date.now() + limits.ms;
  const entries: Record<string, Entry> = {};
  const pending = roots.map(root => path.resolve(workspace, root));
  const visited = new Set<string>();
  let listed = pending.length;
  const incomplete = (reason: string): EffectSnapshot => ({ complete: false, reason, roots });
  const exceeded = (): boolean => listed > limits.entries || Date.now() > deadline;
  while (pending.length) {
    if (exceeded()) return incomplete(`write scope exceeds the reconciliation budget (${limits.entries} entries, ${limits.ms} ms)`);
    const target = pending.pop()!;
    if (visited.has(target) || exclude.some(root => inside(path.resolve(root), target))) continue;
    visited.add(target);
    try {
      const info = await lstat(target);
      entries[path.relative(workspace, target) || '.'] = { size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, inode: info.ino, mode: info.mode };
      if (info.isDirectory()) {
        const directory = await opendir(target);
        for await (const entry of directory) {
          if (++listed > limits.entries || Date.now() > deadline) return incomplete(`write scope exceeds the reconciliation budget (${limits.entries} entries, ${limits.ms} ms)`);
          pending.push(path.join(target, entry.name));
        }
      }
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      return incomplete(`cannot inspect ${path.relative(workspace, target) || '.'}`);
    }
  }
  if (exceeded()) return incomplete(`write scope exceeds the reconciliation budget (${limits.entries} entries, ${limits.ms} ms)`);
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return { complete: true, entries: sorted, hash: createHash('sha256').update(JSON.stringify(sorted)).digest('hex'), roots };
}

/** Take the baseline before dispatch; without isolation the roots cannot describe every possible effect. */
export async function captureEffects(workspace: string, roots: string[], exclude: string[], observesAll: boolean, limits: ScanLimits = defaultScanLimits): Promise<EffectSnapshot> {
  if (!observesAll) return { complete: false, reason: 'process has no OS sandbox; effects outside its write roots cannot be verified', roots };
  return scan(workspace, roots, exclude, limits);
}

/**
 * Without an OS sandbox there is no pre-dispatch manifest. After the process tree
 * stopped, every entry under the roots whose mtime or ctime falls after the start
 * is reported as changed; a create, delete or rename also moves its parent
 * directory's times. Effects outside the roots stay unobserved and are labelled so.
 */
async function changedSince(workspace: string, roots: string[], exclude: string[], startedAt: number, limits: ScanLimits): Promise<EffectEvidence> {
  const first = await scan(workspace, roots, exclude, limits);
  if (!first.complete) return { verified: false, reason: `process has no OS sandbox and ${first.reason}`, roots };
  await new Promise(resolve => setTimeout(resolve, limits.quietMs));
  const second = await scan(workspace, roots, exclude, limits);
  if (!second.complete) return { verified: false, reason: `process has no OS sandbox and ${second.reason}`, roots };
  if (first.hash !== second.hash) return { verified: false, reason: 'files kept changing after the process tree stopped', roots };
  const since = startedAt - timestampSlackMs;
  const changed = Object.entries(second.entries).filter(([, entry]) => entry.mtime >= since || entry.ctime >= since).map(([file]) => file);
  const visible = changed.filter(file => file !== '.');
  return { verified: true, outcome: changed.length ? 'applied' : 'not_applied', changed: visible.slice(0, 50), changedCount: visible.length, roots,
    afterHash: second.hash, exitConfirmation: 'process-tree', basis: 'workspace-change-time', unobserved: 'outside-roots',
    note: `No OS sandbox: write roots were scanned after the process tree stopped; entries modified since the command started are listed${changed.length ? ' and its effects may be partial' : ', and none was found'}. Writes outside the roots were not observed. Task acceptance is still required.` };
}

/**
 * Caller must confirm process-tree exit before calling. Both post-exit manifests must agree.
 * `startedAt` enables the change-time scan for processes without an OS sandbox.
 */
export async function reconcileEffects(workspace: string, roots: string[], before: EffectSnapshot, exclude: string[], observesAll: boolean, limits: ScanLimits = defaultScanLimits, startedAt?: number): Promise<EffectEvidence> {
  if (!observesAll) return startedAt === undefined ? { verified: false, reason: 'process has no OS sandbox; effects outside its write roots cannot be verified', roots } : changedSince(workspace, roots, exclude, startedAt, stoppedScanLimits);
  if (!before.complete) return { verified: false, reason: before.reason, roots };
  if (JSON.stringify(before.roots) !== JSON.stringify(roots)) return { verified: false, reason: 'write roots differ from the pre-dispatch manifest', roots };
  const first = await scan(workspace, roots, exclude, limits);
  if (!first.complete) return { verified: false, reason: first.reason, roots };
  await new Promise(resolve => setTimeout(resolve, limits.quietMs));
  const second = await scan(workspace, roots, exclude, limits);
  if (!second.complete) return { verified: false, reason: second.reason, roots };
  if (first.hash !== second.hash) return { verified: false, reason: 'files kept changing after the process tree stopped', roots };
  const changed = [...new Set([...Object.keys(before.entries), ...Object.keys(second.entries)])]
    .filter(file => JSON.stringify(before.entries[file]) !== JSON.stringify(second.entries[file])).sort();
  const visible = changed.filter(file => file !== '.');
  return { verified: true, outcome: changed.length ? 'applied' : 'not_applied', changed: visible.slice(0, 50), changedCount: visible.length,
    roots, beforeHash: before.hash, afterHash: second.hash, exitConfirmation: 'process-tree',
    note: changed.length ? 'The write scope changed; command effects may be partial and task acceptance is still required.' : 'Pre-dispatch and stable post-exit manifests agree; no filesystem change was observed.' };
}
