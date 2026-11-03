import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Application } from '../application/index.js';
import type { Run } from '../runtime/types.js';
import { actualPath, canAccessFileScope } from '../runtime/scope.js';
import { digest } from '../storage/index.js';

const fileTools = ['file.read', 'image.read', 'file.list', 'file.search', 'file.apply_patch', 'file.patch', 'file.rename', 'file.delete', 'file.mkdir'];
const maxRuns = 128, maxCalls = 1000, maxPaths = 256;
const maxFileBytes = 16 * 1024 * 1024, maxTotalBytes = 64 * 1024 * 1024;
// Match the native file tools' protected names; only relative, readable paths leave this helper.
const protectedPart = (part: string): boolean => /^(?:\.git|\.kodo|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i.test(part);
const within = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const absent = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/**
 * Current bytes of explicitly recorded session paths, never a workspace inventory.
 * `complete` means every retained candidate was checked, not that all project files
 * were observed. Missing paths are versioned too; directories are never traversed.
 */
export async function captureVerificationFiles(app: Application, run: Run): Promise<{ stamp: string; paths: string[]; complete: boolean; note: string }> {
  const store = app.store, requester = store.run(run.id), session = store.session(requester.sessionId);
  const candidates = new Set<string>(), states: [string, string][] = [], paths: string[] = [];
  const issues = new Set<string>();
  const scopeNote = 'Covers current contents and absence of recorded session paths only. Directories are not checked recursively.';
  const result = () => ({ stamp: digest(JSON.stringify({ states, issues: [...issues].sort() })), paths, complete: issues.size === 0 && paths.length > 0, note: `${scopeNote}${issues.size ? ` Incomplete coverage: ${[...issues].sort().join('; ')}.` : paths.length ? ` Checked ${paths.length} paths.` : ' No recorded paths to check.'}` });
  if (!session.permissions.includes('read') || !(requester.permissions ?? session.permissions).includes('read')) {
    issues.add('Run has no read permission'); return result();
  }
  let workspace: string, privateRoot: string;
  try { workspace = actualPath(session.workspace); privateRoot = actualPath(store.directory); }
  catch { issues.add('Cannot resolve workspace and private data boundaries'); return result(); }
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || !value || value.length > 4096 || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) { issues.add('Some recorded paths are invalid'); return; }
    const target = path.resolve(workspace, value);
    if (candidates.has(target)) return;
    if (candidates.size >= maxPaths) { issues.add('Path count exceeds the limit'); return; }
    candidates.add(target);
  };
  const runs = store.runsPage({ sessionId: requester.sessionId, limit: maxRuns + 1 });
  if (runs.items.length > maxRuns || runs.next !== null) issues.add('Run count exceeds the limit');
  let remainingCalls = maxCalls;
  for (const owner of runs.items.slice(0, maxRuns)) {
    if (store.checkpoints.floor(owner.id) !== undefined) issues.add('Earlier file checkpoints have been pruned');
    for (const checkpoint of store.checkpoints.list(owner.id)) for (const file of Object.values(checkpoint.paths)) add(file);
    const filter = { kind: 'tool', name: fileTools, status: 'succeeded' };
    const count = store.countCalls(owner.id, filter);
    if (count > remainingCalls) issues.add('File call count exceeds the limit');
    if (remainingCalls === 0) continue;
    const calls = store.queryCalls(owner.id, { ...filter, limit: Math.min(remainingCalls, maxCalls) });
    remainingCalls -= calls.length;
    for (const call of calls) {
      try {
        const request = store.readBlob<{ arguments: string }>(call.requestRef);
        const args = JSON.parse(request.arguments) as { path?: unknown; destination?: unknown };
        add(args.path);
        if (call.name === 'file.rename') add(args.destination);
      } catch { issues.add('Some file call records cannot be read'); }
    }
  }
  let totalBytes = 0;
  for (const target of [...candidates].sort()) {
    let relative: string, resolved: string;
    try {
      relative = path.relative(workspace, target);
      resolved = actualPath(target);
      const resolvedRelative = path.relative(workspace, resolved);
      if (!within(workspace, target) || !within(workspace, resolved) || within(privateRoot, resolved) || relative.split(path.sep).some(protectedPart) || resolvedRelative.split(path.sep).some(protectedPart) || !canAccessFileScope(requester.scope, 'read', workspace, target)) {
        issues.add('Some records are outside the current read scope'); continue;
      }
      relative = relative.replaceAll('\\', '/') || '.';
    } catch { issues.add('Cannot confirm read scope for some paths'); continue; }
    paths.push(relative);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) { states.push([relative, 'directory']); issues.add('Recorded directories are not checked recursively'); continue; }
      if (!info.isFile()) { states.push([relative, 'unsupported']); issues.add('Records include non-regular files'); continue; }
      if (info.size > maxFileBytes || totalBytes + info.size > maxTotalBytes) { states.push([relative, 'limited']); issues.add('File size exceeds the verification limit'); continue; }
      handle = await open(resolved, 'r');
      const before = await handle.stat(), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      for (;;) {
        const read = await handle.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead; totalBytes += read.bytesRead;
        if (bytes > maxFileBytes || totalBytes > maxTotalBytes) throw new Error('verification byte limit');
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || info.dev !== after.dev || info.ino !== after.ino || actualPath(target) !== resolved) {
        states.push([relative, 'changed-during-read']); issues.add('File changed during verification'); continue;
      }
      states.push([relative, `file:${hash.digest('hex')}`]);
    } catch (error) {
      if (absent(error)) states.push([relative, 'absent']);
      else { states.push([relative, 'unreadable']); issues.add('Some files cannot be read completely'); }
    } finally {
      if (handle) {
        try { await handle.close(); }
        catch { issues.add('A file handle could not be closed'); }
      }
    }
  }
  return result();
}
