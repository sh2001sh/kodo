import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { BigIntStats } from 'node:fs';
import { digest } from '../storage/index.js';
import type { Store } from '../storage/index.js';
import type { CheckpointState } from '../storage/checkpoints.js';
import { KodoError } from '../runtime/types.js';
import type { Call, ToolRecoveryCheck, ToolRecoveryVerifier, ToolRequest } from '../runtime/types.js';

export const nativeRecoveryNames = ['file.patch', 'file.apply_patch', 'file.mkdir', 'file.rename', 'file.delete'] as const;
type NativeName = typeof nativeRecoveryNames[number];
type Identity = { device: string; inode: string; birth: string; modified: string; changed: string };
type FileState = { kind: 'absent' } | { kind: 'file'; hash: string; bytes: number; identity: Identity } | { kind: 'directory' | 'other'; identity: Identity };
type States = { path: FileState; destination?: FileState };
type SavedBody = { bytes: Buffer; mode: number };
interface Preparation {
  id: string; callId: string; runId: string; requestRef: string; attempt: number; name: NativeName; argsDigest: string;
  paths: { path: string; destination?: string }; before: States; afterHash?: string; bytes?: number;
}
interface Completion { preparationId: string; callId: string; requestRef: string; attempt: number; after: States; result: unknown }
export interface NativePreparationToken { readonly preparation: Preparation }
export interface NativePreparationOptions { beforeHash?: string | null; afterHash?: string; bytes?: number }
const preparedType = 'file.recovery.prepared';
const completedType = 'file.recovery.completed';
const isNative = (name: string): name is NativeName => nativeRecoveryNames.includes(name as NativeName);
const samePath = (left: string, right: string): boolean => path.relative(left, right) === '';
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
const argsDigest = (args: unknown): string => digest(JSON.stringify(canonical(args)));
const identity = (info: BigIntStats): Identity => ({ device: info.dev.toString(), inode: info.ino.toString(), birth: info.birthtimeNs.toString(), modified: info.mtimeNs.toString(), changed: info.ctimeNs.toString() });
const sameState = (left: FileState, right: FileState): boolean => JSON.stringify(left) === JSON.stringify(right);

async function snapshot(file: string, signal?: AbortSignal, bodies?: Map<string, SavedBody>): Promise<FileState> {
  signal?.throwIfAborted();
  let info: BigIntStats;
  try { info = await lstat(file, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }; throw error; }
  if (info.isSymbolicLink()) throw new KodoError('RECOVERY_PATH', 'recovery evidence cannot follow a symbolic link');
  if (!info.isFile()) return { kind: info.isDirectory() ? 'directory' : 'other', identity: identity(info) };
  if (info.size > 16n * 1024n * 1024n) throw new KodoError('RECOVERY_LIMIT', 'native recovery files cannot exceed 16 MiB');
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024, ...(signal ? { signal } : {}) })) {
    signal?.throwIfAborted();
    bytes += (chunk as Buffer).length;
    if (bytes > 16 * 1024 * 1024) throw new KodoError('RECOVERY_LIMIT', 'native recovery file grew beyond 16 MiB');
    hash.update(chunk as Buffer);
    if (bodies) chunks.push(chunk as Buffer);
  }
  const after = await lstat(file, { bigint: true });
  if (!after.isFile() || JSON.stringify(identity(info)) !== JSON.stringify(identity(after)) || after.size !== BigInt(bytes) || info.size !== after.size) throw new KodoError('RECOVERY_RACE', 'file changed while reading native recovery evidence');
  signal?.throwIfAborted();
  if (bodies) bodies.set(file, { bytes: Buffer.concat(chunks), mode: Number(after.mode) & 0o777 });
  return { kind: 'file', hash: hash.digest('hex'), bytes, identity: identity(after) };
}
async function snapshots(paths: Preparation['paths'], signal?: AbortSignal, bodies?: Map<string, SavedBody>): Promise<States> {
  const source = await snapshot(paths.path, signal, bodies);
  const destination = paths.destination ? await snapshot(paths.destination, signal, bodies) : undefined;
  // Recheck the source after reading a destination to catch a concurrent multi-path change.
  if (destination && !sameState(source, await snapshot(paths.path, signal))) throw new KodoError('RECOVERY_RACE', 'source changed while reading the destination evidence');
  return { path: source, ...(destination ? { destination } : {}) };
}

