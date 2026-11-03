import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { inspectRun } from '../src/runtime/inspection.js';
import { digest } from '../src/storage/index.js';
import type { Application } from '../src/application/index.js';
import type { Permission } from '../src/runtime/types.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

function inspect(app: Application, requester: string, owner: string, callId?: string): { calls: { id: string; name: string }[]; evidence: { text: string } } {
  return inspectRun(app.store, app.store.run(requester), { run_id: owner, ...(callId ? { call_id: callId } : {}) }) as { calls: { id: string; name: string }[]; evidence: { text: string } };
}
function child(app: Application, parent: string): string {
  return (app.store.transaction(() => app.coordinator.mailbox.execute(app.store.run(parent), 'evidence-child', 'spawn_agent', { objective: 'Produce tool evidence' })) as { id: string }).id;
}

describe('authorized tool evidence', () => {
  it.each([false, true])('exposes all new native file evidence for managed child = %s', async managed => {
    const { app, runId } = fixture(scripted(calls(
      call('file.mkdir', { path: 'delivery' }),
      call('file.apply_patch', { path: 'delivery/before.txt', expectedHash: null, content: 'before' }),
      call('file.patch', { path: 'delivery/before.txt', expectedHash: digest('before'), edits: [{ oldText: 'before', newText: 'after' }] }),
      call('file.rename', { path: 'delivery/before.txt', destination: 'delivery/after.txt', expectedHash: digest('after') }),
      call('file.delete', { path: 'delivery/after.txt', expectedHash: digest('after') }),
    ), answer()));
    const writer = managed ? child(app, runId) : runId;
    expect((await app.coordinator.wake(writer)).status).toBe('completed');
    const tools = app.store.calls(writer).filter(item => item.kind === 'tool');
    expect(inspect(app, runId, writer).calls.map(item => item.name)).toEqual(tools.map(item => item.name));
    for (const tool of tools) {
      expect(tool).toMatchObject({ status: 'succeeded', evidencePermission: 'write' });
      expect(JSON.parse(inspect(app, runId, writer, tool.id).evidence.text)).toMatchObject({ path: expect.stringContaining('delivery') });
    }
  });

  it.each([false, true])('pins custom read/write/exec evidence grants for managed child = %s', async managed => {
    const names = ['custom.read', 'custom.write', 'custom.exec'];
    const { app, runId } = fixture(scripted(calls(...names.map(name => call(name, {}))), answer()), ['read', 'write', 'exec']);
    for (const permission of ['read', 'write', 'exec'] as Permission[]) app.registerTool({ name: `custom.${permission}`, description: `Host ${permission} tool`, permission, effect: permission === 'write' ? 'write' : 'read', parameters: { type: 'object' }, execute: () => ({ evidence: `${permission} result` }) });
    const main = app.store.run(runId);
    const allowed = [...main.card.tools, ...names];
    app.store.updateRun(runId, { card: { ...main.card, tools: allowed }, toolBindings: app.coordinator.tools.bindingSnapshot(allowed) });
    const writer = managed ? child(app, runId) : runId;
    expect((await app.coordinator.wake(writer)).status).toBe('completed');
    const toolCalls = app.store.calls(writer).filter(item => item.kind === 'tool');
    expect(inspect(app, runId, writer).calls.map(item => item.name)).toEqual(names);
    for (const tool of toolCalls) {
      expect(tool.evidencePermission).toBe(tool.name.slice('custom.'.length));
      expect(JSON.parse(inspect(app, runId, writer, tool.id).evidence.text)).toEqual({ evidence: `${tool.evidencePermission} result` });
    }
    // A new main task inherits evidence access, but user revocation still applies.
    const requester = managed ? runId : app.submitInput(runId, 'Review previous evidence').id;
    app.updatePermissions(requester, ['read']);
    expect(inspect(app, requester, writer).calls.map(item => item.name)).toEqual(['custom.read']);
    for (const tool of toolCalls.filter(item => item.name !== 'custom.read')) expect(() => inspect(app, requester, writer, tool.id)).toThrow('authorized evidence permission');
  });

  it('preserves legacy builtin evidence and hides unpinned unknown or private records', () => {
    const { app, runId } = fixture();
    const legacy = ['file.mkdir', 'file.patch', 'file.rename', 'file.delete', 'history.read'];
    // spawn_agent is a current private coordination record even with a recorded permission; a historical
    // send_message record (1d removed the tool) was never given an evidence permission and stays hidden.
    for (const name of [...legacy, 'custom.unpinned', 'spawn_agent', 'send_message', 'model']) app.store.putCall({ id: name, runId, step: 0, kind: name === 'model' ? 'model' : 'tool', name, status: 'succeeded', effect: 'read', requestRef: app.store.blob({}), resultRef: app.store.blob({ evidence: name }), reservedTokens: 0, ...(['spawn_agent', 'model'].includes(name) ? { evidencePermission: 'read' } : {}) });
    expect(inspect(app, runId, runId).calls.map(item => item.name)).toEqual(legacy);
    for (const id of ['custom.unpinned', 'spawn_agent', 'send_message', 'model']) expect(() => inspect(app, runId, runId, id)).toThrow('authorized evidence permission');
  });

  it('exposes skill loading evidence with its pinned read grant', async () => {
    const { app, runId } = fixture(scripted(calls(call('skill.load', { id: 'review' })), answer()));
    const content = 'Verify original source evidence.';
    app.registerSkills([{ id: 'review', description: 'Review evidence', content, digest: digest(content) }]);
    const run = app.store.run(runId);
    const allowed = [...run.card.tools, 'skill.load'];
    app.store.updateRun(runId, { card: { ...run.card, tools: allowed, skills: ['review'] }, toolBindings: app.coordinator.tools.bindingSnapshot(allowed) });
    expect((await app.coordinator.wake(runId)).status).toBe('completed');
    const tool = app.store.calls(runId).find(item => item.name === 'skill.load')!;
    expect(tool.evidencePermission).toBe('read');
    expect(JSON.parse(inspect(app, runId, runId, tool.id).evidence.text)).toMatchObject({ id: 'review', content });
  });

  it('exposes actual MCP response evidence with the host-approved permission', async () => {
    const server = createServer(async (request, response) => {
      if (request.method === 'DELETE') { response.writeHead(204); response.end(); return; }
      let body = ''; for await (const chunk of request) body += String(chunk);
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.method.startsWith('notifications/')) { response.writeHead(202); response.end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} } } : message.method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'Verified remote response' }] };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { app, runId } = fixture(scripted(calls(call('mcp.evidence.lookup', {})), answer()));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing listener');
      const names = await app.connectMcp({ id: 'evidence', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, tools: { lookup: { permission: 'read', effect: 'read' } } });
      const run = app.store.run(runId);
      const allowed = [...run.card.tools, ...names];
      app.store.updateRun(runId, { card: { ...run.card, tools: allowed }, toolBindings: app.coordinator.tools.bindingSnapshot(allowed) });
      const writer = child(app, runId);
      expect((await app.coordinator.wake(writer)).status).toBe('completed');
      const tool = app.store.calls(writer).find(item => item.name === 'mcp.evidence.lookup')!;
      expect(tool.evidencePermission).toBe('read');
      expect(inspect(app, runId, writer, tool.id).evidence.text).toContain('Verified remote response');
    } finally {
      await app.shutdown();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
