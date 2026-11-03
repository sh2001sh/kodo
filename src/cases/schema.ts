import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { KodoError } from '../runtime/types.js';

export interface CaseFile { path: string; content: string }
export type CaseAssertion =
  | { type: 'file'; path: string; exists?: boolean; equals?: string; sha256?: string }
  | { type: 'json'; source: 'output' | 'file'; path?: string; pointer: string; equals: unknown }
  | { type: 'output'; equals: string }
  | { type: 'command'; command: string; exitCode: number; stdout?: string };
export interface CaseDefinition {
  schema_version: 1; id: string; version: string; name: string;
  objective: string; inputs: { files: CaseFile[]; data?: unknown };
  assertions: CaseAssertion[]; timeoutMs?: number;
}
export interface FrozenCase { definition: CaseDefinition; digest: string; inputDigest: string }
const text = { type: 'string', maxLength: 1_000_000 };
const assertion = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required });
const validate = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'id', 'version', 'name', 'objective', 'inputs', 'assertions'],
  properties: {
    schema_version: { const: 1 }, id: { type: 'string', pattern: '^[a-z0-9][a-z0-9/-]{0,159}$' },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' }, name: { type: 'string', minLength: 1, maxLength: 200 },
    objective: { type: 'string', minLength: 1, maxLength: 32000 }, timeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
    inputs: { type: 'object', additionalProperties: false, required: ['files'], properties: {
      files: { type: 'array', maxItems: 100, items: assertion({ path: { type: 'string', minLength: 1, maxLength: 1024 }, content: text }, ['path', 'content']) }, data: {},
    } },
    assertions: { type: 'array', minItems: 1, maxItems: 100, items: { oneOf: [
      assertion({ type: { const: 'file' }, path: text, exists: { type: 'boolean' }, equals: text, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['type', 'path']),
      assertion({ type: { const: 'json' }, source: { enum: ['output', 'file'] }, path: text, pointer: { type: 'string', maxLength: 1024 }, equals: {} }, ['type', 'source', 'pointer', 'equals']),
      assertion({ type: { const: 'output' }, equals: text }, ['type', 'equals']),
      assertion({ type: { const: 'command' }, command: { type: 'string', pattern: '^[a-zA-Z0-9_.-]{1,100}$' }, exitCode: { type: 'integer', minimum: 0, maximum: 255 }, stdout: text }, ['type', 'command', 'exitCode']),
    ] } },
  },
});
/** Canonical JSON identities do not depend on object insertion order. */
export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown, depth = 0): unknown => {
    if (depth > 64) throw new KodoError('CASE_BOUNDS', 'case JSON nesting exceeds 64 levels');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map(item => normalize(item, depth + 1));
    if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) return Object.fromEntries(Object.keys(input).sort().map(key => [key, normalize((input as Record<string, unknown>)[key], depth + 1)]));
    throw new KodoError('CASE_SCHEMA', 'case evidence must contain only JSON values');
  };
  return JSON.stringify(normalize(value));
}
export const caseDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function casePath(value: string): string {
  if (!value || value.length > 1024 || Array.from(value).some(character => character.charCodeAt(0) < 32) || value.includes('\\') || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new KodoError('CASE_PATH', 'case paths must be portable relative file paths without traversal');
  return value;
}
function freeze(value: unknown): void { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
export function freezeCase(input: unknown): FrozenCase {
  const serialized = canonicalJson(input);
  if (Buffer.byteLength(serialized) > 4_000_000) throw new KodoError('CASE_SCHEMA', 'case exceeds 4 MB');
  const definition: unknown = JSON.parse(serialized);
  if (!validate(definition)) throw new KodoError('CASE_SCHEMA', 'invalid case definition');
  const parsed = definition as CaseDefinition;
  const files = new Set<string>();
  for (const file of parsed.inputs.files) { const key = casePath(file.path).toLowerCase(); if (files.has(key)) throw new KodoError('CASE_PATH', 'case input paths must be unique across platforms'); files.add(key); }
  for (const check of parsed.assertions) {
    if (check.type === 'file') { casePath(check.path); if (check.exists === false && (check.equals !== undefined || check.sha256 !== undefined)) throw new KodoError('CASE_SCHEMA', 'missing-file assertions cannot also compare content'); }
    if (check.type === 'json') {
      if ((check.source === 'file') !== (check.path !== undefined)) throw new KodoError('CASE_SCHEMA', 'JSON file assertions require a path and output assertions forbid it');
      if (check.path !== undefined) casePath(check.path);
      if (check.pointer !== '' && (!check.pointer.startsWith('/') || /~(?:[^01]|$)/.test(check.pointer))) throw new KodoError('CASE_SCHEMA', 'JSON pointer must follow RFC 6901');
    }
  }
  const result = { definition: parsed, digest: caseDigest(parsed), inputDigest: caseDigest(parsed.inputs) };
  freeze(result); return result;
}
