import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { temp } from './helpers.js';
import { delta, mockServer, sendStream } from './http-server.js';
import { readHostState } from '../src/cli/host-state.js';

const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
async function cli(args: string[], credentials = false): Promise<{ code: number | null; out: string; err: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, KODO_API_KEY: credentials ? 'fixture' : '', OPENAI_API_KEY: '', KODO_MODEL: '' }, windowsHide: true });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
  });
}
function source(version = '1.0.0', tools = 'file.read'): string {
  const root = temp();
  writeFileSync(path.join(root, 'AGENT.md'), `---\nschema_version: 1\nid: test/portable\nversion: ${version}\nname: Portable\ndescription: CLI package fixture\ncapabilities:\n  tools: [${tools}]\n---\nPACKAGE_BEHAVIOR_MARKER. Follow the task.\n`);
  writeFileSync(path.join(root, 'CAPABILITY.json'), JSON.stringify({ schema_version: 1, license: 'MIT', source: { url: 'https://example.test/portable' }, files: [{ path: 'AGENT.md', distributable: true }] }));
  return root;
}
async function install(data: string, version = '1.0.0'): Promise<void> {
  const root = source(version); const output = path.join(temp(), 'portable.zip');
  const exported = await cli(['package', 'export', root, '--output', output, '--data-dir', data, '--json']);
  expect(exported.code, exported.err).toBe(0);
  const imported = await cli(['package', 'import', output, '--data-dir', data, '--json']);
  expect(imported.code, imported.err).toBe(0);
}

