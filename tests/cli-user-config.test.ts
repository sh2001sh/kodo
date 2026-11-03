import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application } from '../src/application/index.js';
import type { UserConfig } from '../src/cli/user-config.js';
import { delta, mockServer, sendStream } from './http-server.js';
import { temp } from './helpers.js';

const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const configPath = (home: string): string => path.join(home, 'config.json');
const save = (home: string, config: UserConfig): void => writeFileSync(configPath(home), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
const load = (home: string): UserConfig => JSON.parse(readFileSync(configPath(home), 'utf8')) as UserConfig;

async function cli(home: string, args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const env = { ...process.env };
  for (const key of ['KODO_PROVIDER', 'KODO_MODEL', 'KODO_BASE_URL', 'OPENAI_BASE_URL', 'KODO_PROTOCOL', 'KODO_PROMPT_CACHE', 'KODO_API_KEY', 'OPENAI_API_KEY']) delete env[key];
  const child = spawn(process.execPath, [entry, ...args], {
    env: { ...env, KODO_HOME: home, KODO_DATA_DIR: path.join(home, 'runtime'), ...extraEnv }, windowsHide: true,
  });
  afterEach(() => { if (child.exitCode === null) child.kill(); });
  let out = ''; let err = '';
  child.stdout.on('data', chunk => { out += String(chunk); });
  child.stderr.on('data', chunk => { err += String(chunk); });
  child.stdin.end();
  return await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, out, err }));
  });
}

const runArgs = (home: string): string[] => ['run', 'Report fixture status.', '--workspace', home, '--json', '--max-context-tokens', '256000', '--max-output-tokens', '8192'];

