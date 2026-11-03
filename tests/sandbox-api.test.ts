import { describe, expect, it } from 'vitest';
import { linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application, PackageRegistry, createSandbox, exportPackage, verifyToolExamples } from '../src/application/index.js';
import { prepareSandboxCommand, sandboxEnvironment } from '../src/sandbox/index.js';
import { binding, temp } from './helpers.js';

describe('sandbox API configuration', () => {
  it('rejects malformed resources and executable scope escapes before launch', async () => {
    const workspace = temp();
    for (const options of [{ workspace, network: 'silent' }, { workspace, deny: '../secret' }, { workspace, readOnlyPaths: [path.dirname(workspace)] }]) {
      await expect(prepareSandboxCommand(process.execPath, [], options as never)).rejects.toThrow();
    }
    await expect(prepareSandboxCommand(process.execPath, [], { workspace, env: { INVALID: 'a\0b' } })).rejects.toThrow('environment');
    writeFileSync(path.join(workspace, 'program.exe'), 'not executable');
    await expect(prepareSandboxCommand(path.join(workspace, 'program.exe'), [], { workspace, scope: { read: [] } })).rejects.toThrow('executable');
  });
  it('inherits a minimal environment and forwards only explicitly bound secrets', () => {
    process.env.KODO_SANDBOX_TEST_SECRET = 'private';
    try {
      expect(sandboxEnvironment()).not.toHaveProperty('KODO_SANDBOX_TEST_SECRET');
      expect(sandboxEnvironment({ EXPLICIT_BINDING: 'bound' })).toHaveProperty('EXPLICIT_BINDING', 'bound');
    } finally { delete process.env.KODO_SANDBOX_TEST_SECRET; }
  });
});

describe.skipIf(process.platform !== 'win32')('real sandbox through kernel process tools', () => {
  it('enforces scoped IO, protects custom runtime storage and hard links, and bounds stdin', async () => {
    const workspace = temp();
    const outside = temp();
    mkdirSync(path.join(workspace, 'allowed'));
    writeFileSync(path.join(workspace, 'allowed', 'visible'), 'visible');
    writeFileSync(path.join(workspace, 'hidden'), 'hidden');
    writeFileSync(path.join(workspace, '.env'), 'credential');
    writeFileSync(path.join(outside, 'secret'), 'outside');
    linkSync(path.join(outside, 'secret'), path.join(workspace, 'allowed', 'hardlink'));
    const app = new Application(path.join(workspace, '.private-state'), undefined, undefined, { sandbox: {}, toolProfile: 'full', taskProtocol: 1, agentFactors: { D: false, E: false } });
    try {
      const run = app.createRun({ objective: 'Scoped test', workspace, binding, permissions: ['read', 'write', 'exec'], scope: { read: ['allowed'], write: ['allowed'] } });
      const output = await app.coordinator.tools.execute(run.id, 'process.exec', { program: process.execPath, args: ['-e', `
        const f=require('node:fs'); const denied=p=>{try{f.readFileSync(p);return false}catch{return true}};
        f.writeFileSync('allowed/result','ok');
        console.log(JSON.stringify({read:f.readFileSync('allowed/visible','utf8'),hidden:denied('hidden'),private:denied('.private-state/owner.lock'),env:denied('.env'),hardlink:denied('allowed/hardlink'),outside:denied(${JSON.stringify(path.join(outside, 'secret'))})}));
      `] }, AbortSignal.timeout(30000)) as { exitCode: number; stdout: string; stderr: string };
      expect(output.exitCode, output.stderr).toBe(0);
      expect(JSON.parse(output.stdout)).toEqual({ read: 'visible', hidden: true, private: true, env: true, hardlink: true, outside: true });
      expect(readFileSync(path.join(workspace, 'allowed', 'result'), 'utf8')).toBe('ok');
      const sandbox = createSandbox({ workspace });
      const echo = await sandbox.run(process.execPath, ['-e', `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(s))`], { stdin: '中文 $(); literal' });
      expect(echo.exitCode, echo.stderr).toBe(0);
      expect(echo.stdout.trim()).toBe('中文 $(); literal');
      await expect(sandbox.run(process.execPath, [], { stdin: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow('1 MiB');
    } finally { await app.shutdown(); }
  }, 30000);
  it('requires a write grant even when execution is authorized', async () => {
    const workspace = temp();
    const app = new Application(temp(), undefined, undefined, { sandbox: {}, toolProfile: 'full', taskProtocol: 1, agentFactors: { D: false, E: false } });
    try {
      const run = app.createRun({ objective: 'Read-only execution', workspace, binding, permissions: ['read', 'exec'] });
      const output = await app.coordinator.tools.execute(run.id, 'process.exec', { program: process.execPath, args: ['-e', `try{require('node:fs').writeFileSync('denied','bad');console.log('WRITTEN')}catch{console.log('DENIED')}`] }, AbortSignal.timeout(30000)) as { stdout: string; exitCode: number; stderr: string };
      expect(output.exitCode, output.stderr).toBe(0);
      expect(output.stdout.trim()).toBe('DENIED');
    } finally { await app.shutdown(); }
  }, 30000);
  it('loads verified package resources inside private storage without exposing the store', async () => {
    const workspace = temp(); const source = temp();
    const app = new Application(path.join(workspace, '.private-state'));
    try {
      writeFileSync(path.join(workspace, 'public.txt'), 'visible');
      writeFileSync(path.join(source, 'AGENT.md'), '---\nschema_version: 1\nid: example/private-resource\nversion: 1.0.0\nname: Private resource\ndescription: Verify isolated package resource loading\ncapabilities:\n  tools: [fixture.private]\n---\nCheck the isolated package resources.\n');
      writeFileSync(path.join(source, 'tool.json'), JSON.stringify({ format: 'kodo-tool/v1', name: 'fixture.private', description: 'Check isolated resource loading', permission: 'read', effect: 'read', parameters: { type: 'object', additionalProperties: false } }));
      writeFileSync(path.join(source, 'value.mjs'), 'export const value = 42;');
      writeFileSync(path.join(source, 'tool.mjs'), `import {readFileSync} from 'node:fs'; import {value} from './value.mjs';
        export function execute() {
          let privateDenied = false;
          try { readFileSync('.private-state/owner.lock'); } catch { privateDenied = true; }
          return {value, visible: readFileSync('public.txt', 'utf8'), privateDenied};
        }`);
      const expected = { value: 42, visible: 'visible', privateDenied: true };
      const archive = path.join(temp(), 'package.zip');
      await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.com/fixture' }, files: ['AGENT.md', 'tool.json', 'tool.mjs', 'value.mjs'].map(file => ({ path: file, distributable: true })), resources: { tools: [{ name: 'fixture.private', descriptor: 'tool.json', entry: 'tool.mjs' }] }, examples: [{ name: 'private store', input: JSON.stringify({ tool: 'fixture.private', arguments: {} }), expected: JSON.stringify(expected) }] }, archive);
      const registry = new PackageRegistry(path.join(app.store.directory, 'capabilities'));
      await registry.import(archive);
      const card = await registry.activate(app, 'example/private-resource', '1.0.0', { workspace, verifyExamples: verifyToolExamples({ workspace }) });
      const run = app.createRun({ objective: 'Check private resource isolation', workspace, card, binding, permissions: ['read'] });
      expect(await app.coordinator.tools.execute(run.id, 'fixture.private', {}, AbortSignal.timeout(30000))).toEqual(expected);
      expect(readFileSync(path.join(app.store.directory, 'owner.lock'), 'utf8')).not.toBe('');
    } finally { await app.shutdown(); }
  }, 45000);
});
