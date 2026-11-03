import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { declareTasks } from '../src/runtime/task-declare.js';
import { readTaskGraph } from '../src/runtime/task-graph.js';
import { taskCheckCommand } from '../src/runtime/task-checks.js';
import type { ProcessFacts } from '../src/tools/background.js';
import { fixture } from './helpers.js';

function isolatedTeam() {
  const f = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, sandbox: { network: 'none' }, instructions: { global: false }, lockDirectory: false });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=', ...args], { cwd: f.root, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(path.join(f.root, '.gitignore'), '.state/\n*.log\n');
  writeFileSync(path.join(f.root, 'base.txt'), 'baseline\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  return { ...f, store: f.app.store, tools: f.app.coordinator.tools, tasks: f.app.coordinator.tasks, sessionId: f.app.store.run(f.runId).sessionId };
}

const timedCheck = () => ({ program: process.execPath, args: ['-e', "const fs=require('node:fs'); const start=Date.now(); fs.writeFileSync('started.log','started'); setTimeout(()=>console.log(JSON.stringify({start,end:Date.now(),tmp:process.env.TMPDIR})),1500)"] });
const timing = (output: ProcessFacts): { start: number; end: number; tmp: string } => {
  expect(output.exitCode, output.stderr).toBe(0);
  return JSON.parse(output.stdout);
};

// Run on an actual Linux host with bubblewrap. Missing isolation is a failure, never an unsandboxed fallback.
describe.skipIf(process.platform !== 'linux')('isolated task execution concurrency', () => {
  it('overlaps child shell processes while main native reads remain responsive', async () => {
    const f = isolatedTeam();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'a', goal: 'Independent A' }, { id: 'b', goal: 'Independent B' }] });
    await f.tasks.tick(f.sessionId);
    const children = readTaskGraph(f.store, f.runId).nodes.map(node => f.store.run(node.runId!));
    const outputs = Promise.all(children.map(child => f.tools.execute(child.id, 'shell.exec', { command: taskCheckCommand(timedCheck()) }, new AbortController().signal) as Promise<ProcessFacts>));
    try {
      await vi.waitFor(() => expect(children.every(child => existsSync(path.join(child.execution!.root, 'started.log')))).toBe(true));
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 700);
      try {
        await f.tools.execute(f.runId, 'file.read', { path: 'base.txt' }, controller.signal);
        await f.tools.execute(f.runId, 'file.apply_patch', { path: 'main.log', content: 'main continues\n' }, controller.signal);
        // A read of the same child checkout must still wait for its active writer.
        await expect(f.tools.execute(children[0]!.id, 'file.read', { path: 'base.txt' }, AbortSignal.timeout(100))).rejects.toThrow();
      }
      finally { clearTimeout(deadline); }
      const [a, b] = (await outputs).map(timing);
      expect(Math.min(a!.end, b!.end) - Math.max(a!.start, b!.start)).toBeGreaterThan(500);
      for (const child of children) {
        const locks = f.store.events(child.id, { types: ['lock.acquired'] }).filter(event => event.data.mode === 'write');
        expect(locks.some(event => JSON.stringify(event.data.roots) === JSON.stringify([child.execution!.root]))).toBe(true);
      }
    } finally { for (const output of await outputs) expect(output.exitCode, output.stderr).toBe(0); }
  });

  it('runs structured host checks concurrently and retains their real outcomes', async () => {
    const f = isolatedTeam();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'a', goal: 'Check A', check: timedCheck() }, { id: 'b', goal: 'Check B', check: timedCheck() }] });
    await f.tasks.tick(f.sessionId);
    for (const node of readTaskGraph(f.store, f.runId).nodes) f.store.updateRun(node.runId!, { status: 'completed' });
    await f.tasks.tick(f.sessionId);
    await vi.waitFor(() => expect(f.store.calls(f.runId).filter(call => call.name === 'host.task.check').map(call => call.status)).toEqual(['succeeded', 'succeeded']), { timeout: 5000 });
    const calls = f.store.calls(f.runId).filter(call => call.name === 'host.task.check');
    expect(calls.map(call => call.status), JSON.stringify(calls.map(call => f.store.readBlob(call.resultRef!)))).toEqual(['succeeded', 'succeeded']);
    const [a, b] = calls.map(call => timing(f.store.readBlob<ProcessFacts>(call.resultRef!)));
    expect(Math.min(a!.end, b!.end) - Math.max(a!.start, b!.start)).toBeGreaterThan(500);
    await f.tasks.tick(f.sessionId);
    expect(readTaskGraph(f.store, f.runId).nodes.map(node => node.state)).toEqual(['done', 'done']);
  });

  it('reconciles a timed-out isolated command while its sibling continues', async () => {
    const f = isolatedTeam();
    declareTasks(f.store, f.runId, { tasks: [{ id: 'a', goal: 'Timeout A' }, { id: 'b', goal: 'Continue B' }] });
    await f.tasks.tick(f.sessionId);
    const [a, b] = readTaskGraph(f.store, f.runId).nodes;
    const command = taskCheckCommand(timedCheck());
    const [stopped, completed] = await Promise.all([
      f.tools.execute(a!.runId!, 'shell.exec', { command, timeoutMs: 500 }, new AbortController().signal),
      f.tools.execute(b!.runId!, 'shell.exec', { command }, new AbortController().signal),
    ]) as ProcessFacts[];
    expect(stopped).toMatchObject({ timedOut: true, effects: { verified: true } });
    timing(completed!);
    const later = await f.tools.execute(b!.runId!, 'shell.exec', { command: 'printf done > after-timeout.log' }, new AbortController().signal) as ProcessFacts;
    expect(later.exitCode, later.stderr).toBe(0);
    expect(existsSync(path.join(f.store.run(b!.runId!).execution!.root, 'after-timeout.log'))).toBe(true);
  });
});
