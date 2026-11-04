import { readFileSync } from 'node:fs';
import { parseDocument, stringify } from 'yaml';
import { Ajv } from 'ajv';
import { digest } from '../storage/index.js';
import { KodoError } from '../runtime/types.js';
import type { Card, CardReference, FileScope } from '../runtime/types.js';
import { normalizeFileScope } from '../runtime/scope.js';
import { builtinToolNames } from '../tools/index.js';
import { hostToolNames } from '../tools/catalog.js';

const validateV1 = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'id', 'version', 'name', 'description', 'capabilities'],
  properties: {
    schema_version: { const: 1 },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$' },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', minLength: 1, maxLength: 2000 },
    nudges: { type: 'boolean' },
    capabilities: { type: 'object', additionalProperties: false, required: ['tools'], properties: {
      tools: { type: 'array', uniqueItems: true, maxItems: 128, items: { type: 'string', minLength: 1, maxLength: 64 } },
      skills: { type: 'array', uniqueItems: true, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 100 } },
    } },
  },
});

const nonblank = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const strings = (maxLength: number, minItems = 0) => ({ type: 'array', uniqueItems: true, minItems, items: nonblank(maxLength) });
const identity = { type: 'string', maxLength: 128, pattern: '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*$' };
const version = { type: 'string', maxLength: 64, pattern: '^\\d+\\.\\d+\\.\\d+$' };
const field = (kinds: readonly string[]) => ({ type: 'object', additionalProperties: false, required: ['name', 'kind', 'required'], properties: {
  name: { type: 'string', maxLength: 64, pattern: '^[a-z][a-z0-9_]*$' }, kind: { enum: kinds }, required: { type: 'boolean' }, description: nonblank(2000),
} });
const validateV2 = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'id', 'version', 'name', 'description', 'capabilities', 'catalog', 'routing'],
  properties: {
    schema_version: { const: 2 }, id: identity, version,
    name: nonblank(200), description: nonblank(2000), nudges: { type: 'boolean' },
    catalog: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', maxLength: 259, pattern: '^[a-z0-9][a-z0-9-]{0,63}(?:/[a-z0-9][a-z0-9-]{0,63}){1,3}$' }, aliases: strings(200),
    } },
    routing: { type: 'object', additionalProperties: false, required: ['use_when', 'mode'], properties: {
      use_when: strings(2000, 1), not_for: strings(2000), mode: { enum: ['read', 'review', 'write'] },
    } },
    inputs: { type: 'array', items: field(['text', 'paths', 'artifact']) },
    report: { type: 'array', items: field(['text', 'paths', 'calls', 'list']) },
    capabilities: { type: 'object', additionalProperties: false, required: ['tools'], properties: {
      tools: { ...strings(64), maxItems: 128 }, skills: { ...strings(100), maxItems: 64 },
      mcp: { type: 'array', maxItems: 64, items: { type: 'object', additionalProperties: false, required: ['server', 'tools'], properties: {
        server: { type: 'string', maxLength: 100, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' }, tools: { ...strings(64), maxItems: 128 },
      } } },
    } },
    constraints: { type: 'object', additionalProperties: false, properties: {
      permissions: { type: 'array', uniqueItems: true, items: { enum: ['read', 'write', 'exec'] } },
      scope: { type: 'object', additionalProperties: false, properties: { read: strings(4096), write: strings(4096) } }, rules: strings(4096),
    } },
    model: { type: 'object', additionalProperties: false, required: ['role'], properties: { role: { enum: ['fast', 'standard', 'strong'] } } },
    derivation: { type: 'object', additionalProperties: false, required: ['allowed'], properties: { allowed: { type: 'boolean' } } },
    members: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'version', 'digest'], properties: {
      id: identity, version, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    } } },
  },
});

export interface CardCapabilities {
  toolNames?: readonly string[];
  skillIds?: readonly string[];
  /** Registration supplies this lookup; parsing an offline document need not have a registry. */
  resolveMember?: (id: string, version: string) => Pick<CardReference, 'digest'> | undefined;
}
type CardMetadata = Omit<Card, 'prompt' | 'digest' | 'tools' | 'skills' | 'mcp' | 'schemaVersion'> & {
  schema_version: 1 | 2;
  capabilities: { tools: string[]; skills?: string[]; mcp?: Card['mcp'] };
};
const v2Fields = ['catalog', 'routing', 'inputs', 'report', 'constraints', 'model', 'derivation', 'members'] as const;

/** Validate declarations here; resolve variables against host/project values only when freezing a session. */
function cardScope(scope: FileScope): FileScope {
  return Object.fromEntries(Object.entries(scope).map(([operation, roots]) => [operation, roots!.map((root: string) => {
    if (/^\$\{project\.[a-z][a-z0-9_.-]*\}$/.test(root)) return root;
    if (root.includes('${')) throw new KodoError('CARD_SCOPE', 'project variables must occupy one complete path root');
    try { return normalizeFileScope({ [operation]: [root] })[operation as 'read' | 'write']![0]!; }
    catch { throw new KodoError('CARD_SCOPE', 'card scopes must use relative path roots, not globs'); }
  })]));
}

function uniqueNames(items: readonly { name: string }[] | undefined, label: string): void {
  if (items && new Set(items.map(item => item.name)).size !== items.length) throw new KodoError('CARD_SCHEMA', `${label} field names must be unique`);
}

