import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Application } from '../src/application/index.js';
import type { Provider, Run } from '../src/runtime/types.js';
import { answer, call, calls, fixture } from './helpers.js';

function requestRun(app: Application, request: Parameters<Provider['complete']>[0]): Run {
  const identity = request.messages.find(x => x.role === 'system')!.content!;
  const runId = /Run ID: ([^. ]+)\./.exec(identity)?.[1];
  if (!runId) throw new Error('provider request has no runtime identity');
  return app.store.run(runId);
}
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
function withExec(app: Application, runId: string): void {
  const source = app.store.run(runId);
  const card = { ...source.card, tools: [...new Set([...source.card.tools, 'process.exec'])] };
  app.store.updateRun(runId, { card, toolBindings: app.coordinator.tools.bindingSnapshot(card.tools) });
  const session = app.store.session(source.sessionId);
  app.store.putSession({ ...session, budget: { ...session.budget, maxTokens: 2_000_000 } });
}

describe('convergent cancellation of a child running a process', () => {
  it.each([
    ['quiet', 'setTimeout(() => {}, 30000)', []],
    ['writing', "require('node:fs').writeFileSync('child-effect.txt', 'partial'); setTimeout(() => {}, 30000)", ['child-effect.txt']],
  ] as const)('cancel_agent stops a %s child without pausing the parent and reconciles the process effect', async (_label, script, changed) => {
    let childId = '';
    const provider: Provider = { async complete(request) {
      const run = requestRun(app, request);
      if (!run.parentId) {
        if (run.step === 0) return calls(call('spawn_agent', { objective: 'run a long process' }, 'spawn'));
        if (run.step === 1) {
          childId = app.store.listRuns().find(x => x.parentId === run.id)!.id;
          await until(() => app.store.calls(childId).some(x => x.name === 'process.exec' && x.effectState === 'started') && (!changed.length || existsSync(path.join(root, changed[0]!))));
          return calls(call('cancel_agent', { run_id: childId }, 'cancel'));
        }
        await until(() => app.store.run(childId).status === 'cancelled');
        return answer('main continued after cancelling the child');
      }
      return calls(call('process.exec', { program: process.execPath, args: ['-e', script] }, 'exec'));
    } };
    const { app, root, runId } = fixture(provider, ['read', 'write', 'exec']);
    withExec(app, runId);
    const result = await app.run(runId);
    // Without a sandbox the stopped child process is settled from a post-stop scan of its write roots.
    expect(result.status, result.error).toBe('completed');
    expect(app.store.events(runId).filter(x => x.type === 'run.interrupted')).toHaveLength(0);
    expect(app.store.run(childId).status).toBe('cancelled');
    const exec = app.store.calls(childId).find(x => x.name === 'process.exec')!;
    expect(exec).toMatchObject({ status: 'cancelled', effectState: 'started' });
    expect(app.store.readBlob(exec.resultRef!)).toMatchObject({ cancelled: true, effects: { verified: true, basis: 'workspace-change-time', unobserved: 'outside-roots', ...(changed.length ? { outcome: 'applied', changed: expect.arrayContaining([...changed]) } : {}) } });
    expect(app.store.events(childId).find(x => x.type === 'tool.reconciled')?.data).toMatchObject({ callId: exec.id, verified: true, basis: 'workspace-change-time' });
    expect(app.store.unresolvedWrites(undefined, result.sessionId)).toHaveLength(0);
    const cancelled = app.store.events(childId).find(event => event.type === 'run.cancelled')!;
    const reconciled = app.store.events(childId).find(event => event.type === 'tool.reconciled')!;
    expect(cancelled.seq).toBeGreaterThan(reconciled.seq);
    const notice = app.store.messages(result.sessionId).find(message => message.id === `terminal:${childId}`)!;
    expect(JSON.parse(notice.content).reconciliation.unknown).toHaveLength(0);
    if (changed.length) expect(readFileSync(path.join(root, changed[0]!), 'utf8')).toBe('partial');
  }, 30_000);
});
