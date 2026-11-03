import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { serveCommand } from '../src/cli/serve.js';
import { agentAuthoringCommand } from '../src/agents/authoring-cli.js';
import { caseCommand } from '../src/cases/cli.js';
import { userConfigPath, writeUserConfig } from '../src/cli/user-config.js';
import type { ModelBinding } from '../src/runtime/types.js';
import { PackageRegistry, exportPackage } from '../src/application/index.js';
import { answer, scripted, temp } from './helpers.js';
import { delta, sendStream } from './http-server.js';

const serverMock = vi.hoisted(() => ({ binding: undefined as ModelBinding | undefined }));
vi.mock('../src/web/server.js', () => ({
  createLocalServer: async (_app: unknown, options: { binding: ModelBinding }) => {
    serverMock.binding = options.binding;
    process.emit('SIGTERM');
    return { origin: 'http://127.0.0.1:1', startupSecret: 'fixture-secret', async close() {} };
  },
}));

beforeEach(() => {
  vi.stubEnv('KODO_HOME', temp());
  vi.stubEnv('KODO_PROVIDER', undefined);
  vi.stubEnv('KODO_MODEL', undefined);
  vi.stubEnv('KODO_PROVIDER_CONSUMER_FIXTURE_KEY', 'environment-fixture-key');
  serverMock.binding = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; });

const profiles = () => ({ defaultProvider: 'primary', providers: {
  primary: { baseURL: 'https://primary.example/v1', model: 'primary-model', apiKey: 'inline-fixture-key', protocol: 'responses' as const },
  secondary: { baseURL: 'https://secondary.example/v1', model: 'secondary-model', apiKeyEnv: 'KODO_PROVIDER_CONSUMER_FIXTURE_KEY', protocol: 'anthropic' as const },
} });