/** Checkpoint bodies live only in the retained table, not in permanent receipt events. */
function checkpointStates(store: Store, paths: Preparation['paths'], states: States, bodies?: Map<string, SavedBody>): Record<string, CheckpointState> {
  const result: Record<string, CheckpointState> = {};
  for (const [key, file] of Object.entries(paths)) {
    const state = states[key as keyof States];
    if (!state) continue;
    if (state.kind === 'other') throw new KodoError('CHECKPOINT_TYPE', 'native checkpoints support only files and directories');
    const body = bodies?.get(file);
    result[key] = state.kind === 'file'
      ? { kind: 'file', hash: state.hash, bytes: state.bytes, ...(body ? { contentRef: store.blob({ encoding: 'base64', content: body.bytes.toString('base64') }), mode: body.mode } : {}) }
      : { kind: state.kind };
  }
  return result;
}
function latestAttempt(store: Store, runId: string, callId: string): number {
  return store.latestEvent(runId, { types: ['tool.started'], match: { callId } })?.seq ?? 0;
}
function activeCall(store: Store, runId: string, name: NativeName, args: Record<string, unknown>): Call | undefined {
  const modelId = store.run(runId).stepCallId;
  if (!modelId) return;
  return store.calls(runId).findLast(call => {
    if (call.kind !== 'tool' || call.name !== name || call.status !== 'running' || !call.id.startsWith(`${modelId}:`)) return false;
    const request = store.readBlob<ToolRequest>(call.requestRef);
    return request.name === name && argsDigest(JSON.parse(request.arguments) as unknown) === argsDigest(args);
  });
}

/** Persist preconditions before IO. Direct host tool calls without a durable Call need no receipt. */
export async function recordNativePreparation(store: Store, runId: string, name: string, args: Record<string, unknown>, paths: { path: string; destination?: string }, options: NativePreparationOptions = {}, signal?: AbortSignal): Promise<NativePreparationToken | undefined> {
  if (!isNative(name)) return;
  const call = activeCall(store, runId, name, args);
  if (!call) return;
  const bodies = new Map<string, SavedBody>();
  const before = await snapshots(paths, signal, bodies);
  const expected = options.beforeHash ?? args.expectedHash;
  const creating = name === 'file.mkdir' || (name === 'file.apply_patch' && options.beforeHash === null);
  if (creating ? before.path.kind !== 'absent' : before.path.kind !== 'file' || before.path.hash !== expected) throw new KodoError('FILE_CONFLICT', 'native recovery preconditions changed before mutation');
  if (name === 'file.rename' && before.destination?.kind !== 'absent') throw new KodoError('FILE_CONFLICT', 'rename destination changed before mutation');
  if (['file.patch', 'file.apply_patch'].includes(name) && (!options.afterHash || !/^[a-f0-9]{64}$/.test(options.afterHash))) throw new KodoError('RECOVERY_PREPARATION', 'patch recovery requires the computed result hash');
  signal?.throwIfAborted();
  const preparation: Preparation = { id: randomUUID(), callId: call.id, runId, requestRef: call.requestRef, attempt: latestAttempt(store, runId, call.id), name, argsDigest: argsDigest(args), paths: structuredClone(paths), before, ...(options.afterHash ? { afterHash: options.afterHash } : {}), ...(options.bytes !== undefined ? { bytes: options.bytes } : {}) };
  store.transaction(() => {
    const current = store.call(call.id);
    if (current.status !== 'running' || current.requestRef !== call.requestRef || latestAttempt(store, runId, call.id) !== preparation.attempt) throw new KodoError('RECOVERY_CHANGED', 'native tool attempt changed before preparing its effect');
    store.checkpoints.put({ id: preparation.id, runId, step: store.run(runId).step, preparationId: preparation.id, paths: { ...paths }, before: checkpointStates(store, paths, before, bodies) });
    store.event(runId, preparedType, { ...preparation });
  });
  return { preparation };
}

/** Called only after every mutation succeeds; failure must leave the call uncertain. */
export async function recordNativeCompletion(store: Store, token: NativePreparationToken | undefined, result: unknown): Promise<void> {
  if (!token) return;
  try {
    const preparation = token.preparation;
    const after = await snapshots(preparation.paths);
    const completion: Completion = { preparationId: preparation.id, callId: preparation.callId, requestRef: preparation.requestRef, attempt: preparation.attempt, after, result: structuredClone(result) };
    store.transaction(() => {
      store.checkpoints.complete(preparation.id, checkpointStates(store, preparation.paths, after));
      store.event(preparation.runId, completedType, { ...completion });
    });
  } catch (error) {
    // A known syscall success followed by a failed receipt is never a known failed mutation.
    throw new Error('Native file mutation completed but its durable recovery receipt could not be recorded.', { cause: error });
  }
}

