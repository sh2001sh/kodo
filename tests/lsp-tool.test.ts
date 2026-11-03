import { describe, expect, it } from 'vitest';
import { writeFile, mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { lspTools } from '../src/tools/lsp.js';
import { Application } from '../src/application/index.js';
import type { ToolExecutionContext } from '../src/tools/registry.js';
import { binding, fixture, temp } from './helpers.js';

// Real child process exercising byte-framed transport, initialize/open/request/close and UTF-8 lengths.
const fake = String.raw`
let buffer = Buffer.alloc(0); let uri; let text;
function send(message) { const body = JSON.stringify({ jsonrpc: '2.0', ...message }); const packet = Buffer.from('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body); process.stdout.write(packet.subarray(0, 8)); process.stdout.write(packet.subarray(8)); }
process.stdin.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); for (;;) {
const boundary = buffer.indexOf('\r\n\r\n'); if (boundary < 0) return;
const length = Number(buffer.subarray(0, boundary).toString().split(':')[1]); if (buffer.length < boundary + 4 + length) return;
const message = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length)); buffer = buffer.subarray(boundary + 4 + length);
if (message.method === 'initialize') send({ id: message.id, result: { capabilities: { hoverProvider: true, ...(!process.argv.includes('--push') ? { diagnosticProvider: {} } : {}) } } });
else if (message.method === 'textDocument/didOpen') { uri = message.params.textDocument.uri; text = message.params.textDocument.text; if (text === 'push') send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ message: 'push diagnostic', severity: 2 }] } }); }
else if (message.method === 'textDocument/hover') {
if (text === 'hang') continue;
if (text.includes('error')) send({ id: message.id, error: { code: -32603, message: 'fixture failure' } });
else if (text.includes('oversize')) process.stdout.write('Content-Length: 999999999\r\n\r\n');
else send({ id: message.id, result: { contents: { kind: 'plaintext', value: text } } }); }
else if (message.method === 'textDocument/definition') send({ id: message.id, result: [{ uri: text.includes('escape') ? require('node:url').pathToFileURL(require('node:path').resolve(process.cwd(), '..', 'secret.ts')).href : uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] });
else if (message.method === 'textDocument/diagnostic') send({ id: message.id, result: { kind: 'full', items: [{ message: 'fixture diagnostic', severity: 2 }] } });
else if (message.method === 'textDocument/references') send({ id: message.id, result: [] });
else if (message.method === 'textDocument/documentSymbol') send({ id: message.id, result: [{ name: 'fixture', kind: 12 }] });
else if (message.method === 'shutdown') { if (text !== 'shutdownhang') send({ id: message.id, result: null }); }
else if (message.method === 'exit') process.exit(0);
} });`;

async function setup(text = 'const 中文 = 1;', timeoutMs = 4000) {
  const { app, root, runId } = fixture();
  const file = path.join(root, 'fixture.cjs');
  await writeFile(file, fake);
  await writeFile(path.join(root, 'main.ts'), text);
  const run = app.store.run(runId);
  const context: ToolExecutionContext = { run, session: app.store.session(run.sessionId), signal: new AbortController().signal, markEffectStarted() {} };
  const tools = lspTools({ servers: [{ id: 'fixture', program: process.execPath, args: [file, ...(text === 'push' ? ['--push'] : [])], languages: { '.ts': 'typescript' } }], timeoutMs });
  return { tools, context, root };
}
describe('host-approved stdio LSP', () => {
  it('registers unavailable language tools without breaking an unconfigured host', async () => {
    const { context } = await setup();
    const tools = lspTools({ servers: [] });
    expect(tools).toHaveLength(5);
    for (const tool of tools) await expect(tool.execute(context, { path: 'main.ts', line: 0, character: 0 })).rejects.toThrow('no host-approved language servers');
  });
  it('initializes a real server, frames UTF-8, opens current source and reads hover/locations/symbols/diagnostics', async () => {
    const { tools, context, root } = await setup();
    const hover = tools.find(tool => tool.name === 'lsp.hover')!;
    expect(await hover.execute(context, { path: 'main.ts', line: 0, character: 0 })).toMatchObject({ result: { contents: { value: 'const 中文 = 1;' } }, shutdown: 'graceful' });
    await writeFile(path.join(root, 'main.ts'), 'changed source');
    expect(await hover.execute(context, { path: 'main.ts', line: 0, character: 0 })).toMatchObject({ result: { contents: { value: 'changed source' } } });
    for (const operation of ['definition', 'references', 'symbols', 'diagnostics']) {
      expect(await tools.find(tool => tool.name === `lsp.${operation}`)!.execute(context, { path: 'main.ts', line: 0, character: 0 })).toHaveProperty('result');
    }
  });
  it('rejects parent traversal, protected paths, run scope and out-of-document positions before starting a server', async () => {
    const { tools, context, root } = await setup('😀');
    const hover = tools[0]!;
    for (const file of ['../main.ts', '.env', '.kodo/private.ts']) await expect(hover.execute(context, { path: file, line: 0, character: 0 })).rejects.toThrow('workspace-relative');
    await mkdir(path.join(root, 'allowed'));
    await expect(hover.execute({ ...context, run: { ...context.run, scope: { read: ['allowed'] } } }, { path: 'main.ts', line: 0, character: 0 })).rejects.toThrow('outside');
    for (const position of [{ line: 1, character: 0 }, { line: 0, character: 1 }, { line: 0, character: 3 }]) await expect(hover.execute(context, { path: 'main.ts', ...position })).rejects.toThrow('UTF-16');
  });
  it('rejects server response locations escaping workspace and propagates server/protocol errors', async () => {
    const { tools, context, root } = await setup('escape');
    await expect(tools[1]!.execute(context, { path: 'main.ts', line: 0, character: 0 })).rejects.toThrow('outside');
    await writeFile(path.join(root, 'main.ts'), 'error');
    await expect(tools[0]!.execute(context, { path: 'main.ts', line: 0, character: 0 })).rejects.toThrow('fixture failure');
    await writeFile(path.join(root, 'main.ts'), 'oversize');
    await expect(tools[0]!.execute(context, { path: 'main.ts', line: 0, character: 0 })).rejects.toThrow('limit');
  });
  it('bounds hanging servers and honors caller cancellation', async () => {
    const { tools, context } = await setup('hang', 150);
    await expect(tools[0]!.execute(context, { path: 'main.ts', line: 0, character: 0 })).rejects.toThrow('cancelled');
    const controller = new AbortController(); controller.abort();
    await expect(tools[0]!.execute({ ...context, signal: controller.signal }, { path: 'main.ts', line: 0, character: 0 })).rejects.toThrow();
  });
  it('waits for publish diagnostics and reports forced shutdown of uncooperative servers', async () => {
    const push = await setup('push');
    expect(await push.tools[4]!.execute(push.context, { path: 'main.ts' })).toMatchObject({ result: { items: [{ message: 'push diagnostic' }] } });
    const forced = await setup('shutdownhang');
    expect(await forced.tools[0]!.execute(forced.context, { path: 'main.ts', line: 0, character: 0 })).toMatchObject({ shutdown: 'terminated' });
  });
  it('protects explicit host storage even if it is inside the workspace and otherwise readable', async () => {
    const { context, root } = await setup();
    const privateDirectory = path.join(root, 'private');
    await mkdir(privateDirectory);
    await writeFile(path.join(privateDirectory, 'record.ts'), 'private');
    const tool = lspTools({ servers: [{ id: 'fixture', program: process.execPath, args: [path.join(root, 'fixture.cjs')], languages: { '.ts': 'typescript' } }], privatePaths: [privateDirectory] })[0]!;
    await expect(tool.execute(context, { path: 'private/record.ts', line: 0, character: 0 })).rejects.toThrow('private host storage');
  });
  it('pins host configuration and rejects ambiguous language routing', () => {
    const server = { id: 'one', program: process.execPath, args: ['a'], languages: { '.ts': 'typescript' } };
    expect(() => lspTools({ servers: [server, { ...server, id: 'two' }] })).toThrow('unique');
    expect(lspTools({ servers: [server] })[0]!.version).not.toBe(lspTools({ servers: [{ ...server, args: ['b'] }] })[0]!.version);
    expect(lspTools({ servers: [server] })[0]!.permission).toBe('read');
  });
  it('normalizes equivalent sandbox defaults while pinning explicit protected paths and policy changes', async () => {
    const { root } = fixture();
    const other = path.join(root, 'other'); await mkdir(other);
    expect(lspTools({ servers: [], sandbox: {} })[0]!.version).toBe(lspTools({ servers: [], sandbox: { network: 'none' } })[0]!.version);
    expect(lspTools({ servers: [], sandbox: { network: 'none' } })[0]!.version).not.toBe(lspTools({ servers: [], sandbox: { network: 'allow' } })[0]!.version);
    expect(lspTools({ servers: [] })[0]!.version).not.toBe(lspTools({ servers: [], sandbox: {} })[0]!.version);
    expect(lspTools({ servers: [], privatePaths: [root] })[0]!.version).not.toBe(lspTools({ servers: [], privatePaths: [other] })[0]!.version);
    expect(lspTools({ servers: [], runtimeDirectory: root })[0]!.version).toBe(lspTools({ servers: [], runtimeDirectory: other })[0]!.version);
  });
  it('protects the relocated runtime directory while preserving its capability identity', async () => {
    const { context, root } = await setup();
    const original = path.join(root, 'original-state'); const restored = path.join(root, 'restored-state');
    await mkdir(original); await mkdir(restored);
    await writeFile(path.join(restored, 'private.ts'), 'private runtime data');
    const server = { id: 'fixture', program: process.execPath, args: [path.join(root, 'fixture.cjs')], languages: { '.ts': 'typescript' } };
    const old = lspTools({ servers: [server], runtimeDirectory: original })[0]!;
    const current = lspTools({ servers: [server], runtimeDirectory: restored })[0]!;
    expect(current.version).toBe(old.version);
    await expect(current.execute(context, { path: 'restored-state/private.ts', line: 0, character: 0 })).rejects.toThrow('private host storage');
  });
  it('restores default LSP contracts after application restart and backup relocation', async () => {
    const root = temp();
    const state = path.join(root, 'state'); const backup = path.join(root, 'backup');
    const first = new Application(state);
    const run = first.createRun({ objective: 'resume a backup', workspace: root, binding });
    first.store.updateRun(run.id, { status: 'interrupted' });
    const pinned = first.coordinator.tools.bindingSnapshot(['lsp.hover', 'lsp.definition', 'lsp.references', 'lsp.symbols', 'lsp.diagnostics']);
    await first.shutdown();
    const restarted = new Application(state);
    try {
      expect(restarted.coordinator.tools.bindingSnapshot(Object.keys(pinned).filter(name => name.startsWith('lsp.')))).toEqual(pinned);
      expect((await restarted.reconcile(run.id)).blocked).toEqual([]);
    } finally { await restarted.shutdown(); }
    await cp(state, backup, { recursive: true });
    const restored = new Application(backup);
    try {
      expect(restored.coordinator.tools.bindingSnapshot(Object.keys(pinned).filter(name => name.startsWith('lsp.')))).toEqual(pinned);
      expect((await restored.reconcile(run.id)).blocked).toEqual([]);
    } finally { await restored.shutdown(); }
  });
});
