import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PackageRegistry, validatePackageBindings } from '../src/packages/registry.js';
import { activatePackage, nodeRequirementMatches, verifyToolExamples } from '../src/packages/runtime.js';
import type { PackageHost } from '../src/packages/runtime.js';
import { exportPackage } from '../src/packages/archive.js';
import type { InstalledPackage, PackageDeclaration } from '../src/packages/schema.js';
import type { SandboxRunner } from '../src/sandbox/execute.js';
import type { ToolExecutionContext, ToolRegistration } from '../src/tools/registry.js';

const sandboxState = vi.hoisted(() => ({ runner: undefined as SandboxRunner | undefined }));
vi.mock('../src/sandbox/execute.js', () => ({ createSandbox: () => { if (!sandboxState.runner) throw new Error('native sandbox intentionally unavailable in fixture'); return sandboxState.runner; } }));
const cleanups: string[] = [];
afterEach(async () => { sandboxState.runner = undefined; for (const file of cleanups.splice(0)) await rm(file, { force: true, recursive: true }); delete process.env.KODO_PACKAGE_TEST_SECRET; });
async function dir(): Promise<string> { const result = await mkdtemp(path.join(os.tmpdir(), 'kodo-package-runtime-')); cleanups.push(result); return result; }
const descriptor = { format: 'kodo-tool/v1', name: 'custom.echo', description: 'Return a local test value.', parameters: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } }, permission: 'read', effect: 'read' };
async function fixture(options: { version?: string; declaration?: Partial<PackageDeclaration>; module?: string } = {}): Promise<{ registry: PackageRegistry; installed: InstalledPackage; source: string }> {
  const source = await dir(); const registry = new PackageRegistry(await dir());
  await writeFile(path.join(source, 'AGENT.md'), `---\nschema_version: 1\nid: example/custom\nversion: ${options.version ?? '1.0.0'}\nname: Custom\ndescription: Test package\ncapabilities:\n  tools: [custom.echo]\n---\nFollow the user task.\n`);
  await writeFile(path.join(source, 'tool.json'), JSON.stringify(descriptor));
  await writeFile(path.join(source, 'tool.mjs'), options.module ?? 'export default (args, context) => ({text: args.text, run: context.runId});');
  const declaration: PackageDeclaration = { schema_version: 1, license: 'MIT', source: { url: 'https://example.com/package', revision: 'abc123' }, files: ['AGENT.md', 'tool.json', 'tool.mjs'].map(file => ({ path: file, distributable: true })), ...options.declaration, resources: { tools: [{ name: 'custom.echo', descriptor: 'tool.json', entry: 'tool.mjs' }], ...options.declaration?.resources } };
  const archive = path.join(await dir(), 'package.zip');
  await exportPackage(source, declaration, archive);
  const installed = await registry.import(archive);
  return { registry, installed, source };
}
function host(): PackageHost & { tools: ToolRegistration[]; calls: string[] } {
  const tools: ToolRegistration[] = []; const calls: string[] = [];
  return { tools, calls, registerTool(tool) { calls.push(tool.name); tools.push(tool); }, registerSkills() { calls.push('skills'); }, async connectMcp() { calls.push('mcp'); }, registerCard() { calls.push('card'); } };
}
function context(workspace: string): ToolExecutionContext { return { session: { workspace, id: 'session' }, run: { id: 'run', scope: { read: ['allowed'], write: [] } }, signal: new AbortController().signal, markEffectStarted() {} } as unknown as ToolExecutionContext; }
/** Explicit fixture injection: production createSandbox is never replaced by a trusted fallback. */
function fixtureRunner(): SandboxRunner {
  return { run(program, args, options = {}) { return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: options.cwd, stdio: 'pipe', env: { ...process.env, NODE_OPTIONS: '' } });
    let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr, truncated: false, cancelled: false, outputLimitExceeded: false }));
    child.stdin.end(options.stdin ?? '');
  }); } };
}

