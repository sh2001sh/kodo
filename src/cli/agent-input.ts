import { KodoError } from '../runtime/types.js';
import type { FileScope } from '../runtime/types.js';

/** Text values stay text; JSON strings/arrays support path slots without comma ambiguity. */
export function parseAgentSlots(declarations: string[] = []): Record<string, string | string[]> {
  const slots: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  for (const declaration of declarations) {
    const split = declaration.indexOf('=');
    const key = declaration.slice(0, split);
    const raw = declaration.slice(split + 1);
    if (split < 1 || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) || !raw.trim() || Object.hasOwn(slots, key)) throw new KodoError('ARGUMENTS', '--slot requires a unique name=value');
    let value: unknown = raw;
    if (/^["[]/.test(raw.trim())) {
      try { value = JSON.parse(raw); } catch { throw new KodoError('ARGUMENTS', '--slot JSON must be a string or array of paths'); }
    }
    if (!(typeof value === 'string' && value.trim()) && !(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.trim()))) throw new KodoError('ARGUMENTS', '--slot must contain nonempty text or a nonempty array of paths');
    slots[key] = value as string | string[];
  }
  return slots;
}

export function parseAgentScope(raw: string | undefined): FileScope | undefined {
  if (raw === undefined) return;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new KodoError('ARGUMENTS', '--scope must be a JSON object containing read/write path-root arrays'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([key, roots]) => !['read', 'write'].includes(key) || !Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !root))) throw new KodoError('ARGUMENTS', '--scope must be a JSON object containing read/write path-root arrays');
  return value as FileScope;
}
