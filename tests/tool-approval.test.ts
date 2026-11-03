import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KodoError } from '../src/runtime/types.js';
import type { ToolApprovalHandler, ToolApprovalRequest } from '../src/tools/index.js';
import { fixture } from './helpers.js';

const signal = (): AbortSignal => new AbortController().signal;
const patch = (file: string) => ({ path: file, expectedHash: null, content: 'approved content' });
function pendingApproval() {
  let received!: (request: ToolApprovalRequest) => void;
  let resolve!: (allowed: boolean) => void;
  const entered = new Promise<ToolApprovalRequest>(done => { received = done; });
  const decision = new Promise<boolean>(done => { resolve = done; });
  const handler: ToolApprovalHandler = request => { received(request); return decision; };
  return { resolve, entered, handler };
}

describe('host tool consent', () => {
  it('keeps authorized standalone execution working without a consent handler', async () => {
    const { app, runId, root } = fixture();
    await app.coordinator.tools.execute(runId, 'file.apply_patch', patch('ordinary.txt'), signal());
    expect(readFileSync(path.join(root, 'ordinary.txt'), 'utf8')).toBe('approved content');
  });

  it('does not start a denied file operation and writes only after explicit approval', async () => {
    const { app, runId, root } = fixture();
    const tools = app.coordinator.tools, started = vi.fn();
    const approve = vi.fn<ToolApprovalHandler>().mockReturnValue(false);
    tools.setApprovalHandler(approve);
    await expect(tools.execute(runId, 'file.apply_patch', patch('result.txt'), signal(), started, { callId: 'call-1' })).rejects.toMatchObject({ code: 'TOOL_APPROVAL_DENIED' });
    expect(existsSync(path.join(root, 'result.txt'))).toBe(false);
    expect(started).not.toHaveBeenCalled();
    expect(approve.mock.calls[0]?.[0]).toMatchObject({ runId, callId: 'call-1', name: 'file.apply_patch', effect: 'write', arguments: patch('result.txt') });
    approve.mockReturnValue(true);
    await tools.execute(runId, 'file.apply_patch', patch('result.txt'), signal(), started);
    expect(started).toHaveBeenCalledOnce();
    expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('approved content');
  });

  it('fails closed if consent throws or returns a value other than true', async () => {
    const { app, runId, root } = fixture();
    const tools = app.coordinator.tools;
    tools.setApprovalHandler(() => { throw new Error('approval interface unavailable'); });
    await expect(tools.execute(runId, 'file.apply_patch', patch('throw.txt'), signal())).rejects.toMatchObject({ code: 'TOOL_APPROVAL_FAILED', message: expect.stringContaining('approval interface unavailable') });
    tools.setApprovalHandler(() => undefined as unknown as boolean);
    await expect(tools.execute(runId, 'file.apply_patch', patch('missing.txt'), signal())).rejects.toMatchObject({ code: 'TOOL_APPROVAL_DENIED' });
    expect(existsSync(path.join(root, 'throw.txt'))).toBe(false);
    expect(existsSync(path.join(root, 'missing.txt'))).toBe(false);
  });

  it('allows local reads, private reports and host-declared read-only commands without prompting', async () => {
    const command = { program: process.execPath, args: ['-e', 'process.stdout.write("read-only")'] };
    const { app, runId, root } = fixture(undefined, ['read', 'write'], { readOnlyCommands: [command] });
    writeFileSync(path.join(root, 'source.txt'), 'source');
    const approve = vi.fn(() => false), tools = app.coordinator.tools;
    tools.setApprovalHandler(approve);
    expect(await tools.execute(runId, 'file.read', { path: 'source.txt' }, signal())).toMatchObject({ content: 'source' });
    expect(await tools.execute(runId, 'process.run', command, signal())).toMatchObject({ stdout: 'read-only', exitCode: 0 });
    expect(await tools.execute(runId, 'artifact.write', { name: 'report', content: 'evidence' }, signal())).toHaveProperty('id');
    expect(approve).not.toHaveBeenCalled();
  });

  it('gates process execution and remote service reads before starting IO', async () => {
    const { app, runId, root } = fixture(undefined, ['read', 'write', 'exec'], { webFetch: { enabled: true } });
    const tools = app.coordinator.tools, external = vi.fn(() => ({ value: 'remote' }));
    tools.register({ name: 'mcp.demo.lookup', description: 'Read an external service.', permission: 'read', effect: 'read', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: external });
    const run = app.store.run(runId);
    app.store.updateRun(runId, { card: { ...run.card, tools: [...run.card.tools, 'mcp.demo.lookup'] } });
    const approve = vi.fn<ToolApprovalHandler>(() => false);
    tools.setApprovalHandler(approve);
    await expect(tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("spawned.txt", "started")'] }, signal())).rejects.toMatchObject({ code: 'TOOL_APPROVAL_DENIED' });
    await expect(tools.execute(runId, 'mcp.demo.lookup', {}, signal())).rejects.toMatchObject({ code: 'TOOL_APPROVAL_DENIED' });
    await expect(tools.execute(runId, 'web.fetch', { url: 'https://example.com/' }, signal())).rejects.toMatchObject({ code: 'TOOL_APPROVAL_DENIED' });
    expect(approve.mock.calls.map(([request]) => request.name)).toEqual(['process.exec', 'mcp.demo.lookup', 'web.fetch']);
    expect(external).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'spawned.txt'))).toBe(false);
  });

  it('does not ask again when reading output from an already-approved background process', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec']);
    const tools = app.coordinator.tools, approve = vi.fn<ToolApprovalHandler>(() => true);
    tools.setApprovalHandler(approve);
    const result = await tools.execute(runId, 'process.exec', { program: process.execPath, args: ['-e', 'process.stdout.write("background output"); setTimeout(() => {}, 150)'], background: true }, signal()) as { background: { id: string } };
    approve.mockReturnValue(false);
    expect(await tools.execute(runId, 'process.read', { id: result.background.id, waitMs: 1000 }, signal())).toMatchObject({ stdout: 'background output' });
    expect(approve).toHaveBeenCalledOnce();
  });

  it('executes the exact validated input even when the caller changes its draft during approval', async () => {
    const { app, runId, root } = fixture();
    const pending = pendingApproval(), args = patch('original.txt'), tools = app.coordinator.tools;
    tools.setApprovalHandler(pending.handler);
    const work = tools.execute(runId, 'file.apply_patch', args, signal());
    const request = await pending.entered;
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.arguments)).toBe(true);
    expect(Reflect.set(request.arguments, 'content', 'changed by callback')).toBe(false);
    args.path = 'changed.txt'; args.content = 'changed by caller';
    pending.resolve(true);
    await work;
    expect(readFileSync(path.join(root, 'original.txt'), 'utf8')).toBe('approved content');
    expect(existsSync(path.join(root, 'changed.txt'))).toBe(false);
  });

  it('cancels a pending approval immediately even when the host callback ignores cancellation', async () => {
    const { app, runId, root } = fixture();
    const pending = pendingApproval(), control = new AbortController(), started = vi.fn(), tools = app.coordinator.tools;
    tools.setApprovalHandler(pending.handler);
    const work = tools.execute(runId, 'file.apply_patch', patch('cancelled.txt'), control.signal, started);
    await pending.entered;
    const stopped = new KodoError('TURN_INTERRUPTED', 'user interrupted');
    const rejected = expect(work).rejects.toBe(stopped);
    control.abort(stopped);
    await rejected;
    pending.resolve(true);
    await Promise.resolve();
    expect(started).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'cancelled.txt'))).toBe(false);
  });

  it('revalidates permissions after waiting and never upgrades the session grant', async () => {
    const { app, runId, root } = fixture();
    const pending = pendingApproval(), tools = app.coordinator.tools;
    tools.setApprovalHandler(pending.handler);
    const work = tools.execute(runId, 'file.apply_patch', patch('revoked.txt'), signal());
    await pending.entered;
    app.updatePermissions(runId, ['read']);
    pending.resolve(true);
    await expect(work).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    expect(existsSync(path.join(root, 'revoked.txt'))).toBe(false);
    expect(app.store.session(app.store.run(runId).sessionId).permissions).toEqual(['read']);
  });

  it('rejects stale approvals after reinstalling the same handler and makes old cleanup harmless', async () => {
    const { app, runId, root } = fixture();
    const pending = pendingApproval(), tools = app.coordinator.tools;
    const oldCleanup = tools.setApprovalHandler(pending.handler);
    const work = tools.execute(runId, 'file.apply_patch', patch('stale.txt'), signal());
    await pending.entered;
    const newCleanup = tools.setApprovalHandler(pending.handler);
    oldCleanup();
    pending.resolve(true);
    await expect(work).rejects.toMatchObject({ code: 'TOOL_APPROVAL_DENIED' });
    expect(existsSync(path.join(root, 'stale.txt'))).toBe(false);
    // The new handler still owns the boundary; its rejection is still effective.
    tools.setApprovalHandler(() => false);
    newCleanup();
    await expect(tools.execute(runId, 'file.apply_patch', patch('still-gated.txt'), signal())).rejects.toMatchObject({ code: 'TOOL_APPROVAL_DENIED' });
    expect(existsSync(path.join(root, 'still-gated.txt'))).toBe(false);
  });
});
