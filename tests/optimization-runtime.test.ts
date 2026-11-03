import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import type { Message } from '../src/runtime/types.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

describe('optimization execution integration', () => {
  it('continues independent writes after an unknown result without replaying or allowing overlapping writes', async () => {
    const root = temp();
    let started = 0;
    let seen: Message[] = [];
    const app: Application = new Application(path.join(root, '.state'), scripted(
      calls(call('probe.write', {}, 'uncertain'), call('file.apply_patch', { path: 'other.txt', expectedHash: null, content: 'saved' }, 'independent'), call('file.apply_patch', { path: 'uncertain.txt', expectedHash: null, content: 'repeat' }, 'overlap')),
      async request => { seen = request.messages; return answer('The independent output is saved; the first effect needs host reconciliation.'); },
      async request => {
        expect(JSON.stringify(request.messages)).toContain('Host inspected this ordinary test operation');
        return answer('The independent output remains saved; the host verified that the first operation produced no output.');
      },
    ), undefined, { agentFactors: { D: false, E: false, B: false }, exploration: false, lockDirectory: false, hooks: [{ kind: 'tool.failed', callback: ({ data }) => {
      if (data.name === 'probe.write') expect(app.store.call(String(data.callId)).status).toBe('unknown');
    } }], tools: [{
      name: 'probe.write', description: 'A host operation with uncertain completion.', permission: 'write', effect: 'write',
      parameters: { type: 'object', additionalProperties: false }, writeScope: () => ['uncertain.txt'],
      execute() { started++; throw new Error('host operation failed after starting'); },
    }] });
    try {
      const card = { ...app.defaultCard, tools: [...app.defaultCard.tools, 'probe.write'] };
      const run = app.createRun({ workspace: root, objective: 'Save independent output and report uncertainty.', binding, permissions: ['read', 'write'], card });
      const result = await app.run(run.id);
      expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/^UNKNOWN_WRITE:/u) });
      expect(result.resultRef).toBeUndefined();
      expect(started).toBe(1);
      expect(readFileSync(path.join(root, 'other.txt'), 'utf8')).toBe('saved');
      expect(existsSync(path.join(root, 'uncertain.txt'))).toBe(false);
      expect(app.store.calls(run.id).filter(item => item.kind === 'tool').map(item => item.status)).toEqual(['unknown', 'succeeded', 'failed']);
      expect(seen.filter(message => message.role === 'tool')).toHaveLength(3);
      const uncertain = app.store.unresolvedWrites(root)[0]!;
      app.resolveCall(uncertain.id, 'not_applied', 'Host inspected this ordinary test operation and confirmed no output was produced.');
      expect(app.store.unresolvedWrites(root)).toHaveLength(0);
      const recovered = await app.recover(run.id);
      expect(recovered.status, recovered.error).toBe('completed');
      expect(app.store.run(run.id).status).toBe('failed');
      expect(readFileSync(path.join(root, 'other.txt'), 'utf8')).toBe('saved');
      expect(started).toBe(1);
    } finally { await app.shutdown(); }
  });

  it('loads directory instructions before the first write and waits for a revised model request', async () => {
    const root = temp();
    mkdirSync(path.join(root, 'sub'));
    writeFileSync(path.join(root, 'sub', 'AGENTS.md'), 'Write the report in plain text.');
    const app = new Application(path.join(root, '.state'), scripted(
      calls(call('file.apply_patch', { path: 'sub/report.txt', expectedHash: null, content: 'first' }, 'before-instructions')),
      async request => {
        expect(existsSync(path.join(root, 'sub', 'report.txt'))).toBe(false);
        expect(request.messages.some(message => message.content?.includes('Write the report in plain text.'))).toBe(true);
        return calls(call('file.apply_patch', { path: 'sub/report.txt', expectedHash: null, content: 'replanned' }, 'after-instructions'));
      }, answer(),
    ), undefined, { agentFactors: { D: false, E: false, B: false }, exploration: false, lockDirectory: false });
    try {
      const run = app.createRun({ workspace: root, objective: 'Save a report.', binding, permissions: ['read', 'write'] });
      expect((await app.run(run.id)).status).toBe('completed');
      expect(readFileSync(path.join(root, 'sub', 'report.txt'), 'utf8')).toBe('replanned');
      const first = app.store.calls(run.id).find(item => item.id.endsWith(':before-instructions'))!;
      expect(first.effectOutcome).toBe('not_applied');
      expect(app.store.events(run.id, { types: ['tool.started'], match: { callId: first.id } })).toHaveLength(0);
    } finally { await app.shutdown(); }
  });

  it('applies before/after hooks through the execution loop and keeps their notes visible', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'readme.txt'), 'hello');
    const observed: string[] = [];
    const app = new Application(path.join(root, '.state'), scripted(calls(call('file.read', { path: 'readme.txt' })), async request => {
      expect(request.messages.some(message => message.content?.includes('Host after note'))).toBe(true);
      return answer();
    }), undefined, { exploration: false, lockDirectory: false, hooks: [
      { kind: 'tool.before', callback: () => { observed.push('before'); return { note: 'Host before note' }; } },
      { kind: 'tool.after', callback: () => { observed.push('after'); return { note: 'Host after note' }; } },
    ], agentFactors: { D: false, E: false, B: false } });
    try {
      const run = app.createRun({ workspace: root, objective: 'Read once.', binding, permissions: ['read'] });
      expect((await app.run(run.id)).status).toBe('completed');
      expect(observed).toEqual(['before', 'after']);
    } finally { await app.shutdown(); }
  });
});
