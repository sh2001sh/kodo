import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Application } from '../src/application/index.js';
import { delegationGuidance } from '../src/agents/child-card.js';
import { exploreReportChars } from '../src/messaging/explore.js';
import { spawnAgentSpec } from '../src/messaging/spawn-spec.js';
import { KodoError } from '../src/runtime/types.js';
import type { Message, Provider, Run } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, scripted, temp } from './helpers.js';
import { Application as App } from '../src/application/index.js';

type Request = Parameters<Provider['complete']>[0];
const nativeRead = ['file.read', 'file.list', 'file.search', 'image.read'];

function owner(app: Application, request: Request): Run {
  const system = request.messages.find(message => message.role === 'system')?.content ?? '';
  const id = /Run ID: ([^. ]+)\./u.exec(system)?.[1];
  if (!id) throw new Error('Missing run identity');
  return app.store.run(id);
}
function operation(app: Application, runId: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return app.store.transaction(() => {
    const run = app.store.run(runId);
    return app.coordinator.mailbox.execute(run, `${name}-call`, name, app.coordinator.mailbox.validate(run, name, JSON.stringify(args))) as Record<string, unknown>;
  });
}
function expectKodo(action: () => unknown, code: string): KodoError {
  try { action(); }
  catch (error) {
    expect(error).toBeInstanceOf(KodoError);
    expect((error as KodoError).code).toBe(code);
    return error as KodoError;
  }
  throw new Error(`expected KodoError ${code}`);
}
function workspace(root: string): void {
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src/retry.ts'), 'export const backoff = (n: number) => 2 ** n * 100;\n');
}