describe('provider configuration across CLI consumers', () => {
  it('uses a complete configured profile in serve and switches address, protocol and credentials together', async () => {
    writeUserConfig(profiles());
    vi.stubEnv('KODO_BASE_URL', 'https://legacy.example/v1');
    vi.stubEnv('KODO_PROTOCOL', 'chat-completions');
    const args = ['--data-dir', temp(), '--workspace', temp()];
    await serveCommand(args);
    expect(serverMock.binding).toMatchObject({ model: 'primary-model', baseURL: 'https://primary.example/v1', protocol: 'responses' });
    const primaryKey = serverMock.binding!.apiKeyEnv;
    expect(process.env[primaryKey]).toBe('inline-fixture-key');
    expect(JSON.stringify(serverMock.binding)).not.toContain('inline-fixture-key');
    await serveCommand([...args, '--provider', 'secondary']);
    expect(serverMock.binding).toMatchObject({ model: 'secondary-model', baseURL: 'https://secondary.example/v1', protocol: 'anthropic', apiKeyEnv: 'KODO_PROVIDER_CONSUMER_FIXTURE_KEY' });
    expect(process.env[primaryKey]).toBe('inline-fixture-key');
  });

  it('applies explicit serve options over a profile and refuses a configured profile without a model', async () => {
    writeUserConfig(profiles());
    await serveCommand(['--data-dir', temp(), '--workspace', temp(), '--provider', 'secondary', '--model', 'override', '--protocol', 'responses', '--base-url', 'https://override.example/v1']);
    expect(serverMock.binding).toMatchObject({ model: 'override', protocol: 'responses', baseURL: 'https://override.example/v1' });
    writeUserConfig({ defaultProvider: 'empty', providers: { empty: { baseURL: 'https://empty.example/v1', apiKey: 'fixture-key' } } });
    vi.stubEnv('KODO_MODEL', 'legacy-model');
    await expect(serveCommand([])).rejects.toMatchObject({ code: 'MODEL_CONFIG' });
  });

  it('uses configured model bindings for model-assisted agent authoring', async () => {
    writeUserConfig(profiles());
    const root = temp();
    const provider = scripted(async request => {
      expect(request.binding).toMatchObject({ model: 'secondary-model', baseURL: 'https://secondary.example/v1', protocol: 'anthropic', apiKeyEnv: 'KODO_PROVIDER_CONSUMER_FIXTURE_KEY' });
      return answer(JSON.stringify({ name: 'Reviewer', description: 'Review source evidence.', tools: ['file.read'], inputs: ['Source tree.'], steps: ['Read relevant files.'], checks: ['Cite evidence and report missing input.'] }));
    });
    await agentAuthoringCommand(['create', 'Review source evidence.', '--provider', 'secondary', '--id', 'test/provider', '--output', path.join(root, 'agent'), '--source-url', 'https://example.test/project'], { provider, output: () => {} });
  });

  it('keeps offline authoring and case metadata independent of an invalid user config', async () => {
    writeFileSync(userConfigPath(), '{invalid-json');
    const root = temp(); const output: string[] = [];
    await agentAuthoringCommand(['create', 'Review source evidence.', '--template', '--id', 'test/offline', '--output', path.join(root, 'agent'), '--source-url', 'https://example.test/project'], { output: value => output.push(value) });
    expect(JSON.parse(output[0]!).mode).toBe('template-draft');
    await caseCommand(['list', '--data-dir', temp(), '--json']);
    expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('"items":[]'));
  });

  it('rejects provider selectors on operations that do not use model configuration', async () => {
    const common = ['--id', 'test/offline', '--output', path.join(temp(), 'agent'), '--source-url', 'https://example.test/project', '--provider', 'secondary'];
    await expect(agentAuthoringCommand(['create', 'Review source.', '--template', ...common])).rejects.toThrow('--template cannot be combined');
    await expect(agentAuthoringCommand(['save-config', 'run', '--session', 'session', ...common])).rejects.toThrow('do not apply');
    await expect(caseCommand(['list', '--provider', 'secondary'])).rejects.toThrow('--provider is only valid');
  });

  it('uses a configured provider for a real local case execution without an explicit model or key flag', async () => {
    const source = temp(); const data = temp();
    writeFileSync(path.join(source, 'AGENT.md'), '---\nschema_version: 1\nid: test/configured\nversion: 1.0.0\nname: Configured fixture\ndescription: Return case JSON.\ncapabilities:\n  tools: []\n---\nReturn JSON with answer 42.\n');
    const archive = path.join(source, 'agent.zip');
    await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.test' }, files: [{ path: 'AGENT.md', distributable: true }] }, archive);
    await new PackageRegistry(path.join(data, 'capabilities')).import(archive);
    const file = path.join(source, 'case.json');
    writeFileSync(file, JSON.stringify({ schema_version: 1, id: 'configured/json', version: '1.0.0', name: 'Configured JSON', objective: 'Return answer as JSON.', inputs: { files: [] }, assertions: [{ type: 'json', source: 'output', pointer: '/answer', equals: 42 }] }));
    const seen: { path?: string; key?: string; model?: string }[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        seen.push({ path: request.url, key: request.headers.authorization, model: (JSON.parse(body) as { model?: string }).model });
        sendStream(response, [delta({ content: '{"answer":42}' }), delta({}, 'stop')]);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture did not bind');
    try {
      writeUserConfig({ defaultProvider: 'local', providers: { local: { baseURL: `http://127.0.0.1:${address.port}/provider/v1`, model: 'configured-model', apiKey: 'inline-case-fixture-key' } } });
      await caseCommand(['run', file, '--package', 'test/configured@1.0.0', '--data-dir', data, '--json']);
      const result = JSON.parse(vi.mocked(console.log).mock.calls.at(-1)![0] as string) as { status: string };
      expect(result.status).toBe('passed');
      expect(seen).toEqual([{ path: '/provider/v1/chat/completions', key: 'Bearer inline-case-fixture-key', model: 'configured-model' }]);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