describe('built CLI user provider configuration', () => {
  it('dispatches config management without opening a runtime store and redacts local keys', async () => {
    const home = temp();
    const initialized = await cli(home, ['config', 'init']);
    expect(initialized.code, initialized.err).toBe(0);
    expect(load(home)).toEqual({ providers: {} });
    expect((await cli(home, ['config', 'path'])).out.trim()).toBe(configPath(home));
    for (const name of ['first', 'second']) {
      const added = await cli(home, ['config', 'add', name, '--base-url', 'http://127.0.0.1:1/v1', '--model', `fixture-${name}`, '--api-key-env', 'FIXTURE_CONFIG_KEY']);
      expect(added.code, added.err).toBe(0);
    }
    expect((await cli(home, ['config', 'use', 'second'])).code).toBe(0);
    const config = load(home);
    delete config.providers.second!.apiKeyEnv;
    config.providers.second!.apiKey = 'isolated-config-fixture-secret';
    save(home, config);
    const shown = await cli(home, ['config', 'show']);
    expect(shown.code, shown.err).toBe(0);
    expect(JSON.parse(shown.out)).toMatchObject({ defaultProvider: 'second', providers: { second: { apiKey: '[REDACTED]' } } });
    expect(shown.out + shown.err).not.toContain('isolated-config-fixture-secret');
    expect((await cli(home, ['config', 'remove', 'first'])).code).toBe(0);
    expect(Object.keys(load(home).providers)).toEqual(['second']);
    expect(existsSync(path.join(home, 'runtime'))).toBe(false);
  });

  it('manages ordered provider groups, approved model aliases and role defaults through the built CLI', async () => {
    const home = temp();
    expect((await cli(home, ['config', 'init'])).code).toBe(0);
    for (const name of ['primary', 'backup']) {
      const added = await cli(home, ['config', 'add', name, '--base-url', 'http://127.0.0.1:1/v1', '--protocol', 'responses', '--model', 'shared-model', '--api-key-env', 'FIXTURE_GROUP_KEY']);
      expect(added.code, added.err).toBe(0);
    }
    expect((await cli(home, ['config', 'merge', 'resilient', 'primary', 'backup', '--model', 'shared-model'])).code).toBe(0);
    expect((await cli(home, ['config', 'use', 'resilient'])).code).toBe(0);
    expect((await cli(home, ['config', 'model', 'add', 'general', '--provider', 'resilient', '--model', 'shared-model', '--description', 'Default implementation model'])).code).toBe(0);
    expect((await cli(home, ['config', 'role', 'standard', 'general'])).code).toBe(0);
    expect(load(home)).toMatchObject({
      defaultProvider: 'resilient',
      providerGroups: { resilient: { providers: ['primary', 'backup'], model: 'shared-model' } },
      modelBindings: { general: { provider: 'resilient', model: 'shared-model', description: 'Default implementation model' } },
      modelRoles: { standard: 'general' },
    });
    const protectedGroup = await cli(home, ['config', 'unmerge', 'resilient']);
    expect(protectedGroup.code).toBe(1);
    expect(protectedGroup.err).toContain('CONFIG_REFERENCE');
    expect((await cli(home, ['config', 'role', 'standard', 'inherit'])).code).toBe(0);
    expect((await cli(home, ['config', 'model', 'remove', 'general'])).code).toBe(0);
    expect((await cli(home, ['config', 'use', 'primary'])).code).toBe(0);
    expect((await cli(home, ['config', 'unmerge', 'resilient'])).code).toBe(0);
    expect(load(home)).toMatchObject({ defaultProvider: 'primary', providers: { primary: {}, backup: {} }, providerGroups: {}, modelBindings: {}, modelRoles: {} });
    expect(existsSync(path.join(home, 'runtime'))).toBe(false);
  });

  it('uses the configured default connection and an explicitly selected provider with separate protocols and credentials', async () => {
    const home = temp();
    const requests: { endpoint: string; model: unknown; bearer?: string; key?: string }[] = [];
    const first = await mockServer((body, response, incoming) => {
      requests.push({ endpoint: incoming.url!, model: body.model, bearer: incoming.headers.authorization });
      sendStream(response, [delta({ content: 'First provider fixture complete.' }), delta({}, 'stop')]);
    });
    const second = await mockServer((body, response, incoming) => {
      requests.push({ endpoint: incoming.url!, model: body.model, key: incoming.headers['x-api-key'] as string | undefined });
      const events = [
        { type: 'message_start', message: { id: 'msg-isolated-fixture', role: 'assistant', content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Second provider fixture complete.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
    save(home, { defaultProvider: 'first', providers: {
      first: { baseURL: first, model: 'first-fixture', apiKey: 'isolated-first-fixture-secret' },
      second: { baseURL: second, model: 'second-fixture', protocol: 'anthropic', apiKey: 'isolated-second-fixture-secret' },
    } });
    const firstResult = await cli(home, runArgs(home), { KODO_MODEL: 'unrelated-legacy-model', KODO_BASE_URL: 'http://127.0.0.1:1/v1', KODO_API_KEY: 'unrelated-legacy-secret' });
    expect(firstResult.code, firstResult.err + firstResult.out).toBe(0);
    const secondResult = await cli(home, [...runArgs(home), '--provider', 'second']);
    expect(secondResult.code, secondResult.err + secondResult.out).toBe(0);
    expect(requests).toEqual([
      { endpoint: '/v1/chat/completions', model: 'first-fixture', bearer: 'Bearer isolated-first-fixture-secret' },
      { endpoint: '/v1/messages', model: 'second-fixture', key: 'isolated-second-fixture-secret' },
    ]);
    const app = new Application(path.join(home, 'runtime'));
    try {
      const bindings = app.store.listRuns().map(run => run.binding);
      expect(bindings.map(binding => binding.apiKeyEnv)).toHaveLength(2);
      expect(new Set(bindings.map(binding => binding.apiKeyEnv)).size).toBe(2);
      expect(JSON.stringify(bindings)).not.toContain('fixture-secret');
      expect(bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ baseURL: first, model: 'first-fixture' }),
        expect.objectContaining({ baseURL: second, model: 'second-fixture', protocol: 'anthropic' }),
      ]));
    } finally { await app.shutdown(); }
    expect(firstResult.out + firstResult.err + secondResult.out + secondResult.err).not.toContain('fixture-secret');
  });

  it('rehydrates the original inline credential when answering a saved session after changing the default provider', async () => {
    const home = temp();
    let firstCalls = 0; let secondCalls = 0;
    const first = await mockServer((body, response, incoming) => {
      expect(incoming.headers.authorization).toBe('Bearer isolated-resume-fixture-secret');
      expect(body.model).toBe('original-fixture');
      if (++firstCalls === 1) sendStream(response, [delta({ tool_calls: [{ index: 0, id: 'ask-fixture', function: { name: 'ask_user', arguments: '{"question":"Select fixture output."}' } }] }), delta({}, 'tool_calls')]);
      else sendStream(response, [delta({ content: 'Original provider resumed successfully.' }), delta({}, 'stop')]);
    });
    const second = await mockServer((_body, response) => { secondCalls++; response.writeHead(500).end(); });
    save(home, { defaultProvider: 'first', providers: {
      first: { baseURL: first, model: 'original-fixture', apiKey: 'isolated-resume-fixture-secret' },
      second: { baseURL: second, model: 'different-fixture', apiKey: 'isolated-other-fixture-secret' },
    } });
    const started = await cli(home, runArgs(home));
    expect(started.code, started.err + started.out).toBe(2);
    const required = JSON.parse(started.out.trim().split(/\r?\n/).at(-1)!) as { runId: string; questions: { id: string }[] };
    expect((await cli(home, ['config', 'use', 'second'])).code).toBe(0);
    const answered = await cli(home, ['answer', required.questions[0]!.id, '--text', 'Use the fixture report.', '--json']);
    expect(answered.code, answered.err + answered.out).toBe(0);
    expect(firstCalls).toBe(2);
    expect(secondCalls).toBe(0);
    const app = new Application(path.join(home, 'runtime'));
    try {
      expect(app.store.run(required.runId).binding).toMatchObject({ model: 'original-fixture', baseURL: first });
    } finally { await app.shutdown(); }
    expect(load(home).defaultProvider).toBe('second');
  });

  it.each(['unknown provider', 'missing model', 'missing credentials', 'malformed config'])('rejects %s without changing configuration or contacting the provider', async scenario => {
    const home = temp();
    let calls = 0;
    const endpoint = await mockServer((_body, response) => { calls++; response.writeHead(500).end(); });
    const provider = { baseURL: endpoint, ...(scenario === 'missing model' ? {} : { model: 'fixture' }), ...(scenario === 'missing credentials' ? {} : { apiKey: 'isolated-error-fixture-secret' }) };
    save(home, { defaultProvider: 'fixture', providers: { fixture: provider } });
    if (scenario === 'malformed config') writeFileSync(configPath(home), '{"providers":', 'utf8');
    const before = readFileSync(configPath(home), 'utf8');
    const result = await cli(home, [...runArgs(home), ...(scenario === 'unknown provider' ? ['--provider', 'absent'] : [])], { KODO_API_KEY: 'unrelated-legacy-secret' });
    expect(result.code).toBe(1);
    expect(result.err).toContain(scenario === 'unknown provider' ? 'PROVIDER_CONFIG' : scenario === 'missing model' ? 'MODEL_CONFIG' : scenario === 'missing credentials' ? 'MODEL_CREDENTIAL' : 'USER_CONFIG');
    expect(readFileSync(configPath(home), 'utf8')).toBe(before);
    expect(calls).toBe(0);
    expect(result.out + result.err).not.toContain('fixture-secret');
  });

  it('reports configured readiness in doctor without exposing secrets and disallows replacing saved bindings via --provider', async () => {
    const home = temp();
    save(home, { defaultProvider: 'fixture', providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: 'isolated-doctor-fixture-secret' } } });
    const doctor = await cli(home, ['doctor']);
    expect(doctor.code, doctor.err).toBe(0);
    expect(JSON.parse(doctor.out)).toMatchObject({ configPath: configPath(home), provider: 'fixture', modelConfigured: true, credentialConfigured: true });
    expect(doctor.out + doctor.err).not.toContain('isolated-doctor-fixture-secret');
    for (const args of [['runs'], ['resume', 'unavailable-run']]) {
      const result = await cli(home, [...args, '--provider', 'fixture']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('ARGUMENTS');
    }
  });
});