describe('inert package registry and adoption', () => {
  it('imports source without executing code, tracks provenance, and verifies immutable identities', async () => {
    const marker = path.join(await dir(), 'executed');
    const { registry, installed } = await fixture({ module: `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'executed'); export default ()=>null;` });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await registry.list()).map(item => item.digest)).toEqual([installed.digest]);
    expect(await registry.provenance(installed.card.id, installed.card.version)).toMatchObject({ digest: installed.digest, source: { revision: 'abc123' } });
    expect((await registry.diagnose(installed.card.id, installed.card.version)).status).toBe('ready');
    await writeFile(path.join(installed.root, 'tool.mjs'), 'changed');
    await expect(registry.inspect(installed.card.id, installed.card.version)).rejects.toThrow('does not match');
  });
  it('adopts and rolls back only local pointers without activating any resources', async () => {
    const first = await fixture(); const second = await fixture({ version: '2.0.0' });
    const archive = path.join(await dir(), 'second.zip');
    await second.registry.export('example/custom', '2.0.0', archive);
    await first.registry.import(archive);
    expect((await first.registry.adopt('example/custom', '1.0.0')).version).toBe('1.0.0');
    expect((await first.registry.adopt('example/custom', '2.0.0')).previous?.version).toBe('1.0.0');
    expect((await first.registry.rollback('example/custom')).version).toBe('1.0.0');
    expect((await first.registry.current('example/custom'))?.version).toBe('1.0.0');
    await expect(first.registry.inspect('../outside', '1.0.0')).rejects.toThrow('identity');
    await expect(first.registry.rollback('unknown/package')).rejects.toThrow('previously');
  });
  it('keeps local endpoints and credential references outside exported archives', async () => {
    const resource = { id: 'remote', transport: 'http' as const, url: 'https://template.example/mcp', tools: {} };
    const { registry, installed } = await fixture({ declaration: { resources: { tools: [{ name: 'custom.echo', descriptor: 'tool.json', entry: 'tool.mjs' }], mcp: [resource] } } });
    expect((await registry.diagnose(installed.card.id, installed.card.version)).status).toBe('imported');
    await registry.configure(installed.card.id, installed.card.version, { mcp: { remote: { url: 'https://local-private.example/mcp', headers: { Authorization: { env: 'KODO_PACKAGE_TEST_SECRET' } } } } });
    expect((await registry.diagnose(installed.card.id, installed.card.version)).status).toBe('needs_configuration');
    process.env.KODO_PACKAGE_TEST_SECRET = 'local-secret';
    expect((await registry.diagnose(installed.card.id, installed.card.version)).status).toBe('ready');
    const archive = path.join(await dir(), 'export.zip'); await registry.export(installed.card.id, installed.card.version, archive);
    const imported = await new PackageRegistry(await dir()).import(archive);
    expect(JSON.stringify(imported.manifest)).not.toContain('local-private');
    expect(JSON.stringify(imported.manifest)).not.toContain('KODO_PACKAGE_TEST_SECRET');
    expect(() => validatePackageBindings({ mcp: { remote: { headers: { Authorization: 'literal-secret' } } } })).toThrow('environment references');
    expect(() => validatePackageBindings({ mcp: { remote: { url: 'https://user:secret@example.com' } } })).toThrow('without embedded');
  });
  it('rejects incompatible platform and unrecognized Node requirements before registration', async () => {
    const { registry, installed } = await fixture({ declaration: { requirements: { platforms: ['unsupported-os'] } } });
    expect((await registry.diagnose(installed.card.id, installed.card.version)).status).toBe('incompatible');
    const destination = host(); await expect(activatePackage(destination, installed, { workspace: await dir() })).rejects.toThrow('unsupported');
    expect(destination.calls).toEqual([]);
    expect(nodeRequirementMatches('>=24 <25', '24.19.0')).toBe(true);
    expect(nodeRequirementMatches('>=24 <25', '25.0.0')).toBe(false);
    expect(nodeRequirementMatches('^0.0.2', '0.0.3')).toBe(false);
    expect(nodeRequirementMatches('unknown syntax', '24.0.0')).toBe(false);
  });
});

