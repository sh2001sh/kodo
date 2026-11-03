import { describe, expect, it } from 'vitest';
import { scriptReadRequest } from '../src/runtime/script-read.js';
import { repeatedReads, rereadNotice, writeNudge } from '../src/runtime/progress-guard.js';
import type { Call } from '../src/runtime/types.js';
import { fixture } from './helpers.js';

// Isolated synthetic call records exercise diagnostics without executing shell commands.
function evidence(protocol: 1 | 2 | 3 = 3) {
  const { app, runId } = fixture(undefined, undefined, { taskProtocol: protocol });
  let index = 0;
  const record = (command: string, status: Call['status'] = 'succeeded', exitCode = 0) => {
    const call: Call = { id: `read-${index++}`, runId, step: index, kind: 'tool', name: 'shell.exec', status,
      effect: 'write', reservedTokens: 0, requestRef: app.store.blob({ arguments: JSON.stringify({ command }) }),
      resultRef: app.store.blob({ exitCode, stdout: 'source evidence' }) };
    app.store.putCall(call);
    return call;
  };
  const reads = (count: number) => Array.from({ length: count }, (_, n) => record(`cd /app && sed -n '${n + 1},${n + 5}p' src/app.ts`));
  return { app, runId, record, reads, nudge: () => writeNudge(app.store, runId, true) };
}

describe('investigation diagnostics for shell-based workflows', () => {
  it.each([
    'cd /app && sed -n \'1,80p\' src/main.ts',
    'cd "/app/my project" && cat "src/my file.ts"',
    'cd /app && grep -n "route|handler" src/main.ts | head -n 20',
    'cd /app && rg -n "route" src | head -n 30',
    'cd /app && ls -la src; cat src/main.ts',
    'nl -ba src/main.ts',
  ])('counts a literal reading command: %s', command => {
    const { app, record } = evidence();
    expect(scriptReadRequest(app.store, record(command))).toMatchObject({ script: command });
  });

  it.each(['cd /app', 'git switch work', 'npm test', 'cd /app &&', 'sed -i \'s/old/new/\' src/main.ts', 'cat src/main.ts && npm test'])('does not count management, mutation or incomplete syntax: %s', command => {
    const { app, record } = evidence();
    expect(scriptReadRequest(app.store, record(command))).toBeUndefined();
  });

  it('recovers after setup and unknown commands, and reports only the recent window', () => {
    const { record, reads, nudge } = evidence();
    record('git switch work');
    reads(7);
    expect(nudge()).toBeUndefined();
    record('npm test');
    reads(7);
    expect(nudge()).toBeUndefined();
    reads(1);
    expect(nudge()).toMatchObject({ readCalls: 8 });
    expect(nudge()!.text).toContain('last 8 tool calls');
    expect(nudge()!.text).not.toContain('no edit');
  });

  it.each([['failed', 0], ['succeeded', 1]] as const)('does not count a %s read with exit code %s', (status, exitCode) => {
    const { record, reads, nudge } = evidence();
    reads(7);
    record('cat missing.ts', status, exitCode);
    reads(1);
    expect(nudge()).toBeUndefined();
    reads(7);
    expect(nudge()?.readCalls).toBe(8);
  });

  it('a real edit interrupts the window without permanently suppressing later advice', () => {
    const { app, runId, reads, nudge } = evidence();
    reads(7);
    app.store.putCall({ id: 'edit', runId, step: 8, kind: 'tool', name: 'file.apply_patch', status: 'succeeded', effect: 'write', reservedTokens: 0, requestRef: app.store.blob({ arguments: '{}' }) });
    reads(1);
    expect(nudge()).toBeUndefined();
    reads(7);
    expect(nudge()?.readCalls).toBe(8);
  });

  it('gives one persisted advisory that allows an analysis-only task to finish without edits', () => {
    const { app, runId, reads, nudge } = evidence();
    reads(8);
    expect(nudge()!.text).toContain('deliver the analysis');
    expect(nudge()!.text).toContain('neither edits nor delegation are required');
    expect(writeNudge(app.store, runId, false)).toBeUndefined();
    app.store.event(runId, 'progress.write_nudged', { readCalls: 8 });
    expect(nudge()).toBeUndefined();
  });

  it('stops suggesting initial independent work once a child actually exists', () => {
    const { app, runId, reads, nudge } = evidence();
    app.coordinator.mailbox.execute(app.store.run(runId), 'delegate', 'spawn_agent', { objective: 'Synthetic bounded analysis', permissions: ['read'] });
    reads(8);
    expect(nudge()).toBeUndefined();
  });

  it.each([1, 2] as const)('preserves the legacy threshold for protocol %s', protocol => {
    const { reads, nudge } = evidence(protocol);
    reads(29);
    expect(nudge()).toBeUndefined();
    reads(1);
    expect(nudge()?.readCalls).toBe(30);
  });

  it('detects repeated compound reads without demanding writes from a read-only task', () => {
    const { app, runId, record } = evidence();
    const command = 'cd /app && sed -n \'1,40p\' src/app.ts';
    record(command);
    record('cat src/other.ts');
    record(command);
    const latest = record(command);
    const paths = repeatedReads(app.store, runId, new Set([latest.id]));
    expect(paths).toEqual(['src/app.ts (via shell.exec)']);
    expect(rereadNotice(paths)).toContain('not a requirement to edit');
  });
});