describe('explore: read-only delegation in one control call', () => {
  it('creates one scoped read-only child per task and registers an all-wait in the same transaction', () => {
    const { app, runId } = fixture();
    const tasks = [
      { prompt: 'Find where retries are configured', scope: ['src'], thoroughness: 'quick' },
      { prompt: 'Map the storage module' },
      { prompt: 'List the CLI entry points', thoroughness: 'thorough' },
      { prompt: 'Locate the web server routes', scope: ['src/web'] },
    ];
    const result = operation(app, runId, 'explore', { tasks }) as { status: string; waitId: string; runs: { id: string }[] };
    expect(result.status).toBe('wait_registered');
    expect(result.runs).toHaveLength(4);
    const children = result.runs.map(child => app.store.run(child.id));
    for (const child of children) {
      expect(child.parentId).toBe(runId);
      expect(child.permissions).toEqual(['read']);
      expect(child.scope?.write).toEqual([]);
      expect(child.card.tools.every(name => nativeRead.includes(name))).toBe(true);
      expect(child.card.tools).toContain('file.read');
      expect(child.card.skills).toEqual([]);
      expect(child.explore).toMatchObject({ callId: 'explore-call' });
      const packet = JSON.stringify(app.store.readBlob<Message[]>(child.contextRef));
      expect(packet).toContain('no JSON contract is required');
      expect(packet).not.toContain('Exploration result contract');
    }
    expect(children[0]!.scope?.read).toEqual(['src']);
    expect(children[1]!.scope?.read).toBeUndefined();
    expect(children.map(child => child.explore!.thoroughness)).toEqual(['quick', 'medium', 'thorough', 'medium']);
    const wait = app.store.wait(result.waitId);
    expect(wait).toMatchObject({ runId, mode: 'all', status: 'registered', runIds: children.map(child => child.id) });
    expect(app.store.run(runId).waitId).toBe(wait.id);
  });

  it('rejects a batch over remaining child capacity explicitly and creates nothing', () => {
    const root = temp();
    const app = new App(path.join(root, '.state'), scripted(), undefined, { taskProtocol: 1, toolProfile: 'full', agentFactors: { B: false } });
    try {
      const run = app.createRun({ objective: 'Investigate', workspace: root, binding, budget: { maxChildren: 2 } });
      const error = expectKodo(() => operation(app, run.id, 'explore', { tasks: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] }), 'CHILD_BUDGET');
      expect(error.message).toContain('only 2 child slots remain');
      expect(app.store.listRuns(run.sessionId)).toHaveLength(1);
      expect(app.store.run(run.id).waitId).toBeUndefined();
      expectKodo(() => operation(app, run.id, 'explore', { tasks: Array.from({ length: 5 }, (_, index) => ({ prompt: `q${index}` })) }), 'TOOL_ARGUMENTS');
      expectKodo(() => operation(app, run.id, 'explore', { tasks: [{ prompt: '   ' }] }), 'TOOL_ARGUMENTS');
      const child = operation(app, run.id, 'explore', { tasks: [{ prompt: 'one' }] }) as { runs: { id: string }[] };
      expectKodo(() => operation(app, child.runs[0]!.id, 'explore', { tasks: [{ prompt: 'nested' }] }), 'ROLE_DENIED');
    } finally { app.close(); }
  });

  it.each([
    ['explore before another call', [call('explore', { tasks: [{ prompt: 'x' }] }, 'explore'), call('file.list', { path: '.' }, 'list')]],
    ['explore with another control', [call('explore', { tasks: [{ prompt: 'x' }] }, 'explore'), call('wait_for_events', { run_ids: ['placeholder'] }, 'wait')]],
  ] as const)('rejects the entire batch with CONTROL_BATCH: %s', async (_label, requests) => {
    const { app, runId } = fixture(scripted(calls(...requests), async request => {
      const results = request.messages.filter(message => message.role === 'tool');
      expect(results).toHaveLength(requests.length);
      for (const result of results) expect(result.content).toContain('CONTROL_BATCH');
      return answer('batch rejected');
    }));
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.listRuns(app.store.run(runId).sessionId)).toHaveLength(1);
  });

  it('delivers every free-text report once in the next main input, so the main agent finishes in two model calls', async () => {
    const markers = [`MARK-${Math.random().toString(36).slice(2)}`, `MARK-${Math.random().toString(36).slice(2)}`];
    let mainCalls = 0;
    let finalInput: Request | undefined;
    const provider: Provider = { async complete(request) {
      const run = owner(app, request);
      if (run.parentId) {
        // Runtime history and collaboration tools remain; no host tool can change files or run processes.
        if (request.tools.some(tool => /patch|exec|write|mkdir|rename|delete|spawn|explore|web|lsp|todo|agent\./.test(tool.name))) throw new Error(`explore child received a mutating tool: ${request.tools.map(tool => tool.name).join(', ')}`);
        if (run.step === 0) return calls(call('file.read', { path: 'src/retry.ts' }, 'read'));
        const index = app.store.listRuns(run.sessionId).filter(child => child.parentId).findIndex(child => child.id === run.id);
        return answer(`Conclusion: backoff is exponential. Key file: src/retry.ts:1. Marker ${markers[index]}. Unresolved: none.`);
      }
      mainCalls++;
      if (run.step === 0) return calls(call('explore', { tasks: [{ prompt: 'How is retry backoff computed?', scope: ['src'] }, { prompt: 'Where is backoff exported?', scope: ['src'], thoroughness: 'quick' }] }, 'explore'));
      finalInput = request;
      const text = request.messages.map(message => message.content ?? '').join('\n');
      return answer(`Backoff is exponential (${markers.filter(marker => text.includes(marker)).join(', ')}).`);
    } };
    const { app, root, runId } = fixture(provider, ['read']);
    workspace(root);
    const completed = await app.run(runId);
    expect(completed.status, completed.error).toBe('completed');
    expect(mainCalls).toBe(2);
    const final = app.store.readBlob<{ text: string }>(completed.resultRef!).text;
    for (const marker of markers) {
      expect(final).toContain(marker);
      const occurrences = finalInput!.messages.map(message => message.content ?? '').join('\n').split(marker).length - 1;
      expect(occurrences).toBe(1);
    }
    const children = app.store.listRuns(completed.sessionId).filter(child => child.parentId);
    for (const child of children) {
      expect(child.status).toBe('completed');
      const note = JSON.parse(app.store.message(`terminal:${child.id}`)!.content) as Record<string, unknown>;
      expect(note).toMatchObject({ runId: child.id, status: 'completed', reportTruncated: false, inspect: { run_id: child.id } });
      expect(note.report).toContain('Key file: src/retry.ts:1');
      expect(note).not.toHaveProperty('summary');
      expect(note).not.toHaveProperty('next');
    }
  });

  it('truncates an oversized report at the delivery bound and points at the rest through inspect_run', async () => {
    const long = `${'Finding line. '.repeat(1000)}TAIL`;
    const provider: Provider = { async complete(request) {
      const run = owner(app, request);
      if (run.parentId) return answer(long);
      if (run.step === 0) return calls(call('explore', { tasks: [{ prompt: 'Survey the repository' }] }, 'explore'));
      return answer('Read the report.');
    } };
    const { app, runId } = fixture(provider, ['read']);
    expect((await app.run(runId)).status).toBe('completed');
    const child = app.store.listRuns(app.store.run(runId).sessionId).find(candidate => candidate.parentId)!;
    const note = JSON.parse(app.store.message(`terminal:${child.id}`)!.content) as { report: string; reportTruncated: boolean; next: { run_id: string; content_offset: number; max_chars: number } };
    expect(note.report).toHaveLength(exploreReportChars);
    expect(note.reportTruncated).toBe(true);
    expect(note.next).toEqual({ run_id: child.id, content_offset: exploreReportChars, max_chars: exploreReportChars });
    const rest = operation(app, runId, 'inspect_run', note.next) as { result: { text: string; complete: boolean } };
    expect(note.report + rest.result.text).toBe(long);
    expect(rest.result.complete).toBe(true);
  });

  it('gives each child an end condition and maps depth to the kind of question', () => {
    const { app, runId } = fixture();
    const result = operation(app, runId, 'explore', { tasks: [{ prompt: 'Where is the report bound defined?', thoroughness: 'quick' }] }) as { runs: { id: string }[] };
    const packet = JSON.stringify(app.store.readBlob<Message[]>(app.store.run(result.runs[0]!.id).contextRef));
    expect(packet).toContain('quick (fact lookup)');
    expect(packet).toContain('Stop as soon as the evidence answers the question');
    expect(packet).toContain('report what stays unresolved');
    expect(app.coordinator.mailbox.specs(app.store.run(runId)).find(spec => spec.name === 'explore')!.description).toContain('thorough only for cross-module conflicts');
  });

  it('delivers a failed child as failed beside a completed report, each once, without widening permissions', async () => {
    let finalInput: Request | undefined;
    const provider: Provider = { async complete(request) {
      const run = owner(app, request);
      if (run.parentId) {
        const first = app.store.listRuns(run.sessionId).filter(child => child.parentId)[0]!.id === run.id;
        if (first) return answer('Conclusion: not found in src. Searched: src/retry.ts. Unresolved: the limit may live outside the read scope.');
        throw new Error('child provider failure');
      }
      if (run.step === 0) return calls(call('explore', { tasks: [{ prompt: 'Find the limit', scope: ['src'], thoroughness: 'quick' }, { prompt: 'Find the caller', scope: ['src'] }] }, 'explore'));
      if (run.step === 1) {
        finalInput = request;
        const failed = app.store.listRuns(run.sessionId).find(child => child.parentId === run.id && child.status === 'failed')!;
        return calls(call('inspect_run', { run_id: failed.id }, 'inspect-failed-child'));
      }
      return answer('One report unresolved, one child failed.');
    } };
    const { app, root, runId } = fixture(provider, ['read']);
    workspace(root);
    const completed = await app.run(runId);
    expect(completed.status, completed.error).toBe('completed');
    const children = app.store.listRuns(completed.sessionId).filter(child => child.parentId);
    expect(children.map(child => child.status).sort()).toEqual(['completed', 'failed']);
    for (const child of children) expect(child.permissions).toEqual(['read']);
    const notes = children.map(child => JSON.parse(app.store.message(`terminal:${child.id}`)!.content) as { status: string; report: string });
    // Untyped provider errors are sanitized by the runtime; the note carries the recorded run error.
    const failed = children.find(child => child.status === 'failed')!;
    expect(failed.error).toBeTruthy();
    expect(app.store.calls(runId).find(operation => operation.name === 'inspect_run')?.status).toBe('succeeded');
    expect(notes.find(note => note.status === 'failed')!.report).toBe(failed.error);
    expect(notes.find(note => note.status === 'completed')!.report).toContain('Unresolved: the limit may live outside the read scope');
    const text = finalInput!.messages.map(message => message.content ?? '').join('\n');
    expect(text.split('Unresolved: the limit may live outside').length - 1).toBe(1);
  });

  it('delivers a cancelled child as cancelled while its sibling report still arrives', async () => {
    let finalInput: Request | undefined;
    const provider: Provider = { async complete(request, signal) {
      const run = owner(app, request);
      if (run.parentId) {
        if (run.objective.includes('slow')) {
          // Cancel this child while its model call is in flight.
          setTimeout(() => { app.coordinator.cancel(run.id); }, 20);
          return await new Promise<never>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
          });
        }
        return answer('Conclusion: backoff is exponential. Key file: src/retry.ts:1. Unresolved: none.');
      }
      if (run.step === 0) return calls(call('explore', { tasks: [{ prompt: 'slow survey', scope: ['src'] }, { prompt: 'Find backoff', scope: ['src'], thoroughness: 'quick' }] }, 'explore'));
      finalInput = request;
      return answer('One report arrived; the other child was cancelled.');
    } };
    const { app, root, runId } = fixture(provider, ['read']);
    workspace(root);
    const completed = await app.run(runId);
    expect(completed.status, completed.error).toBe('completed');
    const children = app.store.listRuns(completed.sessionId).filter(child => child.parentId);
    expect(children.map(child => child.status).sort()).toEqual(['cancelled', 'completed']);
    const notes = children.map(child => JSON.parse(app.store.message(`terminal:${child.id}`)!.content) as { status: string; report: string });
    expect(notes.map(note => note.status).sort()).toEqual(['cancelled', 'completed']);
    const text = finalInput!.messages.map(message => message.content ?? '').join('\n');
    expect(text.split('backoff is exponential').length - 1).toBe(1);
  });

  it('keeps an out-of-scope read denied and lets the child report the gap as unresolved', async () => {
    let finalInput: Request | undefined;
    let deniedResult = '';
    const provider: Provider = { async complete(request) {
      const run = owner(app, request);
      if (run.parentId) {
        if (run.step === 0) return calls(call('file.read', { path: 'docs/limits.md' }, 'outside'));
        deniedResult = String(request.messages.findLast(message => message.role === 'tool')?.content ?? '');
        return answer('Conclusion: not answered. docs/limits.md is outside my read scope (src). Unresolved: the limit, which needs docs/ access.');
      }
      if (run.step === 0) return calls(call('explore', { tasks: [{ prompt: 'Find the documented limit', scope: ['src'], thoroughness: 'quick' }] }, 'explore'));
      finalInput = request;
      return answer('The limit needs docs/ access; the child could not read it.');
    } };
    const { app, root, runId } = fixture(provider, ['read']);
    workspace(root);
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'docs/limits.md'), 'LIMIT-SECRET-VALUE 42\n');
    const completed = await app.run(runId);
    expect(completed.status, completed.error).toBe('completed');
    expect(deniedResult).toContain('FILE_SCOPE');
    expect(deniedResult).not.toContain('LIMIT-SECRET-VALUE');
    const child = app.store.listRuns(completed.sessionId).find(candidate => candidate.parentId)!;
    expect(child.scope).toEqual({ read: ['src'], write: [] });
    expect(child.permissions).toEqual(['read']);
    const text = finalInput!.messages.map(message => message.content ?? '').join('\n');
    expect(text).toContain('Unresolved: the limit, which needs docs/ access.');
    expect(text).not.toContain('LIMIT-SECRET-VALUE');
  });

  it('keeps the bounded summary for ordinary spawned children', () => {
    const { app, runId } = fixture();
    const spawned = operation(app, runId, 'spawn_agent', { objective: 'Write tests', scope: { write: ['tests'] } }) as { id: string };
    expect(app.store.run(spawned.id).explore).toBeUndefined();
    app.store.updateRun(spawned.id, { status: 'completed', resultRef: app.store.blob({ text: 'y'.repeat(3000) }) });
    app.coordinator.mailbox.onTerminal(spawned.id);
    const note = JSON.parse(app.store.message(`terminal:${spawned.id}`)!.content) as { summary: string; summaryTruncated: boolean };
    expect(note.summary).toHaveLength(1200);
    expect(note.summaryTruncated).toBe(true);
    expect(note).not.toHaveProperty('report');
  });

  it('plans before delegating and distinguishes asynchronous members from explore waits', () => {
    const { app, runId } = fixture(undefined, undefined, { agentFactors: { B: true } });
    const system = app.store.readBlob<Message[]>(app.store.run(runId).contextRef)[0]!.content;
    expect(system).toContain('Start each request with a brief plan');
    expect(system).toContain('Delegate substantial separable work');
    expect(system).toContain('spawn_agent for asynchronous read, review or implementation tasks');
    expect(system).toContain('explore when you want to dispatch read-only investigations and wait for all reports');
    expect(system).toContain('Reuse a suitable idle teammate with followup_task');
    expect(system).toContain('Keep coupled implementation and its checks with one owner');
    expect(system).toContain('Answer simple questions directly when the required facts are already available');
    expect(system).not.toContain('three or more files');
    expect(system).toContain('Parallel writes require disjoint scopes and agreed interfaces');
    const wording = [system, spawnAgentSpec.description, delegationGuidance].join('\n');
    expect(wording.split('Start each request with a brief plan').length - 1).toBe(1);
    for (const repeated of ['tightly coupled', 'small or', 'fill capacity', 'flood your context']) expect(wording).not.toContain(repeated);
    const specs = app.coordinator.mailbox.specs(app.store.run(runId)).map(spec => spec.name);
    expect(specs.filter(name => name === 'explore')).toHaveLength(1);
    expect(specs.filter(name => name === 'spawn_agent')).toHaveLength(1);
    expect(specs).not.toContain('exploration.plan');
    expect(specs.indexOf('explore')).toBeLessThan(specs.indexOf('spawn_agent'));
  });

  it('stays offered on the last call an explicit cap allows', async () => {
    const root = temp();
    const app = new App(path.join(root, '.state'), scripted(
      async request => {
        expect(request.tools.map(tool => tool.name)).toContain('explore');
        return answer('Finished without new exploration.');
      },
    ), undefined, { taskProtocol: 1, toolProfile: 'full' });
    try {
      const run = app.createRun({ objective: 'Finish now.', workspace: root, binding, budget: { maxTokens: 200_000, maxModelCalls: 1 } });
      expect((await app.run(run.id)).status).toBe('completed');
      expect(app.store.listRuns(run.sessionId)).toHaveLength(1);
    } finally { await app.shutdown(); }
  });
});