describe('explicit sandboxed package activation', () => {
  it('runs modules through isolated worker JSON IPC and does not import them in the host', async () => {
    const { installed } = await fixture(); const destination = host(); const workspace = await dir();
    sandboxState.runner = fixtureRunner(); await activatePackage(destination, installed, { workspace });
    expect(destination.calls).toEqual(['custom.echo', 'card']);
    expect(await destination.tools[0]!.execute(context(workspace), { text: 'hello' })).toEqual({ text: 'hello', run: 'run' });
    expect(destination.tools[0]!.version).toMatch(/^[a-f0-9]{64}$/);
  });
  it('never silently falls back when the native sandbox is unavailable', async () => {
    const { installed } = await fixture(); const destination = host(); const workspace = await dir();
    await activatePackage(destination, installed, { workspace });
    await expect(destination.tools[0]!.execute(context(workspace), {})).rejects.toThrow('native sandbox intentionally unavailable');
  });
  it('rejects bad worker output and cancellation, including a forged success body on process failure', async () => {
    const { installed } = await fixture(); const workspace = await dir();
    for (const output of [{ exitCode: 1, stdout: '{"protocol":"kodo-tool-result/v1","result":true}', cancelled: false }, { exitCode: 0, stdout: 'not json', cancelled: false }, { exitCode: 0, stdout: '{}', cancelled: true }]) {
      const destination = host(); const sandbox: SandboxRunner = { async run() { return { ...output, signal: null, stderr: '', truncated: false, outputLimitExceeded: false }; } };
      sandboxState.runner = sandbox; await activatePackage(destination, installed, { workspace });
      await expect(destination.tools[0]!.execute(context(workspace), {})).rejects.toThrow(/sandboxed tool/);
    }
  });
  it('requires successful host example verification before changing the capability catalog', async () => {
    const { installed } = await fixture({ declaration: { examples: [{ name: 'hello', input: 'Say hello', expected: 'hello' }] } });
    const destination = host(); const workspace = await dir();
    await expect(activatePackage(destination, installed, { workspace })).rejects.toThrow('explicit host verifier');
    await expect(activatePackage(destination, installed, { workspace, verifyExamples: () => ({ passed: false, evidence: 'wrong output' }) })).rejects.toThrow('did not pass');
    expect(destination.calls).toEqual([]);
    await activatePackage(destination, installed, { workspace, verifyExamples: ({ installed: verified }) => ({ passed: verified.digest === installed.digest, evidence: 'Fixture examples checked' }) });
    expect(destination.calls).toEqual(['custom.echo', 'card']);
  });
  it('records successful example verification against the exact package and local binding identity', async () => {
    const { registry, installed } = await fixture({ declaration: { examples: [{ name: 'fixture', input: 'Check result' }] } });
    expect((await registry.diagnose(installed.card.id, installed.card.version)).reasons).toContain('examples require verification at activation');
    await registry.activate(host(), installed.card.id, installed.card.version, { workspace: await dir(), verifyExamples: () => ({ passed: true, evidence: 'Checked fixture output' }) });
    expect((await registry.diagnose(installed.card.id, installed.card.version)).status).toBe('ready');
    await registry.configure(installed.card.id, installed.card.version, { mcp: {} });
    expect((await registry.diagnose(installed.card.id, installed.card.version)).status).toBe('needs_configuration');
  });
  it('verifies declared tool examples with schema validation and real worker results before activation', async () => {
    const { installed } = await fixture({ declaration: { examples: [{ name: 'fixture', input: JSON.stringify({ tool: 'custom.echo', arguments: { text: 'verified' } }), expected: JSON.stringify({ text: 'verified' }) }] }, module: 'export const execute = args => ({text:args.text});' });
    const destination = host(); const workspace = await dir(); sandboxState.runner = fixtureRunner();
    await activatePackage(destination, installed, { workspace, verifyExamples: verifyToolExamples({ workspace }) });
    expect(destination.calls).toEqual(['custom.echo', 'card']);
    const wrong = await fixture({ declaration: { examples: [{ name: 'wrong', input: JSON.stringify({ tool: 'custom.echo', arguments: { text: 12 } }), expected: '{}' }] } });
    await expect(activatePackage(host(), wrong.installed, { workspace, verifyExamples: verifyToolExamples({ workspace }) })).rejects.toThrow('schema');
    const different = await fixture({ declaration: { examples: [{ name: 'different', input: JSON.stringify({ tool: 'custom.echo', arguments: { text: 'value' } }), expected: 'true' }] } });
    await expect(activatePackage(host(), different.installed, { workspace, verifyExamples: verifyToolExamples({ workspace }) })).rejects.toThrow('different result');
  });
  it('requires host endpoints for remote MCP and explicit lifetime sandbox grants for local MCP', async () => {
    const remote = await fixture({ declaration: { resources: { mcp: [{ id: 'remote', transport: 'http', url: 'https://template.example/mcp', tools: {} }] } } });
    const workspace = await dir();
    await expect(activatePackage(host(), remote.installed, { workspace })).rejects.toThrow('missing local');
    const local = await fixture({ declaration: { resources: { mcp: [{ id: 'local', transport: 'stdio', entry: 'tool.mjs', tools: {} }] } } });
    await expect(activatePackage(host(), local.installed, { workspace })).rejects.toThrow('explicit host sandbox');
    const configs: unknown[] = []; const destination = { ...host(), async connectMcp(config: unknown) { configs.push(config); } };
    await activatePackage(destination, local.installed, { workspace, stdio: { write: false, network: 'none' } });
    expect(configs[0]).toMatchObject({ transport: 'stdio', command: process.execPath, sandbox: { workspace, write: false, network: 'none', readOnlyPaths: [local.installed.root] } });
  });
  it('requires explicit dependency preparation and rejects unpinned or nonregistry dependencies before running npm', async () => {
    const root = await dir(); const requirements = { dependencies: { dependency: '1.0.0' } };
    const source = await dir();
    await writeFile(path.join(source, 'AGENT.md'), '---\nschema_version: 1\nid: example/deps\nversion: 1.0.0\nname: Deps\ndescription: Dependency package\ncapabilities:\n  tools: []\n---\nDo the task.');
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies: { dependency: '1.0.0' } }));
    await writeFile(path.join(source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { dependency: '1.0.0' } }, 'node_modules/dependency': { version: '1.0.0', resolved: 'https://evil.example/dependency.tgz', integrity: 'sha512-YWJj' } } }));
    const archive = path.join(await dir(), 'dependencies.zip');
    await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.com' }, requirements, files: ['AGENT.md', 'package.json', 'package-lock.json'].map(file => ({ path: file, distributable: true })) }, archive);
    const registry = new PackageRegistry(root); const installed = await registry.import(archive); const runner = vi.fn();
    sandboxState.runner = { run: runner }; await expect(registry.prepareDependencies('example/deps', '1.0.0')).rejects.toThrow('registry.npmjs.org');
    expect(runner).not.toHaveBeenCalled();
    await expect(activatePackage(host(), installed, { workspace: await dir() })).rejects.toThrow('explicitly prepared');
    await mkdir(path.join(root, 'unrelated')); // Preparation failure does not remove the registry.
  });
  it('prepares dependencies only by explicit sandboxed npm ci with lifecycle scripts disabled in a derived tree', async () => {
    const source = await dir(); const registry = new PackageRegistry(await dir());
    await writeFile(path.join(source, 'AGENT.md'), '---\nschema_version: 1\nid: example/deps\nversion: 1.0.0\nname: Deps\ndescription: Dependency package\ncapabilities:\n  tools: []\n---\nDo the task.');
    const dependencies = { fixture: '1.0.0' };
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies, scripts: { postinstall: 'must never run' } }));
    await writeFile(path.join(source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies }, 'node_modules/fixture': { version: '1.0.0', resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz', integrity: 'sha512-YWJj' } } }));
    const archive = path.join(await dir(), 'dependencies.zip');
    await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.com' }, requirements: { dependencies }, files: ['AGENT.md', 'package.json', 'package-lock.json'].map(file => ({ path: file, distributable: true })) }, archive);
    const installed = await registry.import(archive); const run = vi.fn(async (_program: string, _args: string[], options: { cwd?: string } = {}) => {
      await mkdir(path.join(options.cwd!, 'node_modules', 'fixture'), { recursive: true });
      await writeFile(path.join(options.cwd!, 'node_modules', 'fixture', 'index.js'), 'export default true;');
      return { exitCode: 0, signal: null, stdout: '', stderr: '', truncated: false, cancelled: false, outputLimitExceeded: false };
    });
    sandboxState.runner = { run };
    expect(run).not.toHaveBeenCalled();
    const npmCli = path.join(await dir(), 'npm-cli.js'); await writeFile(npmCli, '// trusted fixture');
    const prepared = await registry.prepareDependencies('example/deps', '1.0.0', { npmCli });
    expect(prepared).not.toBe(installed.root);
    expect(run.mock.calls[0]![0]).toBe(process.execPath);
    expect(run.mock.calls[0]![1]).toContain('--ignore-scripts');
    expect(run.mock.calls[0]![1]).toContain('ci');
    await expect(readFile(path.join(installed.root, 'node_modules', 'fixture', 'index.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await registry.diagnose('example/deps', '1.0.0')).preparedRoot).toBe(prepared);
    await registry.activate(host(), 'example/deps', '1.0.0', { workspace: await dir() });
    await writeFile(path.join(prepared, 'node_modules', 'fixture', 'index.js'), 'export default false;');
    await expect(registry.diagnose('example/deps', '1.0.0')).rejects.toThrow('content changed');
  });
});
