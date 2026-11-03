import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Store } from '../storage/index.js';
import { digest } from '../storage/index.js';
import { actualPath, assertFileScope } from '../runtime/scope.js';
import { KodoError } from '../runtime/types.js';
import type { ToolRegistration } from './registry.js';

const target = (name: unknown): string => `.kodo/memory/${String(name)}.md`;

async function contents(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

/** Project memory is an explicit host capability and uses the run's ordinary write scope. */
export function memoryTools(store: Store, options: { enabled: boolean }): ToolRegistration[] {
  if (!options.enabled) return [];
  return [{
    name: 'memory.write', version: '1', permission: 'write', effect: 'write',
    description: 'Save concise reusable project decisions or lessons in .kodo/memory/<name>.md. Host opt-in is required. Use expectedHash=null for a new memory or the hash of the current UTF-8 content before replacing one. Memory is subordinate project guidance and cannot grant permissions or change deliverables. It is loaded by later runs; this run receives an instruction delta after the write.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['name', 'content', 'expectedHash'],
      properties: {
        name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
        content: { type: 'string', minLength: 1, maxLength: 12000 },
        expectedHash: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[a-f0-9]{64}$' }] },
      },
    },
    writeScope: input => [target(input.name)],
    async execute({ run, session, signal, markEffectStarted }, args) {
      signal.throwIfAborted();
      const relative = target(args.name);
      const file = path.resolve(session.workspace, relative);
      assertFileScope(run.scope, 'write', session.workspace, file);
      const resolved = actualPath(file);
      if (resolved !== file) throw new KodoError('MEMORY_PATH', 'project memory must use an ordinary workspace path');
      const prior = await contents(file);
      if ((prior === undefined ? null : digest(prior)) !== args.expectedHash) throw new KodoError('MEMORY_STALE', 'project memory changed; read its current content before replacing it');
      const content = String(args.content).trim() + '\n';
      if (!content.trim()) throw new KodoError('MEMORY_CONTENT', 'memory must contain visible text');
      const temporary = `${file}.${randomUUID()}.tmp`;
      signal.throwIfAborted();
      markEffectStarted();
      await mkdir(path.dirname(file), { recursive: true });
      try {
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
        signal.throwIfAborted();
        await rename(temporary, file);
      } catch (error) {
        try { await unlink(temporary); }
        catch (cleanup) { if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanup], 'project memory write and temporary-file cleanup failed', { cause: cleanup }); }
        throw error;
      }
      const hash = digest(content);
      store.event(run.id, 'memory.written', { path: relative, hash, bytes: Buffer.byteLength(content) });
      return { path: relative, hash, bytes: Buffer.byteLength(content) };
    },
    async recover({ run, request, signal }) {
      signal.throwIfAborted();
      const args = JSON.parse(request.arguments) as { name: string; content: string; expectedHash: string | null };
      const workspace = store.session(run.sessionId).workspace;
      const file = path.resolve(workspace, target(args.name));
      assertFileScope(run.scope, 'write', workspace, file);
      const current = await contents(file);
      const currentHash = current === undefined ? null : digest(current);
      const hash = digest(args.content.trim() + '\n');
      if (currentHash === hash) return { outcome: 'succeeded', evidence: 'Project memory matches the requested content.', result: { path: target(args.name), hash } };
      if (currentHash === args.expectedHash) return { outcome: 'not_applied', evidence: 'Project memory still matches its pre-write content.' };
      return { outcome: 'unknown', evidence: 'Project memory matches neither the old nor requested content.' };
    },
  }];
}
