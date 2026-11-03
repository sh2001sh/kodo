import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Application, loadSkill } from '../src/application/index.js';
import type { ToolRegistration } from '../src/application/index.js';
import { answer, binding, call, calls, scripted } from './helpers.js';

const applications = new Set<Application>();
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const app of applications) { try { await app.shutdown(); } catch (error) { errors.push(error); } }
  applications.clear();
  while (servers.length) {
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (errors.length) throw new AggregateError(errors, 'capability restart cleanup failed');
});
async function directory(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-restart-')); directories.push(root); return root; }
function track(app: Application): Application { applications.add(app); return app; }
async function close(app: Application): Promise<void> { await app.shutdown(); applications.delete(app); }
const cardSource = (tool: string, skill?: string): string => `---\nschema_version: 1\nid: local/restart\nversion: 1.0.0\nname: Restart\ndescription: Resume only the original approved capability contract\ncapabilities:\n  tools: [${tool}]\n${skill ? `  skills: [${skill}]\n` : ''}---\nComplete the persisted operation exactly once.\n`;

/** Persist the exact crash boundary after a model response and before any tool IO.
 * Store close/reopen, automatic interruption, Application.recover and tool execution are real. */
function checkpoint(app: Application, root: string, tool: string, args: Record<string, unknown> = {}, skill?: string): { id: string; callId: string } {
  const run = app.createRun({ objective: 'Resume the approved pending operation.', workspace: root, binding, card: app.parseCard(cardSource(tool, skill)) });
  const request = call(tool, args, 'pending-operation');
  const modelId = `checkpoint:${run.id}`;
  const callId = `${modelId}:${request.id}`;
  app.store.transaction(() => {
    app.store.putCall({ id: modelId, runId: run.id, step: 0, kind: 'model', name: binding.model, status: 'succeeded', effect: 'read', reservedTokens: 0, decisionVersion: 0,
      requestRef: app.store.blob({ binding, messages: app.store.readBlob(run.contextRef), tools: app.coordinator.tools.specs(run.card.tools, app.store.session(run.sessionId)), maxOutputTokens: 8192 }),
      resultRef: app.store.blob(calls(request)),
    });
    app.store.putCall({ id: callId, runId: run.id, step: 0, kind: 'tool', name: tool, status: 'planned', effect: app.coordinator.tools.effect(tool), effectState: 'not_started', requestRef: app.store.blob(request), reservedTokens: 0 });
    app.store.putSession({ ...app.store.session(run.sessionId), modelCalls: 1, tokens: 80 });
    app.store.updateRun(run.id, { status: 'running', stepCallId: modelId });
  });
  return { id: run.id, callId };
}

const customTool = (version: string, execute: ToolRegistration['execute']): ToolRegistration => ({
  name: 'custom.approved', version, description: 'Read one approved host value.', parameters: { type: 'object', properties: {}, additionalProperties: false }, permission: 'read', effect: 'read', execute,
});

describe('capability contracts across actual application restart', () => {
  it.each(['same', 'changed', 'missing'])('read-only command %s declaration is checked before replay', async variant => {
    const root = await directory();
    const state = path.join(root, '.state');
    const command = { program: process.execPath, args: ['-e', 'process.stdout.write("approved read-only evidence")'] };
    const original = track(new Application(state, scripted(), undefined, { readOnlyCommands: [command], agentFactors: { D: false, E: false, B: false } }));
    const pending = checkpoint(original, root, 'process.run', command);
    const pinned = original.store.run(pending.id).toolBindings;
    await close(original);
    const complete = vi.fn(async () => answer('Verified the resumed read-only evidence.'));
    const commands = variant === 'missing' ? [] : [variant === 'changed' ? { ...command, args: ['--version'] } : command];
    const reopened = track(new Application(state, { complete }, undefined, { readOnlyCommands: commands, agentFactors: { D: false, E: false, B: false } }));
    expect(reopened.store.run(pending.id)).toMatchObject({ status: 'interrupted', toolBindings: pinned });
    if (variant === 'same') {
      expect((await reopened.recover(pending.id)).status).toBe('completed');
      const executed = reopened.store.call(pending.callId);
      expect(executed.status).toBe('succeeded');
      expect(reopened.store.readBlob(executed.resultRef!)).toMatchObject({ stdout: 'approved read-only evidence', exitCode: 0 });
      expect(complete).toHaveBeenCalledTimes(1);
    } else {
      await expect(Promise.resolve().then(() => reopened.recover(pending.id))).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
      expect(reopened.store.call(pending.callId)).toMatchObject({ status: 'planned', effectState: 'not_started' });
      expect(complete).not.toHaveBeenCalled();
    }
  });

  it.each(['same', 'changed', 'missing'])('custom tool %s registration is checked before replaying a pending call', async variant => {
    const root = await directory();
    const state = path.join(root, '.state');
    const originalCallback = vi.fn(() => ({ approved: true }));
    const original = track(new Application(state, scripted(), undefined, { tools: [customTool('1', originalCallback)], agentFactors: { D: false, E: false, B: false } }));
    const pending = checkpoint(original, root, 'custom.approved');
    const pinned = original.store.run(pending.id).toolBindings;
    await close(original);
    const callback = vi.fn(() => ({ approved: true }));
    const complete = vi.fn(async () => answer('Resumed the original pending capability.'));
    const reopened = track(new Application(state, { complete }, undefined, { tools: variant === 'missing' ? [] : [customTool(variant === 'changed' ? '2' : '1', callback)], agentFactors: { D: false, E: false, B: false } }));
    expect(reopened.store.run(pending.id)).toMatchObject({ status: 'interrupted', toolBindings: pinned });
    expect(originalCallback).not.toHaveBeenCalled();
    if (variant === 'same') {
      const result = await reopened.recover(pending.id);
      expect(result.status).toBe('completed');
      expect(callback).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
      const executed = reopened.store.call(pending.callId);
      expect(executed.status).toBe('succeeded');
      expect(reopened.store.readBlob(executed.resultRef!)).toEqual({ approved: true });
    } else {
      await expect(Promise.resolve().then(() => reopened.recover(pending.id))).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
      expect(reopened.store.run(pending.id).status).toBe('interrupted');
      expect(callback).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(reopened.store.call(pending.callId)).toMatchObject({ status: 'planned', effectState: 'not_started' });
    }
  });

  it.each([false, true])('skill content change=%s is checked before loading the persisted skill request', async changed => {
    const root = await directory();
    const state = path.join(root, '.state');
    const file = path.join(root, 'SKILL.md');
    const content = '---\nname: review\ndescription: Review original evidence\n---\nInspect source evidence before reporting.\n';
    await writeFile(file, content, 'utf8');
    const skill = await loadSkill(file);
    const original = track(new Application(state, scripted(), undefined, { skills: [skill], agentFactors: { D: false, E: false, B: false } }));
    const pending = checkpoint(original, root, 'skill.load', { id: skill.id }, skill.id);
    await close(original);
    if (changed) await writeFile(file, content + 'Changed instruction requiring a different procedure.\n', 'utf8');
    const complete = vi.fn(async () => answer('Loaded the unchanged approved skill.'));
    const reopened = track(new Application(state, { complete }, undefined, { skills: [await loadSkill(file)], agentFactors: { D: false, E: false, B: false } }));
    expect(reopened.store.run(pending.id).status).toBe('interrupted');
    if (changed) {
      await expect(Promise.resolve().then(() => reopened.recover(pending.id))).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
      expect(reopened.store.run(pending.id).status).toBe('interrupted');
      const operation = reopened.store.call(pending.callId);
      expect(operation.status).toBe('planned');
      expect(operation.resultRef).toBeUndefined();
      expect(complete).not.toHaveBeenCalled();
    } else {
      const result = await reopened.recover(pending.id);
      const operation = reopened.store.call(pending.callId);
      expect(result.status).toBe('completed');
      expect(operation.status).toBe('succeeded');
      expect(reopened.store.readBlob(operation.resultRef!)).toMatchObject({ id: skill.id, digest: skill.digest, content });
      expect(complete).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['same', 'endpoint', 'policy version'])('MCP %s identity is checked before a persisted call reaches the actual server', async variant => {
    const root = await directory();
    const state = path.join(root, '.state');
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += String(chunk);
      const message = JSON.parse(body) as { method: string; id?: number };
      if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
      let result: unknown;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} } };
      else if (message.method === 'tools/list') result = { tools: [{ name: 'approved', description: 'Read approved remote evidence.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      else { requests.push(request.url!); result = { content: [{ type: 'text', text: 'original approved remote result' }] }; }
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing MCP fixture listener');
    const endpoint = `http://127.0.0.1:${address.port}`;
    const original = track(new Application(state, scripted(), undefined, { agentFactors: { D: false, E: false, B: false } }));
    await original.connectMcp({ id: 'approved', transport: 'http', url: endpoint + '/original', tools: { approved: { permission: 'read', effect: 'read', version: '1' } } });
    const pending = checkpoint(original, root, 'mcp.approved.approved');
    await close(original);
    const complete = vi.fn(async () => answer('Read the original remote evidence once.'));
    const reopened = track(new Application(state, { complete }, undefined, { agentFactors: { D: false, E: false, B: false } }));
    await reopened.connectMcp({ id: 'approved', transport: 'http', url: endpoint + (variant === 'endpoint' ? '/different-service' : '/original'), tools: { approved: { permission: 'read', effect: 'read', version: variant === 'policy version' ? '2' : '1' } } });
    expect(reopened.store.run(pending.id).status).toBe('interrupted');
    if (variant === 'same') {
      const result = await reopened.recover(pending.id);
      expect(result.status).toBe('completed');
      expect(requests).toEqual(['/original']);
      expect(reopened.store.readBlob(reopened.store.call(pending.callId).resultRef!)).toEqual({ content: [{ type: 'text', text: 'original approved remote result' }] });
      expect(complete).toHaveBeenCalledTimes(1);
    } else {
      await expect(Promise.resolve().then(() => reopened.recover(pending.id))).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
      expect(reopened.store.run(pending.id).status).toBe('interrupted');
      expect(requests).toEqual([]);
      expect(reopened.store.call(pending.callId)).toMatchObject({ status: 'planned', effectState: 'not_started' });
      expect(complete).not.toHaveBeenCalled();
    }
  });
});
