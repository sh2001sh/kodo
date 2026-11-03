import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { digest } from '../storage/index.js';

/** Per-directory instruction file: the first existing name wins, then the local overlay is added. */
const primaryNames = ['AGENTS.md', 'CLAUDE.md'] as const;
const localName = 'AGENTS.local.md';
/** Byte budget of one discovered chain (initial or one touch delta). */
export const chainBudgetBytes = 16 * 1024;
/** Share of the run's input capacity all loaded instructions may use. */
export const instructionCapacityShare = 0.10;
const maxIncludeDepth = 3;
const maxFileBytes = 256 * 1024;
export const globalLabel = 'global:AGENTS.md';

export interface InstructionSource { global?: string | false }
export interface InstructionFile { path: string; bytes: number; digest: string; includedBy?: string; truncated?: true; omitted?: true }
export interface InstructionChain { text: string; files: InstructionFile[]; notes: string[]; bytes: number }
export interface DiscoveryInput {
  workspace: string;
  /** Relative posix directories whose chain from the workspace root is loaded. */
  directories: string[];
  /** Load the global file, the workspace root files and unconditional rules. */
  includeRoot: boolean;
  /** Relative posix files; `.kodo/rules` entries whose `paths` match are loaded. */
  touched?: string[];
  /** Rule labels to load regardless of paths (inheritance). */
  rules?: string[];
  /** Card-declared workspace-relative rule files, loaded through the same bounded include loader. */
  cardRules?: string[];
  /** Labels already loaded by this run or its parent. */
  loaded: ReadonlySet<string>;
  global: string | false;
  maxBytes: number;
  /** Host opt-in; memory files use the same loader, ordering and total budget. */
  includeMemory?: boolean;
}

/** `$KODO_HOME/AGENTS.md`, otherwise `~/.kodo/AGENTS.md`. */
export function defaultGlobalInstructions(): string {
  return process.env.KODO_HOME ? path.join(process.env.KODO_HOME, 'AGENTS.md') : path.join(os.homedir(), '.kodo', 'AGENTS.md');
}

