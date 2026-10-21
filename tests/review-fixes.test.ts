import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application, defaultBudget, parseCard } from '../src/application/index.js';
import { Store, digest } from '../src/storage/index.js';
import { KodoError } from '../src/runtime/types.js';
import type { Message, Run, Wait } from '../src/runtime/types.js';
import { estimateTextTokens } from '../src/runtime/context-tokens.js';
import { buildContext } from '../src/runtime/context.js';
import { terminalText } from '../src/cli/terminal.js';
import { answer, binding, call, calls, fixture, scripted, temp } from './helpers.js';

const signal = (): AbortSignal => new AbortController().signal;
function operation(app: Application, id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return app.store.transaction(() => app.coordinator.mailbox.execute(app.store.run(id), `${id}:${name}`, name, app.coordinator.mailbox.validate(app.store.run(id), name, JSON.stringify(args)))) as Record<string, unknown>;
}
function waiting(app: Application, id: string, args: Record<string, unknown>): Wait {
  const result = operation(app, id, 'wait_for_events', args);
  const wait = app.store.wait(result.waitId as string);
  if (wait.status === 'registered') app.store.updateRun(id, { status: 'waiting' });
  return wait;
}

describe('review regressions', () => {
  it.each(['timeout', 'cancel'])('keeps a queued write safe on %s while the workspace is locked', async reason => {
    const { app, root, runId } = fixture(scripted(calls(call('file.apply_patch', { path: 'never.txt', expectedHash: null, content: 'no' })), answer()), ['read', 'write', 'exec']);
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, toolTimeoutMs: 30 } });
    const blocker = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const holding = app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] }, blocker.signal, entered);
    await started;
    const off = app.store.subscribe(event => { if (reason === 'cancel' && event.type === 'tool.started') app.coordinator.cancel(runId); });
    try {
      const run = await app.run(runId);
      expect(run.status).toBe(reason === 'cancel' ? 'cancelled' : 'completed');
      const write = app.store.calls(runId).find(item => item.kind === 'tool')!;
      expect(write.effectState).toBe('not_started');
      expect(['failed', 'cancelled']).toContain(write.status);
      expect(app.store.unresolvedWrites()).toEqual([]);
      expect(existsSync(path.join(root, 'never.txt'))).toBe(false);
    } finally { off(); blocker.abort(); await holding; }
  });

  it('allows unrelated workspaces to write while another workspace holds a write lock', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec']);
    const other = temp();
    const run = app.createRun({ objective: 'other workspace', workspace: other, binding, permissions: ['read', 'write'] });
    const controller = new AbortController();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const holding = app.coordinator.tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] }, controller.signal, entered);
    await started;
    try {
      await app.coordinator.tools.execute(run.id, 'file.apply_patch', { path: 'parallel.txt', expectedHash: null, content: 'ok' }, AbortSignal.timeout(1000));
      expect(readFileSync(path.join(other, 'parallel.txt'), 'utf8')).toBe('ok');
    } finally { controller.abort(); await holding; }
  });

  it('recovers a persisted pre-effect call without requiring reconciliation', () => {
    const { app, runId } = fixture();
    const requestRef = app.store.blob(call('file.apply_patch', { path: 'not-started.txt', expectedHash: null, content: 'ok' }));
    app.store.putCall({ id: 'queued-at-crash', runId, step: 0, kind: 'tool', name: 'file.apply_patch', status: 'running', effect: 'write', effectState: 'not_started', requestRef, reservedTokens: 0 });
    app.store.updateRun(runId, { status: 'interrupted' });
    expect(app.store.unresolvedWrites()).toEqual([]);
    app.coordinator.classifyRecovery(runId);
    expect(app.store.call('queued-at-crash').status).toBe('planned');
  });

  it('times out host-declared read-only commands without write barriers and rejects argument escalation', async () => {
    const root = temp();
    const command = { program: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] };
    const app = new Application(path.join(root, 'state'), scripted(calls(call('process.run', command)), answer()), undefined, { readOnlyCommands: [command] });
    try {
      const run = app.createRun({ objective: 'read-only timeout', workspace: root, binding, budget: { toolTimeoutMs: 30 } });
      expect((await app.run(run.id)).status).toBe('completed');
      expect(app.store.unresolvedWrites()).toEqual([]);
      expect(app.store.calls(run.id).find(item => item.name === 'process.run')?.effect).toBe('read');
      await expect(app.coordinator.tools.execute(run.id, 'process.run', { ...command, args: ['-e', 'process.exit(0)'] }, signal())).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    } finally { await app.shutdown(); }
  });

  it('lets a healthy peer use the model slot during another run retry backoff', async () => {
    let mainId = '';
    let attempts = 0;
    let retrying!: () => void;
    const retry = new Promise<void>(resolve => { retrying = resolve; });
    const { app, runId } = fixture({ async complete(request) {
      if (request.messages[0]!.content!.includes(mainId) && ++attempts === 1) throw new KodoError('MODEL_RATE_LIMIT', 'limited', { usageKnownZero: true, retryAfterMs: 300 });
      return answer();
    } });
    mainId = runId;
    const main = app.store.run(runId);
    const session = app.store.session(main.sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxConcurrentModels: 1 } });
    const peer: Run = { ...main, id: 'healthy-peer', parentId: main.id, contextRef: app.store.blob([{ role: 'system', content: 'healthy peer' }, { role: 'user', content: 'finish' }]) };
    app.store.putRun(peer);
    const off = app.store.subscribe(event => { if (event.type === 'model.retry') retrying(); });
    const running = app.coordinator.wake(mainId);
    try {
      await retry;
      expect((await app.coordinator.wake(peer.id)).status).toBe('completed');
      expect(attempts).toBe(1);
      expect((await running).status).toBe('completed');
    } finally { off(); await running; }
  });

  it.each(['any', 'question'])('does not settle an unrelated parent %s wait on a child cycle', mode => {
    const { app, runId } = fixture();
    const spawn = (): string => operation(app, runId, 'spawn_agent', { objective: 'independent work' }).id as string;
    const [a, b, healthy] = [spawn(), spawn(), spawn()] as [string, string, string];
    let args: Record<string, unknown> = { run_ids: [a, healthy], mode: 'any' };
    if (mode === 'question') {
      const q = operation(app, runId, 'send_message', { to: healthy, kind: 'question', content: 'Need evidence' }).id as string;
      args = { question_ids: [q] };
    }
    const parent = waiting(app, runId, args);
    waiting(app, a, { run_ids: [b] });
    waiting(app, b, { run_ids: [a] });
    expect(app.store.wait(parent.id).status).toBe('registered');
    expect(app.store.events(a).some(event => event.type === 'wait.deadlock')).toBe(true);
  });

  it('aborts an in-flight provider on permission revocation', async () => {
    let entered!: () => void;
    let aborted = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { app, runId } = fixture({ complete: async (_request, abort) => {
      entered();
      return await new Promise((_resolve, reject) => abort.addEventListener('abort', () => { aborted = true; reject(abort.reason); }, { once: true }));
    } });
    const running = app.coordinator.wake(runId);
    await started;
    app.updatePermissions(runId, ['read']);
    await running;
    expect(aborted).toBe(true);
    expect(app.store.calls(runId)[0]!.status).toBe('cancelled');
  });

  it('collects only unreachable blobs, keeping recursive archives and artifacts', () => {
    const { app, runId } = fixture();
    const leaf = app.store.blob({ text: 'verbatim evidence' });
    const nested = app.store.blob({ messages: [{ content: JSON.stringify({ history: { ref: leaf } }) }] });
    app.store.event(runId, 'context.compacted', { archivedRef: nested });
    const artifact = app.store.blob({ content: 'report' });
    app.store.artifact(runId, artifact);
    const orphan = app.store.blob({ uncommitted: true });
    const report = app.store.gc({ vacuum: true });
    expect(report.removedBlobs).toBe(1);
    expect(existsSync(path.join(app.store.directory, 'blobs', `${orphan}.json`))).toBe(false);
    expect(app.store.readBlob(leaf)).toEqual({ text: 'verbatim evidence' });
    expect(app.store.readBlob(artifact)).toEqual({ content: 'report' });
    app.store.updateRun(runId, { status: 'running' });
    expect(() => app.store.gc()).toThrow('stop active execution');
    app.store.updateRun(runId, { status: 'queued' });
  });

  it('expires terminal sessions only after their last activity, never unresolved writes', () => {
    const { app, runId } = fixture();
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, createdAt: '2020-01-01T00:00:00Z' });
    app.store.updateRun(runId, { status: 'completed' });
    expect(app.store.gc({ olderThanDays: 1 }).removedSessions).toBe(0);
    app.store.db.prepare('UPDATE events SET time=?').run('2020-01-01T00:00:00Z');
    const requestRef = app.store.blob({ unknown: true });
    app.store.putCall({ id: 'legacy-unknown', runId, step: 0, kind: 'tool', name: 'process.exec', status: 'unknown', effect: 'write', requestRef, reservedTokens: 0 });
    expect(app.store.gc({ olderThanDays: 1 }).removedSessions).toBe(0);
    app.store.putCall({ ...app.store.call('legacy-unknown'), status: 'succeeded' });
    expect(app.store.gc({ olderThanDays: 1 }).removedSessions).toBe(1);
  });

  it('cleans crash temporary blobs after obtaining exclusive directory ownership', () => {
    const directory = path.join(temp(), 'state');
    const store = new Store(directory);
    store.close();
    const file = path.join(directory, 'blobs', `${'a'.repeat(64)}.11111111-1111-1111-1111-111111111111.tmp`);
    writeFileSync(file, 'partial');
    const reopened = new Store(directory);
    try { expect(existsSync(file)).toBe(false); } finally { reopened.close(); }
  });

  it('queries the inbox and write barrier without scanning unrelated runs or session messages', () => {
    const { app, runId } = fixture();
    const run = app.store.run(runId);
    app.store.putMessage({ id: 'input', sessionId: run.sessionId, from: 'user', to: runId, kind: 'input', content: 'new' });
    vi.spyOn(app.store, 'messages').mockImplementation(() => { throw new Error('full message scan'); });
    vi.spyOn(app.store, 'listRuns').mockImplementation(() => { throw new Error('full run scan'); });
    expect(app.store.inbox(runId).map(message => message.id)).toEqual(['input']);
    expect(app.store.unresolvedWrites()).toEqual([]);
  });

  it('uses model limits and a token window without a hidden character ceiling', () => {
    const { app, runId } = fixture();
    expect(defaultBudget.maxTokens).toBeNull();
    expect(defaultBudget.toolTimeoutMs).toBeGreaterThan(31_820);
    expect(estimateTextTokens('中'.repeat(1000))).toBeGreaterThanOrEqual(1000);
    expect(estimateTextTokens('中'.repeat(1000))).toBeLessThan(1600);
    const run = app.store.run(runId);
    const context: Message[] = [...app.store.readBlob<Message[]>(run.contextRef), { role: 'assistant', content: 'readable text '.repeat(6000) }];
    const next = { ...run, contextRef: app.store.blob(context) };
    expect(buildContext(app.store, next, defaultBudget.maxContextChars, [], app.store.session(run.sessionId).budget).archivedRef).toBeUndefined();
    expect(() => app.createRun({ objective: 'invalid', workspace: app.store.session(run.sessionId).workspace, binding, budget: { maxOutputTokens: 100, maxContextTokens: 100 } })).toThrow('leave room');
  });

  it('hashes actual BOM bytes and round-trips BOM through read and patch', async () => {
    const { app, root, runId } = fixture();
    const original = '\uFEFF中文\n';
    writeFileSync(path.join(root, 'bom.txt'), original);
    const page = await app.coordinator.tools.execute(runId, 'file.read', { path: 'bom.txt' }, signal()) as { content: string; hash: string };
    expect(page.hash).toBe(digest(original));
    expect(page.hash).not.toBe(digest(original.slice(1)));
    expect(page.content).toBe(original);
    await expect(app.coordinator.tools.execute(runId, 'file.apply_patch', { path: 'bom.txt', expectedHash: digest(original.slice(1)), content: 'bad' }, signal())).rejects.toMatchObject({ code: 'FILE_CONFLICT' });
    await app.coordinator.tools.execute(runId, 'file.apply_patch', { path: 'bom.txt', expectedHash: page.hash, content: page.content.replace('中文', '修改') }, signal());
    expect(readFileSync(path.join(root, 'bom.txt'), 'utf8')).toBe('\uFEFF修改\n');
  });

  it.each(['secret.pem', '.npmrc', '.aws/credentials', '.ssh/config'])('denies protected path %s', async target => {
    const { app, root, runId } = fixture();
    mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
    writeFileSync(path.join(root, target), 'secret');
    await expect(app.coordinator.tools.execute(runId, 'file.read', { path: target }, signal())).rejects.toMatchObject({ code: 'PATH_DENIED' });
  });

  it('rejects unknown card tool names and strips terminal controls including split escapes', () => {
    expect(() => parseCard('---\nschema_version: 1\nid: test/card\nversion: 1.0.0\nname: test\ndescription: test\ncapabilities:\n  tools: [file.raed]\n---\nRead files')).toThrow('unsupported or invalid');
    expect(terminalText('\u001b[2J\u001b]0;spoof\u0007safe\r\n')).toBe('safe\n');
    expect(terminalText('\u001b[') + terminalText('2Jsafe')).not.toContain('\u001b');
  });
});
