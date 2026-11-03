import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Application, loadSkill } from '../src/application/index.js';
import type { ToolRegistration } from '../src/application/index.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

const active: Application[] = [];
afterEach(async () => { while (active.length) await active.pop()!.shutdown(); });
const cardSource = (tools: string, skills = ''): string => `---\nschema_version: 1\nid: local/capabilities\nversion: 1.0.0\nname: Capabilities\ndescription: Test approved host capabilities\ncapabilities:\n  tools: [${tools}]\n${skills ? `  skills: [${skills}]\n` : ''}---\nUse only approved capabilities.\n`;

describe('application capability integration', () => {
  it('loads a host skill through a card, records actual output, and exposes paginated host evidence', async () => {
    const root = temp();
    const file = path.join(root, 'SKILL.md');
    writeFileSync(file, '---\nname: evidence\ndescription: Inspect actual evidence\n---\nVerify the deliverable before reporting.\n', 'utf8');
    const skill = await loadSkill(file);
    const app = new Application(path.join(root, 'data'), scripted(calls(call('skill.load', { id: 'evidence' })), answer()), undefined, { skills: [skill] });
    active.push(app);
    const card = app.parseCard(cardSource('skill.list, skill.load', 'evidence'));
    app.registerCard(card);
    expect(app.searchCards({ query: 'approved host' }).cards).toHaveLength(1);
    const run = app.createRun({ objective: 'Use the evidence skill.', workspace: root, binding, card });
    expect((await app.run(run.id)).status).toBe('completed');
    const tool = app.calls(run.id).items.find(item => item.kind === 'tool')!;
    expect(app.store.readBlob(tool.resultRef!)).toMatchObject({ id: 'evidence', digest: skill.digest, content: skill.content });
    const first = app.events({ runId: run.id, limit: 1 });
    expect(first.items).toHaveLength(1);
    const rest = app.events({ runId: run.id, after: first.next!, limit: 100 });
    expect(rest.items.every(item => item.seq > first.items[0]!.seq)).toBe(true);
    expect(app.runs({ sessionId: run.sessionId }).items.map(item => item.id)).toEqual([run.id]);
    expect(app.snapshot(run.id).session.id).toBe(run.sessionId);
    expect(() => app.registerSkills([skill])).toThrow('once');
    expect(() => app.updateProgress(run.id, { pending: ['Change terminal state'] })).toThrow('active');
  });

  it('keeps a failed constructor from holding the directory lock and rejects unapproved custom tools', async () => {
    const root = temp();
    const definition: ToolRegistration = { name: 'file.read', description: 'Collision', parameters: { type: 'object' }, permission: 'read', effect: 'read', execute: () => ({}) };
    expect(() => new Application(path.join(root, 'data'), scripted(), undefined, { tools: [definition] })).toThrow('collid');
    const app = new Application(path.join(root, 'data'), scripted(answer()));
    active.push(app);
    expect(() => app.parseCard(cardSource('custom.missing'))).toThrow('unsupported');
    expect(app.sessions().items).toEqual([]);
  });

  it('rejects a conflicting recovery verifier before installing its tool', () => {
    const root = temp();
    const app = new Application(path.join(root, 'data'), scripted());
    active.push(app);
    app.registerRecoveryVerifier('custom.write', () => ({ outcome: 'unknown', evidence: 'Existing host verifier.' }));
    expect(() => app.registerTool({ name: 'custom.write', description: 'Write through the host', parameters: { type: 'object' }, permission: 'write', effect: 'write', execute: () => ({}), recover: () => ({ outcome: 'unknown', evidence: 'Conflicting verifier.' }) })).toThrow();
    expect(app.coordinator.tools.isRegistered('custom.write')).toBe(false);
    expect(() => app.parseCard(cardSource('custom.write'))).toThrow('unsupported');
    // A separate verifier is a supported host contract when the tool has no bundled one.
    app.registerTool({ name: 'custom.write', description: 'Write through the host', parameters: { type: 'object' }, permission: 'write', effect: 'write', execute: () => ({}) });
    expect(app.coordinator.tools.isRegistered('custom.write')).toBe(true);
  });

  it('preflights an entire MCP catalog so invalid later schemas leave no partial registrations', async () => {
    const root = temp();
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const message = JSON.parse(body) as { id?: number; method: string };
      if (message.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} } } : {
        tools: [{ name: 'valid', inputSchema: { type: 'object' } }, { name: 'invalid', inputSchema: { type: 'object', properties: { broken: { type: 'not-a-json-schema-type' } } } }],
      };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const app = new Application(path.join(root, 'data'), scripted());
    active.push(app);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing port');
      await expect(app.connectMcp({ id: 'atomic', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, tools: { valid: { permission: 'read', effect: 'read' }, invalid: { permission: 'read', effect: 'read' } } })).rejects.toThrow('JSON schema');
      expect(() => app.parseCard(cardSource('mcp.atomic.valid'))).toThrow('unsupported');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
