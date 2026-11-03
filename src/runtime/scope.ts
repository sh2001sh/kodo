import { realpathSync } from 'node:fs';
import path from 'node:path';
import { KodoError } from './types.js';
import type { FileScope } from './types.js';

const permissions = ['read', 'write'] as const;
const compare = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const within = (root: string, target: string): boolean => {
  const relative = path.relative(compare(root), compare(target));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function canonicalRoot(root: string): string {
  if (typeof root !== 'string' || !root || root.length > 4096 || Array.from(root).some(character => character.charCodeAt(0) < 32) || /[<>:"|?*]/.test(root)) throw new KodoError('FILE_SCOPE', 'file scope roots must be valid relative paths');
  const value = root.replaceAll('\\', '/');
  if (value.startsWith('/') || /^[a-z]:/i.test(value)) throw new KodoError('FILE_SCOPE', `file scope root ${JSON.stringify(root)} must be relative to the workspace, for example "src" instead of an absolute path`);
  const components = value.split('/').filter(part => part !== '.' && part !== '');
  if (components.some(part => part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new KodoError('FILE_SCOPE', 'file scope roots cannot traverse parents or contain invalid Windows path segments');
  return components.join('/') || '.';
}

/** A missing permission list inherits; a child can only narrow its parent's roots. */
export function normalizeFileScope(scope: FileScope, parent?: FileScope): FileScope {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some(key => !permissions.includes(key as typeof permissions[number]))) throw new KodoError('FILE_SCOPE', 'file scope accepts only read and write root lists');
  const result: FileScope = {};
  for (const permission of permissions) {
    const inherited = parent?.[permission];
    const requested = scope[permission];
    if (requested !== undefined && !Array.isArray(requested)) throw new KodoError('FILE_SCOPE', 'file scope roots must be arrays');
    const roots = requested ?? inherited;
    if (roots === undefined) continue;
    const normalized = [...new Set(roots.map(canonicalRoot))];
    if (inherited !== undefined && normalized.some(root => !inherited.map(canonicalRoot).some(allowed => within(path.resolve(allowed), path.resolve(root))))) throw new KodoError('SCOPE_ESCALATION', `child ${permission} scope ${JSON.stringify(normalized)} must be contained in the parent ${permission} scope ${JSON.stringify(inherited)}`);
    result[permission] = normalized;
  }
  return result;
}

/** Intersect path roots, retaining the narrower root in every overlapping pair. */
export function intersectFileScopes(...scopes: (FileScope | undefined)[]): FileScope {
  const result: FileScope = {};
  for (const scope of scopes) {
    const normalized = normalizeFileScope(scope ?? {});
    for (const permission of permissions) {
      const roots = normalized[permission];
      if (roots === undefined) continue;
      const existing = result[permission];
      const intersection = existing === undefined ? roots : existing.flatMap(left => roots.flatMap(right => {
        if (within(path.resolve(left), path.resolve(right))) return [right];
        if (within(path.resolve(right), path.resolve(left))) return [left];
        return [];
      }));
      result[permission] = [...new Set(intersection)].filter((root, index, all) => !all.some((other, otherIndex) => otherIndex !== index && within(path.resolve(other), path.resolve(root)) && (otherIndex < index || !within(path.resolve(root), path.resolve(other))))).sort();
    }
  }
  return result;
}

/** Project variables represent complete root lists, never fragments or patterns. */
export function resolveScopeVariables(scope: FileScope | undefined, variables: Record<string, string[]> = {}): FileScope {
  const expanded: FileScope = {};
  for (const permission of permissions) {
    const roots = scope?.[permission];
    if (roots === undefined) continue;
    expanded[permission] = roots.flatMap(root => {
      const variable = /^\$\{(project\.[a-z][a-z0-9_.-]*)\}$/.exec(root);
      if (!variable) return [root];
      const value = variables[variable[1]!];
      if (!value?.length) throw new KodoError('CARD_UNAVAILABLE', `unresolved scope variable ${root}`);
      return value;
    });
  }
  return normalizeFileScope(expanded);
}

/** Resolve existing ancestors too, so a newly created descendant cannot bypass a symlink. */
export function actualPath(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try { return path.join(realpathSync(current), ...missing.reverse()); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function canAccessFileScope(scope: FileScope | undefined, permission: 'read' | 'write', workspace: string, resolvedPath: string, allowTraversal = false): boolean {
  const workspaceRoot = realpathSync(workspace);
  const target = actualPath(resolvedPath);
  if (!within(workspaceRoot, target)) return false;
  const roots = scope?.[permission];
  if (roots === undefined) return true;
  return roots.some(root => {
    const lexical = path.resolve(workspaceRoot, canonicalRoot(root));
    const actual = actualPath(lexical);
    // Both boundaries matter: a scoped root itself must not redirect to a sibling.
    if (!within(workspaceRoot, actual) || !within(lexical, actual)) return false;
    return (within(lexical, target) && within(actual, target)) || (allowTraversal && permission === 'read' && within(target, lexical) && within(target, actual));
  });
}

export function assertFileScope(scope: FileScope | undefined, permission: 'read' | 'write', workspace: string, resolvedPath: string): void {
  if (!canAccessFileScope(scope, permission, workspace, resolvedPath)) throw new KodoError('FILE_SCOPE', `path is outside this run's ${permission} scope`);
}

/**
 * Whether two write scopes can touch the same path. An omitted list is the whole
 * workspace and an empty list writes nothing; a directory overlaps the files under it.
 */
export function writeScopesOverlap(left: FileScope | undefined, right: FileScope | undefined): boolean {
  const roots = (scope: FileScope | undefined): string[] => scope?.write === undefined ? ['.'] : scope.write.map(canonicalRoot);
  const resolve = (root: string): string => path.resolve('/', root);
  return roots(left).some(a => roots(right).some(b => within(resolve(a), resolve(b)) || within(resolve(b), resolve(a))));
}
