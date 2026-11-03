import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const BASE_SHA = '3713ce8d4bc50db655837bb1dd79550df24219fc';
export const PR_HEAD_SHA = 'd96ff8add845cbd1db99249cde1747ac71df9af6';
export const MERGE_SHA = 'c20d7c78da256a89d56138e9091d0253b83cde99';

const allowed = new Set(['source', 'test', 'readme.md', 'DELIVERY.md']);
const derived = new Set(['distribution', 'node_modules']);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function seedWorkspace(fixtureRoot, dependencyRoot, workspace) {
  if (existsSync(workspace)) throw new Error(`workspace already exists: ${workspace}`);
  mkdirSync(workspace, { recursive: true });
  for (const entry of readdirSync(fixtureRoot, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'distribution' || entry.name === '.git') continue;
    cpSync(path.join(fixtureRoot, entry.name), path.join(workspace, entry.name), { recursive: true, errorOnExist: true });
  }
  cpSync(dependencyRoot, path.join(workspace, 'node_modules'), { recursive: true, errorOnExist: true });
}

function walk(root, relative, files) {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const next = relative ? path.posix.join(relative, entry.name) : entry.name;
    const top = next.split('/')[0];
    if (allowed.has(top) || derived.has(top) || top === '.git') continue;
    if (entry.isDirectory()) walk(root, next, files);
    else if (entry.isFile()) files[next] = sha256(readFileSync(path.join(root, next)));
    else files[next] = `UNSUPPORTED:${entry.isSymbolicLink() ? 'link' : 'special'}`;
  }
}

/** Protect every task file except the declared editable and derived paths. */
export function protectedSnapshot(workspace) {
  const files = {};
  walk(workspace, '', files);
  return { files, missing: [] };
}

export function taskTreeDigest(root) {
  const files = {};
  const visit = relative => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const next = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'distribution') continue;
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile()) files[next] = sha256(readFileSync(path.join(root, next)));
    }
  };
  visit('');
  return sha256(JSON.stringify(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))));
}

export function directoryBytes(root) {
  let bytes = 0;
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) bytes += statSync(target).size;
    }
  };
  visit(root);
  return bytes;
}
