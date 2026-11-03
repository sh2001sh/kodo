import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configuredAgentModels, resolveConfiguredBinding, tuiModelConfig } from '../src/cli/config-binding.js';
import { readUserConfig, userConfigPath, writeUserConfig } from '../src/cli/user-config.js';
import type { UserConfig } from '../src/cli/user-config.js';
import { fixture, temp } from './helpers.js';
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

function configFixture(): UserConfig {
  return {
    defaultProvider: 'combined',
    providers: {
      alpha: { baseURL: 'https://alpha.example/v1', model: 'alpha-default', protocol: 'responses', apiKey: 'alpha-group-fixture-key' },
      beta: { baseURL: 'https://beta.example/v1', model: 'beta-default', protocol: 'responses', apiKey: 'beta-group-fixture-key' },
    },
    providerGroups: { combined: { providers: ['beta', 'alpha'], model: 'exact/group-model' } },
    modelBindings: {
      quick: { provider: 'alpha', model: 'exact/quick-model', description: 'Small focused checks.' },
      deep: { provider: 'combined', model: 'exact/deep-model', description: 'Complex investigations.' },
    },
    modelRoles: { fast: 'quick', standard: 'quick', strong: 'deep' },
  };
}

interface MetadataState { models: { id: string; name?: string }[]; status: number }
async function localProfiles(): Promise<{ config: UserConfig; alpha: MetadataState; beta: MetadataState; requests: { provider: string; method?: string; url?: string; authorization?: string }[] }> {
  const requests: { provider: string; method?: string; url?: string; authorization?: string }[] = [];
  const alpha: MetadataState = { models: [{ id: 'shared', name: 'Alpha shared' }, { id: 'alpha-only' }], status: 200 };
  const beta: MetadataState = { models: [{ id: 'shared', name: 'Beta shared' }, { id: 'beta-only' }], status: 200 };
  const config = configFixture();
  for (const [provider, state] of [['alpha', alpha], ['beta', beta]] as const) {
    config.providers[provider]!.baseURL = await mockServer((_body, response, request) => {
      requests.push({ provider, method: request.method, url: request.url, authorization: request.headers.authorization });
      response.writeHead(state.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(state.status === 200 ? { data: state.models } : { error: 'private-fixture-provider-error' }));
    });
  }
  writeUserConfig(config);
  return { config, alpha, beta, requests };
}

