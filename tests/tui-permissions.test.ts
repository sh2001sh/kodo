import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PackageRegistry } from '../src/packages/registry.js';
import { TuiController } from '../src/tui/controller.js';
import type { TuiOptions } from '../src/tui/types.js';
import type { Provider } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, scripted } from './helpers.js';

const controllers: TuiController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.close(); });

function setup(provider: Provider, options: Partial<TuiOptions> = {}) {
  const env = fixture(provider, ['read', 'write', 'exec'], { compaction: false, instructions: { global: false } });
  const controller = new TuiController({ app: env.app, workspace: env.root, binding, permissions: ['read', 'write', 'exec'], registry: new PackageRegistry(path.join(env.root, '.packages')), ...options });
  controllers.push(controller);
  return { ...env, controller };
}
const write = (name: string) => call('file.apply_patch', { path: name, expectedHash: null, content: 'approved content' }, name);
const waiting = async (controller: TuiController) => await expect.poll(() => controller.snapshot().panel?.title, { timeout: 3000 }).toBe('Approval required');
const settled = async (controller: TuiController) => await expect.poll(() => controller.snapshot().busy, { timeout: 3000 }).toBe(false);
function action(controller: TuiController, id: string): string {
  const command = controller.snapshot().panel?.items?.find(item => item.id === id)?.command;
  expect(command).toBeTruthy();
  return command!;
}

describe('TUI permission modes', () => {
  it('defaults to Ask and lets the user inspect modes without a model call or task', async () => {
    const env = setup(scripted());
    expect(env.controller.snapshot().permissionMode).toBe('ask');
    await env.controller.submit('/permissions');
    expect(env.controller.snapshot()).toMatchObject({ permissionMode: 'ask', panel: { title: 'Permissions' } });
    expect(env.controller.snapshot().panel?.items?.map(item => item.id)).toEqual(['ask', 'yolo']);
    expect(env.controller.snapshot().runId).toBeUndefined();
    expect(env.app.store.calls(env.runId)).toEqual([]);
    await expect(env.controller.submit('/permissions invalid')).rejects.toThrow('Use /permissions');
    expect(env.controller.snapshot().permissionMode).toBe('ask');
  });

  it('waits before a real write, approves it once, and asks again for the next call', async () => {
    const env = setup(scripted(calls(write('first.txt')), calls(write('second.txt')), answer('Finished')));
    await env.controller.submit('Create two files');
    await waiting(env.controller);
    expect(existsSync(path.join(env.root, 'first.txt'))).toBe(false);
    expect(env.controller.snapshot().panel?.lines.join('\n')).toContain('first.txt');
    await env.controller.submit(action(env.controller, 'approve'));
    await waiting(env.controller);
    await expect.poll(() => existsSync(path.join(env.root, 'first.txt'))).toBe(true);
    await expect.poll(() => env.controller.snapshot().panel?.lines.join('\n')).toContain('second.txt');
    expect(existsSync(path.join(env.root, 'second.txt'))).toBe(false);
    await env.controller.submit(action(env.controller, 'approve'));
    await settled(env.controller);
    expect(readFileSync(path.join(env.root, 'second.txt'), 'utf8')).toBe('approved content');
    expect(env.controller.snapshot().permissionMode).toBe('ask');
  });

  it.each(['deny', 'escape'])('does not write when the user chooses %s', async choice => {
    const env = setup(scripted(calls(write('denied.txt')), answer('The operation was denied')));
    await env.controller.submit('Create a file');
    await waiting(env.controller);
    if (choice === 'deny') await env.controller.submit(action(env.controller, 'deny'));
    else env.controller.dismissPanel();
    await settled(env.controller);
    expect(existsSync(path.join(env.root, 'denied.txt'))).toBe(false);
    const recorded = env.app.store.calls(env.controller.snapshot().runId!).find(item => item.name === 'file.apply_patch')!;
    expect(recorded).toMatchObject({ status: 'failed', effectState: 'not_started' });
    expect(env.app.store.readBlob(recorded.resultRef!)).toMatchObject({ error: expect.stringContaining('TOOL_APPROVAL_DENIED') });
  });

  it('approves pending and future permitted writes when the user selects YOLO', async () => {
    const env = setup(scripted(calls(write('pending.txt')), calls(write('automatic.txt')), answer()));
    await env.controller.submit('Create files');
    await waiting(env.controller);
    await env.controller.submit('/permissions');
    expect(env.controller.snapshot().panel?.title).toBe('Permissions');
    await env.controller.submit(action(env.controller, 'yolo'));
    await settled(env.controller);
    expect(env.controller.snapshot().permissionMode).toBe('yolo');
    expect(readFileSync(path.join(env.root, 'pending.txt'), 'utf8')).toBe('approved content');
    expect(readFileSync(path.join(env.root, 'automatic.txt'), 'utf8')).toBe('approved content');
  });

  it('applies Ask to subsequent calls in the same session after switching from YOLO', async () => {
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const env = setup(scripted(async () => { await pause; return calls(write('review.txt')); }, answer()), { permissionMode: 'yolo' });
    await env.controller.submit('Create a file after review');
    await env.controller.submit('/permissions ask');
    release();
    await waiting(env.controller);
    expect(existsSync(path.join(env.root, 'review.txt'))).toBe(false);
    await env.controller.submit(action(env.controller, 'deny'));
    await settled(env.controller);
  });

  it('interrupts a pending approval without a write and rejects a stale answer', async () => {
    const env = setup(scripted(calls(write('interrupted.txt')), answer()));
    await env.controller.submit('Create a file');
    await waiting(env.controller);
    const command = action(env.controller, 'approve');
    await env.controller.interrupt();
    await settled(env.controller);
    await expect(env.controller.submit(command)).rejects.toThrow('expired or was already answered');
    expect(existsSync(path.join(env.root, 'interrupted.txt'))).toBe(false);
    expect(env.controller.snapshot().panel?.title).not.toBe('Approval required');
  });

  it('closes while approval is pending without starting the operation', async () => {
    const env = setup(scripted(calls(write('closed.txt')), answer()));
    await env.controller.submit('Create a file');
    await waiting(env.controller);
    await env.controller.close();
    expect(existsSync(path.join(env.root, 'closed.txt'))).toBe(false);
    expect(env.app.store.run(env.controller.snapshot().runId!).status).toBe('interrupted');
  });

  it('keeps literal mode text as task content and never treats it as permission consent', async () => {
    const env = setup(scripted(answer()));
    await env.controller.submit('/permissions yolo', { literal: true });
    await settled(env.controller);
    expect(env.controller.snapshot().permissionMode).toBe('ask');
    expect(env.app.store.run(env.controller.snapshot().runId!).objective).toBe('/permissions yolo');
  });

  it('does not turn Ask or YOLO into additional run grants', async () => {
    const env = setup(scripted(calls(write('unavailable.txt')), answer()), { permissions: ['read'], permissionMode: 'yolo' });
    await env.controller.submit('Inspect the workspace');
    await settled(env.controller);
    expect(existsSync(path.join(env.root, 'unavailable.txt'))).toBe(false);
    expect(env.controller.snapshot().panel).toBeUndefined();
    const run = env.app.store.run(env.controller.snapshot().runId!);
    expect(env.app.store.session(run.sessionId).permissions).toEqual(['read']);
  });
});
