import { Ajv } from 'ajv';
import { KodoError } from '../runtime/types.js';
import type { Card, Permission } from '../runtime/types.js';

export const PACKAGE_MANIFEST = 'CAPABILITY.json';
export const PACKAGE_LIMITS = Object.freeze({ files: 2048, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, archiveBytes: 32 * 1024 * 1024, manifestBytes: 1024 * 1024 });
export interface PackageFile { path: string; sha256: string; size: number; distributable: true }
export interface PackageToolPolicy { permission: Permission; effect: 'read' | 'write'; description?: string; version?: string }
export interface PackageSkill { id: string; entry: string; files?: string[] }
export interface PackageTool { name: string; descriptor: string; entry: string; files?: string[] }
interface PackageMcpBase { id: string; tools: Record<string, PackageToolPolicy> }
export type PackageMcp = PackageMcpBase & ({ transport: 'stdio'; entry: string; args?: string[]; env?: Record<string, { env: string }>; files?: string[] } | { transport: 'http'; url: string; headers?: Record<string, { env: string }> });
export interface PackageManifest {
  schema_version: 1;
  license: string;
  source: { url: string; revision?: string };
  files: PackageFile[];
  resources?: { skills?: PackageSkill[]; tools?: PackageTool[]; mcp?: PackageMcp[] };
  requirements?: { node?: string; platforms?: string[]; arch?: string[]; dependencies?: Record<string, string> };
  examples?: { name: string; input: string; expected?: string }[];
}
export type PackageDeclaration = Omit<PackageManifest, 'files'> & { files: (Pick<PackageFile, 'path' | 'distributable'> & Partial<Pick<PackageFile, 'size' | 'sha256'>>)[] };
export interface PackageInspection { manifest: PackageManifest; card: Card; digest: string; bytes: number }
export interface InstalledPackage extends PackageInspection { root: string }

const text = { type: 'string', minLength: 1, maxLength: 2000 };
const fileRef = { type: 'string', minLength: 1, maxLength: 240 };
const refs = { type: 'array', uniqueItems: true, maxItems: PACKAGE_LIMITS.files, items: fileRef };
const environment = { type: 'object', maxProperties: 100, propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, additionalProperties: { type: 'object', additionalProperties: false, required: ['env'], properties: { env: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', maxLength: 200 } } } };
const policies = { type: 'object', maxProperties: 128, propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_.-]{0,63}$' }, additionalProperties: { type: 'object', additionalProperties: false, required: ['permission', 'effect'], properties: { permission: { enum: ['read', 'write', 'exec'] }, effect: { enum: ['read', 'write'] }, description: text, version: { type: 'string', minLength: 1, maxLength: 200 } } } };
const validate = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false, required: ['schema_version', 'license', 'source', 'files'],
  properties: {
    schema_version: { const: 1 }, license: { type: 'string', minLength: 1, maxLength: 200 },
    source: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: text, revision: { type: 'string', minLength: 1, maxLength: 200 } } },
    files: { type: 'array', minItems: 1, maxItems: PACKAGE_LIMITS.files, items: { type: 'object', additionalProperties: false, required: ['path', 'sha256', 'size', 'distributable'], properties: { path: fileRef, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, size: { type: 'integer', minimum: 0, maximum: PACKAGE_LIMITS.fileBytes }, distributable: { const: true } } } },
    resources: { type: 'object', additionalProperties: false, properties: {
      skills: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['id', 'entry'], properties: { id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*(?:/[a-z0-9][a-z0-9-]*)?$', maxLength: 100 }, entry: fileRef, files: refs } } },
      tools: { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: false, required: ['name', 'descriptor', 'entry'], properties: { name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.-]{0,63}$' }, descriptor: fileRef, entry: fileRef, files: refs } } },
      mcp: { type: 'array', maxItems: 64, items: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['id', 'transport', 'entry', 'tools'], properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,19}$' }, transport: { const: 'stdio' }, entry: fileRef, args: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 2000 } }, env: environment, tools: policies, files: refs } },
        { type: 'object', additionalProperties: false, required: ['id', 'transport', 'url', 'tools'], properties: { id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,19}$' }, transport: { const: 'http' }, url: text, headers: { ...environment, propertyNames: { pattern: '^[A-Za-z0-9-]+$' } }, tools: policies } },
      ] } },
    } },
    requirements: { type: 'object', additionalProperties: false, properties: { node: { type: 'string', minLength: 1, maxLength: 200 }, platforms: { type: 'array', uniqueItems: true, minItems: 1, maxItems: 20, items: { type: 'string', pattern: '^[a-z0-9_-]+$', maxLength: 30 } }, arch: { type: 'array', uniqueItems: true, minItems: 1, maxItems: 20, items: { type: 'string', pattern: '^[a-z0-9_-]+$', maxLength: 30 } }, dependencies: { type: 'object', maxProperties: 100, propertyNames: { pattern: '^(?:@[a-z0-9._-]+/)?[a-z0-9][a-z0-9._-]*$' }, additionalProperties: { type: 'string', minLength: 1, maxLength: 200 } } } },
    examples: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['name', 'input'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, input: { type: 'string', minLength: 1, maxLength: 16000 }, expected: { type: 'string', maxLength: 16000 } } } },
  },
});

