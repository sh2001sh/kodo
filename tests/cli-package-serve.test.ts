import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { PackageRegistry, exportPackage } from '../src/application/index.js';
import type { InstalledPackage } from '../src/application/index.js';
import { serveCommand } from '../src/cli/serve.js';
import { readHostState } from '../src/cli/host-state.js';
import { KodoError } from '../src/runtime/types.js';
import { temp } from './helpers.js';

// The HTTP server itself is exercised by tests/web-packages.test.ts; here the CLI wiring is
// captured without binding a port, and the mocked server asks for a follow-up session so the
// host-state persist/matching path runs end to end.
const serverMock = vi.hoisted(() => ({
  options: undefined as unknown,
  closeCalls: 0,
  createSession: false,
}));
vi.mock('../src/web/server.js', () => ({
  createLocalServer: async (_app: unknown, options: unknown) => {
    serverMock.options = options;
    const policy = options as { onSession?: (sessionId: string) => void };
    if (serverMock.createSession) policy.onSession?.('web-session-package-fixture');
    process.emit('SIGTERM');
    return { origin: 'http://127.0.0.1:1', startupSecret: 'package-serve-secret', async close() { serverMock.closeCalls++; } };
  },
}));

beforeEach(() => { serverMock.options = undefined; serverMock.closeCalls = 0; serverMock.createSession = false; });
afterEach(() => { vi.restoreAllMocks(); });

async function installPackage(data: string): Promise<InstalledPackage> {
  const source = temp();
  writeFileSync(path.join(source, 'AGENT.md'), `---\nschema_version: 1\nid: example/echo\nversion: 1.0.0\nname: Package echo\ndescription: CLI package fixture\ncapabilities:\n  tools: []\n---\nFollow the approved package instructions.\n`);
  const archive = path.join(temp(), 'echo.zip');
  await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.test/echo' }, files: [{ path: 'AGENT.md', distributable: true }] }, archive);
  return await new PackageRegistry(path.join(data, 'capabilities')).import(archive);
}

async function failure(args: string[]): Promise<KodoError> {
  try { await serveCommand(args); }
  catch (error) { expect(error).toBeInstanceOf(KodoError); return error as KodoError; }
  throw new Error(`serveCommand unexpectedly succeeded for ${args.join(' ')}`);
}

