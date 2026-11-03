import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { digest } from '../src/storage/index.js';
import { memoryTools } from '../src/tools/memory.js';
import { answer, binding, call, calls, fixture, scripted, temp } from './helpers.js';

describe('opt-in project memory', () => {
  it('is absent by default and registers no tool when disabled', () => {
    const f = fixture();
    expect(memoryTools(f.app.store, { enabled: false })).toEqual([]);
    expect(f.app.defaultCard.tools).not.toContain('memory.write');
  });

  it('writes UTF-8 project guidance and loads it before the next model request', async () => {
    const root = temp();
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    const content = 'Use the stable display order. 已定决策：保留兼容接口。';
    const app = new Application(path.join(root, 'state'), scripted(
      calls(call('memory.write', { name: 'compatibility', content, expectedHash: null })),
      async request => {
        expect(request.messages.some(message => message.role === 'user' && message.content.includes('kind="project-instructions"') && message.content.includes(content))).toBe(true);
        return answer('saved');
      },
    ), undefined, { agentFactors: { D: false, E: false, B: false }, memory: true, exploration: false, instructions: { global: false } });
    try {
      const run = app.createRun({ workspace, objective: 'Record the project decision.', binding, permissions: ['read', 'write'] });
      const result = await app.run(run.id);
      expect(result.status, result.error).toBe('completed');
      const saved = readFileSync(path.join(workspace, '.kodo', 'memory', 'compatibility.md'));
      expect(saved.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      expect(saved.toString('utf8')).toBe(content + '\n');
      expect(app.store.latestEvent(run.id, { types: ['memory.written'] })?.data.hash).toBe(digest(content + '\n'));
    } finally { await app.shutdown(); }
  });

  it('requires the current content hash before replacing an existing memory and recovers a committed write', async () => {
    const f = fixture();
    const file = path.join(f.root, '.kodo', 'memory', 'ordering.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'previous\n');
    const [tool] = memoryTools(f.app.store, { enabled: true });
    const run = f.app.store.run(f.runId);
    const signal = new AbortController().signal;
    const context = { run, session: f.app.store.session(run.sessionId), signal, markEffectStarted() {} };
    await expect(tool!.execute(context, { name: 'ordering', content: 'new', expectedHash: null })).rejects.toThrow('project memory changed');
    expect(readFileSync(file, 'utf8')).toBe('previous\n');
    const args = { name: 'ordering', content: 'new', expectedHash: digest('previous\n') };
    await expect(tool!.execute(context, args)).resolves.toMatchObject({ path: '.kodo/memory/ordering.md', hash: digest('new\n') });
    const request = call('memory.write', args);
    const fakeCall = { id: 'memory-call', runId: run.id, step: 0, kind: 'tool' as const, name: 'memory.write', status: 'unknown' as const, effect: 'write' as const, requestRef: f.app.store.blob(request), reservedTokens: 0 };
    await expect(tool!.recover!({ run, call: fakeCall, request, signal })).resolves.toMatchObject({ outcome: 'succeeded', result: { hash: digest('new\n') } });
  });
});