export function packageError(message: string): KodoError { return new KodoError('PACKAGE_INVALID', message); }
export function validatePackagePath(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 240 || value.normalize('NFC') !== value || Buffer.from(value, 'utf8').toString('utf8') !== value || /[\\:]/.test(value) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || value.startsWith('/') || value.endsWith('/')) throw packageError('package paths must be portable relative paths');
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /[<>"|?*]/.test(part) || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)) throw packageError('package path contains a reserved or unsafe component');
    if (/^(?:\.git|\.hg|\.svn|node_modules|\.kodo|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.pypirc|\.netrc|credentials?|id_(?:rsa|dsa|ecdsa|ed25519)|\.env(?:\..*)?)$/i.test(part) || /\.(?:key|p12|pfx|kdbx)$/i.test(part)) throw packageError('private configuration or credentials cannot be distributed');
  }
}
export function assertManifest(value: unknown): asserts value is PackageManifest {
  if (!validate(value)) throw packageError('unsupported or invalid capability manifest');
  const manifest = value as PackageManifest;
  try { const source = new URL(manifest.source.url); if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password || source.search) throw new Error(); }
  catch { throw packageError('package source requires an HTTP(S) URL without credentials'); }
  const files = new Set<string>(); const folded = new Set<string>(); const components = new Map<string, string>(); let bytes = 0;
  for (const file of manifest.files) {
    validatePackagePath(file.path);
    if (file.path.split('/')[0]!.toLowerCase() === PACKAGE_MANIFEST.toLowerCase() || folded.has(file.path.toLowerCase())) throw packageError('duplicate, colliding or reserved package file');
    const parts = file.path.split('/');
    for (let end = 1; end <= parts.length; end++) { const name = parts.slice(0, end).join('/'); const key = name.toLowerCase(); if (components.has(key) && components.get(key) !== name) throw packageError('case-colliding package paths'); components.set(key, name); }
    files.add(file.path); folded.add(file.path.toLowerCase()); bytes += file.size;
  }
  if (!files.has('AGENT.md') || bytes > PACKAGE_LIMITS.totalBytes) throw packageError('package requires AGENT.md and must fit the size limit');
  // Reject file/directory and case-folded ancestor collisions on every target OS.
  for (const file of files) { const parts = file.split('/'); parts.pop(); while (parts.length) { if (folded.has(parts.join('/').toLowerCase())) throw packageError('package file collides with a parent directory'); parts.pop(); } }
  const reference = (name: string): void => { validatePackagePath(name); if (!files.has(name)) throw packageError('resource references an undeclared package file'); };
  const names = new Set<string>(); const skillIds = new Set<string>(); const mcpIds = new Set<string>();
  for (const skill of manifest.resources?.skills ?? []) { if (skillIds.has(skill.id)) throw packageError('duplicate skill ID'); skillIds.add(skill.id); reference(skill.entry); skill.files?.forEach(reference); }
  for (const tool of manifest.resources?.tools ?? []) { if (names.has(tool.name.replaceAll('.', '_'))) throw packageError('duplicate or colliding tool name'); names.add(tool.name.replaceAll('.', '_')); reference(tool.descriptor); reference(tool.entry); tool.files?.forEach(reference); }
  for (const server of manifest.resources?.mcp ?? []) {
    if (mcpIds.has(server.id)) throw packageError('duplicate MCP ID'); mcpIds.add(server.id);
    if (server.transport === 'stdio') { reference(server.entry); server.files?.forEach(reference); if (server.args?.some(arg => arg.includes('\0'))) throw packageError('invalid MCP argument'); }
    else { try { const url = new URL(server.url); if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error(); } catch { throw packageError('MCP template requires HTTPS or loopback HTTP without credentials'); } }
    for (const [name, policy] of Object.entries(server.tools)) { const full = `mcp.${server.id}.${name}`; if (full.length > 64 || names.has(full.replaceAll('.', '_')) || (policy.permission === 'read' && policy.effect === 'write')) throw packageError('invalid or colliding MCP tool policy'); names.add(full.replaceAll('.', '_')); }
  }
}
