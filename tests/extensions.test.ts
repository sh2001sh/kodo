import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { connectMcp, loadSkill, skillTools } from '../src/extensions/index.js';
import type { Skill } from '../src/extensions/index.js';
import { digest } from '../src/storage/index.js';
import { parseCard } from '../src/agents/card.js';
import type { ToolExecutionContext } from '../src/tools/registry.js';
import { Application } from '../src/application/index.js';
import { answer, binding, call, calls, fullToolCard, scripted } from './helpers.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); delete process.env.KODO_TEST_MCP_SECRET; delete process.env.KODO_TEST_MCP_OTHER_SECRET; });
const context = (skills: string[] = [], signal = new AbortController().signal): ToolExecutionContext => ({ run: { card: { ...fullToolCard, skills } }, signal, markEffectStarted() {} } as unknown as ToolExecutionContext);
async function directory(): Promise<string> { const dir = await mkdtemp(path.join(os.tmpdir(), 'kodo-ext-')); cleanup.push(() => rm(dir, { force: true, recursive: true })); return dir; }
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  return `http://127.0.0.1:${address.port}/mcp`;
}
const card = (tools: string, skills = ''): string => `---\nschema_version: 1\nid: test/custom\nversion: 1.0.0\nname: Test\ndescription: Discovery agent\ncapabilities:\n  tools: [${tools}]\n${skills ? `  skills: [${skills}]\n` : ''}---\nWork carefully`;

describe('host skills and card capabilities', () => {
  it('validates structural host skill content and rejects forged or stale content identities', () => {
    const skill: Skill = { id: 'host/review', description: 'Review source evidence.', content: 'Read the original source evidence.', digest: digest('Read the original source evidence.') };
    expect(skillTools([skill])[0]!.version).toMatch(/^[a-f0-9]{64}$/);
    for (const hash of ['', 'malformed', 'a'.repeat(64)]) expect(() => skillTools([{ ...skill, digest: hash }])).toThrow('digest must match');
    expect(() => skillTools([{ ...skill, content: 'Changed instructions using the old digest.' }])).toThrow('digest must match');
    for (const invalid of [null, {}, '', { ...skill, id: '' }, { ...skill, id: '../escape' }, { ...skill, description: '' }, { ...skill, description: 'x\0y' }, { ...skill, description: '\ud800' }]) expect(() => skillTools([invalid as unknown as Skill])).toThrow('valid id');
    for (const content of ['', ' \n\t', 'x\0y', '\ud800', 'x'.repeat(128_001), '中'.repeat(43_000)]) expect(() => skillTools([{ ...skill, content, digest: digest(content) }])).toThrow('valid UTF-8');
    const modified = { ...skill, content: 'Reviewed updated source.', digest: digest('Reviewed updated source.') };
    expect(skillTools([modified])[0]!.version).not.toBe(skillTools([skill])[0]!.version);
  });
  it('loads validated UTF-8 skill snapshots and reveals only allowed skills on demand', async () => {
    const dir = await directory();
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: review\ndescription: Review source with evidence\n---\nRead source.\n' + 'x'.repeat(9000));
    const skill = await loadSkill(dir);
    const tools = skillTools([skill]);
    expect(skill.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await tools[0]!.execute(context(), {})).toEqual({ skills: [] });
    expect(await tools[0]!.execute(context(['review']), {})).toMatchObject({ skills: [{ id: 'review', description: 'Review source with evidence' }] });
    expect(() => tools[1]!.execute(context(), { id: 'review' })).toThrow('not authorized');
    const first = await tools[1]!.execute(context(['review']), { id: 'review' }) as { content: string; next: { offset: number } };
    const second = await tools[1]!.execute(context(['review']), { id: 'review', ...first.next }) as { content: string; next: null };
    expect(first.content + second.content).toBe(skill.content);
    expect(second.next).toBeNull();
    const other = { ...skill, id: 'other-review' };
    expect(skillTools([skill, other])[0]!.version).toBe(skillTools([other, skill])[0]!.version);
    expect(tools[0]!.version).toBe(tools[1]!.version);
    await writeFile(path.join(dir, 'SKILL.md'), skill.content + '\nChanged instructions.');
    expect(skillTools([await loadSkill(dir)])[0]!.version).not.toBe(tools[0]!.version);
    expect(() => tools[1]!.execute(context(['review']), { id: 'review', offset: 99999 })).toThrow('cursor');
    await writeFile(path.join(dir, 'SKILL.md'), Buffer.from([0xff]));
    await expect(loadSkill(dir)).rejects.toThrow('UTF-8');
    expect(() => skillTools([skill, skill])).toThrow('unique');
  });
  it('requires host approval for custom tools and skill IDs and retains description', () => {
    expect(() => parseCard(card('skill.list'))).toThrow('built-in tools only');
    expect(() => parseCard(card('skill.list', 'review'), { toolNames: ['skill.list'] })).toThrow('not registered');
    expect(parseCard(card('skill.list', 'review'), { toolNames: ['skill.list'], skillIds: ['review'] })).toMatchObject({ description: 'Discovery agent', tools: ['skill.list'], skills: ['review'] });
  });
});