export function parseCard(content: string, options: CardCapabilities = {}): Card {
  if (Buffer.byteLength(content) > 128_000) throw new KodoError('CARD_SIZE', 'card exceeds 128 KB');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(content);
  if (!match) throw new KodoError('CARD_FORMAT', 'AGENT.md must contain YAML front matter and a prompt');
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new KodoError('CARD_YAML', 'invalid YAML or duplicate keys');
  const data: unknown = document.toJS({ maxAliasCount: 20 });
  const v2 = data !== null && typeof data === 'object' && 'schema_version' in data && data.schema_version === 2;
  if (!(v2 ? validateV2(data) : validateV1(data))) throw new KodoError('CARD_SCHEMA', v2 ? 'invalid schema v2 card fields, routing metadata or contract declarations' : 'unsupported or invalid card fields; this preview supports built-in tools only');
  const meta = data as CardMetadata;
  const tools = new Set([...builtinToolNames, ...(options.toolNames ?? [])]);
  if (meta.capabilities.tools.some(name => !tools.has(name))) throw new KodoError('CARD_SCHEMA', 'unsupported or invalid card fields; this preview supports built-in tools only unless the host registers extensions');
  if (!v2 && meta.capabilities.skills?.some(id => !options.skillIds?.includes(id))) throw new KodoError('CARD_SCHEMA', 'skill is not registered by the host');
  if (!match[2]!.trim()) throw new KodoError('CARD_PROMPT', 'card prompt is empty');
  const card: Card = { id: meta.id, version: meta.version, name: meta.name, description: meta.description, tools: meta.capabilities.tools, ...(meta.nudges === undefined ? {} : { nudges: meta.nudges }), ...(meta.capabilities.skills ? { skills: meta.capabilities.skills } : {}), prompt: match[2]!.trim(), digest: digest(content.replaceAll('\r\n', '\n')) };
  if (v2) {
    card.schemaVersion = 2;
    for (const key of v2Fields) if (meta[key] !== undefined) Object.assign(card, { [key]: meta[key] });
    if (meta.capabilities.mcp !== undefined) card.mcp = meta.capabilities.mcp;
    uniqueNames(card.inputs, 'input slot'); uniqueNames(card.report, 'report');
    if (card.mcp && new Set(card.mcp.map(item => item.server)).size !== card.mcp.length) throw new KodoError('CARD_SCHEMA', 'MCP server declarations must be unique');
    if (card.constraints?.scope) card.constraints.scope = cardScope(card.constraints.scope);
    if (card.constraints?.rules) for (const rule of card.constraints.rules) {
      try { normalizeFileScope({ read: [rule] }); }
      catch { throw new KodoError('CARD_SCHEMA', 'card rules must name relative workspace files'); }
    }
    if (card.members && new Set(card.members.map(item => item.id)).size !== card.members.length) throw new KodoError('CARD_SCHEMA', 'member ids must be unique');
    for (const member of card.members ?? []) if (options.resolveMember) {
      const registered = options.resolveMember(member.id, member.version);
      if (!registered) throw new KodoError('CARD_MEMBER', `member ${member.id}@${member.version} is not registered`);
      if (registered.digest !== member.digest) throw new KodoError('CARD_MEMBER', `member ${member.id}@${member.version} digest does not match the registered card`);
    }
  }
  return card;
}

/** Render all public declarations and the private method; reparsing produces the new document digest. */
export function serializeCard(card: Card): string {
  const schema = card.schemaVersion === 2 || card.mcp !== undefined || v2Fields.some(key => card[key] !== undefined) ? 2 : 1;
  const metadata = {
    schema_version: schema, id: card.id, version: card.version, name: card.name, description: card.description ?? card.name,
    ...(card.nudges === undefined ? {} : { nudges: card.nudges }),
    ...(schema === 2 ? Object.fromEntries(v2Fields.filter(key => card[key] !== undefined).map(key => [key, card[key]])) : {}),
    capabilities: { tools: card.tools, ...(card.skills === undefined ? {} : { skills: card.skills }), ...(schema === 2 && card.mcp !== undefined ? { mcp: card.mcp } : {}) },
  };
  return `---\n${stringify(metadata)}---\n${card.prompt.trim()}\n`;
}

/** Reusable structural registration check for callers receiving an already parsed Card object. */
export function validateCard(card: Card, options: CardCapabilities = {}): void { parseCard(serializeCard(card), options); }
export const loadCard = (file: string, options?: CardCapabilities): Card => parseCard(readFileSync(file, 'utf8'), options);
/**
 * The single default card (phase 1f): a general work assistant's file and command
 * method. Delegation and review policy live in the system prompt, not here. Its tool
 * view hides redundant CRUD only when exec is granted.
 */
export const simpleDefaultCard = parseCard(`---
schema_version: 1
id: builtin/general-simple
version: 2.0.0
name: General agent
description: Complete local work with files, commands and child agents.
nudges: true
capabilities:
  tools: [file.read, file.list, file.search, file.apply_patch, file.patch, file.mkdir, file.rename, file.delete, shell.exec, process.run, todo.read, todo.write]
---
Read the relevant files before acting on them, then do the requested work and check it. Use file.read before native edits; file.patch makes localized edits, while file.apply_patch creates or replaces a whole file and requires an existing parent directory. file.search matches literal text, not regular expressions. Use native file-management tools when command execution is unavailable.
Run short commands directly; use registered background handles for long ones and process.read to collect their outcome. Do not wait through shell sleep or polling.
Reuse existing check output while its inputs and environment still match. Report actual changes, verification and remaining gaps.
`, { toolNames: hostToolNames });