const describe = (state: FileState): string => state.kind === 'file' ? `file SHA-256 ${state.hash}, ${state.bytes} bytes, inode ${state.identity.device}:${state.identity.inode}` : state.kind;
const matchesExpectedAfter = (preparation: Preparation, current: States): boolean => {
  switch (preparation.name) {
    case 'file.patch':
    case 'file.apply_patch': return current.path.kind === 'file' && current.path.hash === preparation.afterHash;
    case 'file.mkdir': return current.path.kind === 'directory';
    case 'file.delete': return current.path.kind === 'absent';
    case 'file.rename': return current.path.kind === 'absent' && current.destination?.kind === 'file' && preparation.before.path.kind === 'file' && current.destination.hash === preparation.before.path.hash && current.destination.identity.device === preparation.before.path.identity.device && current.destination.identity.inode === preparation.before.path.identity.inode && current.destination.identity.birth === preparation.before.path.identity.birth;
  }
};

/** Caller owns the workspace write lock and validates current capabilities and file scopes. */
export async function probeNativeRecovery(store: Store, input: Parameters<ToolRecoveryVerifier>[0], resolvePath: (input: string) => Promise<string>): Promise<ToolRecoveryCheck> {
  const { run, call, request, signal } = input;
  signal.throwIfAborted();
  if (!isNative(call.name) || request.name !== call.name || call.runId !== run.id) throw new KodoError('RECOVERY_REQUEST', 'native recovery request does not match its owned call');
  const args = JSON.parse(request.arguments) as Record<string, unknown>;
  const attempt = latestAttempt(store, run.id, call.id);
  const prepared = store.latestEvent(run.id, { types: [preparedType], match: { callId: call.id, attempt, requestRef: call.requestRef } });
  if (!prepared) return { outcome: 'unknown', evidence: 'No preparation evidence exists for this native file operation and attempt; its effect cannot be established automatically.' };
  const preparation = prepared.data as unknown as Preparation;
  if (preparation.argsDigest !== argsDigest(args) || preparation.name !== call.name || preparation.runId !== run.id) throw new KodoError('RECOVERY_REQUEST', 'native preparation evidence does not match the immutable request');
  const paths = { path: await resolvePath(args.path as string), ...(call.name === 'file.rename' ? { destination: await resolvePath(args.destination as string) } : {}) };
  if (!samePath(paths.path, preparation.paths.path) || (paths.destination !== undefined && (!preparation.paths.destination || !samePath(paths.destination, preparation.paths.destination)))) return { outcome: 'unknown', evidence: 'Canonical file locations changed since preparation; native effects cannot be resolved across changed links or workspace paths.' };
  const current = await snapshots(paths, signal);
  const evidence = `Verified ${call.name} attempt ${attempt}: source is ${describe(current.path)}${current.destination ? `; destination is ${describe(current.destination)}` : ''}.`;
  const receiptEvent = store.latestEvent(run.id, { types: [completedType], match: { preparationId: preparation.id } });
  if (receiptEvent) {
    const receipt = receiptEvent.data as unknown as Completion;
    if (receipt.callId !== call.id || receipt.requestRef !== call.requestRef || receipt.attempt !== attempt) throw new KodoError('RECOVERY_REQUEST', 'native completion receipt belongs to a different attempt');
    if (matchesExpectedAfter(preparation, current) && sameState(current.path, receipt.after.path) && (current.destination === undefined || (receipt.after.destination !== undefined && sameState(current.destination, receipt.after.destination)))) return { outcome: 'succeeded', evidence: `${evidence} A committed completion receipt matches the current state.`, result: receipt.result };
    return { outcome: 'unknown', evidence: `${evidence} A completion receipt exists but current state diverged; replay is not authorized.` };
  }
  // Patches have deterministic desired content; like apply_patch, matching that complete state is sufficient.
  if (['file.patch', 'file.apply_patch'].includes(preparation.name) && matchesExpectedAfter(preparation, current)) return { outcome: 'succeeded', evidence: `${evidence} Current content matches the complete computed patch result recorded before mutation.`, result: { path: args.path, hash: preparation.afterHash, bytes: current.path.kind === 'file' ? current.path.bytes : 0, recovery: { verified: true } } };
  if (sameState(current.path, preparation.before.path) && (current.destination === undefined || (preparation.before.destination !== undefined && sameState(current.destination, preparation.before.destination)))) return { outcome: 'not_applied', evidence: `${evidence} Exact prepared state and file identity remain unchanged; a controlled retry is safe.` };
  return { outcome: 'unknown', evidence: `${evidence} No completion receipt establishes the full mutation; changed or partial state remains blocked.` };
}