describe('MCP HTTP transport', () => {
  it('pins service identity and host semantic version while credential rotation preserves the binding', async () => {
    process.env.KODO_TEST_MCP_SECRET = 'first-secret-value';
    process.env.KODO_TEST_MCP_OTHER_SECRET = 'different-secret-reference';
    const url = await listen(createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += String(chunk);
      const message = JSON.parse(body) as { method: string; id?: number };
      if (message.method.startsWith('notifications/')) { res.writeHead(202); res.end(); return; }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} } } : { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    }));
    const version = async (options: { endpoint?: string; reference?: string; literal?: string; revision?: string; reverse?: boolean } = {}): Promise<string | undefined> => {
      const authorization = { env: options.reference ?? 'KODO_TEST_MCP_SECRET' };
      const literal = options.literal ?? 'host-client';
      const connection = await connectMcp({ id: 'pinned', transport: 'http', url: options.endpoint ?? url,
        headers: options.reverse ? { 'X-Client': literal, Authorization: authorization } : { Authorization: authorization, 'X-Client': literal },
        tools: { echo: { permission: 'read', effect: 'read', ...(options.revision ? { version: options.revision } : {}) } } });
      cleanup.push(() => connection.close());
      return connection.tools[0]!.version;
    };
    const first = await version();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    process.env.KODO_TEST_MCP_SECRET = 'rotated-secret-value';
    expect(await version({ reverse: true })).toBe(first);
    expect(await version({ endpoint: url + '/other' })).not.toBe(first);
    expect(await version({ reference: 'KODO_TEST_MCP_OTHER_SECRET' })).not.toBe(first);
    expect(await version({ literal: 'different-host-client' })).not.toBe(first);
    expect(await version({ revision: '2' })).not.toBe(first);
  });
  it('rejects insecure or credential-bearing endpoint URLs before network IO', async () => {
    for (const url of ['http://example.com/mcp', 'https://user:password@example.com/mcp', 'https://example.com/mcp?token=secret', 'https://example.com/mcp#fragment']) await expect(connectMcp({ id: 'unsafe', transport: 'http', url, tools: {} })).rejects.toThrow('HTTPS or loopback HTTP');
  });
  it('initializes sessions, follows tool pagination, parses SSE, redacts secrets and uses host permissions', async () => {
    process.env.KODO_TEST_MCP_SECRET = 'private-credential-value';
    const methods: string[] = [];
    let pings = 0;
    let deleted = false;
    const server = createServer(async (req, res) => {
      if (req.method === 'DELETE') { deleted = true; res.writeHead(204); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += String(chunk);
      const message = JSON.parse(body) as { id?: number; method: string; params?: { cursor?: string; name?: string; arguments?: { fail?: boolean } } };
      if (!message.method) { pings++; res.writeHead(202); res.end(); return; }
      methods.push(message.method);
      expect(req.headers.authorization).toBe('private-credential-value');
      if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      if (message.method !== 'initialize') expect(req.headers['mcp-session-id']).toBe('test-session');
      let result: unknown;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      else if (message.method === 'tools/list') result = message.params?.cursor ? { tools: [{ name: 'mutate', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } : { tools: [{ name: 'echo', description: 'Echo safely', inputSchema: { type: 'object' } }], nextCursor: 'page2' };
      else result = message.params?.arguments?.fail ? { isError: true, content: [{ type: 'text', text: 'fix configuration private-credential-value' }] } : { content: [{ type: 'text', text: 'private-credential-value' }] };
      res.setHeader('Mcp-Session-Id', 'test-session');
      if (message.method === 'tools/call') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('event: message\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 'server-ping', method: 'ping' }) + '\r\n\r\n');
        res.write(': comment\r\n\r\nevent: message\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} }) + '\r\n\r\n');
        res.write('event: message\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\r\n\r\n');
        // Deliberately leave streaming connection open; client must stop after response.
      } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); }
    });
    const url = await listen(server);
    const connection = await connectMcp({ id: 'fixture', transport: 'http', url, headers: { Authorization: { env: 'KODO_TEST_MCP_SECRET' } }, tools: { mutate: { permission: 'write', effect: 'write' } } });
    cleanup.push(() => connection.close());
    expect(connection.tools).toHaveLength(1);
    expect(connection.tools[0]).toMatchObject({ name: 'mcp.fixture.mutate', permission: 'write', effect: 'write' });
    let marked = false;
    const output = await connection.tools[0]!.execute({ ...context(), markEffectStarted: () => { marked = true; } }, {});
    expect(marked).toBe(true);
    expect(output).toEqual({ content: [{ type: 'text', text: '[REDACTED]' }] });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call']);
    expect(pings).toBe(1);
    await expect(connection.tools[0]!.execute(context(), { fail: true })).rejects.toThrow('fix configuration [REDACTED]');
    await connection.close();
    expect(deleted).toBe(true);
    await expect(connection.tools[0]!.execute(context(), {})).rejects.toThrow('closed');
  });
  it('bounds input and cancels timed out calls without leaking server error text', async () => {
    const server = createServer(async (req, res) => {
      if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
      let body = ''; for await (const chunk of req) body += String(chunk);
      const message = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: { fail?: boolean; malformed?: boolean } } };
      if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      let result: unknown;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} } };
      else if (message.method === 'tools/list') result = { tools: [{ name: 'wait', inputSchema: { type: 'object' } }] };
      else if (message.params?.arguments?.malformed) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {}, error: { code: -32000, message: 'secret from server' } })); return; }
      else if (message.params?.arguments?.fail) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'secret from server' } })); return; }
      else return;
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    const url = await listen(server);
    const connection = await connectMcp({ id: 'errors', transport: 'http', url, timeoutMs: 1000, maxMessageBytes: 1024, tools: { wait: { permission: 'read', effect: 'read' } } });
    cleanup.push(() => connection.close());
    await expect(connection.tools[0]!.execute(context(), { fail: true })).rejects.toThrow('rejected the protocol request');
    await expect(connection.tools[0]!.execute(context(), { malformed: true })).rejects.toThrow('invalid JSON-RPC response');
    await expect(connection.tools[0]!.execute(context(), { long: 'x'.repeat(1200) })).rejects.toThrow('message limit');
    const controller = new AbortController();
    const pending = connection.tools[0]!.execute(context([], controller.signal), {});
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    await expect(connection.tools[0]!.execute(context(), {})).rejects.toThrow('timed out');
  });
});

