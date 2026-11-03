import { readdir } from 'node:fs/promises';
import path from 'node:path';

const maxSuggestions = 3;
const maxScannedEntries = 2_000;

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

function score(wanted: string, candidate: string): number {
  const a = wanted.toLowerCase();
  const b = candidate.toLowerCase();
  if (a === b) return 0;
  const stemA = a.replace(/\.[^.]+$/, '');
  const stemB = b.replace(/\.[^.]+$/, '');
  if (stemA === stemB) return 1;
  if (b.startsWith(stemA) || a.startsWith(stemB)) return 2;
  return 3 + editDistance(a, b);
}

/**
 * Finds up to three existing workspace-relative paths that resemble a missing input path.
 * It walks up to the nearest existing ancestor directory and ranks that directory's entries by name similarity.
 */
export async function similarPaths(workspace: string, input: string, hidden: (part: string) => boolean): Promise<string[]> {
  const parts = input.replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
  const wanted = parts.at(-1);
  if (!wanted) return [];
  for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
    const directory = path.join(workspace, ...parts.slice(0, depth));
    let names: string[];
    try { names = (await readdir(directory)).slice(0, maxScannedEntries); }
    catch { continue; }
    const target = parts[depth]!;
    const limit = Math.max(2, Math.floor(target.length / 2));
    const ranked = names
      .filter(name => !hidden(name))
      .map(name => ({ name, rank: score(target, name) }))
      .filter(entry => entry.rank < 3 + limit)
      .sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name))
      .slice(0, maxSuggestions);
    return ranked.map(entry => [...parts.slice(0, depth), entry.name].join('/'));
  }
  return [];
}
