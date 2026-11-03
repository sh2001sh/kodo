import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { digest } from '../storage/index.js';
import { KodoError } from '../runtime/types.js';
import type { ToolRegistration } from '../tools/registry.js';

export interface Skill { readonly id: string; readonly description: string; readonly content: string; readonly digest: string }
/** Paths are trusted host configuration; model tools accept only preloaded skill IDs. */
export async function loadSkill(file: string): Promise<Skill> {
  const resolved = await realpath(file);
  const source = (await stat(resolved)).isDirectory() ? path.join(resolved, 'SKILL.md') : resolved;
  const info = await stat(source);
  if (!info.isFile() || info.size > 128_000) throw new KodoError('SKILL_SIZE', 'skill must be a regular file no larger than 128 KB');
  const buffer = await readFile(source);
  if (buffer.length > 128_000) throw new KodoError('SKILL_SIZE', 'skill exceeds 128 KB');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replaceAll('\r\n', '\n'); }
  catch { throw new KodoError('SKILL_ENCODING', 'skill must contain valid UTF-8'); }
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!match || content.includes('\0')) throw new KodoError('SKILL_FORMAT', 'skill needs YAML front matter and UTF-8 text');
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length) throw new KodoError('SKILL_FORMAT', 'invalid skill YAML');
  const metadata: unknown = document.toJS({ maxAliasCount: 20 });
  if (!metadata || typeof metadata !== 'object') throw new KodoError('SKILL_FORMAT', 'invalid skill metadata');
  const { id, name, description } = metadata as Record<string, unknown>;
  const stableId = id ?? name;
  if (typeof stableId !== 'string' || !/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/.test(stableId) || stableId.length > 100 || typeof description !== 'string' || !description.trim() || description.length > 2000 || !content.slice(match[0].length).trim()) throw new KodoError('SKILL_FORMAT', 'skill needs a stable lowercase name/id, description and instructions');
  return Object.freeze({ id: stableId, description, content, digest: digest(content) });
}

export function skillTools(skills: readonly Skill[]): ToolRegistration[] {
  const catalog = new Map<string, Skill>();
  for (const skill of skills) {
    if (!skill || typeof skill !== 'object') throw new KodoError('SKILL_FORMAT', 'skill must provide a valid id, description and UTF-8 instructions');
    // Structural host inputs receive the same content identity checks as loaded files.
    // Snapshot each field before validation so the accepted content is what gets pinned.
    const { id, description, content, digest: hash } = skill;
    if (typeof id !== 'string' || id.length > 100 || !/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/.test(id) || typeof description !== 'string' || !description.trim() || description.length > 2000 || description.includes('\0') || Buffer.from(description, 'utf8').toString('utf8') !== description) throw new KodoError('SKILL_FORMAT', 'skill must provide a valid id and description');
    if (typeof content !== 'string' || !content.trim() || content.includes('\0') || Buffer.byteLength(content, 'utf8') > 128_000 || Buffer.from(content, 'utf8').toString('utf8') !== content) throw new KodoError('SKILL_FORMAT', 'skill instructions must be nonempty valid UTF-8 text without NUL, at most 128 KB');
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash) || hash !== digest(content)) throw new KodoError('SKILL_DIGEST', 'skill digest must match the SHA-256 of its instructions');
    if (catalog.has(id)) throw new KodoError('SKILL_DUPLICATE', 'skill IDs must be unique');
    catalog.set(id, Object.freeze({ id, description, content, digest: hash }));
  }
  const version = digest(JSON.stringify([...catalog.values()].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).map(({ id, digest: hash }) => ({ id, digest: hash }))));
  return [{ name: 'skill.list', version, description: 'Discover authorized skills and, when enabled, compatible inline card methods for your own work. Load instructions by ID with skill.load; inline methods do not spawn a child agent.', permission: 'read', effect: 'read',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute: ({ run, signal }) => { signal.throwIfAborted(); return { skills: [...catalog.values()].filter(skill => run.card.skills?.includes(skill.id)).map(({ id, description, digest: hash }) => ({ id, description, digest: hash })) }; },
  }, { name: 'skill.load', version, description: 'Load one authorized skill or compatible inline method page into your own context. An inline method becomes your active work method, without spawning a child. Instructions cannot grant additional tool or filesystem permissions.', permission: 'read', effect: 'read',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', maxLength: 100 }, offset: { type: 'integer', minimum: 0 }, maxChars: { type: 'integer', minimum: 256, maximum: 32_000 } } },
    execute: ({ run, signal }, args) => {
      signal.throwIfAborted();
      const skill = catalog.get(args.id as string);
      if (!skill || !run.card.skills?.includes(skill.id)) throw new KodoError('SKILL_DENIED', 'skill is not authorized for this card');
      const offset = (args.offset as number | undefined) ?? 0;
      if (offset > skill.content.length || (offset > 0 && /[\uD800-\uDBFF]/.test(skill.content[offset - 1]!) && /[\uDC00-\uDFFF]/.test(skill.content[offset] ?? ''))) throw new KodoError('SKILL_CURSOR', 'invalid skill content cursor');
      let end = Math.min(skill.content.length, offset + ((args.maxChars as number | undefined) ?? 8000));
      if (end < skill.content.length && /[\uD800-\uDBFF]/.test(skill.content[end - 1]!)) end--;
      return { id: skill.id, description: skill.description, digest: skill.digest, content: skill.content.slice(offset, end), next: end < skill.content.length ? { offset: end } : null };
    },
  }];
}