describe('provider group runtime bindings and approved agent aliases', () => {
  it('resolves ordered group connections with the exact same model and independent credential references', () => {
    const config = configFixture();
    const resolved = resolveConfiguredBinding({}, config);
    expect(resolved.provider).toBe('combined');
    expect(resolved.binding).toMatchObject({ provider: 'beta', baseURL: config.providers.beta!.baseURL, model: 'exact/group-model', protocol: 'responses', fallbacks: [{ provider: 'alpha', baseURL: config.providers.alpha!.baseURL, model: 'exact/group-model', protocol: 'responses' }] });
    const backup = resolved.binding.fallbacks![0]!;
    expect(resolved.binding.apiKeyEnv).not.toBe(backup.apiKeyEnv);
    expect(process.env[resolved.binding.apiKeyEnv]).toBe('beta-group-fixture-key');
    expect(process.env[backup.apiKeyEnv]).toBe('alpha-group-fixture-key');
    const env = fixture();
    const run = env.app.createRun({ objective: 'Keep group routes pinned.', workspace: env.root, binding: resolved.binding });
    expect(env.app.store.run(run.id).binding).toEqual(resolved.binding);
    const stored = JSON.stringify(env.app.store.run(run.id));
    expect(stored).not.toContain('alpha-group-fixture-key'); expect(stored).not.toContain('beta-group-fixture-key');
  });

  it.each(['base-url', 'api-key-env', 'protocol'])('rejects an explicit %s connection override on a group', key => {
    const value = { 'base-url': 'https://override.example/v1', 'api-key-env': 'OVERRIDE_FIXTURE_KEY', protocol: 'chat-completions' }[key]!;
    expect(() => resolveConfiguredBinding({ [key]: value }, configFixture())).toThrow('keeps each connection pinned');
  });

  it('applies exact model and prompt-cache overrides to every ordered route', () => {
    const { binding } = resolveConfiguredBinding({ model: 'explicit/exact-model', 'prompt-cache': 'off' }, configFixture());
    expect([binding, ...binding.fallbacks!].map(route => ({ model: route.model, cache: route.promptCache, provider: route.provider }))).toEqual([
      { model: 'explicit/exact-model', cache: 'off', provider: 'beta' }, { model: 'explicit/exact-model', cache: 'off', provider: 'alpha' },
    ]);
  });

  it('compiles only approved aliases, role mappings and descriptions into an independent runtime snapshot', () => {
    const config = configFixture();
    const policy = configuredAgentModels(config);
    expect(Object.keys(policy.modelBindings)).toEqual(['quick', 'deep']);
    expect(policy.modelRoles).toEqual({ fast: 'quick', standard: 'quick', strong: 'deep' });
    expect(policy.modelBindingDescriptions).toEqual({ quick: 'Small focused checks.', deep: 'Complex investigations.' });
    expect(policy.modelBindings.quick).toMatchObject({ provider: 'alpha', model: 'exact/quick-model' });
    expect([policy.modelBindings.deep!, ...policy.modelBindings.deep!.fallbacks!].map(route => route.model)).toEqual(['exact/deep-model', 'exact/deep-model']);
    config.modelBindings!.deep!.model = 'later-model'; config.modelRoles!.strong = 'quick';
    config.providerGroups!.combined!.providers.reverse();
    expect(policy.modelBindings.deep!.model).toBe('exact/deep-model');
    expect(policy.modelBindings.deep!.provider).toBe('beta'); expect(policy.modelRoles.strong).toBe('deep');
  });

  it('freezes an explicitly empty approved range in the session even when providers exist and aliases are added later', () => {
    const config = configFixture(); delete config.modelBindings; delete config.modelRoles;
    const policy = configuredAgentModels(config);
    expect(policy).toEqual({ modelBindings: {}, modelRoles: {}, modelBindingDescriptions: {} });
    const env = fixture(undefined, ['read'], policy);
    config.modelBindings = { later: { provider: 'combined', model: 'later-model' } };
    expect(Object.keys(configuredAgentModels(config).modelBindings)).toEqual(['later']);
    const session = env.app.store.session(env.app.store.run(env.runId).sessionId);
    expect(session.modelBindings).toEqual({}); expect(session.modelRoles).toEqual({});
    expect(policy.modelBindings).toEqual({});
  });
});