describe('kodo serve capability-package options', () => {
  it('documents every package switch in serve --help', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { logs.push(values.map(value => String(value)).join(' ')); });
    await serveCommand(['--help']);
    const help = logs.join('\n');
    expect(help).toContain('kodo serve');
    expect(help).toContain('--packages (read-only capability-package panel');
    expect(help).toContain('--package-actions (requires --packages or --package');
    expect(help).toContain('--npm-cli ABSOLUTE_PATH (requires --package-actions');
    expect(help).toContain('--package author/name[@x.y.z]');
  });

  it('rejects invalid package option combinations before startup', async () => {
    const cases: { args: string[]; message: string }[] = [
      { args: ['--package-actions'], message: '--package-actions requires --packages or --package' },
      { args: ['--npm-cli', path.join(temp(), 'npm-cli.js')], message: '--npm-cli requires --package-actions' },
      { args: ['--packages', '--package-actions', '--npm-cli', 'relative/npm-cli.js'], message: '--npm-cli requires an absolute trusted npm CLI path' },
      { args: ['--package', 'not-a-package'], message: '--package requires author/name or author/name@1.2.3' },
      { args: ['--package', 'Author/name'], message: '--package requires author/name or author/name@1.2.3' },
      { args: ['--package', 'author/name@1.2'], message: '--package requires author/name or author/name@1.2.3' },
      { args: ['--package', 'author/name@1.2.3.4'], message: '--package requires author/name or author/name@1.2.3' },
      { args: ['--package', 'extra/name/more'], message: '--package requires author/name or author/name@1.2.3' },
    ];
    for (const testCase of cases) {
      const error = await failure(testCase.args);
      expect(error.code, testCase.args.join(' ')).toBe('ARGUMENTS');
      expect(error.message).toContain(testCase.message);
    }
  });

  it('accepts valid package combinations and stops at model configuration before startup', async () => {
    const saved = { model: process.env.KODO_MODEL, apiKey: process.env.KODO_API_KEY, openai: process.env.OPENAI_API_KEY };
    delete process.env.KODO_MODEL; delete process.env.KODO_API_KEY; delete process.env.OPENAI_API_KEY;
    try {
      const combinations = [
        ['--packages'],
        ['--package', 'author/name'],
        ['--package', 'author/name@1.2.3', '--package-actions'],
        ['--packages', '--package-actions', '--npm-cli', path.join(temp(), 'npm-cli.js')],
      ];
      for (const args of combinations) {
        const error = await failure(args);
        expect(error.code, args.join(' ')).toBe('MODEL_CONFIG');
      }
    } finally {
      if (saved.model === undefined) delete process.env.KODO_MODEL; else process.env.KODO_MODEL = saved.model;
      if (saved.apiKey === undefined) delete process.env.KODO_API_KEY; else process.env.KODO_API_KEY = saved.apiKey;
      if (saved.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.openai;
    }
  });

  it('refuses startup when the requested package is not installed', async () => {
    const saved = { key: process.env.KODO_TEST_KEY, model: process.env.KODO_MODEL };
    process.env.KODO_TEST_KEY = 'fixture'; delete process.env.KODO_MODEL;
    const data = temp(); const workspace = temp();
    const common = ['--data-dir', data, '--workspace', workspace, '--model', 'fixture', '--api-key-env', 'KODO_TEST_KEY'];
    try {
      const explicit = await failure(['--package', 'example/missing@1.0.0', ...common]);
      expect(explicit.code).toBe('PACKAGE_REGISTRY');
      expect(explicit.message).toContain('example/missing@1.0.0');
      const adopted = await failure(['--package', 'example/missing', ...common]);
      expect(adopted.code).toBe('PACKAGE_REGISTRY');
      expect(adopted.message).toContain('no adopted version');
    } finally {
      if (saved.key === undefined) delete process.env.KODO_TEST_KEY; else process.env.KODO_TEST_KEY = saved.key;
      if (saved.model === undefined) delete process.env.KODO_MODEL; else process.env.KODO_MODEL = saved.model;
    }
  });

  it('activates an installed package, passes its card and panel runtime, and matches persisted package sessions', async () => {
    const savedKey = process.env.KODO_TEST_KEY;
    process.env.KODO_TEST_KEY = 'fixture';
    const data = temp(); const workspace = temp();
    const installed = await installPackage(data);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const common = ['--data-dir', data, '--workspace', workspace, '--model', 'fixture', '--api-key-env', 'KODO_TEST_KEY'];
    try {
      serverMock.createSession = true;
      await serveCommand(['--package', 'example/echo@1.0.0', '--packages', '--package-actions', ...common]);
      serverMock.createSession = false;
      const first = serverMock.options as {
        card?: { id: string; version: string; digest: string };
        packages?: { enabled?: boolean; runtime?: { id: string; version: string; digest: string }; prepare?: boolean; adopt?: boolean };
        sessionIds?: string[];
      };
      expect(first.card).toMatchObject({ id: 'example/echo', version: '1.0.0', digest: installed.card.digest });
      expect(first.packages).toEqual({ enabled: true, runtime: { id: 'example/echo', version: '1.0.0', digest: installed.digest }, prepare: true, adopt: true });
      expect(first.sessionIds).toEqual([]);
      expect(serverMock.closeCalls).toBe(1);
      const state = readHostState(data);
      expect(state).toHaveLength(1);
      expect(state[0]).toEqual({ sessionId: 'web-session-package-fixture', runIds: [], questionIds: [], compaction: { strategy: 'summary', triggerRatio: 0.8 }, package: { id: 'example/echo', version: '1.0.0', digest: installed.digest, stdioWrite: false, stdioNetwork: 'none' } });
      // The identical host configuration sees the package session; absent or different capabilities stay hidden.
      await serveCommand(['--package', 'example/echo@1.0.0', ...common]);
      expect((serverMock.options as { sessionIds: string[] }).sessionIds).toEqual(['web-session-package-fixture']);
      expect((serverMock.options as { card?: { digest: string } }).card?.digest).toBe(installed.card.digest);
      await serveCommand(common);
      expect((serverMock.options as { sessionIds: string[] }).sessionIds).toEqual([]);
      expect((serverMock.options as { card?: unknown }).card).toBeUndefined();
      expect((serverMock.options as { packages?: unknown }).packages).toBeUndefined();
      await serveCommand(['--package', 'example/echo@1.0.0', '--sandbox', ...common]);
      expect((serverMock.options as { sessionIds: string[] }).sessionIds).toEqual([]);
      await serveCommand(['--packages', ...common]);
      expect((serverMock.options as { sessionIds: string[] }).sessionIds).toEqual([]);
      expect((serverMock.options as { packages?: { enabled?: boolean; prepare?: boolean; adopt?: boolean } }).packages).toMatchObject({ enabled: true, prepare: false, adopt: false });
      expect((serverMock.options as { packages?: { runtime?: unknown } }).packages?.runtime).toBeUndefined();
    } finally {
      if (savedKey === undefined) delete process.env.KODO_TEST_KEY; else process.env.KODO_TEST_KEY = savedKey;
    }
  });
});
