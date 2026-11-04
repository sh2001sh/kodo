import { describe, expect, it } from 'vitest';
import { readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { attachmentKind } from '../src/runtime/attachments.js';
import { digest } from '../src/storage/index.js';
import type { Message, ModelResponse, Provider } from '../src/runtime/types.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

type Step = ModelResponse | ((messages: Message[]) => ModelResponse);

async function run(root: string, steps: Step[]): Promise<{ app: Application; runId: string; requests: Message[][] }> {
  const requests: Message[][] = [];
  const provider: Provider = scripted(...steps.map(step => async (request: Parameters<Provider['complete']>[0]) => {
    requests.push(request.messages);
    return typeof step === 'function' ? step(request.messages) : step;
  }));
  const app = new Application(path.join(root, '.state'), provider);
  const created = app.createRun({ objective: 'Edit the files.', workspace: root, binding, permissions: ['read', 'write'] });
  const final = await app.run(created.id);
  expect(final.status, final.error).toBe('completed');
  return { app, runId: created.id, requests };
}
const lastTool = (messages: Message[]): string => messages.findLast(message => message.role === 'tool')!.content;
const notices = (messages: Message[]): string[] => messages.filter(message => attachmentKind(message) === 'changed-files').map(message => message.role === 'user' ? message.content : '');

describe('stale-write guard', () => {
  it('rejects a write over content changed after the run read it until the run reads again', async () => {
    const root = temp();
    const file = path.join(root, 'a.txt');
    writeFileSync(file, 'one\n');
    const { app, requests } = await run(root, [
      calls(call('file.read', { path: 'a.txt' }, 'read1')),
      () => {
        writeFileSync(file, 'two\n');
        return calls(call('file.patch', { path: 'a.txt', expectedHash: digest('two\n'), edits: [{ oldText: 'two', newText: 'three' }] }, 'stale'));
      },
      messages => {
        expect(lastTool(messages)).toContain('FILE_STALE');
        expect(lastTool(messages)).not.toContain(digest('two\n'));
        expect(notices(messages)).toHaveLength(1);
        expect(notices(messages)[0]).toContain('"a.txt"');
        return calls(call('file.read', { path: 'a.txt' }, 'read2'));
      },
      calls(call('file.patch', { path: 'a.txt', expectedHash: digest('two\n'), edits: [{ oldText: 'two', newText: 'three' }] }, 'fresh')),
      answer(),
    ]);
    try {
      expect(readFileSync(file, 'utf8')).toBe('three\n');
      expect(notices(requests.at(-1)!)).toHaveLength(1);
    } finally { await app.shutdown(); }
  });

  it('treats the run\'s own native writes as seen and ignores a touch without content change', async () => {
    const root = temp();
    const file = path.join(root, 'b.txt');
    const { app, requests } = await run(root, [
      calls(call('file.apply_patch', { path: 'b.txt', expectedHash: null, content: 'first\n' }, 'create')),
      () => {
        const later = new Date(Date.now() + 5_000);
        utimesSync(file, later, later);
        return calls(call('file.patch', { path: 'b.txt', expectedHash: digest('first\n'), edits: [{ oldText: 'first', newText: 'second' }] }, 'edit'));
      },
      calls(call('file.rename', { path: 'b.txt', destination: 'c.txt', expectedHash: digest('second\n') }, 'move')),
      calls(call('file.delete', { path: 'c.txt', expectedHash: digest('second\n') }, 'remove')),
      answer(),
    ]);
    try {
      expect(requests.flatMap(notices)).toEqual([]);
      for (const id of ['create', 'edit', 'move', 'remove']) expect(app.store.calls(app.store.listRuns()[0]!.id).find(item => item.id.endsWith(`:${id}`))?.status).toBe('succeeded');
    } finally { await app.shutdown(); }
  });

  it('reports a deleted file once and allows creating it again', async () => {
    const root = temp();
    const file = path.join(root, 'd.txt');
    writeFileSync(file, 'keep\n');
    const { app, requests } = await run(root, [
      calls(call('file.read', { path: 'd.txt' }, 'read')),
      () => { unlinkSync(file); return calls(call('file.list', { path: '.' }, 'list1')); },
      messages => {
        expect(notices(messages)).toHaveLength(1);
        return calls(call('file.list', { path: '.' }, 'list2'));
      },
      calls(call('file.apply_patch', { path: 'd.txt', expectedHash: null, content: 'again\n' }, 'recreate')),
      answer(),
    ]);
    try {
      expect(notices(requests.at(-1)!)).toHaveLength(1);
      expect(readFileSync(file, 'utf8')).toBe('again\n');
    } finally { await app.shutdown(); }
  });

  it('requires this run to read an existing file even when its expected hash matches', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'e.txt'), 'base\n');
    const { app, requests } = await run(root, [
      calls(call('file.patch', { path: 'e.txt', expectedHash: digest('base\n'), edits: [{ oldText: 'base', newText: 'next' }] }, 'edit')),
      answer(),
    ]);
    try {
      expect(readFileSync(path.join(root, 'e.txt'), 'utf8')).toBe('base\n');
      expect(lastTool(requests.at(-1)!)).toContain('FILE_UNREAD');
    }
    finally { await app.shutdown(); }
  });
});
