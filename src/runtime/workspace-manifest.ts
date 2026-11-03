import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { KodoError } from './types.js';
import { git, protectedPath } from './execution-workspace.js';

export type FileMode = '100644' | '100755';
/** One snapshot file: content sha256 (`hash`), Git object id (`blob`), and the stat used for external-change rechecks. */
export interface ManifestEntry { path: string; mode: FileMode | '120000'; hash: string; blob: string; size: number; mtimeMs: number; linkTarget?: string }
export interface WorkspaceManifest { entries: ManifestEntry[]; excluded: number; digest: string }

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** Tracked plus unignored untracked paths, minus protected paths, which never reach the index or object database. */
function snapshotPaths(root: string): { files: string[]; excluded: number } {
  const listed = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
  const files = listed.filter(file => !protectedPath(file)).sort();
  return { files, excluded: listed.length - files.length };
}

export function indexModes(root: string): Map<string, string> {
  const modes = new Map<string, string>();
  for (const line of git(root, ['ls-files', '-s', '-z']).split('\0')) {
    const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/su.exec(line);
    if (match) modes.set(match[2]!, match[1]!);
  }
  return modes;
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

/** Preserve relative links within the ordinary workspace; never copy their target's bytes as the link. */
function snapshotLink(root: string, file: string): string {
  const target = readlinkSync(path.join(root, file));
  const relative = (absolute: string): string => path.relative(root, absolute).split(path.sep).join('/');
  const permitted = (value: string): boolean => value !== '..' && !value.startsWith('../') && !path.isAbsolute(value) && !protectedPath(value);
  if (path.isAbsolute(target) || !permitted(relative(path.resolve(root, path.dirname(file), target)))) throw new KodoError('EXECUTION_FILE', `snapshot link must remain in the ordinary workspace: ${file}`);
  let resolved: string;
  try { resolved = relative(realpathSync(path.join(root, file))); }
  catch { throw new KodoError('EXECUTION_FILE', `snapshot link target must exist and resolve without a cycle: ${file}`); }
  if (!permitted(resolved)) throw new KodoError('EXECUTION_FILE', `snapshot link must resolve in the ordinary workspace: ${file}`);
  return target;
}

/** Hash regular files and internal relative links; its digest is the workspace version (6.6). */
export function workspaceManifest(root: string): WorkspaceManifest {
  const { files, excluded } = snapshotPaths(root);
  // Windows has no executable bit; the index records the mode the user's Git tracks.
  const modes = process.platform === 'win32' ? indexModes(root) : undefined;
  const format = git(root, ['rev-parse', '--show-object-format']).trim() === 'sha256' ? 'sha256' : 'sha1';
  const entries: ManifestEntry[] = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    let stat;
    try { stat = lstatSync(absolute); } catch (error) { if (missing(error)) continue; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new KodoError('EXECUTION_FILE', `snapshot supports regular files and internal relative links only: ${file}`);
    if (/[\r\n]/u.test(file)) throw new KodoError('EXECUTION_FILE', `snapshot cannot represent a path containing a line break: ${JSON.stringify(file)}`);
    const linkTarget = stat.isSymbolicLink() ? snapshotLink(root, file) : undefined;
    const content = linkTarget === undefined ? readFileSync(absolute) : Buffer.from(linkTarget);
    const mode = linkTarget !== undefined ? '120000' : modes ? (modes.get(file) === '100755' ? '100755' : '100644') : (stat.mode & 0o100 ? '100755' : '100644');
    const blob = createHash(format).update(`blob ${content.length}\0`).update(content).digest('hex');
    entries.push({ path: file, mode, hash: sha256(content), blob, size: stat.size, mtimeMs: stat.mtimeMs, ...(linkTarget !== undefined ? { linkTarget } : {}) });
  }
  return { entries, excluded, digest: sha256(entries.map(entry => `${entry.mode} ${entry.hash} ${entry.path}\n`).join('')) };
}
