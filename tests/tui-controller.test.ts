import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PackageRegistry } from '../src/packages/registry.js';
import { TuiController } from '../src/tui/controller.js';
import { mainCommands, parseCommand, quoteArgument } from '../src/tui/commands.js';
import type { TuiOptions } from '../src/tui/types.js';
import type { ApplicationOptions, CreateRunOptions } from '../src/application/index.js';
import type { Call, ModelResponse, Provider } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, scripted, temp } from './helpers.js';

const controllers: TuiController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.close(); });
function setup(provider: Provider = scripted(answer()), extra: Partial<TuiOptions> = {}, runtime: ApplicationOptions = {}) {
  const env = fixture(provider, ['read', 'write', 'exec'], runtime);
  const controller = new TuiController({ app: env.app, workspace: env.root, binding, permissions: ['read', 'write', 'exec'], permissionMode: 'yolo', registry: new PackageRegistry(path.join(env.root, '.packages')), restore: () => {}, ...extra });
  controllers.push(controller);
  return { ...env, controller };
}
async function open(env: ReturnType<typeof setup>) { await env.controller.submit(`/resume ${env.runId}`); }
async function settled(controller: TuiController) { await expect.poll(() => controller.snapshot().busy, { timeout: 3000 }).toBe(false); }

describe('TUI application controller', () => {
  it('opens local pages and the twelve-command menu without creating a run or calling a model', async () => {
    const complete = vi.fn<Provider['complete']>(); const env = setup({ complete });
    for (const command of ['/help', '/help keys', '/model', '/settings', '/status', '/resume', '/agents']) await env.controller.submit(command);
    expect(complete).not.toHaveBeenCalled();
    expect(env.app.runs().items).toHaveLength(1);
    await env.controller.submit('/help');
    expect(mainCommands).toHaveLength(12);
    expect(env.controller.snapshot().panel?.items).toHaveLength(12);
    await expect(env.controller.submit('/not-a-command')).rejects.toThrow('Unknown command');
    expect(env.controller.snapshot().notice).toContain('Unknown command');
    expect(complete).not.toHaveBeenCalled();
  });

  it('starts asynchronously, streams bounded text, and replaces it with the persisted final result', async () => {
    let finish!: (value: ModelResponse) => void;
    const env = setup({ complete: async (_request, signal) => await new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
    await env.controller.submit('实现中文输入');
    await expect.poll(() => Boolean(finish)).toBe(true);
    expect(env.controller.snapshot().busy).toBe(true);
    const runId = env.controller.snapshot().runId!;
    env.controller.onText(runId, '临时文本');
    expect(env.controller.snapshot().entries.some(entry => entry.text.includes('临时文本'))).toBe(true);
    env.controller.onText(runId, 'x'.repeat(40_000));
    expect(env.controller.snapshot().entries.find(entry => entry.id === `stream:${runId}`)?.text.length).toBeLessThanOrEqual(32_000);
    finish(answer('持久的最终交付'));
    await settled(env.controller);
    expect(env.controller.snapshot().entries.some(entry => entry.id === `stream:${runId}`)).toBe(false);
    expect(env.controller.snapshot().entries.find(entry => entry.id === `result:${runId}`)).toMatchObject({ text: '持久的最终交付', status: 'Completed · Host verification not_checked' });
    expect(env.controller.snapshot().entries.find(entry => entry.id === `result:${runId}`)?.details).toContain('Host verification: not_checked');
  });

  it('serializes rapid initial submissions into one session when host creation is asynchronous', async () => {
    const createRun = vi.fn(async (options: CreateRunOptions) => { await Promise.resolve(); return env.app.createRun(options); });
    const env = setup(scripted(answer('first'), answer('second')), { createRun });
    await Promise.all([env.controller.submit('first input'), env.controller.submit('second input')]);
    await settled(env.controller);
    expect(createRun).toHaveBeenCalledOnce();
    const sessionId = env.controller.snapshot().sessionId!;
    expect(env.app.runs().items.filter(run => run.id !== env.runId).every(run => run.sessionId === sessionId)).toBe(true);
    expect(env.app.messages(sessionId).items.some(message => message.kind === 'input' && message.content === 'second input')).toBe(true);
  });

  it('keeps a real nonzero process exit visible even when the tool call itself succeeded', async () => {
    const command = { program: process.execPath, args: ['-e', 'process.exit(1)'] };
    const env = setup(scripted(calls(call('process.run', command)), answer('The fixed command exited with code 1.')), {}, { readOnlyCommands: [command] });
    await env.controller.submit('Run the fixed host-declared command.'); await settled(env.controller);
    const runId = env.controller.snapshot().runId!;
    const recorded = env.app.store.calls(runId).find(call => call.name === 'process.run')!;
    expect(recorded.status).toBe('succeeded');
    expect(env.app.store.readBlob(recorded.resultRef!)).toMatchObject({ exitCode: 1 });
    expect(env.controller.snapshot().entries.find(entry => entry.id === `tool:${recorded.id}`)).toMatchObject({ status: 'Failed', text: expect.stringContaining('Exit code 1') });
    await env.controller.submit(`/resume ${runId}`);
    expect(env.controller.snapshot().entries.find(entry => entry.id === `tool:${recorded.id}`)?.status).toBe('Failed');
  });

  it.each([
    [{ cancelled: true }, 'Process cancelled'],
    [{ outputLimitExceeded: true }, 'result incomplete'],
    [{ passed: false }, 'Tool check failed'],
  ])('keeps incomplete or failed tool outcomes visible without copying long logs (%j)', async (result, expected) => {
    const env = setup(); await open(env);
    const recorded: Call = { id: 'recorded-outcome', runId: env.runId, kind: 'tool', name: 'verify.run', status: 'succeeded', effect: 'write', step: 0, reservedTokens: 0, requestRef: env.app.store.blob({}), resultRef: env.app.store.blob({ ...result, stdout: 'large log body'.repeat(4000) }) };
    env.app.store.putCall(recorded); env.app.store.event(env.runId, 'tool.finished', { callId: recorded.id, name: recorded.name, status: recorded.status, resultRef: recorded.resultRef });
    const entry = env.controller.snapshot().entries.find(entry => entry.id === `tool:${recorded.id}`)!;
    expect(entry.status).toBe('Failed'); expect(entry.text).toContain(expected); expect(JSON.stringify(entry)).not.toContain('large log body');
  });

  it('treats multi-line slash text as literal task content and keeps command tokenization inert', async () => {
    const env = setup(scripted(answer('收到')));
    await env.controller.submit('/paste'); await env.controller.submit('/quit confirm'); await env.controller.submit('第二行');
    expect(env.controller.snapshot().runId).toBeUndefined();
    await env.controller.submit('/send'); await settled(env.controller);
    expect(env.app.store.run(env.controller.snapshot().runId!).objective).toBe('/quit confirm\n第二行');
    expect(env.controller.snapshot().quitting).toBe(false);
    const value = 'folder with spaces\\file "quoted"';
    expect(parseCommand(`/files ${quoteArgument(value)}`)).toEqual(['/files', value]);
    expect(parseCommand('/files "$(do-not-execute)"')).toEqual(['/files', '$(do-not-execute)']);
    expect(() => parseCommand('/files "missing')).toThrow('Unclosed quote');
  });

  it('browses a persisted session without running it and requires its original host configuration before execution', async () => {
    const complete = vi.fn<Provider['complete']>().mockResolvedValue(answer('done'));
    const restore = vi.fn().mockRejectedValue(new Error('original host unavailable'));
    const env = setup({ complete }, { restore }); await open(env);
    expect(complete).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
    expect(env.controller.snapshot().panel?.title).toBe('Session opened');
    await expect(env.controller.submit(`/resume run ${env.runId}`)).rejects.toThrow('original host unavailable');
    expect(restore).toHaveBeenCalledOnce(); expect(complete).not.toHaveBeenCalled();
    expect(env.app.store.run(env.runId).status).toBe('queued');
  });

  it('changes models only for new sessions, and continuing a terminal run preserves its immutable record', async () => {
    const env = setup(scripted(answer('first'), answer('follow up'), answer('new session')));
    await env.controller.submit('first'); await settled(env.controller);
    const first = env.controller.snapshot().runId!;
    await env.controller.submit('/model next-model');
    expect(env.app.store.run(first).binding.model).toBe(binding.model);
    await env.controller.submit('follow up'); await settled(env.controller);
    const follow = env.app.store.run(env.controller.snapshot().runId!);
    expect(follow.continuationOf).toBe(first); expect(follow.binding.model).toBe(binding.model);
    expect(env.app.store.run(first).status).toBe('completed');
    await env.controller.submit(`/resume ${follow.id}`);
    expect(env.controller.snapshot().entries.filter(entry => entry.kind === 'assistant').map(entry => entry.text)).toEqual(expect.arrayContaining(['first', 'follow up']));
    await env.controller.submit('/new'); await env.controller.submit('new session'); await settled(env.controller);
    expect(env.app.store.run(env.controller.snapshot().runId!).binding.model).toBe('next-model');
  });

  it('edits and withdraws the deferred queue before execution, and quit confirms before interrupting', async () => {
    let started = false;
    const env = setup({ complete: async (_request, signal) => { started = true; return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
    await env.controller.submit('active task'); await expect.poll(() => started).toBe(true);
    await env.controller.submit('/next original');
    const item = env.controller.snapshot().queue[0]!;
    await env.controller.submit(`/next edit ${item.id} "edited later"`);
    expect(env.controller.snapshot().queue[0]?.content).toBe('edited later');
    await env.controller.submit(`/next remove ${item.id}`);
    expect(env.controller.snapshot().queue).toHaveLength(0);
    await env.controller.submit('/next should never execute');
    await env.controller.quit();
    expect(env.controller.snapshot().panel?.title).toBe('Exit Kodo');
    expect(env.controller.snapshot().quitting).toBe(false);
    const id = env.controller.snapshot().runId!;
    await env.controller.quit(true);
    expect(env.controller.snapshot().quitting).toBe(true);
    expect(env.controller.snapshot().queue).toHaveLength(0);
    expect(env.app.store.run(id).status).toBe('interrupted');
    expect(env.app.runs({ sessionId: env.app.store.run(id).sessionId }).items).toHaveLength(1);
    await env.controller.close(); await env.controller.close();
  });

  it('binds an answer to the chosen question ID and never guesses a question for ordinary input', async () => {
    const env = setup(scripted(answer('first task done'), answer('continued'))); await open(env);
    const sessionId = env.app.store.run(env.runId).sessionId;
    env.app.store.putMessage({ id: 'q-one', sessionId, from: env.runId, to: 'user', kind: 'question', content: 'Which target?' });
    env.app.store.putMessage({ id: 'q-two', sessionId, from: env.runId, to: 'user', kind: 'question', content: 'Which format?' });
    await env.controller.submit('/tasks answer');
    expect(env.controller.snapshot().panel?.items?.map(item => item.command)).toEqual(['/tasks answer q-one', '/tasks answer q-two']);
    await env.controller.submit('/tasks answer q-two');
    expect(env.controller.snapshot().panel?.title).toBe('Answer selected question');
    await env.controller.submit('JSON'); await settled(env.controller);
    expect(env.app.store.answer('q-two')?.content).toBe('JSON');
    expect(env.app.store.answer('q-one')).toBeUndefined();
    await env.controller.submit('ordinary follow-up'); await settled(env.controller);
    expect(env.app.store.answer('q-one')).toBeUndefined();
    expect(env.app.messages(sessionId).items.some(message => message.kind === 'input' && message.content === 'ordinary follow-up')).toBe(true);
  });

  it('does not redirect main input when viewing a child and offers no peer-message command', async () => {
    const complete = vi.fn<Provider['complete']>().mockResolvedValue(answer('done'));
    const env = setup({ complete }); await open(env);
    const main = env.app.store.run(env.runId);
    const child = env.app.spawnAgent(main.sessionId, { objective: 'Inspect the local implementation.' });
    await env.controller.submit(`/tasks show ${child.id}`);
    expect(complete).not.toHaveBeenCalled(); expect(env.controller.snapshot().runId).toBe(main.id);
    expect(env.controller.snapshot().panel?.items?.map(item => item.id)).not.toEqual(expect.arrayContaining(['message', 'interrupt']));
    await expect(env.controller.submit(`/tasks message ${child.id} "Inspect input behavior"`)).rejects.toThrow('Use /tasks');
    expect(env.app.messages(main.sessionId).items.some(message => message.to === child.id && message.from === 'user')).toBe(false);
    expect(env.controller.snapshot().runId).toBe(main.id);
  });

  it('previews uncertain effects without resolving them and requires an explicit outcome with concrete evidence', async () => {
    const env = setup(); await open(env);
    env.app.store.updateRun(env.runId, { status: 'interrupted' });
    const effect: Call = { id: 'uncertain-call', runId: env.runId, kind: 'tool', name: 'file.apply_patch', step: 0, effect: 'write', status: 'unknown', reservedTokens: 0, requestRef: env.app.store.blob(call('file.apply_patch', { path: 'result.txt', expectedHash: null, content: 'applied' })), resultRef: env.app.store.blob({ error: 'effect uncertain' }) };
    env.app.store.putCall(effect);
    await env.controller.submit('/tasks');
    expect(env.controller.snapshot().panel?.items).toEqual(expect.arrayContaining([expect.objectContaining({ command: `/tasks resolve ${effect.id}` })]));
    await env.controller.submit(`/tasks resolve ${effect.id}`);
    expect(env.controller.snapshot().panel?.title).toContain('Review effects');
    expect(env.app.store.call(effect.id).status).toBe('unknown');
    await expect(env.controller.submit(`/tasks resolve ${effect.id} applied`)).rejects.toThrow('observed evidence');
    expect(env.app.store.call(effect.id).status).toBe('unknown');
    await env.controller.submit(`/tasks resolve ${effect.id} not_applied "Inspected result.txt and the recorded workspace baseline; the requested file was not created."`);
    expect(env.app.store.events(env.runId, { types: ['recovery.resolved'] })).toHaveLength(1);
    expect(env.app.store.events(env.runId, { types: ['recovery.resolved'] })[0]?.data.outcome).toBe('not_applied');
    expect(env.app.store.readBlob(effect.resultRef!)).toEqual({ error: 'effect uncertain' });
  });

  it('recovers a failed UNKNOWN_WRITE through an immutable continuation only after explicit evidence without replaying its write', async () => {
    const provider = scripted(calls(call('host.write', {}, 'uncertain-write')), answer('Candidate completion.'), answer('Completed after verified recovery.'));
    const complete = vi.spyOn(provider, 'complete'), env = setup(provider);
    let writes = 0;
    env.app.registerTool({
      name: 'host.write', description: 'Write the local fixture marker once.', permission: 'write', effect: 'write',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => { writes++; writeFileSync(path.join(env.root, 'effect.txt'), 'applied exactly once'); throw new Error('fixture response lost after the write'); },
    });
    const card = env.app.parseCard('---\nschema_version: 1\nid: test/tui-recovery\nversion: 1.0.0\nname: TUI recovery\ndescription: Reconcile a recorded fixture write.\ncapabilities:\n  tools: [host.write]\n---\nWrite the fixture marker.');
    const run = env.app.createRun({ objective: 'Write the fixture marker once.', workspace: env.root, binding, card, permissions: ['read', 'write'] });
    const original = await env.app.run(run.id);
    expect(original).toMatchObject({ status: 'failed', error: expect.stringMatching(/^UNKNOWN_WRITE:/u) });
    const effect = env.app.store.calls(run.id).find(entry => entry.name === 'host.write')!;
    const requests = complete.mock.calls.length;
    await env.controller.submit(`/resume ${run.id}`);
    expect(env.controller.snapshot().panel?.items).toEqual([expect.objectContaining({ command: `/resume run ${run.id}` })]);
    expect(env.controller.snapshot().panel?.lines.join('\n')).toContain('/tasks resolve');
    await expect(env.controller.submit(`/resume run ${run.id}`)).rejects.toThrow('writes awaiting review');
    expect(complete).toHaveBeenCalledTimes(requests); expect(writes).toBe(1);
    expect(env.app.store.events(run.id, { types: ['recovery.continued'] })).toHaveLength(0);
    await env.controller.submit(`/tasks resolve ${effect.id} applied "Inspected effect.txt and verified the exact fixture contents were applied once."`);
    const execute = vi.spyOn(env.app.coordinator.tools, 'execute');
    await env.controller.submit(`/resume run ${run.id}`); await settled(env.controller);
    const recovered = env.app.store.run(env.controller.snapshot().runId!);
    expect(recovered).toMatchObject({ status: 'completed', continuationOf: run.id }); expect(recovered.id).not.toBe(run.id);
    expect(env.app.store.run(run.id)).toEqual(original); expect(env.app.store.call(effect.id)).toEqual(effect);
    expect(writes).toBe(1); expect(execute).not.toHaveBeenCalled();
    expect(readFileSync(path.join(env.root, 'effect.txt'), 'utf8')).toBe('applied exactly once');
  });

  it.each(['completed', 'cancelled', 'failed'] as const)('keeps ordinary %s terminal records outside explicit effect recovery', async status => {
    const complete = vi.fn<Provider['complete']>().mockResolvedValue(answer()), env = setup({ complete });
    env.app.store.updateRun(env.runId, { status, ...(status === 'failed' ? { error: 'MODEL_PROTOCOL: fixture failure' } : {}) });
    const original = env.app.store.run(env.runId);
    await open(env);
    expect(env.controller.snapshot().panel?.items).toEqual([expect.objectContaining({ id: 'follow', input: '' })]);
    await expect(env.controller.submit(`/resume run ${env.runId}`)).rejects.toThrow('An ended task cannot be reopened');
    expect(complete).not.toHaveBeenCalled(); expect(env.app.store.run(env.runId)).toEqual(original);
  });

  it('shows scoped file references, rejects traversal, and inserts paths without reading full files', async () => {
    const env = setup(); mkdirSync(path.join(env.root, 'allowed')); mkdirSync(path.join(env.root, 'private'));
    writeFileSync(path.join(env.root, 'allowed', '名字 file.ts'), 'secret body never inserted');
    writeFileSync(path.join(env.root, 'private', 'hidden.ts'), 'private');
    env.app.store.updateRun(env.runId, { scope: { read: ['allowed'] } }); await open(env);
    await env.controller.submit('/files file');
    expect(env.controller.snapshot().panel?.items).toEqual([expect.objectContaining({ input: '@"allowed/名字 file.ts"' })]);
    expect(JSON.stringify(env.controller.snapshot().panel)).not.toContain('secret body');
    await env.controller.submit('/files hidden'); expect(env.controller.snapshot().panel?.items).toEqual([]);
    await expect(env.controller.submit('/files ../outside')).rejects.toThrow('Only workspace-relative paths'); expect(env.controller.snapshot().notice).toContain('Only workspace-relative paths');
  });

  it('completes file names without changing the current panel, run or model usage', async () => {
    const complete = vi.fn<Provider['complete']>();
    const env = setup({ complete });
    mkdirSync(path.join(env.root, 'src'));
    writeFileSync(path.join(env.root, 'src', 'my file.ts'), 'private file body not loaded');
    await env.controller.submit('/help');
    const before = env.controller.snapshot(), run = env.app.store.run(env.runId);
    const items = await env.controller.completeFiles('src/my');
    expect(items).toEqual([expect.objectContaining({ id: 'src/my file.ts', input: '@"src/my file.ts"' })]);
    expect(JSON.stringify(items)).not.toContain('private file body');
    expect(env.controller.snapshot()).toEqual(before);
    expect(env.app.store.run(env.runId)).toEqual(run);
    expect(env.app.store.calls(env.runId)).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
    expect(await env.controller.completeFiles('src/missing')).toEqual([]);
  });

  it('reports unavailable file searches without changing the current UI', async () => {
    const denied = setup(scripted(), { permissions: [] });
    const before = denied.controller.snapshot();
    await expect(denied.controller.completeFiles('')).rejects.toThrow('read permission');
    expect(denied.controller.snapshot()).toEqual(before);
    const workspace = temp();
    const missing = setup(scripted(), { workspace });
    rmdirSync(workspace);
    const original = missing.controller.snapshot();
    await expect(missing.controller.completeFiles('')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(missing.controller.snapshot()).toEqual(original);
  });

  it('uses retained native checkpoints for diffs and requires confirmation before rewinding actual files', async () => {
    const env = setup(scripted(calls(call('file.apply_patch', { path: 'created.txt', expectedHash: null, content: 'created contents' })), answer('Created the file.')));
    await env.controller.submit('Create file'); await settled(env.controller);
    const id = env.controller.snapshot().runId!;
    expect(existsSync(path.join(env.root, 'created.txt'))).toBe(true);
    await env.controller.submit('/changes diff created.txt');
    expect(env.controller.snapshot().panel?.lines.join('\n')).toContain('+created contents');
    await env.controller.submit('/changes rewind -1');
    expect(existsSync(path.join(env.root, 'created.txt'))).toBe(true);
    expect(env.controller.snapshot().panel?.items?.[0]?.command).toBe('/changes rewind -1 confirm');
    await env.controller.submit('/changes rewind -1 confirm');
    expect(existsSync(path.join(env.root, 'created.txt'))).toBe(false);
    expect(env.app.store.run(id).status).toBe('completed');
    expect(env.app.store.events(id, { types: ['file.rewind.completed'] })).toHaveLength(1);
  });

  it('runs only the bound host check, records evidence, and marks results stale after another workspace write', async () => {
    const env = setup(scripted(calls(call('file.apply_patch', { path: 'tracked.txt', expectedHash: null, content: 'first' })), answer('done'))); await env.app.run(env.runId); await open(env);
    const validator = vi.fn().mockResolvedValue({ passed: true, evidence: { command: ['fixed-program', '--check'], exitCode: 0, stdout: 'verified' } });
    // Runtime registration is normally attached before completion; emulate that host-owned binding here.
    env.app.coordinator.completionValidators.set(env.runId, validator);
    await expect(env.controller.submit('/check run "arbitrary shell command"')).rejects.toThrow('commands must come from host configuration');
    expect(validator).not.toHaveBeenCalled();
    await env.controller.submit('/check run completion'); await settled(env.controller);
    expect(validator).toHaveBeenCalledOnce();
    const event = env.app.store.events(env.runId, { types: ['tui.check.finished'] })[0]!;
    expect(event.data.passed).toBe(true);
    expect(event.data.fileState).toMatchObject({ complete: true, paths: ['tracked.txt'] });
    expect(env.app.store.readBlob(event.data.evidenceRef as string)).toMatchObject({ name: 'completion', passed: true, result: { evidence: { exitCode: 0 } } });
    await env.controller.submit('/check results'); expect(env.controller.snapshot().panel?.lines.join('\n')).not.toContain('Stale result');
    writeFileSync(path.join(env.root, 'tracked.txt'), 'other');
    await env.controller.submit('/check results'); expect(env.controller.snapshot().panel?.lines.join('\n')).toContain('Stale result');
    writeFileSync(path.join(env.root, 'tracked.txt'), 'first');
    await env.controller.submit('/check results'); expect(env.controller.snapshot().panel?.lines.join('\n')).not.toContain('Stale result');
    const mutation: Call = { id: 'subsequent-workspace-write', runId: env.runId, kind: 'tool', name: 'file.apply_patch', step: 1, status: 'succeeded', effect: 'write', effectState: 'started', effectOutcome: 'applied', reservedTokens: 0, requestRef: env.app.store.blob(call('file.apply_patch', { path: 'changed.txt', expectedHash: null, content: 'later' })), resultRef: env.app.store.blob({ path: 'changed.txt' }) };
    writeFileSync(path.join(env.root, 'changed.txt'), 'later'); env.app.store.putCall(mutation); env.app.store.event(env.runId, 'files.changed', { paths: ['changed.txt'] });
    await env.controller.submit('/check results'); expect(env.controller.snapshot().panel?.lines.join('\n')).toContain('Stale result');
    expect(readFileSync(path.join(env.root, 'changed.txt'), 'utf8')).toBe('later');
  });

  it('rejects an otherwise passing host check when an observed source file changes during verification', async () => {
    const env = setup(scripted(calls(call('file.apply_patch', { path: 'source.txt', expectedHash: null, content: 'before' })), answer('done')), { completionValidator: () => async () => { writeFileSync(path.join(env.root, 'source.txt'), 'after!'); return { passed: true, evidence: { exitCode: 0 } }; } });
    await env.app.run(env.runId); await open(env);
    await env.controller.submit('/check run completion'); await settled(env.controller);
    const event = env.app.store.events(env.runId, { types: ['tui.check.finished'] })[0]!;
    expect(event.data.passed).toBe(false);
    expect(env.app.store.readBlob(event.data.evidenceRef as string)).toMatchObject({ workspaceStable: false, result: { passed: true, evidence: { exitCode: 0 } } });
  });

  it.skipIf(process.platform !== 'win32')('executes the fixed approved verify.run and persists its actual process evidence and effect state', async () => {
    const base = setup(scripted(answer('done')), {}, {
      sandbox: { network: 'none' }, verification: { enabled: true, approved: true, backend: 'native', program: process.execPath, args: ['--version'] },
    });
    // The application default card is the one that carries the host-configured verify.run.
    const env = { ...base, runId: base.app.createRun({ objective: 'Verify the project.', workspace: base.root, binding, permissions: ['read', 'write', 'exec'] }).id };
    await env.app.run(env.runId); await open(env);
    await env.controller.submit('/check run verify.run');
    await expect.poll(() => env.controller.snapshot().busy, { timeout: 30_000 }).toBe(false);
    const check = env.app.store.calls(env.runId).find(call => call.id.startsWith('tui-check:'))!;
    expect(check).toMatchObject({ name: 'verify.run', status: 'succeeded', effect: 'write', effectState: 'started', effectOutcome: 'applied' });
    const result = env.app.store.readBlob(check.resultRef!);
    expect(result).toMatchObject({ passed: true, complete: true, attempts: [{ exitCode: 0, stdout: expect.stringMatching(/^v24\./u) }] });
    expect(env.app.store.events(env.runId, { types: ['tui.check.finished'] })[0]?.data.passed).toBe(true);
  }, 35_000);

  it('aborts an explicit host check on confirmed quit without draining its deferred queue', async () => {
    let checking = false;
    const env = setup(scripted(answer('done')), { completionValidator: () => async ({ signal }) => { checking = true; return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
    await env.app.run(env.runId); await open(env);
    await env.controller.submit('/check run completion'); await expect.poll(() => checking).toBe(true);
    await env.controller.submit('/next must not run');
    await env.controller.quit(); expect(env.controller.snapshot().quitting).toBe(false);
    await env.controller.quit(true); expect(env.controller.snapshot().quitting).toBe(true);
    expect(env.controller.snapshot().queue).toHaveLength(0);
    expect(env.app.runs({ sessionId: env.app.store.run(env.runId).sessionId }).items).toHaveLength(1);
    expect(env.app.store.events(env.runId, { types: ['tui.check.finished'] })[0]?.data.passed).toBe(false);
  });

  it.each(['bound', 'explicit'] as const)('requires the original host binding before answering a persisted question (%s)', async mode => {
    const complete = vi.fn<Provider['complete']>().mockResolvedValue(answer());
    const restore = vi.fn().mockRejectedValue(new Error('original host binding missing'));
    const env = setup({ complete }, { restore }); await open(env);
    env.app.store.putMessage({ id: 'saved-question', sessionId: env.app.store.run(env.runId).sessionId, from: env.runId, to: 'user', kind: 'question', content: 'Which target?' });
    if (mode === 'bound') await env.controller.submit('/tasks answer saved-question');
    await expect(env.controller.submit(mode === 'bound' ? 'chosen answer' : '/tasks answer saved-question "chosen answer"')).rejects.toThrow('original host binding missing');
    expect(env.app.store.answer('saved-question')).toBeUndefined(); expect(complete).not.toHaveBeenCalled();
  });

  it('retains earlier durable evidence beyond two thousand unrelated events and provides actual history pages', async () => {
    const env = setup(), store = env.app.store;
    const recorded: Call = { id: 'early-tool', runId: env.runId, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', step: 0, reservedTokens: 0, requestRef: store.blob(call('file.read', { path: 'read.txt' })), resultRef: store.blob({ content: 'retained evidence body' }) };
    store.putCall(recorded); store.event(env.runId, 'tool.finished', { callId: recorded.id, name: recorded.name });
    store.transaction(() => { for (let index = 0; index < 2100; index++) store.event(env.runId, 'fixture.tick', { index }); });
    await open(env);
    expect(env.controller.snapshot().entries.some(entry => entry.id === 'tool:early-tool')).toBe(true);
    await env.controller.submit('/tasks history');
    expect(env.controller.snapshot().panel?.items).toEqual(expect.arrayContaining([expect.objectContaining({ command: `/tasks evidence ${env.runId} early-tool` })]));
    const next = env.controller.snapshot().panel?.items?.find(item => item.id === 'next')?.command;
    expect(next).toMatch(/^\/tasks history \d+$/u);
    const first = env.controller.snapshot().panel?.lines.join('\n'); await env.controller.submit(next!);
    expect(env.controller.snapshot().panel?.lines.join('\n')).not.toBe(first);
    expect(store.run(env.runId).status).toBe('queued');
  });

  it('finds an uncertain write after the first thousand calls without scanning provider records into the UI', async () => {
    const env = setup(), store = env.app.store;
    store.transaction(() => {
      for (let index = 0; index < 1001; index++) store.putCall({ id: `early-${index}`, runId: env.runId, kind: 'tool', name: 'file.read', step: 0, status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef: store.blob({}) });
      store.putCall({ id: 'late-unknown', runId: env.runId, kind: 'tool', name: 'file.apply_patch', step: 1, status: 'unknown', effect: 'write', reservedTokens: 0, requestRef: store.blob({}) });
    });
    await open(env); await env.controller.submit('/tasks');
    expect(env.controller.snapshot().panel?.items).toEqual(expect.arrayContaining([expect.objectContaining({ command: '/tasks resolve late-unknown' })]));
  });

  it('stops late session members after the first thousand immutable run records', async () => {
    const env = setup(), store = env.app.store, original = store.run(env.runId);
    store.updateRun(env.runId, { status: 'completed' });
    store.transaction(() => {
      for (let index = 0; index < 1001; index++) store.putRun({ ...original, id: `fixture-history-${index}`, status: 'completed' });
      store.putRun({ ...original, id: 'late-child', parentId: original.id, status: 'queued' });
    });
    await open(env); await env.controller.submit('/stop all');
    expect(store.run('late-child').status).toBe('interrupted');
  });

  it.each(['stop', 'quit'] as const)('settles real background processes even when their owner is already terminal (%s)', async action => {
    const env = setup(), owner = env.app.store.run(env.runId);
    const result = await env.app.coordinator.tools.execute(owner.id, 'process.exec', { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], background: true, timeoutMs: 30_000 }, new AbortController().signal) as { background: { id: string } };
    expect(result.background.id).toBeTruthy(); expect(env.app.coordinator.tools.backgroundRunning(owner.id)).toBe(true);
    env.app.store.updateRun(owner.id, { status: 'completed' }); await open(env);
    if (action === 'quit') { await env.controller.quit(); expect(env.controller.snapshot().quitting).toBe(false); expect(env.controller.snapshot().panel?.title).toBe('Exit Kodo'); await env.controller.quit(true); }
    else await env.controller.submit('/stop all');
    expect(env.app.coordinator.tools.backgroundRunning(owner.id)).toBe(false);
    expect(env.app.store.events(owner.id, { types: ['process.background.finished'] })).toHaveLength(1);
    expect(env.controller.snapshot().quitting).toBe(action === 'quit');
  });

  it('shows and restores a managed child file without dropping its evidence or rewinding the parent', async () => {
    const env = setup(scripted(calls(call('file.apply_patch', { path: 'child.txt', expectedHash: null, content: 'child contents' })), answer('Child file created.'))), main = env.app.store.run(env.runId);
    const child = env.app.spawnAgent(main.sessionId, { objective: 'Create the child-owned fixture.' });
    writeFileSync(path.join(env.root, 'parent.txt'), 'parent contents');
    env.app.coordinator.interrupt(main.id); await env.app.coordinator.waitForStop(main.id);
    expect((await env.app.run(child.id)).status).toBe('completed');
    await open(env); await env.controller.submit('/changes');
    expect(env.controller.snapshot().panel?.lines.join('\n')).toContain(`child.txt · Recorded by task ${child.id}`);
    await env.controller.submit('/changes diff child.txt'); expect(env.controller.snapshot().panel?.lines.join('\n')).toContain('+child contents');
    await env.controller.submit(`/changes task ${child.id}`);
    expect(env.controller.snapshot().panel?.items).toEqual(expect.arrayContaining([expect.objectContaining({ command: `/changes task ${child.id} rewind` })]));
    await env.controller.submit(`/changes task ${child.id} rewind -1`); expect(existsSync(path.join(env.root, 'child.txt'))).toBe(true);
    await env.controller.submit(`/changes task ${child.id} rewind -1 confirm`);
    expect(existsSync(path.join(env.root, 'child.txt'))).toBe(false); expect(readFileSync(path.join(env.root, 'parent.txt'), 'utf8')).toBe('parent contents');
    expect(env.app.store.events(child.id, { types: ['file.rewind.completed'] })).toHaveLength(1);
    expect(env.app.store.events(main.id, { types: ['file.rewind.completed'] })).toHaveLength(0);
  });

  it('marks prior checks stale when the decision changes without any file mutation', async () => {
    const env = setup(scripted(answer('done')), { completionValidator: () => async () => ({ passed: true }) });
    await env.app.run(env.runId); await open(env); await env.controller.submit('/check run completion'); await settled(env.controller);
    const session = env.app.store.session(env.app.store.run(env.runId).sessionId);
    env.app.store.putSession({ ...session, decisionVersion: 1 }); env.app.store.event(env.runId, 'decision.updated', { version: 1, content: 'Changed acceptance constraint.' });
    await env.controller.submit('/check results'); expect(env.controller.snapshot().panel?.lines.join('\n')).toContain('Stale result');
    expect(env.controller.snapshot().entries.find(entry => entry.id === `result:${env.runId}`)?.status).toContain('Decision changed');
  });

  it('freezes the decision version at check admission and cannot approve a check after it changes', async () => {
    const env = setup(scripted(answer('done')), { completionValidator: () => async () => { const session = env.app.store.session(env.app.store.run(env.runId).sessionId); env.app.store.putSession({ ...session, decisionVersion: 1 }); return { passed: true }; } });
    await env.app.run(env.runId); await open(env); await env.controller.submit('/check run completion'); await settled(env.controller);
    expect(env.app.store.events(env.runId, { types: ['tui.check.finished'] })[0]?.data).toMatchObject({ passed: false, decisionVersion: 0 });
  });

  it('stops a metered author operation while its submit promise is pending and leaves no draft on cancellation', async () => {
    let requested = false;
    const env = setup({ complete: async (_request, signal) => { requested = true; return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
    await env.controller.submit('/agents new "Fixture method" --id local/cancelled-method --output "cancelled-method" --source-url "https://example.com/fixture"');
    const confirm = env.controller.snapshot().panel?.items?.find(item => item.id === 'confirm')?.command;
    expect(confirm).toMatch(/^\/agents author-confirm /u);
    const submitted = env.controller.submit(confirm!).then(() => undefined, error => error);
    await expect.poll(() => requested).toBe(true);
    const id = env.controller.snapshot().runId!;
    await env.controller.submit('/stop all'); await submitted;
    expect(['cancelled', 'interrupted']).toContain(env.app.store.run(id).status);
    expect(env.app.store.calls(id).filter(call => call.kind === 'model')).toHaveLength(1);
    expect(existsSync(path.join(env.root, 'cancelled-method'))).toBe(false);
    expect(env.controller.snapshot().busy).toBe(false);
  });

  it('finds workspace sessions beyond a thousand foreign runs and exposes the remaining matching pages', async () => {
    const env = setup(), store = env.app.store;
    const foreign = env.app.createRun({ objective: 'Foreign workspace fixture.', workspace: temp(), binding });
    store.transaction(() => { for (let index = 0; index < 1001; index++) store.putRun({ ...foreign, id: `foreign-${index}`, status: 'completed' }); });
    const selected = env.app.createRun({ objective: 'Late workspace session.', workspace: env.root, binding });
    await env.controller.submit('/resume');
    expect(env.controller.snapshot().panel?.items).toEqual(expect.arrayContaining([expect.objectContaining({ command: `/resume ${selected.id}` })]));
    store.transaction(() => { for (let index = 0; index < 101; index++) store.putRun({ ...selected, id: `matching-${index}`, status: 'completed' }); });
    await env.controller.submit('/resume');
    const first = new Set(env.controller.snapshot().panel?.items?.filter(item => item.id !== 'next').map(item => item.id));
    const next = env.controller.snapshot().panel?.items?.find(item => item.id === 'next')?.command;
    expect(first.size).toBe(100); expect(next).toMatch(/^\/resume list \d+$/u);
    await env.controller.submit(next!);
    expect(env.controller.snapshot().panel?.items?.filter(item => item.id !== 'next').some(item => first.has(item.id))).toBe(false);
    expect(env.controller.snapshot().panel?.items?.some(item => item.id === 'matching-100')).toBe(true);
  });
});
