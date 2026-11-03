import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { answer, call, calls, fixture, scripted } from './helpers.js';

describe('Bash timeout write reconciliation', () => {
  it.each([
    'sleep 30',
    'cd . && sleep 30; tail -5 suite.log; echo "---"; grep -E "^(FAILED|ERROR)" suite.log | head -20; grep -cE "^\\." suite.log 2>/dev/null | head -1',
  ])('settles a read/wait timeout without a sandbox and continues writing: %s', async command => {
    const { app, root, runId } = fixture(scripted(
      calls(call('shell.exec', { command, timeoutMs: 1500 }, 'wait')),
      async request => {
        const result = JSON.parse(request.messages.findLast(message => message.role === 'tool')!.content);
        expect(result, JSON.stringify(result)).toMatchObject({ timedOut: true, cancelled: true, effects: { verified: true, outcome: 'not_applied', basis: 'read-only-command', exitConfirmation: 'process-tree' } });
        expect(app.store.unresolvedWrites(root)).toEqual([]);
        return calls(call('shell.exec', { command: 'tail -5 suite.log' }, 'read-log'));
      },
      calls(call('file.apply_patch', { path: 'result.txt', expectedHash: null, content: 'completed after wait timeout' }, 'save')),
      answer('Saved the result after reading the log; the wait timed out.'),
    ), ['read', 'write', 'exec']);
    writeFileSync(path.join(root, 'suite.log'), 'tests completed\n');
    const final = await app.run(runId);
    expect(final.status, final.error).toBe('completed');
    const wait = app.store.calls(runId).find(entry => entry.id.endsWith(':wait'))!;
    expect(wait).toMatchObject({ effect: 'read', status: 'failed' });
    expect(app.store.events(runId, { types: ['tool.reconciled'], match: { callId: wait.id } })[0]?.data).toMatchObject({ verified: true, outcome: 'not_applied', exitConfirmation: 'process-tree' });
    expect(app.store.events(runId, { types: ['run.handoff'] })).toEqual([]);
    expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('completed after wait timeout');
  });

  it('stops a waiting pipeline, confirms its exit and allows subsequent work', async () => {
    const { app, root, runId } = fixture(scripted(
      calls(call('shell.exec', { command: 'sleep 30 | cat; tail -5 suite.log', timeoutMs: 1500 }, 'wait')),
      async request => {
        const result = JSON.parse(request.messages.findLast(message => message.role === 'tool')!.content);
        expect(result, JSON.stringify(result)).toMatchObject({ timedOut: true, effects: { verified: true, basis: 'read-only-command', exitConfirmation: 'process-tree' } });
        expect(app.store.unresolvedWrites(root)).toEqual([]);
        return calls(call('file.apply_patch', { path: 'result.txt', expectedHash: null, content: 'saved' }));
      }, answer('The wait failed; saved the independent result.'),
    ), ['read', 'write', 'exec']);
    writeFileSync(path.join(root, 'suite.log'), 'completed\n');
    const final = await app.run(runId);
    expect(final.status, final.error).toBe('completed');
    expect(app.store.calls(runId).find(entry => entry.id.endsWith(':wait'))).toMatchObject({ effect: 'read', status: 'failed' });
    expect(app.store.events(runId, { types: ['run.handoff'] })).toEqual([]);
    expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('saved');
  });

  it('settles a timed-out unsandboxed write from a post-stop workspace scan and continues', async () => {
    const { app, root, runId } = fixture(scripted(calls(call('shell.exec', { command: "printf 'one' > uncertain.txt; printf started; sleep 30", timeoutMs: 1500 })), answer('timed out after writing uncertain.txt')), ['read', 'write', 'exec']);
    const source = app.store.run(runId);
    const card = { ...source.card, tools: [...new Set([...source.card.tools, 'shell.exec'])] };
    app.store.updateRun(runId, { card, toolBindings: app.coordinator.tools.bindingSnapshot(card.tools) });
    const result = await app.run(runId);
    const shellCall = app.store.calls(runId).find(entry => entry.name === 'shell.exec')!;
    expect(result.status, result.error).toBe('completed');
    // Timeout stays a failure; the effect itself is settled as applied, not unknown.
    expect(shellCall).toMatchObject({ status: 'failed', effectOutcome: 'applied', effectRoots: [app.store.session(source.sessionId).workspace] });
    expect(app.store.readBlob(shellCall.resultRef!)).toMatchObject({ timedOut: true, cancelled: true, stdout: 'started', effects: { verified: true, outcome: 'applied', changed: expect.arrayContaining(['uncertain.txt']), basis: 'workspace-change-time', unobserved: 'outside-roots' } });
    expect(app.store.events(runId).find(x => x.type === 'tool.reconciled')?.data).toMatchObject({ callId: shellCall.id, verified: true, outcome: 'applied', basis: 'workspace-change-time', unobserved: 'outside-roots' });
    expect(app.store.unresolvedWrites(root)).toEqual([]);
    expect(app.store.events(runId, { types: ['run.handoff'] })).toEqual([]);
    expect(readFileSync(path.join(root, 'uncertain.txt'), 'utf8')).toBe('one');
  }, 15_000);

  it('records the read-only basis when a wait command times out', async () => {
    const { app, runId } = fixture(scripted(calls(call('shell.exec', { command: 'sleep 30', timeoutMs: 1500 }, 'wait')), answer('waited')), ['read', 'write', 'exec']);
    const source = app.store.run(runId);
    const card = { ...source.card, tools: [...new Set([...source.card.tools, 'shell.exec'])] };
    app.store.updateRun(runId, { card, toolBindings: app.coordinator.tools.bindingSnapshot(card.tools) });
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.events(runId).find(x => x.type === 'tool.reconciled')?.data).toMatchObject({ verified: true, outcome: 'not_applied', basis: 'read-only-command' });
  }, 15_000);
});
