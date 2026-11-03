import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import type { Card } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';
import { normalizeFileScope } from '../runtime/scope.js';

/** Project metadata is read once when a session starts; later edits affect the next session. */
export function projectAgentAssets(workspace: string, parse: (source: string) => Card): { cards: Card[]; descriptions: Record<string, string>; roots: Record<string, string[]> } {
  const cards: Card[] = [];
  const descriptions: Record<string, string> = {};
  const roots: Record<string, string[]> = {};
  const base = path.join(workspace, '.kodo', 'agents');
  function read(file: string): string {
    const real = realpathSync(file);
    const relative = path.relative(workspace, real);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new KodoError('CARD_PATH', 'project agent assets must stay inside the workspace');
    if (statSync(real).size > 128_000) throw new KodoError('CARD_SIZE', 'project agent asset exceeds 128 KB');
    return readFileSync(real, 'utf8');
  }
  function visit(directory: string): void {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.isSymbolicLink()) throw new KodoError('CARD_PATH', 'project agent assets must be ordinary files and directories');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const source = read(file);
        if (entry.name === '_catalog.md') descriptions[path.relative(base, directory).split(path.sep).join('/')] = source.trim();
        else cards.push(parse(source));
      }
    }
  }
  visit(base);
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const file = path.join(workspace, name);
    let source: string;
    try { source = read(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
    if (header) {
      const document = parseDocument(header[1]!, { uniqueKeys: true });
      if (document.errors.length) throw new KodoError('PROJECT_METADATA', 'invalid project instruction front matter');
      const data = document.toJS({ maxAliasCount: 20 }) as { project?: Record<string, unknown> } | null;
      if (data?.project && typeof data.project === 'object') for (const [key, value] of Object.entries(data.project)) {
        if (!Array.isArray(value) || value.some(root => typeof root !== 'string')) throw new KodoError('PROJECT_METADATA', 'project variables must contain lists of relative path roots');
        roots[`project.${key}`] = normalizeFileScope({ write: value }).write!;
      }
    }
    break;
  }
  return { cards, descriptions, roots };
}
