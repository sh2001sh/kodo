import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application/index.js';
import { runProcess } from '../src/tools/index.js';
import { answer, binding, call, calls, fixture, scripted, temp } from './helpers.js';

describe('delivery completion', () => {
  it('corrects an empty final without claiming quality acceptance or exposing reasoning', async () => {
    const blank = answer(' \n\t');
    blank.message.providerData = { protocol: 'chat-completions', reasoningContent: 'private reasoning is not a final answer' };
    const { app, runId } = fixture(scripted(blank, async request => {
      expect(request.messages.at(-1)?.content).toContain('nonblank final response');
      return answer('Implemented and verified.');
    }));
    const run = await app.run(runId);
    expect(run.status).toBe('completed');
    expect(app.store.readBlob(run.resultRef!)).toMatchObject({ text: 'Implemented and verified.', delivery: { status: 'passed' }, quality: { status: 'not_checked' } });
    expect(app.store.session(run.sessionId).modelCalls).toBe(2);
    expect(app.store.events(runId).filter(e => e.type === 'completion.correction_requested')).toHaveLength(1);
  });

  it('fails after two empty-answer correction opportunities and preserves files and evidence', async () => {
    const { app, root, runId } = fixture(scripted(answer(''), answer(' '), answer('\n')));
    writeFileSync(path.join(root, 'candidate.txt'), 'keep me');
    const run = await app.run(runId);
    expect(run).toMatchObject({ status: 'failed', error: expect.stringContaining('DELIVERY_FAILED') });
    expect(app.store.events(runId).filter(e => e.type === 'completion.correction_requested')).toHaveLength(2);
    expect(app.store.calls(runId).filter(c => c.kind === 'model')).toHaveLength(3);
    expect(readFileSync(path.join(root, 'candidate.txt'), 'utf8')).toBe('keep me');
    expect(run.resultRef).toBeUndefined();
  });

  it('does not let successful public validation accept an empty final', async () => {
    const { app, runId } = fixture(scripted(answer(''), answer('fixed final')));
    const validate = vi.fn(() => ({ passed: true, evidence: { exitCode: 0 } }));
    app.setCompletionValidator(runId, validate);
    const run = await app.run(runId);
    expect(app.store.session(run.sessionId).modelCalls).toBe(2);
    expect(app.store.readBlob(run.resultRef!)).toMatchObject({ text: 'fixed final', delivery: { status: 'passed' }, quality: { status: 'passed' } });
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('rechecks the actual directory on every candidate, rejecting a later broken build', async () => {
    const { app, root, runId } = fixture(scripted(answer(''), async () => {
      writeFileSync(path.join(root, 'source.cjs'), 'module.exports = ;');
      return answer('nonempty but broken');
    }, answer('still broken')));
    writeFileSync(path.join(root, 'source.cjs'), 'module.exports = 1;');
    const exits: (number | null)[] = [];
    app.setCompletionValidator(runId, async ({ signal }) => {
      const output = await runProcess(process.execPath, ['--check', 'source.cjs'], root, binding.apiKeyEnv, signal);
      exits.push(output.exitCode);
      return { passed: output.exitCode === 0, evidence: { ...output }, feedback: output.stderr.slice(0, 16000) };
    });
    const run = await app.run(runId);
    expect(exits).toEqual([0, 1, 1]);
    expect(run).toMatchObject({ status: 'failed', error: expect.stringContaining('QUALITY_FAILED') });
  });

  it('persists an explicit optional-response contract across restart and follow-up', async () => {
    const root = temp();
    const directory = path.join(root, 'state');
    const first = new Application(directory, scripted(answer('')));
    const run = first.createRun({ objective: 'Silent artifact task', workspace: root, binding, finalResponse: 'optional' });
    first.close();
    const reopened = new Application(directory, scripted(answer(''), answer('')));
    try {
      const result = await reopened.run(run.id);
      expect(result.status).toBe('completed');
      expect(reopened.store.readBlob(result.resultRef!)).toMatchObject({ text: '', delivery: { status: 'not_required' }, quality: { status: 'not_checked' } });
      const next = reopened.submitInput(run.id, 'Another silent artifact');
      expect(next.finalResponse).toBe('optional');
      expect((await reopened.run(next.id)).status).toBe('completed');
    } finally { reopened.close(); }
  });

  it('rejects a passing verdict if a child changes the delivery while validation is pending', async () => {
    let childSteps = 0;
    const { app, root, runId } = fixture({ async complete(request) {
      if (request.messages.some(m => m.role === 'user' && m.content === 'Child writer')) {
        return childSteps++ === 0 ? calls(call('file.apply_patch', { path: 'source.cjs', expectedHash: null, content: 'module.exports = ;' })) : calls(call('wait_for_events', { run_ids: [runId], timeout_ms: 300000 }));
      }
      return answer('candidate');
    } });
    const child = app.store.transaction(() => app.coordinator.mailbox.execute(app.store.run(runId), 'child-writer', 'spawn_agent', { objective: 'Child writer' })) as { id: string };
    let checks = 0;
    app.setCompletionValidator(runId, async ({ signal }) => {
      if (++checks === 1) {
        // The verifier saw the previous valid directory; the child writes before its verdict returns.
        await app.coordinator.wake(child.id);
        return { passed: true };
      }
      const output = await runProcess(process.execPath, ['--check', 'source.cjs'], root, binding.apiKeyEnv, signal);
      return { passed: output.exitCode === 0, feedback: output.stderr.slice(0, 16000) };
    });
    expect(await app.run(runId)).toMatchObject({ status: 'failed', error: expect.stringContaining('QUALITY_FAILED') });
    expect(checks).toBe(3);
  });

  it('still checks artifacts for an explicitly optional final response', async () => {
    const root = temp();
    const app = new Application(path.join(root, 'state'), scripted(answer(''), answer(''), answer('')));
    try {
      const run = app.createRun({ objective: 'Structured artifact', workspace: root, binding, finalResponse: 'optional' });
      app.setCompletionValidator(run.id, () => ({ passed: false, feedback: 'Missing required artifact' }));
      expect(await app.run(run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('QUALITY_FAILED') });
      expect(app.store.events(run.id).filter(e => e.type === 'completion.checked')).toHaveLength(3);
    } finally { app.close(); }
  });

  it('invalidates acceptance if a recorded write lands immediately before terminal commit', async () => {
    const { app, root, runId } = fixture(scripted(answer('candidate'), answer('retry 1'), answer('retry 2')));
    writeFileSync(path.join(root, 'source.cjs'), 'module.exports = 1;');
    let checks = 0;
    app.setCompletionValidator(runId, async ({ signal }) => {
      checks++;
      const output = await runProcess(process.execPath, ['--check', 'source.cjs'], root, binding.apiKeyEnv, signal);
      return { passed: output.exitCode === 0, feedback: output.stderr.slice(0, 16000) };
    });
    let injected = false;
    app.store.subscribe(event => {
      if (event.runId !== runId || event.type !== 'completion.checked' || injected) return;
      injected = true;
      // Inject the exact scheduling boundary: a managed write committed after the verdict.
      writeFileSync(path.join(root, 'source.cjs'), 'module.exports = ;');
      app.store.putCall({ id: 'late-write', runId, step: 0, kind: 'tool', name: 'process.exec', effect: 'write', effectState: 'started', status: 'succeeded', reservedTokens: 0, requestRef: app.store.blob({}), resultRef: app.store.blob({ exitCode: 0 }) });
    });
    expect(await app.run(runId)).toMatchObject({ status: 'failed', error: expect.stringContaining('QUALITY_FAILED') });
    expect(checks).toBe(4);
    expect(app.store.events(runId).filter(e => e.type === 'completion.invalidated')).toHaveLength(1);
    expect(app.store.events(runId).filter(e => e.type === 'run.completed')).toHaveLength(0);
  });
});