describe('MCP durable effect integration', () => {
  it.each(['dropped response', 'cancelled request'])('preserves uncertainty after a committed external write with %s', async scenario => {
    const root = await directory();
    let committed!: () => void;
    const effect = new Promise<void>(resolve => { committed = resolve; });
    let executions = 0;
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += String(chunk);
      const message = JSON.parse(body) as { method: string; id?: number };
      if (message.method.startsWith('notifications/')) { res.writeHead(202); res.end(); return; }
      let result: unknown;
      if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} } };
      else if (message.method === 'tools/list') result = { tools: [{ name: 'commit', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
      else {
        executions++;
        await writeFile(path.join(root, 'committed.txt'), 'committed exactly once');
        committed();
        if (scenario === 'dropped response') res.destroy();
        return;
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    const url = await listen(server);
    const app = new Application(path.join(root, '.state'), scripted(calls(call('mcp.durable.commit', {})), answer('External write requires host reconciliation.')));
    cleanup.push(() => app.shutdown());
    await app.connectMcp({ id: 'durable', transport: 'http', url, tools: { commit: { permission: 'write', effect: 'write' } } });
    const capability = app.parseCard(card('mcp.durable.commit'));
    const run = app.createRun({ objective: 'Commit once', workspace: root, binding, permissions: ['read', 'write'], card: capability });
    const pending = app.run(run.id);
    await Promise.race([effect, pending.then(ended => { throw new Error(`run ended before external effect: ${ended.error ?? ended.status}`); })]);
    if (scenario === 'cancelled request') app.coordinator.cancel(run.id);
    const ended = await pending;
    expect(await readFile(path.join(root, 'committed.txt'), 'utf8')).toBe('committed exactly once');
    expect(executions).toBe(1);
    expect(app.store.calls(run.id).find(value => value.kind === 'tool')).toMatchObject({ status: 'unknown', effectState: 'started' });
    if (scenario === 'dropped response') expect(ended.error).toMatch(/^UNKNOWN_WRITE:/);
    else expect(ended.status).toBe('cancelled');
    expect(app.store.unresolvedWrites(root)).toHaveLength(1);
    const next = app.createRun({ objective: 'Do not write before reconciliation', workspace: root, binding, permissions: ['read', 'write'] });
    await expect(app.coordinator.tools.execute(next.id, 'file.apply_patch', { path: 'duplicate.txt', expectedHash: null, content: 'should not exist' }, new AbortController().signal)).rejects.toThrow('unresolved effect');
    expect(executions).toBe(1);
  });
});

describe('MCP stdio transport', () => {
  it('runs an actual host-declared server, isolates environment, propagates cancellation and closes it', async () => {
    const dir = await directory();
    const fixture = path.join(dir, 'server.mjs');
    process.env.KODO_TEST_MCP_SECRET = 'private-credential-value';
    await writeFile(fixture, `import { createInterface } from 'node:readline';
const rl = createInterface({input:process.stdin});
let initialized = false; let pinged = false;
rl.on('line', line => {
 const m=JSON.parse(line); let result;
 if (m.id==='server-ping') {pinged=!!m.result;return;}
 if (m.method==='notifications/initialized') {initialized=true;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'server-ping',method:'ping'})+'\\n');return;}
 if(m.method==='notifications/cancelled') return;
 if(m.method==='initialize') result={protocolVersion:'2025-03-26',capabilities:{tools:{}}};
 else if(m.method==='tools/list') result={tools:[{name:'echo',inputSchema:{type:'object'}}]};
 else if(m.params.arguments.wait) {setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'late cancelled result'}]}})+'\\n'),10);return;}
 else result={content:[{type:'text',text:JSON.stringify({initialized,pinged,secret:process.env.KODO_TEST_MCP_SECRET??null,forwarded:process.env.APPROVED_TOKEN})}]};
 const emit=()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 if(m.params?.arguments?.slow) setTimeout(emit,30);else emit();
});`);
    const connection = await connectMcp({ id: 'local', transport: 'stdio', command: process.execPath, args: [fixture], cwd: dir, env: { APPROVED_TOKEN: { env: 'KODO_TEST_MCP_SECRET' } }, tools: { echo: { permission: 'read', effect: 'read' } } });
    cleanup.push(() => connection.close());
    const result = await connection.tools[0]!.execute(context(), {}) as { content: { text: string }[] };
    expect(JSON.parse(result.content[0]!.text)).toEqual({ initialized: true, pinged: true, secret: null, forwarded: '[REDACTED]' });
    const controller = new AbortController();
    const pending = connection.tools[0]!.execute(context([], controller.signal), { wait: true });
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    const afterCancel = await connection.tools[0]!.execute(context(), { slow: true }) as { content: { text: string }[] };
    expect(JSON.parse(afterCancel.content[0]!.text)).toEqual({ initialized: true, pinged: true, secret: null, forwarded: '[REDACTED]' });
    await connection.close();
    await expect(connection.tools[0]!.execute(context(), {})).rejects.toThrow('closed');
  });
  it('rejects malformed and oversized server frames and missing host policies', async () => {
    const dir = await directory();
    const fixture = path.join(dir, 'invalid.mjs');
    await writeFile(fixture, `process.stdin.once('data',()=>process.stdout.write('x'.repeat(2048)+'\\n'));`);
    await expect(connectMcp({ id: 'invalid', transport: 'stdio', command: process.execPath, args: [fixture], maxMessageBytes: 1024, tools: {} })).rejects.toThrow('message exceeds limit');
    await expect(connectMcp({ id: 'invalid', transport: 'stdio', command: process.execPath, tools: { unsafe: { permission: 'read', effect: 'write' } } })).rejects.toThrow('host tool policy');
  });
});