const compare = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
function inside(root: string, target: string): boolean {
  const relative = path.relative(compare(root), compare(target));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function isFile(file: string): boolean {
  try { return statSync(file).isFile(); } catch { return false; }
}
const posix = (value: string): string => value.split(path.sep).join('/');

/** Directories from the first component below the root down to `directory`, root excluded. */
export function directoryChain(directory: string): string[] {
  const parts = directory.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) return [];
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

interface Section { label: string; text: string }
interface Loader { workspaceReal: string; files: InstructionFile[]; notes: string[]; loaded: ReadonlySet<string> }

/** Reads one instruction file and expands `@relative/path` lines; every include must stay inside the workspace. */
function load(loader: Loader, file: string, label: string, depth: number, stack: string[], includedBy?: string): string | undefined {
  let real: string;
  try { real = realpathSync(file); } catch { loader.notes.push(`${label}: not readable`); return; }
  if (label !== globalLabel && !inside(loader.workspaceReal, real)) { loader.notes.push(`${label}: refused, resolves outside the workspace`); return; }
  if (stack.includes(compare(real))) { loader.notes.push(`${label}: include cycle skipped`); return; }
  const size = statSync(real).size;
  if (size > maxFileBytes) { loader.notes.push(`${label}: refused, larger than ${maxFileBytes} bytes`); return; }
  const text = readFileSync(real, 'utf8').replace(/^\uFEFF/, '');
  loader.files.push({ path: label, bytes: Buffer.byteLength(text), digest: digest(text), ...(includedBy ? { includedBy } : {}) });
  return text.split(/\r?\n/).map(line => {
    const match = /^@(\S+)\s*$/.exec(line.trim());
    if (!match) return line;
    const target = match[1]!;
    if (label === globalLabel || path.isAbsolute(target)) { loader.notes.push(`${label}: include ${target} refused, only workspace-relative includes are allowed`); return ''; }
    if (depth >= maxIncludeDepth) { loader.notes.push(`${label}: include ${target} skipped, depth limit ${maxIncludeDepth}`); return ''; }
    const resolved = path.resolve(path.dirname(real), target);
    if (!inside(loader.workspaceReal, resolved) || !isFile(resolved)) { loader.notes.push(`${label}: include ${target} refused or missing`); return ''; }
    const childLabel = posix(path.relative(loader.workspaceReal, resolved));
    return load(loader, resolved, childLabel, depth + 1, [...stack, compare(real)], label) ?? '';
  }).join('\n').trim();
}

function directoryCandidates(workspace: string, directory: string): { label: string; file: string }[] {
  const base = directory ? path.join(workspace, ...directory.split('/')) : workspace;
  const prefix = directory ? `${directory}/` : '';
  const primary = primaryNames.find(name => isFile(path.join(base, name)));
  return [...(primary ? [primary] : []), ...(isFile(path.join(base, localName)) ? [localName] : [])].map(name => ({ label: `${prefix}${name}`, file: path.join(base, name) }));
}

interface Rule { label: string; file: string; paths?: string[] }
function rules(workspace: string): Rule[] {
  const directory = path.join(workspace, '.kodo', 'rules');
  let names: string[];
  try { names = readdirSync(directory).filter(name => name.endsWith('.md')).sort(); } catch { return []; }
  return names.map(name => {
    const file = path.join(directory, name);
    const label = `.kodo/rules/${name}`;
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(isFile(file) ? readFileSync(file, 'utf8') : '');
    const data = match ? parseDocument(match[1]!).toJS() as { paths?: unknown } | null : null;
    const paths = Array.isArray(data?.paths) ? data.paths.filter((item): item is string => typeof item === 'string') : undefined;
    return { label, file, ...(paths?.length ? { paths } : {}) };
  });
}
const stripFrontmatter = (text: string): string => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

/** Truncate a UTF-8 string to at most `bytes` without splitting a character. */
function cut(text: string, bytes: number): string {
  return Buffer.from(text).subarray(0, Math.max(0, bytes)).toString('utf8').replace(/�+$/, '');
}

/**
 * Fit sections general→specific into the budget: nearer sections are kept
 * first; the first section that does not fit is cut, farther ones are omitted.
 */
function fit(sections: Section[], files: InstructionFile[], notes: string[], maxBytes: number): Section[] {
  const render = (section: Section): number => Buffer.byteLength(`### ${section.label}\n${section.text}\n\n`);
  let room = maxBytes;
  const kept: Section[] = [];
  for (const section of sections.toReversed()) {
    const size = render(section);
    const entry = files.find(file => file.path === section.label && !file.includedBy);
    if (size <= room) { kept.unshift(section); room -= size; continue; }
    if (room > 256) {
      kept.unshift({ label: section.label, text: cut(section.text, room - Buffer.byteLength(`### ${section.label}\n\n\n`) - 64) });
      notes.push(`${section.label}: truncated to the instruction budget`);
      if (entry) entry.truncated = true;
      room = 0;
      continue;
    }
    notes.push(`${section.label}: omitted, instruction budget exhausted`);
    if (entry) entry.omitted = true;
    room = 0;
  }
  return kept;
}

/** Discover and render project instructions; files in `loaded` are skipped. Never reads above the workspace. */
export function discoverInstructions(input: DiscoveryInput): InstructionChain {
  let workspaceReal: string;
  try { workspaceReal = realpathSync(input.workspace); } catch { return { text: '', files: [], notes: [], bytes: 0 }; }
  const loader: Loader = { workspaceReal, files: [], notes: [], loaded: input.loaded };
  const candidates: { label: string; file: string }[] = [];
  if (input.includeRoot && input.global && isFile(input.global)) candidates.push({ label: globalLabel, file: input.global });
  if (input.includeRoot) candidates.push(...directoryCandidates(input.workspace, ''));
  if (input.includeRoot && input.includeMemory) {
    const directory = path.join(input.workspace, '.kodo', 'memory');
    let names: string[] = [];
    try { names = readdirSync(directory).filter(name => name.endsWith('.md')).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') loader.notes.push('project memory could not be listed'); }
    for (const name of names) candidates.push({ label: `.kodo/memory/${name}`, file: path.join(directory, name) });
  }
  const available = rules(input.workspace);
  const touched = input.touched ?? [];
  for (const rule of available) {
    const always = !rule.paths && input.includeRoot;
    const inherited = input.rules?.includes(rule.label);
    const matched = rule.paths?.some(pattern => touched.some(file => path.posix.matchesGlob(compare(file), compare(pattern))));
    if (always || inherited || matched) candidates.push(rule);
  }
  // Given order is kept: inherited coverage first, then the run's own directories.
  for (const directory of new Set(input.directories.flatMap(directoryChain))) {
    candidates.push(...directoryCandidates(input.workspace, directory));
  }
  for (const rule of input.cardRules ?? []) {
    const label = path.posix.normalize(rule.replaceAll('\\', '/'));
    if (path.isAbsolute(rule) || /^[a-z]:/i.test(rule) || label === '..' || label.startsWith('../')) {
      loader.notes.push(`${rule}: card rule must be workspace-relative`);
      continue;
    }
    candidates.push({ label, file: path.resolve(input.workspace, label) });
  }
  const sections: Section[] = [];
  for (const candidate of candidates) {
    if (input.loaded.has(candidate.label) || sections.some(section => section.label === candidate.label)) continue;
    const text = load(loader, candidate.file, candidate.label, 0, []);
    if (text !== undefined) sections.push({ label: candidate.label, text: candidate.label.startsWith('.kodo/rules/') ? stripFrontmatter(text).trim() : text });
  }
  const header = 'Project instructions, ordered from general to specific; later sections take precedence on conflict. They constrain the method only.';
  const originalNotes = [...loader.notes];
  const limit = Math.max(0, input.maxBytes);
  let room = Math.max(0, limit - Buffer.byteLength(header) - 4);
  let text = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    loader.notes = [...originalNotes];
    for (const file of loader.files) { delete file.truncated; delete file.omitted; }
    const kept = fit(sections.filter(section => section.text), loader.files, loader.notes, room);
    const body = kept.map(section => `### ${section.label}\n${section.text}`).join('\n\n');
    const noteBudget = Math.max(0, Math.min(2048, Math.floor(limit / 4)));
    const notes = loader.notes.length ? cut(`Notes: ${loader.notes.join('; ')}.`, noteBudget) : '';
    text = body || notes ? [header, ...(body ? [body] : []), ...(notes ? [notes] : [])].join('\n\n') : '';
    const overflow = Buffer.byteLength(text) - limit;
    if (overflow <= 0) break;
    room = Math.max(0, room - overflow);
  }
  // Even a very small or exhausted total allowance cannot grow through notes.
  if (Buffer.byteLength(text) > limit) text = limit >= 64 ? cut('Project instruction budget exhausted; additional files omitted. See context.instructions_loaded for paths.', limit) : '';
  return { text, files: loader.files, notes: loader.notes, bytes: Buffer.byteLength(text) };
}

/** Digest a previously admitted source only inside its original boundary. */
export function instructionSourceDigest(workspace: string, label: string, global?: string): string | undefined {
  const file = label === globalLabel ? global : path.resolve(workspace, label);
  if (!file) return;
  try {
    const real = realpathSync(file);
    if (label !== globalLabel && !inside(realpathSync(workspace), real)) return;
    if (statSync(real).size > maxFileBytes) return;
    return digest(readFileSync(real, 'utf8').replace(/^\uFEFF/, ''));
  } catch { return; }
}