describe('CLI capability distribution', () => {
  it('exports, imports, diagnoses and rolls back packages without model credentials or code execution', async () => {
    const data = temp(); await install(data); await install(data, '2.0.0');
    const list = await cli(['package', 'list', '--json', '--data-dir', data]);
    expect(list.code, list.err).toBe(0);
    expect(JSON.parse(list.out)).toMatchObject([{ id: 'test/portable', version: '1.0.0' }, { id: 'test/portable', version: '2.0.0' }]);
    const diagnostic = await cli(['package', 'diagnose', 'test/portable@1.0.0', '--json', '--data-dir', data]);
    expect(JSON.parse(diagnostic.out).status).toBe('ready');
    expect((await cli(['package', 'adopt', 'test/portable@1.0.0', '--data-dir', data])).code).toBe(0);
    expect((await cli(['package', 'adopt', 'test/portable@2.0.0', '--data-dir', data])).code).toBe(0);
    const rollback = await cli(['package', 'rollback', 'test/portable', '--data-dir', data]);
    expect(JSON.parse(rollback.out).version).toBe('1.0.0');
    expect(existsSync(path.join(data, 'runtime.sqlite'))).toBe(false);
    const output = path.join(temp(), 'again.zip');
    expect((await cli(['package', 'export', 'test/portable@1.0.0', '--output', output, '--data-dir', data])).code).toBe(0);
    expect((await cli(['package', 'inspect', output, '--data-dir', data])).out).toContain('test/portable');
  }, 20000);

  it('rejects secret literals and invalid management options before executing resources', async () => {
    const data = temp(); await install(data);
    const bindings = path.join(temp(), 'bindings.json');
    writeFileSync(bindings, JSON.stringify({ mcp: { remote: { headers: { Authorization: 'literal-secret' } } } }));
    const configured = await cli(['package', 'configure', 'test/portable@1.0.0', '--bindings', bindings, '--data-dir', data]);
    expect(configured.code).toBe(1); expect(configured.err).toContain('environment references'); expect(configured.err).not.toContain('literal-secret');
    for (const args of [['package', 'list', 'extra'], ['package', 'adopt', 'test/portable'], ['package', 'export', 'test/portable@1.0.0'], ['package', 'list', '--output', 'x'], ['package', 'verify', 'test/portable@1.0.0', '--workspace', temp()]]) {
      expect((await cli([...args, '--data-dir', data])).code).toBe(1);
    }
    expect((await cli(['run', 'task', '--allow-network', '--data-dir', data])).err).toContain('requires --sandbox');
  }, 20000);

  it('reattaches the immutable original package for an answer in a later CLI process', async () => {
    const data = temp(); await install(data); const workspace = temp(); let requests = 0;
    expect((await cli(['package', 'adopt', 'test/portable@1.0.0', '--data-dir', data])).code).toBe(0);
    const url = await mockServer((body, response) => {
      requests++;
      expect(JSON.stringify(body.messages)).toContain('PACKAGE_BEHAVIOR_MARKER');
      if (requests === 1) sendStream(response, [delta({ tool_calls: [{ index: 0, id: 'ask', function: { name: 'ask_user', arguments: '{"question":"Which language?"}' } }] }), delta({}, 'tool_calls')]);
      else sendStream(response, [delta({ content: 'Package resumed.' }), delta({}, 'stop')]);
    });
    const first = await cli(['run', 'task', '--package', 'test/portable', '--sandbox', '--data-dir', data, '--workspace', workspace, '--model', 'test', '--base-url', url, '--max-context-tokens', '256000', '--max-output-tokens', '8192', '--json'], true);
    expect(first.code, first.err).toBe(2);
    const required = JSON.parse(first.out.trim().split(/\r?\n/).at(-1)!);
    const state = readHostState(data);
    expect(state[0]?.package).toMatchObject({ id: 'test/portable', version: '1.0.0' });
    expect(state[0]?.questionIds).toContain(required.questions[0].id);
    expect(state[0]?.sandbox).toEqual({ network: 'none' });
    await install(data, '2.0.0');
    expect((await cli(['package', 'adopt', 'test/portable@2.0.0', '--data-dir', data])).code).toBe(0);
    const changed = await cli(['answer', required.questions[0].id, '--text', 'Chinese', '--sandbox', '--allow-network', '--data-dir', data], true);
    expect(changed.err).toContain('CAPABILITY_CHANGED'); expect(requests).toBe(1);
    const answer = await cli(['answer', required.questions[0].id, '--text', 'Chinese', '--data-dir', data, '--json'], true);
    expect(answer.code, answer.err).toBe(0); expect(answer.out).toContain('Package resumed.'); expect(requests).toBe(2);
    const persisted = JSON.parse(readFileSync(path.join(data, 'cli-host.json'), 'utf8'));
    expect(persisted[0].package.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted[0].package.version).toBe('1.0.0');
  }, 20000);

  it('fails closed on corrupt local host bindings', () => {
    const data = temp(); mkdirSync(path.join(data, 'nested'));
    writeFileSync(path.join(data, 'cli-host.json'), '{');
    expect(() => readHostState(data)).toThrow('cannot read local execution bindings');
    writeFileSync(path.join(data, 'cli-host.json'), JSON.stringify([{ sessionId: 'session', runIds: [], questionIds: [], sandbox: { network: 'fallback' } }]));
    expect(() => readHostState(data)).toThrow('invalid local execution bindings');
  });

  it.runIf(process.platform === 'win32')('resumes a verified write example without replaying its sandboxed side effect', async () => {
    const data = temp(); const workspace = temp(); const root = source('1.0.0', 'custom.bump');
    writeFileSync(path.join(root, 'tool.json'), JSON.stringify({ format: 'kodo-tool/v1', name: 'custom.bump', description: 'Record one acceptance execution.', parameters: { type: 'object', additionalProperties: false }, permission: 'write', effect: 'write' }));
    writeFileSync(path.join(root, 'tool.mjs'), `import {appendFileSync,readFileSync} from 'node:fs'; import path from 'node:path'; export default (_args,context)=>{const file=path.join(context.workspace,'verification-count.txt');appendFileSync(file,'verified\\n');return {count:readFileSync(file,'utf8').trim().split('\\n').length};};`);
    const declaration = JSON.parse(readFileSync(path.join(root, 'CAPABILITY.json'), 'utf8'));
    declaration.files.push({ path: 'tool.json', distributable: true }, { path: 'tool.mjs', distributable: true });
    declaration.resources = { tools: [{ name: 'custom.bump', descriptor: 'tool.json', entry: 'tool.mjs' }] };
    declaration.examples = [{ name: 'write once', input: JSON.stringify({ tool: 'custom.bump', arguments: {} }), expected: JSON.stringify({ count: 1 }) }];
    writeFileSync(path.join(root, 'CAPABILITY.json'), JSON.stringify(declaration));
    const archive = path.join(temp(), 'write.zip');
    const exported = await cli(['package', 'export', root, '--output', archive, '--data-dir', data]); expect(exported.code, exported.err).toBe(0);
    const imported = await cli(['package', 'import', archive, '--data-dir', data]); expect(imported.code, imported.err).toBe(0);
    let requests = 0;
    const url = await mockServer((_body, response) => {
      requests++;
      if (requests === 1) sendStream(response, [delta({ tool_calls: [{ index: 0, id: 'ask', function: { name: 'ask_user', arguments: '{"question":"Continue?"}' } }] }), delta({}, 'tool_calls')]);
      else sendStream(response, [delta({ content: 'Resumed without another acceptance write.' }), delta({}, 'stop')]);
    });
    const first = await cli(['run', 'task', '--package', 'test/portable@1.0.0', '--allow-write', '--data-dir', data, '--workspace', workspace, '--model', 'test', '--base-url', url, '--max-context-tokens', '256000', '--max-output-tokens', '8192', '--json'], true);
    expect(first.code, first.err).toBe(2);
    expect(readFileSync(path.join(workspace, 'verification-count.txt'), 'utf8')).toBe('verified\n');
    const question = JSON.parse(first.out.trim().split(/\r?\n/).at(-1)!).questions[0].id;
    const bindings = path.join(temp(), 'bindings.json');
    writeFileSync(bindings, JSON.stringify({ mcp: { unused: { url: 'https://example.test/mcp' } } }));
    expect((await cli(['package', 'configure', 'test/portable@1.0.0', '--bindings', bindings, '--data-dir', data])).code).toBe(0);
    const changed = await cli(['answer', question, '--text', 'Yes', '--data-dir', data, '--json'], true);
    expect(changed.code).toBe(1); expect(changed.err).toContain('original package verification');
    expect(readFileSync(path.join(workspace, 'verification-count.txt'), 'utf8')).toBe('verified\n'); expect(requests).toBe(1);
    writeFileSync(bindings, '{}');
    expect((await cli(['package', 'configure', 'test/portable@1.0.0', '--bindings', bindings, '--data-dir', data])).code).toBe(0);
    const answer = await cli(['answer', question, '--text', 'Yes', '--data-dir', data, '--json'], true);
    expect(answer.code, answer.err).toBe(0); expect(requests).toBe(2);
    expect(readFileSync(path.join(workspace, 'verification-count.txt'), 'utf8')).toBe('verified\n');
  }, 60000);
});