describe('terminal provider group metadata and persistence', () => {
  it('keeps duplicate model IDs with provider provenance when browsing all providers', async () => {
    const { config, requests } = await localProfiles();
    const picker = tuiModelConfig(resolveConfiguredBinding({}, config), config);
    expect(await picker.listModels('*', new AbortController().signal)).toEqual([
      { id: 'alpha-only', provider: 'alpha' }, { id: 'beta-only', provider: 'beta' },
      { id: 'shared', name: 'Alpha shared', provider: 'alpha' }, { id: 'shared', name: 'Beta shared', provider: 'beta' },
    ]);
    expect(requests).toEqual(expect.arrayContaining([
      { provider: 'alpha', method: 'GET', url: '/v1/models', authorization: 'Bearer alpha-group-fixture-key' },
      { provider: 'beta', method: 'GET', url: '/v1/models', authorization: 'Bearer beta-group-fixture-key' },
    ]));
    expect(requests).toHaveLength(2); expect(readUserConfig()).toEqual(config);
  });

  it('deduplicates a group union and keeps ordered member provenance', async () => {
    const { config } = await localProfiles();
    const picker = tuiModelConfig(resolveConfiguredBinding({}, config), config);
    expect(await picker.listModels('combined', new AbortController().signal)).toEqual([
      { id: 'alpha-only', provider: 'combined', sources: ['alpha'] },
      { id: 'beta-only', provider: 'combined', sources: ['beta'] },
      { id: 'shared', name: 'Beta shared', provider: 'combined', sources: ['beta', 'alpha'] },
    ]);
    expect(picker.lastModelWarnings).toEqual([]);
  });

  it('returns available group models with a warning on partial failure and clears warnings after recovery', async () => {
    const { config, beta } = await localProfiles(); beta.status = 503;
    const picker = tuiModelConfig(resolveConfiguredBinding({}, config), config);
    const before = readFileSync(userConfigPath(), 'utf8');
    expect(await picker.listModels('combined', new AbortController().signal)).toEqual([
      { id: 'alpha-only', provider: 'combined', sources: ['alpha'] },
      { id: 'shared', name: 'Alpha shared', provider: 'combined', sources: ['alpha'] },
    ]);
    expect(picker.lastModelWarnings).toEqual([expect.stringContaining('Provider beta could not load')]);
    expect(JSON.stringify(picker.lastModelWarnings)).not.toContain('private-fixture-provider-error');
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(before);
    beta.status = 200;
    await picker.listModels('combined', new AbortController().signal);
    expect(picker.lastModelWarnings).toEqual([]);
  });

  it('rejects when all providers fail without overwriting the current configuration or selected binding', async () => {
    const { config, alpha, beta } = await localProfiles(); alpha.status = 401; beta.status = 503;
    const initial = resolveConfiguredBinding({}, config); const frozen = structuredClone(initial.binding);
    const picker = tuiModelConfig(initial, config); const before = readFileSync(userConfigPath(), 'utf8');
    await expect(picker.listModels('combined', new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_LIST_UNAVAILABLE' });
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(before); expect(initial.binding).toEqual(frozen);
    expect(picker.lastModelWarnings).toEqual([]);
  });

  it('cancels model fetching without changing persisted defaults or the active runtime binding', async () => {
    const config = configFixture();
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const pendingURL = await mockServer((_body, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.flushHeaders(); started(); });
    config.providers.alpha!.baseURL = pendingURL; config.providers.beta!.baseURL = pendingURL;
    writeUserConfig(config);
    const initial = resolveConfiguredBinding({}, config); const frozen = structuredClone(initial.binding);
    const picker = tuiModelConfig(initial, config); const before = readFileSync(userConfigPath(), 'utf8');
    const cancellation = new AbortController();
    const pending = picker.listModels('combined', cancellation.signal);
    const assertion = expect(pending).rejects.toThrow('fixture model-list cancellation');
    await ready; cancellation.abort(new Error('fixture model-list cancellation')); await assertion;
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(before); expect(initial.binding).toEqual(frozen);
    expect(picker.lastModelWarnings).toEqual([]);
  });

  it('persists provider selection for new sessions while keeping the caller and stored active binding unchanged', async () => {
    const config = configFixture(); writeUserConfig(config);
    const initial = resolveConfiguredBinding({}, config); const frozen = structuredClone(initial.binding);
    const picker = tuiModelConfig(initial, config); const env = fixture();
    const run = env.app.createRun({ objective: 'Retain active group routing.', workspace: env.root, binding: initial.binding });
    const selected = await picker.selectProvider!('alpha');
    expect(selected).toMatchObject({ provider: 'alpha', model: 'alpha-default' });
    expect(readUserConfig()).toEqual({ ...config, defaultProvider: 'alpha' });
    expect(initial.binding).toEqual(frozen); expect(env.app.store.run(run.id).binding).toEqual(frozen);
    expect(resolveConfiguredBinding().provider).toBe('alpha');
  });

  it('updates every group route model and the group default while preserving member models, aliases and roles', async () => {
    const config = configFixture(); config.defaultProvider = 'alpha'; writeUserConfig(config);
    const initial = resolveConfiguredBinding({ provider: 'combined' }, config); const frozen = structuredClone(initial.binding);
    const picker = tuiModelConfig(initial, config);
    const selected = await picker.select('combined', 'chosen/exact-model');
    expect([selected, ...selected.fallbacks!].map(route => ({ provider: route.provider, model: route.model }))).toEqual([
      { provider: 'beta', model: 'chosen/exact-model' }, { provider: 'alpha', model: 'chosen/exact-model' },
    ]);
    expect(readUserConfig()).toEqual({ ...config, defaultProvider: 'combined', providerGroups: { combined: { ...config.providerGroups!.combined!, model: 'chosen/exact-model' } } });
    expect(picker.providers.find(provider => provider.id === 'combined')).toEqual({ id: 'combined', members: ['beta', 'alpha'], model: 'chosen/exact-model' });
    expect(initial.binding).toEqual(frozen);
  });

  it('merges providers using fresh configuration, refreshes descriptors and preserves unrelated settings', async () => {
    const config = configFixture(); writeUserConfig(config);
    const picker = tuiModelConfig(resolveConfiguredBinding({}, config), config);
    const fresh = readUserConfig();
    fresh.providers.gamma = { baseURL: 'https://gamma.example/v1', model: 'gamma-default', protocol: 'responses', apiKeyEnv: 'GAMMA_GROUP_FIXTURE_KEY' };
    fresh.modelBindings!.quick!.description = 'Freshly edited description.';
    writeUserConfig(fresh);
    await picker.mergeProviders!('newgroup', ['gamma', 'alpha']);
    expect(readUserConfig()).toEqual({ ...fresh, providerGroups: { ...fresh.providerGroups, newgroup: { providers: ['gamma', 'alpha'], model: 'gamma-default' } } });
    expect(picker.providers).toEqual(expect.arrayContaining([
      { id: 'gamma', model: 'gamma-default' }, { id: 'newgroup', members: ['gamma', 'alpha'], model: 'gamma-default' },
    ]));
    await picker.mergeProviders!('combined', ['alpha', 'gamma']);
    expect(readUserConfig().providerGroups!.combined).toEqual({ providers: ['alpha', 'gamma'], model: 'exact/group-model' });
  });

  it.each(['invalid-model', 'invalid-merge', 'unknown-provider', 'malformed-config'])('preserves exact config bytes after %s failure', async failure => {
    const config = configFixture(); writeUserConfig(config);
    const initial = resolveConfiguredBinding({}, config); const frozen = structuredClone(initial.binding);
    const picker = tuiModelConfig(initial, config); const descriptors = structuredClone(picker.providers);
    if (failure === 'malformed-config') writeFileSync(userConfigPath(), '{"providers":', 'utf8');
    const before = readFileSync(userConfigPath(), 'utf8');
    const attempt = async (): Promise<unknown> => {
      if (failure === 'invalid-model') return await picker.select('combined', 'x'.repeat(513));
      if (failure === 'invalid-merge') return await picker.mergeProviders!('badgroup', ['alpha', 'alpha']);
      return await picker.selectProvider!(failure === 'unknown-provider' ? 'missing' : 'alpha');
    };
    await expect(attempt()).rejects.toThrow();
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(before); expect(initial.binding).toEqual(frozen);
    expect(picker.providers).toEqual(descriptors);
  });

  it('keeps compiled aliases and selected TUI routes independent of later dictionary edits and caller mutation', async () => {
    const config = configFixture(); writeUserConfig(config);
    const initial = resolveConfiguredBinding({}, config); const frozen = structuredClone(initial.binding);
    const policy = configuredAgentModels(config); const picker = tuiModelConfig(initial, config);
    initial.binding.fallbacks![0]!.baseURL = 'https://caller-mutated.example/v1';
    const fresh = readUserConfig();
    fresh.modelBindings!.deep = { provider: 'alpha', model: 'fresh/alias-model', description: 'Fresh alias.' };
    fresh.modelRoles!.strong = 'quick';
    writeUserConfig(fresh);
    expect(configuredAgentModels().modelBindings.deep).toMatchObject({ provider: 'alpha', model: 'fresh/alias-model' });
    expect(policy.modelBindings.deep).toMatchObject({ provider: 'beta', model: 'exact/deep-model' });
    expect(policy.modelRoles.strong).toBe('deep');
    const selected = await picker.select('combined', 'selected/exact-model');
    expect(selected.baseURL).toBe(frozen.baseURL); expect(selected.fallbacks![0]!.baseURL).toBe(frozen.fallbacks![0]!.baseURL);
    expect([selected, ...selected.fallbacks!].every(route => route.model === 'selected/exact-model')).toBe(true);
    expect(readUserConfig().modelBindings).toEqual(fresh.modelBindings); expect(readUserConfig().modelRoles).toEqual(fresh.modelRoles);
  });
});
