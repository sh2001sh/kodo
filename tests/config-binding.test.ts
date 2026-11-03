import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateConfigCredentials, resolveConfiguredBinding, tuiModelConfig } from '../src/cli/config-binding.js';
import { readUserConfig, userConfigPath, writeUserConfig } from '../src/cli/user-config.js';
import type { UserConfig } from '../src/cli/user-config.js';
import { answer, fixture, scripted, temp } from './helpers.js';
import { mockServer } from './http-server.js';

const credentialPattern = /^KODO_PROVIDER_[A-F0-9]{24}_API_KEY$/u;
let previousCredentials = new Map<string, string>();
beforeEach(() => {
  previousCredentials = new Map(Object.entries(process.env).filter((entry): entry is [string, string] => credentialPattern.test(entry[0]) && entry[1] !== undefined));
  vi.stubEnv('KODO_HOME', path.join(temp(), '.kodo'));
  for (const name of ['KODO_PROVIDER', 'KODO_MODEL', 'KODO_BASE_URL', 'OPENAI_BASE_URL', 'KODO_PROTOCOL', 'KODO_API_KEY', 'OPENAI_API_KEY', 'KODO_PROMPT_CACHE']) vi.stubEnv(name, undefined);
});
afterEach(() => {
  for (const name of Object.keys(process.env)) if (credentialPattern.test(name)) delete process.env[name];
  for (const [name, value] of previousCredentials) process.env[name] = value;
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

function profiles(): UserConfig {
  return { defaultProvider: 'alpha', providers: {
    alpha: { baseURL: 'https://alpha.example/v1', model: 'alpha-model', protocol: 'responses', apiKeyEnv: 'ALPHA_FIXTURE_KEY' },
    beta: { baseURL: 'https://beta.example/api', model: 'beta-model', protocol: 'anthropic', apiKey: 'isolated-beta-fixture' },
  } };
}

describe('configured model bindings', () => {
  it('gives explicit CLI fields and provider selection priority over environment selectors and profile defaults', () => {
    vi.stubEnv('KODO_PROVIDER', 'beta'); vi.stubEnv('KODO_MODEL', 'legacy-model'); vi.stubEnv('KODO_BASE_URL', 'https://legacy.example'); vi.stubEnv('KODO_PROTOCOL', 'anthropic');
    const resolved = resolveConfiguredBinding({ provider: 'alpha', model: 'cli-model', 'base-url': 'http://localhost:1234/v1', 'api-key-env': 'CLI_FIXTURE_KEY', protocol: 'chat-completions', 'prompt-cache': 'off' }, profiles());
    expect(resolved).toEqual({ provider: 'alpha', binding: { model: 'cli-model', baseURL: 'http://localhost:1234/v1', apiKeyEnv: 'CLI_FIXTURE_KEY', protocol: 'chat-completions', provider: 'alpha', promptCache: 'off' } });
  });

  it('uses the environment provider selector before the default, then the default before an unselected profile', () => {
    const config = profiles(); vi.stubEnv('KODO_PROVIDER', 'beta');
    expect(resolveConfiguredBinding({}, config)).toMatchObject({ provider: 'beta', binding: { model: 'beta-model', baseURL: 'https://beta.example/api', protocol: 'anthropic' } });
    vi.stubEnv('KODO_PROVIDER', undefined);
    expect(resolveConfiguredBinding({}, config)).toMatchObject({ provider: 'alpha', binding: { model: 'alpha-model' } });
    delete config.defaultProvider; delete config.providers.alpha;
    expect(resolveConfiguredBinding({}, config)).toMatchObject({ provider: 'beta', binding: { model: 'beta-model' } });
  });

  it('uses legacy connection variables only when no provider is selected', () => {
    vi.stubEnv('KODO_MODEL', 'legacy-model'); vi.stubEnv('KODO_BASE_URL', 'https://legacy.example/v1'); vi.stubEnv('OPENAI_BASE_URL', 'https://openai-fallback.example/v1');
    vi.stubEnv('KODO_PROTOCOL', 'responses'); vi.stubEnv('KODO_API_KEY', 'isolated-legacy-fixture'); vi.stubEnv('KODO_PROMPT_CACHE', 'session');
    const config = profiles(); delete config.defaultProvider;
    expect(resolveConfiguredBinding({}, config)).toEqual({ binding: { model: 'legacy-model', baseURL: 'https://legacy.example/v1', protocol: 'responses', apiKeyEnv: 'KODO_API_KEY', promptCache: 'session' } });
    vi.stubEnv('KODO_BASE_URL', undefined); vi.stubEnv('KODO_API_KEY', undefined);
    expect(resolveConfiguredBinding({}, { providers: {} })).toMatchObject({ binding: { baseURL: 'https://openai-fallback.example/v1', apiKeyEnv: 'OPENAI_API_KEY' } });
    vi.stubEnv('OPENAI_BASE_URL', undefined);
    expect(resolveConfiguredBinding({}, { providers: {} }).binding.baseURL).toBe('https://api.openai.com/v1');
  });

  it('keeps an incomplete selected profile independent of legacy model, connection, protocol and credentials', () => {
    vi.stubEnv('KODO_MODEL', 'unrelated-model'); vi.stubEnv('KODO_BASE_URL', 'https://unrelated.example/v1'); vi.stubEnv('KODO_PROTOCOL', 'anthropic');
    vi.stubEnv('KODO_API_KEY', 'isolated-unrelated-kodo-key'); vi.stubEnv('OPENAI_API_KEY', 'isolated-unrelated-openai-key');
    const resolved = resolveConfiguredBinding({}, { providers: { local: { baseURL: 'http://127.0.0.1:4321/v1' } } });
    expect(resolved).toMatchObject({ provider: 'local', binding: { model: '', baseURL: 'http://127.0.0.1:4321/v1', protocol: 'chat-completions' } });
    expect(resolved.binding.apiKeyEnv).toMatch(credentialPattern);
    expect(process.env[resolved.binding.apiKeyEnv]).toBeUndefined();
  });

  it('rejects unknown providers and non-string CLI options without falling back to another profile', () => {
    const config = profiles();
    expect(() => resolveConfiguredBinding({ provider: 'missing' }, config)).toThrow('Unknown provider');
    vi.stubEnv('KODO_PROVIDER', 'missing');
    expect(() => resolveConfiguredBinding({}, config)).toThrow('Unknown provider');
    vi.stubEnv('KODO_PROVIDER', undefined);
    expect(() => resolveConfiguredBinding({ provider: false }, config)).toThrow('Unknown provider');
    for (const key of ['model', 'base-url', 'api-key-env', 'protocol', 'prompt-cache']) expect(() => resolveConfiguredBinding({ [key]: true }, config)).toThrow('string');
  });

  it('isolates inline key references by provider ID and connection URL and retains only references in durable runs', () => {
    const config: UserConfig = { providers: {
      alpha: { baseURL: 'https://models.example/v1', model: 'fixture-model', apiKey: 'isolated-first-fixture' },
      beta: { baseURL: 'https://models.example/v1', model: 'fixture-model', apiKey: 'isolated-second-fixture' },
    } };
    const first = resolveConfiguredBinding({ provider: 'alpha' }, config).binding;
    const second = resolveConfiguredBinding({ provider: 'beta' }, config).binding;
    config.providers.alpha = { ...config.providers.alpha!, baseURL: 'https://other.example/v1', apiKey: 'isolated-third-fixture' };
    const third = resolveConfiguredBinding({ provider: 'alpha' }, config).binding;
    expect(new Set([first.apiKeyEnv, second.apiKeyEnv, third.apiKeyEnv]).size).toBe(3);
    expect(process.env[first.apiKeyEnv]).toBe('isolated-first-fixture');
    expect(process.env[second.apiKeyEnv]).toBe('isolated-second-fixture');
    expect(process.env[third.apiKeyEnv]).toBe('isolated-third-fixture');
    const env = fixture();
    const run = env.app.createRun({ objective: 'Persist a configured connection.', workspace: env.root, binding: first });
    expect(env.app.store.run(run.id).binding).toEqual(first);
    const stored = JSON.stringify(env.app.store.run(run.id));
    for (const secret of ['isolated-first-fixture', 'isolated-second-fixture', 'isolated-third-fixture']) expect(stored).not.toContain(secret);
  });

  it('validates all profiles before changing any hydrated credentials', () => {
    const config = profiles(); const previous = resolveConfiguredBinding({ provider: 'beta' }, config).binding;
    const invalid = profiles(); invalid.providers.beta!.apiKey = 'isolated-rejected-fixture';
    invalid.providers.alpha = { ...invalid.providers.alpha!, baseURL: 'not a URL' };
    expect(() => resolveConfiguredBinding({ provider: 'beta' }, invalid)).toThrow('baseURL');
    expect(process.env[previous.apiKeyEnv]).toBe('isolated-beta-fixture');
    expect(() => hydrateConfigCredentials(invalid)).toThrow('baseURL');
    expect(process.env[previous.apiKeyEnv]).toBe('isolated-beta-fixture');
  });
});

describe('terminal model configuration host', () => {
  it('fetches real local model metadata using the selected connection, without generating completions', async () => {
    const requests: string[] = [];
    const baseURL = await mockServer((_body, response, request) => {
      requests.push(`${request.method} ${request.url}`);
      expect(request.headers.authorization).toBe('Bearer isolated-metadata-fixture');
      response.end(JSON.stringify({ data: [{ id: 'advertised/model-2', name: 'Advertised model' }, { id: 'x'.repeat(512) }] }));
    });
    const config: UserConfig = { providers: { local: { baseURL, model: 'old-model', apiKey: 'isolated-metadata-fixture' } } };
    writeUserConfig(config);
    const initial = resolveConfiguredBinding({}, config); const picker = tuiModelConfig(initial, config);
    expect(picker.path).toBe(userConfigPath()); expect(picker.providers).toEqual([{ id: 'local', model: 'old-model' }]);
    expect(await picker.listModels('local', new AbortController().signal)).toEqual([{ id: 'advertised/model-2', name: 'Advertised model' }, { id: 'x'.repeat(512) }]);
    expect(requests).toEqual(['GET /v1/models']);
    expect(readUserConfig()).toEqual(config);
    expect(initial.binding.model).toBe('old-model');
  });

  it('reads another provider freshly and persists model/default changes without overwriting unrelated fresh values', async () => {
    const baseURL = await mockServer((_body, response, request) => {
      expect(request.headers['x-api-key']).toBe('isolated-fresh-fixture');
      response.end(JSON.stringify({ data: [{ id: 'fresh-advertised-model' }] }));
    });
    const original = profiles(); writeUserConfig(original);
    const initial = resolveConfiguredBinding({}, original); const frozen = { ...initial.binding }; const picker = tuiModelConfig(initial, original);
    const fresh = profiles(); fresh.providers.beta = { baseURL, protocol: 'anthropic', model: 'edited-model', apiKey: 'isolated-fresh-fixture' };
    fresh.providers.alpha!.model = 'fresh-other-model'; fresh.providers.third = { baseURL: 'https://third.example/v1', apiKeyEnv: 'THIRD_FIXTURE_KEY' };
    writeUserConfig(fresh);
    expect(await picker.listModels('beta', new AbortController().signal)).toEqual([{ id: 'fresh-advertised-model' }]);
    const selected = await picker.select('beta', 'x'.repeat(512));
    expect(selected).toMatchObject({ model: 'x'.repeat(512), baseURL, protocol: 'anthropic' });
    expect(process.env[selected.apiKeyEnv]).toBe('isolated-fresh-fixture');
    expect(readUserConfig()).toEqual({ ...fresh, defaultProvider: 'beta', providers: { ...fresh.providers, beta: { ...fresh.providers.beta!, model: 'x'.repeat(512) } } });
    expect(initial.binding).toEqual(frozen);
  });

  it.each(['invalid-model', 'missing-provider', 'malformed-config'])('preserves the previous runtime connection and exact current config after %s rejection', async failure => {
    const baseURL = await mockServer((_body, response) => { response.end(JSON.stringify({ data: [{ id: 'original-connection-model' }] })); });
    const config = profiles(); config.providers.alpha!.baseURL = baseURL; writeUserConfig(config);
    const initial = resolveConfiguredBinding({}, config); const frozen = { ...initial.binding }; const picker = tuiModelConfig(initial, config);
    const env = fixture(scripted(answer()));
    const run = env.app.createRun({ objective: 'Keep the prior model binding.', workspace: env.root, binding: initial.binding });
    if (failure === 'missing-provider') { const changed = profiles(); changed.providers.alpha!.baseURL = baseURL; delete changed.providers.beta; writeUserConfig(changed); }
    if (failure === 'malformed-config') writeFileSync(userConfigPath(), '{"providers":', 'utf8');
    const before = readFileSync(userConfigPath(), 'utf8');
    await expect(Promise.resolve().then(() => picker.select('beta', failure === 'invalid-model' ? 'x'.repeat(513) : 'rejected-model'))).rejects.toThrow();
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(before);
    expect(initial.binding).toEqual(frozen);
    expect(env.app.store.run(run.id).binding).toEqual(frozen);
    expect(await picker.listModels('alpha', new AbortController().signal)).toEqual([{ id: 'original-connection-model' }]);
  });

  it('preserves explicit startup overrides when selecting a model on the current provider', async () => {
    const config = profiles(); writeUserConfig(config);
    const initial = resolveConfiguredBinding({ provider: 'alpha', 'base-url': 'http://localhost:4321/v1', protocol: 'chat-completions', 'api-key-env': 'OVERRIDE_FIXTURE_KEY' }, config);
    const picker = tuiModelConfig(initial, config);
    expect(await picker.select('alpha', 'override-model')).toEqual({ ...initial.binding, model: 'override-model' });
    expect(readUserConfig().providers.alpha).toEqual({ ...config.providers.alpha!, model: 'override-model' });
  });
});
