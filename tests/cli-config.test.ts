import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configCommand, ensureInteractiveProviderConfig } from '../src/cli/config.js';
import { readUserConfig, userConfigPath, writeUserConfig } from '../src/cli/user-config.js';
import { temp } from './helpers.js';
import { mockServer } from './http-server.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function setup(tty = false) {
  const root = path.join(temp(), 'user-config');
  vi.stubEnv('KODO_HOME', root);
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): unknown };
  input.isTTY = tty; input.isRaw = false;
  const rawModes: boolean[] = [];
  input.setRawMode = mode => { rawModes.push(mode); input.isRaw = mode; return input; };
  const output = Object.assign(new PassThrough(), { isTTY: tty, columns: 80 });
  let text = '';
  output.on('data', chunk => { text += String(chunk); });
  const run = async (...args: string[]) => await configCommand(args, { stdin: input, stdout: output });
  const respond = async (prompt: string, value: string) => {
    await expect.poll(() => text, { timeout: 2000 }).toContain(prompt);
    input.write(`${value}\n`);
  };
  return { root, input, output, run, respond, rawModes, text: () => text };
}

describe('kodo config provider management', () => {
  it('runs the provider wizard for the first interactive TUI session and skips it once configured', async () => {
    const f = setup(true);
    const baseURL = await mockServer((_body, response) => { response.end(JSON.stringify({ data: [{ id: 'first-model' }] })); });
    const work = ensureInteractiveProviderConfig({ stdin: f.input, stdout: f.output });
    try {
      await f.respond('Provider name:', 'first');
      await f.respond('Select protocol [1-3,', '');
      await f.respond('Base URL (example:', baseURL);
      await f.respond('API key (hidden;', 'isolated-first-run-key');
      await f.respond('Select model [1-1,', '1');
      await f.respond('Use as default provider?', '');
      expect(await work).toEqual({ defaultProvider: 'first', providers: { first: { baseURL, protocol: 'chat-completions', apiKey: 'isolated-first-run-key', model: 'first-model' } } });
      expect(f.text()).toContain('API version path detected: /v1.');
      const outputBefore = f.text();
      expect(await ensureInteractiveProviderConfig({ stdin: f.input, stdout: f.output })).toEqual(readUserConfig());
      expect(f.text()).toBe(outputBefore);
      expect(f.text()).not.toContain('isolated-first-run-key');
    } finally { f.input.end(); await work.catch(() => {}); }
  });

  it.each([
    { label: 'adds /v1 by default', answer: '', suffix: '/v1', requestPath: '/v1/models', notice: 'Using versioned base URL:' },
    { label: 'keeps a custom root when declined', answer: 'n', suffix: '', requestPath: '/models', notice: 'Keeping the base URL unchanged.' },
  ])('$label when the entered URL has no version path', async ({ answer, suffix, requestPath, notice }) => {
    const f = setup(true);
    let requestedPath: string | undefined;
    const versioned = await mockServer((_body, response, request) => {
      requestedPath = request.url;
      response.end(JSON.stringify({ data: [{ id: 'version-check-model' }] }));
    });
    const rootURL = versioned.slice(0, -3);
    const work = f.run();
    try {
      await f.respond('Provider name:', 'version-check');
      await f.respond('Select protocol [1-3,', 'chat-completions');
      await f.respond('Base URL (example:', rootURL);
      await f.respond('Add /v1 for chat-completions?', answer);
      await f.respond('API key (hidden;', 'isolated-version-check-key');
      await f.respond('Select model [1-1,', '1');
      await f.respond('Use as default provider?', '');
      await work;
      expect(readUserConfig().providers['version-check']?.baseURL).toBe(`${rootURL}${suffix}`);
      expect(requestedPath).toBe(requestPath);
      expect(f.text()).toContain(notice);
      expect(f.text()).not.toContain('isolated-version-check-key');
    } finally { f.input.end(); await work.catch(() => {}); }
  });

  it('initializes the user-level file once without overwriting existing providers or credentials', async () => {
    const f = setup();
    await f.run('init');
    expect(existsSync(userConfigPath())).toBe(true);
    expect(readUserConfig()).toEqual({ providers: {} });
    writeUserConfig({ defaultProvider: 'local', providers: { local: { baseURL: 'https://example.com/v1', apiKey: 'isolated-fixture-key' } } });
    const saved = readFileSync(userConfigPath(), 'utf8');
    await f.run('init');
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(saved);
    expect(f.text()).not.toContain('isolated-fixture-key');
  });

  it('stores multiple providers, preserves omitted values on updates, and selects the default', async () => {
    const f = setup();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await f.run('add', 'first', '--base-url', 'https://first.example/v1', '--api-key-env', 'FIRST_KEY', '--protocol', 'responses', '--model', 'first-model');
    await f.run('add', 'second', '--base-url', 'https://second.example/v1', '--protocol', 'anthropic');
    expect(readUserConfig()).toMatchObject({ defaultProvider: 'first', providers: { first: { apiKeyEnv: 'FIRST_KEY', model: 'first-model', protocol: 'responses' }, second: { protocol: 'anthropic' } } });
    await f.run('add', 'first', '--model', 'updated-model');
    expect(readUserConfig().providers.first).toEqual({ baseURL: 'https://first.example/v1', apiKeyEnv: 'FIRST_KEY', protocol: 'responses', model: 'updated-model' });
    await f.run('use', 'second');
    expect(readUserConfig().defaultProvider).toBe('second');
    await f.run('remove', 'first');
    expect(Object.keys(readUserConfig().providers)).toEqual(['second']);
    expect(readUserConfig().defaultProvider).toBe('second');
    await f.run('remove', 'second');
    expect(readUserConfig()).toEqual({ providers: {} });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('redacts saved API keys for list, show, JSON output, and noninteractive bare config', async () => {
    const f = setup();
    writeUserConfig({ defaultProvider: 'private', providers: { private: { baseURL: 'https://example.com/v1', apiKey: 'isolated-not-a-real-credential', model: 'test-model' } } });
    for (const args of [['list'], ['show'], ['show', '--json'], [], ['--json']]) await f.run(...args);
    expect(f.text()).toContain('[REDACTED]');
    expect(f.text()).toContain('test-model');
    expect(f.text()).not.toContain('isolated-not-a-real-credential');
    expect(readUserConfig().providers.private?.apiKey).toBe('isolated-not-a-real-credential');
  });

  it('preserves saved inline credentials unless the user explicitly replaces their source', async () => {
    const f = setup();
    writeUserConfig({ defaultProvider: 'private', providers: { private: { baseURL: 'https://example.com/v1', apiKey: 'isolated-fixture-key' } } });
    await f.run('add', 'private', '--model', 'new-model');
    expect(readUserConfig().providers.private?.apiKey).toBe('isolated-fixture-key');
    await f.run('add', 'private', '--api-key-env', 'PRIVATE_PROVIDER_KEY');
    expect(readUserConfig().providers.private).toEqual({ baseURL: 'https://example.com/v1', model: 'new-model', apiKeyEnv: 'PRIVATE_PROVIDER_KEY' });
    expect(f.text()).not.toContain('isolated-fixture-key');
  });

  it('reports the isolated config path and offers help without creating files', async () => {
    const f = setup();
    await f.run('path');
    expect(f.text()).toContain(path.join(f.root, 'config.json'));
    await f.run('--help');
    expect(f.text()).toContain('/model');
    expect(existsSync(userConfigPath())).toBe(false);
  });

  it.each([
    ['add', 'new'], ['add', 'bad/name', '--base-url', 'https://example.com/v1'],
    ['add', 'new', '--base-url', 'https://example.com/v1', '--protocol', 'unknown'],
    ['add', 'new', '--base-url', 'https://example.com/v1', '--api-key-env', 'bad env'],
    ['use', 'missing'], ['remove', 'missing'], ['show', 'extra'], ['use', 'old', '--model', 'wrong-owner'],
    ['unknown'], ['add', 'new', '--base-url', 'https://example.com/v1', '--api-key', 'do-not-echo-this'],
  ].map(args => ({ args })))('rejects invalid command arguments without changing config: $args', async ({ args }) => {
    const f = setup();
    writeUserConfig({ defaultProvider: 'old', providers: { old: { baseURL: 'https://example.com/v1', apiKeyEnv: 'OLD_KEY' } } });
    const saved = readFileSync(userConfigPath(), 'utf8');
    await expect(f.run(...args)).rejects.toThrow();
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(saved);
    expect(f.text()).not.toContain('do-not-echo-this');
  });

  it('fetches actual models and saves the selected provider without echoing its API key', async () => {
    const f = setup(true);
    const requests: { method?: string; url?: string; authorization?: string }[] = [];
    const baseURL = await mockServer((_body, response, request) => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      response.end(JSON.stringify({ data: [{ id: 'z-model', name: 'Z model' }, { id: 'a-model' }, { id: 'z-model' }] }));
    });
    const temporaryEnvs = Object.keys(process.env).filter(key => key.startsWith('KODO_CONFIG_MODEL_KEY_'));
    const work = f.run();
    try {
      await f.respond('Provider name:', 'wizard');
      await f.respond('Select protocol [1-3,', '2');
      await f.respond('Base URL (example:', baseURL);
      await f.respond('API key (hidden;', 'isolated-wizard-key');
      await f.respond('Select model [1-2,', '2');
      await expect.poll(f.text).toContain('Use as default provider?');
      expect(existsSync(userConfigPath())).toBe(false);
      await f.respond('Use as default provider?', '');
      await work;
      expect(readUserConfig()).toEqual({ defaultProvider: 'wizard', providers: { wizard: { baseURL, protocol: 'responses', apiKey: 'isolated-wizard-key', model: 'z-model' } } });
      expect(requests).toEqual([{ method: 'GET', url: '/v1/models', authorization: 'Bearer isolated-wizard-key' }]);
      expect(f.text()).toContain('1. a-model');
      expect(f.text()).toContain('2. z-model (Z model)');
      expect(f.text()).toContain('Base URL (example: https://api.openai.com/v1)');
      expect(f.text()).not.toContain('isolated-wizard-key');
      expect(f.text()).toContain('/model');
      expect(Object.keys(process.env).filter(key => key.startsWith('KODO_CONFIG_MODEL_KEY_'))).toEqual(temporaryEnvs);
      expect(f.input.isRaw).toBe(false);
    } finally { f.input.end(); await work.catch(() => {}); }
  });

  it('supports an environment reference in interactive setup', async () => {
    const f = setup(true);
    vi.stubEnv('PROVIDER_TOKEN', 'isolated-environment-key');
    const requests: { url?: string; apiKey: string | string[] | undefined; authorization?: string; version: string | string[] | undefined }[] = [];
    const versionedURL = await mockServer((_body, response, request) => {
      requests.push({ url: request.url, apiKey: request.headers['x-api-key'], authorization: request.headers.authorization, version: request.headers['anthropic-version'] });
      response.end(JSON.stringify({ data: [{ id: 'chosen-model', display_name: 'Chosen model' }] }));
    });
    const baseURL = versionedURL.slice(0, -3);
    const work = f.run();
    try {
      await f.respond('Provider name:', 'environment');
      await f.respond('Select protocol [1-3,', '3');
      await f.respond('Base URL (example:', baseURL);
      await f.respond('API key (hidden;', '');
      await f.respond('API key environment variable [KODO_API_KEY]:', 'PROVIDER_TOKEN');
      await f.respond('Select model [1-1,', '1');
      await f.respond('Use as default provider?', 'yes');
      await work;
      expect(readUserConfig().providers.environment).toEqual({ baseURL, protocol: 'anthropic', apiKeyEnv: 'PROVIDER_TOKEN', model: 'chosen-model' });
      expect(requests).toEqual([{ url: '/v1/models', apiKey: 'isolated-environment-key', authorization: undefined, version: '2023-06-01' }]);
      expect(f.text()).toContain('Anthropic base URLs do not need /v1');
      expect(f.text()).toContain('Base URL (example: https://api.anthropic.com)');
      expect(f.text()).not.toContain('isolated-environment-key');
    } finally { f.input.end(); await work.catch(() => {}); }
  });

  it('reports a failed model request and retries before saving the selected model', async () => {
    const f = setup(true);
    let requests = 0;
    const baseURL = await mockServer((_body, response) => {
      if (++requests === 1) response.writeHead(401).end('isolated-retry-key: private provider detail');
      else response.end(JSON.stringify({ data: [{ id: 'retry-model' }] }));
    });
    const work = f.run();
    try {
      await f.respond('Provider name:', 'retry');
      await f.respond('Select protocol [1-3,', '');
      await f.respond('Base URL (example:', baseURL);
      await f.respond('API key (hidden;', 'isolated-retry-key');
      await expect.poll(f.text).toContain('HTTP 401');
      expect(existsSync(userConfigPath())).toBe(false);
      await f.respond('Select model [m=manual,', 'r');
      await expect.poll(f.text).toContain('1. retry-model');
      await f.respond('Select model [1-1,', '1');
      await f.respond('Use as default provider?', '');
      await work;
      expect(requests).toBe(2);
      expect(readUserConfig().providers.retry?.model).toBe('retry-model');
      expect(f.text()).not.toContain('isolated-retry-key');
      expect(f.text()).not.toContain('private provider detail');
    } finally { f.input.end(); await work.catch(() => {}); }
  });

  it('reports an empty list and allows a manually entered 512-character model ID', async () => {
    const f = setup(true);
    const baseURL = await mockServer((_body, response) => { response.end(JSON.stringify({ data: [] })); });
    const work = f.run();
    try {
      await f.respond('Provider name:', 'manual');
      await f.respond('Select protocol [1-3,', '');
      await f.respond('Base URL (example:', baseURL);
      await f.respond('API key (hidden;', 'isolated-manual-key');
      await expect.poll(f.text).toContain('Provider returned no models');
      await f.respond('Select model [m=manual,', 'm');
      await f.respond('Model ID (blank to skip):', 'x'.repeat(513));
      await expect.poll(f.text).toContain('Model ID must contain 1-512 characters');
      expect(existsSync(userConfigPath())).toBe(false);
      await f.respond('Model ID (blank to skip):', 'x'.repeat(512));
      await f.respond('Use as default provider?', 'n');
      await work;
      expect(readUserConfig().providers.manual?.model).toBe('x'.repeat(512));
      expect(readUserConfig().defaultProvider).toBeUndefined();
    } finally { f.input.end(); await work.catch(() => {}); }
  });

  it('rejects an unlisted selection and preserves an existing model and inline credential on Enter', async () => {
    const f = setup(true);
    let authorization: string | undefined;
    const baseURL = await mockServer((_body, response, request) => {
      authorization = request.headers.authorization;
      response.end(JSON.stringify({ data: [{ id: 'available-model' }] }));
    });
    writeUserConfig({ defaultProvider: 'existing', providers: { existing: { baseURL, apiKey: 'isolated-existing-key', model: 'previous-model' } } });
    const saved = readFileSync(userConfigPath(), 'utf8');
    const work = f.run();
    try {
      await f.respond('Provider name:', 'existing');
      await f.respond('Select protocol [1-3,', '');
      await f.respond('Base URL (example:', '');
      await f.respond('API key (hidden;', '');
      await f.respond('Select model [1-1,', '2');
      await expect.poll(f.text).toContain('Choose a listed model number');
      expect(readFileSync(userConfigPath(), 'utf8')).toBe(saved);
      await f.respond('Select model [1-1,', '');
      await f.respond('Use as default provider?', '');
      await work;
      expect(authorization).toBe('Bearer isolated-existing-key');
      expect(readUserConfig().providers.existing).toEqual({ baseURL, apiKey: 'isolated-existing-key', protocol: 'chat-completions', model: 'previous-model' });
      expect(f.text()).not.toContain('isolated-existing-key');
    } finally { f.input.end(); await work.catch(() => {}); }
  });

  it.each(['Ctrl+C', 'EOF'])('cancels %s during a pending model fetch without saving or retaining inline credentials', async cancellation => {
    const f = setup(true);
    writeUserConfig({ providers: { original: { baseURL: 'https://example.com/v1', apiKeyEnv: 'ORIGINAL_KEY' } } });
    const saved = readFileSync(userConfigPath(), 'utf8');
    const listeners = process.listenerCount('SIGINT');
    const temporaryEnvs = Object.keys(process.env).filter(key => key.startsWith('KODO_CONFIG_MODEL_KEY_'));
    let requested = false;
    const baseURL = await mockServer((_body, response) => {
      requested = true;
      response.writeHead(200, { 'content-type': 'application/json' }); response.write('{');
    });
    const work = f.run().catch(error => error as Error);
    await f.respond('Provider name:', 'cancelled');
    await f.respond('Select protocol [1-3,', '');
    await f.respond('Base URL (example:', baseURL);
    await f.respond('API key (hidden;', 'isolated-fetch-cancel-key');
    await expect.poll(() => requested).toBe(true);
    if (cancellation === 'Ctrl+C') f.input.write('\u0003');
    else f.input.end();
    expect(await work).toMatchObject({ code: 'CANCELLED' });
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(saved);
    expect(Object.keys(process.env).filter(key => key.startsWith('KODO_CONFIG_MODEL_KEY_'))).toEqual(temporaryEnvs);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
    expect(f.input.isRaw).toBe(false);
    expect(f.text()).not.toContain('isolated-fetch-cancel-key');
    expect(f.text()).not.toContain('Select model');
  });

  it('cancels during hidden input without saving changes or leaking signal listeners and raw mode', async () => {
    const f = setup(true);
    writeUserConfig({ providers: { original: { baseURL: 'https://example.com/v1', apiKeyEnv: 'ORIGINAL_KEY' } } });
    const saved = readFileSync(userConfigPath(), 'utf8');
    const listeners = process.listenerCount('SIGINT');
    const work = f.run().catch(error => error as Error);
    await f.respond('Provider name:', 'cancelled');
    await f.respond('Select protocol [1-3,', '');
    await f.respond('Base URL (example:', 'https://cancelled.example/v1');
    await expect.poll(f.text).toContain('API key (hidden;');
    f.input.write('unfinished-private-value');
    f.input.write('\u0003');
    expect(await work).toMatchObject({ code: 'CANCELLED' });
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(saved);
    expect(f.text()).not.toContain('unfinished-private-value');
    expect(process.listenerCount('SIGINT')).toBe(listeners);
    expect(f.input.isRaw).toBe(false);
    expect(f.rawModes).toContain(true);
  });

  it('cancels on closed input without creating a half-configured provider', async () => {
    const f = setup(true);
    const work = f.run().catch(error => error as Error);
    await expect.poll(f.text).toContain('Provider name:');
    f.input.end();
    expect(await work).toMatchObject({ code: 'CANCELLED' });
    expect(existsSync(userConfigPath())).toBe(false);
    expect(f.input.isRaw).toBe(false);
  });
});

describe('kodo config provider groups and approved model aliases', () => {
  function seed() {
    writeUserConfig({ defaultProvider: 'first', providers: {
      first: { baseURL: 'https://first.example/v1', model: 'first-model', apiKey: 'isolated-config-secret' },
      second: { baseURL: 'https://second.example/v1', protocol: 'chat-completions', model: 'second-model' },
      other: { baseURL: 'https://other.example/v1', protocol: 'anthropic', model: 'other-model' },
      unset: { baseURL: 'https://unset.example/v1' },
    } });
  }

  it('merges ordered providers, preserves explicit group defaults and selects groups without network requests', async () => {
    const f = setup(); seed();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await f.run('merge', 'fallback', 'second', 'first');
    expect(readUserConfig().providerGroups?.fallback).toEqual({ providers: ['second', 'first'], model: 'second-model' });
    await f.run('merge', 'fallback', 'first', 'second', '--model', 'custom-group-model');
    await f.run('merge', 'fallback', 'second', 'first');
    expect(readUserConfig().providerGroups?.fallback).toEqual({ providers: ['second', 'first'], model: 'custom-group-model' });
    await f.run('use', 'fallback');
    expect(readUserConfig().defaultProvider).toBe('fallback');
    await f.run('unmerge', 'fallback');
    expect(readUserConfig().providerGroups).toEqual({});
    expect(readUserConfig().defaultProvider).toBeUndefined();
    expect(Object.keys(readUserConfig().providers)).toEqual(['first', 'second', 'other', 'unset']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('registers approved aliases, defaults their models from providers or groups and assigns all three roles', async () => {
    const f = setup(); seed();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await f.run('merge', 'fallback', 'first', 'second', '--model', 'group-model');
    await f.run('model', 'add', 'quick', '--provider', 'first', '--description', 'Fast tasks');
    await f.run('model', 'add', 'balanced', '--provider', 'fallback', '--description', 'Balanced tasks');
    await f.run('model', 'add', 'reasoning', '--provider', 'other', '--model', 'r'.repeat(512), '--description', 'd'.repeat(240));
    expect(readUserConfig().modelBindings).toEqual({
      quick: { provider: 'first', model: 'first-model', description: 'Fast tasks' },
      balanced: { provider: 'fallback', model: 'group-model', description: 'Balanced tasks' },
      reasoning: { provider: 'other', model: 'r'.repeat(512), description: 'd'.repeat(240) },
    });
    await f.run('role', 'fast', 'quick');
    await f.run('role', 'standard', 'balanced');
    await f.run('role', 'strong', 'reasoning');
    expect(readUserConfig().modelRoles).toEqual({ fast: 'quick', standard: 'balanced', strong: 'reasoning' });
    await f.run('role', 'fast', 'inherit');
    expect(readUserConfig().modelRoles).toEqual({ standard: 'balanced', strong: 'reasoning' });
    await f.run('model', 'remove', 'quick');
    expect(readUserConfig().modelBindings?.quick).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    const before = f.text().length;
    await f.run('show', '--json');
    const visible = JSON.parse(f.text().slice(before));
    expect(visible.providerGroups).toEqual(readUserConfig().providerGroups);
    expect(visible.modelBindings).toEqual(readUserConfig().modelBindings);
    expect(visible.modelRoles).toEqual(readUserConfig().modelRoles);
    expect(visible.providers.first.apiKey).toBe('[REDACTED]');
    expect(f.text()).not.toContain('isolated-config-secret');
  });

  it('does not silently cascade group, model alias or role references when removing configuration', async () => {
    const f = setup(); seed();
    await f.run('merge', 'fallback', 'first', 'second');
    await f.run('model', 'add', 'balanced', '--provider', 'fallback');
    await f.run('model', 'add', 'quick', '--provider', 'unset', '--model', 'custom-model');
    await f.run('role', 'standard', 'balanced');
    for (const args of [['remove', 'first'], ['unmerge', 'fallback'], ['model', 'remove', 'balanced'], ['remove', 'unset']]) {
      const before = readFileSync(userConfigPath(), 'utf8');
      await expect(f.run(...args)).rejects.toMatchObject({ code: 'CONFIG_REFERENCE' });
      expect(readFileSync(userConfigPath(), 'utf8')).toBe(before);
    }
    await f.run('role', 'standard', 'inherit');
    await f.run('model', 'remove', 'balanced');
    await f.run('unmerge', 'fallback');
    await f.run('model', 'remove', 'quick');
    await f.run('remove', 'unset');
    expect(readUserConfig().modelRoles).toEqual({});
    expect(readUserConfig().modelBindings).toEqual({});
    expect(readUserConfig().providerGroups).toEqual({});
    expect(readUserConfig().providers.unset).toBeUndefined();
  });

  it('requires an explicit model when a configured provider or group has no model', async () => {
    const f = setup(); seed();
    await f.run('merge', 'noModel', 'unset', 'first');
    expect(readUserConfig().providerGroups?.noModel).toEqual({ providers: ['unset', 'first'] });
    const before = readFileSync(userConfigPath(), 'utf8');
    for (const provider of ['unset', 'noModel']) {
      await expect(f.run('model', 'add', 'manual', '--provider', provider)).rejects.toThrow('supply --model');
      expect(readFileSync(userConfigPath(), 'utf8')).toBe(before);
    }
    await f.run('model', 'add', 'manual', '--provider', 'noModel', '--model', 'explicit/model');
    expect(readUserConfig().modelBindings?.manual).toEqual({ provider: 'noModel', model: 'explicit/model' });
  });

  it('keeps absent optional fields absent when a role already inherits', async () => {
    const f = setup(); seed();
    await f.run('role', 'fast', 'inherit');
    expect(readUserConfig()).not.toHaveProperty('modelRoles');
    expect(readUserConfig()).not.toHaveProperty('providerGroups');
    expect(readUserConfig()).not.toHaveProperty('modelBindings');
  });

  it.each([
    ['merge', 'first', 'first', 'second'], ['merge', 'bad/name', 'first', 'second'],
    ['merge', 'bad', 'first'], ['merge', 'bad', 'first', 'first'], ['merge', 'bad', 'first', 'missing'],
    ['merge', 'bad', 'first', 'other'], ['merge', 'bad', 'first', 'fallback'],
    ['merge', 'bad', 'first', 'second', '--model', 'x'.repeat(513)],
    ['merge', 'bad', 'first', 'second', '--model', 'line\nbreak'],
    ['merge', 'bad', 'first', 'second', '--protocol', 'responses'],
    ['add', 'first', '--protocol', 'responses'], ['add', 'fallback', '--base-url', 'https://new.example/v1'],
    ['use', 'missing-group'], ['unmerge', 'first'], ['unmerge', 'missing'],
    ['model', 'add', 'alias'], ['model', 'add', 'alias', '--provider', 'missing'],
    ['model', 'add', 'alias', '--provider', 'first', '--model', ''],
    ['model', 'add', 'alias', '--provider', 'first', '--model', 'm'.repeat(513)],
    ['model', 'add', 'alias', '--provider', 'first', '--description', 'd'.repeat(241)],
    ['model', 'add', 'alias', '--provider', 'first', '--description', 'line\nbreak'],
    ['model', 'add', 'alias', '--provider', 'first', '--api-key-env', 'KEY'],
    ['model', 'remove', 'missing'], ['model', 'remove', 'alias', '--provider', 'first'],
    ['model', 'other', 'alias'], ['role', 'unknown', 'inherit'], ['role', 'fast', 'unapproved'],
    ['role', 'fast', 'inherit', '--model', 'unrelated'], ['show', '--provider', 'first'],
  ].map(args => ({ args })))('rejects invalid group and model commands while preserving config: $args', async ({ args }) => {
    const f = setup(); seed();
    await f.run('merge', 'fallback', 'first', 'second');
    const before = readFileSync(userConfigPath(), 'utf8');
    await expect(f.run(...args)).rejects.toThrow();
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(before);
    expect(f.text()).not.toContain('isolated-config-secret');
  });
});
