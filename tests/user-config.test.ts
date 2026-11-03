import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureUserConfig, readUserConfig, userConfigPath, validateUserConfig, writeUserConfig } from '../src/cli/user-config.js';
import type { UserConfig } from '../src/cli/user-config.js';
import { temp } from './helpers.js';

afterEach(() => vi.unstubAllEnvs());
const config = (): UserConfig => ({ defaultProvider: 'local', providers: {
  local: { baseURL: 'http://127.0.0.1:12345/v1', protocol: 'chat-completions', model: 'fixture-model', apiKeyEnv: 'FIXTURE_API_KEY' },
  remote: { baseURL: 'https://model.example/v1', protocol: 'anthropic', apiKey: 'isolated-fixture-secret' },
} });
const groupedConfig = (): UserConfig => ({
  ...config(), defaultProvider: 'cluster',
  providers: { ...config().providers, backup: { baseURL: 'https://backup.example/v1', model: 'fallback-model' } },
  providerGroups: { cluster: { providers: ['local', 'backup'], model: 'group-model' } },
  modelBindings: {
    quick: { provider: 'cluster', model: 'exact/model:preview', description: 'Low latency tasks' },
    reason: { provider: 'remote', model: 'x'.repeat(512) },
  },
  modelRoles: { fast: 'quick', strong: 'reason' },
});
function setup(): string { const directory = path.join(temp(), '.kodo'); vi.stubEnv('KODO_HOME', directory); return directory; }

describe('user config.json', () => {
  it('uses the home .kodo directory unless KODO_HOME supplies an absolute directory', () => {
    vi.stubEnv('KODO_HOME', undefined);
    expect(userConfigPath()).toBe(path.join(os.homedir(), '.kodo', 'config.json'));
    const directory = setup();
    expect(userConfigPath()).toBe(path.join(directory, 'config.json'));
    for (const value of ['', ' ', './relative', 'relative']) {
      vi.stubEnv('KODO_HOME', value);
      expect(() => userConfigPath()).toThrow('absolute directory');
    }
  });

  it('treats a missing configuration as empty without creating files during a read', () => {
    const directory = setup();
    expect(readUserConfig()).toEqual({ providers: {} });
    expect(existsSync(directory)).toBe(false);
  });

  it('initializes the user folder and a UTF-8 file without a byte-order mark', () => {
    setup();
    expect(ensureUserConfig()).toEqual({ providers: {} });
    const bytes = readFileSync(userConfigPath());
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({ providers: {} });
    expect(readdirSync(path.dirname(userConfigPath()))).toEqual(['config.json']);
  });

  it('persists multiple providers and replaces the complete selected configuration', () => {
    setup();
    writeUserConfig(config());
    expect(readUserConfig()).toEqual(config());
    const next = config(); next.defaultProvider = 'remote'; delete next.providers.local;
    writeUserConfig(next);
    expect(readUserConfig()).toEqual(next);
    expect(readdirSync(path.dirname(userConfigPath()))).toEqual(['config.json']);
  });

  it('preserves the exact existing file when initialization is repeated', () => {
    setup();
    mkdirSync(path.dirname(userConfigPath()), { recursive: true });
    const text = JSON.stringify(config());
    writeFileSync(userConfigPath(), text);
    expect(ensureUserConfig()).toEqual(config());
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(text);
  });

  it('does not overwrite malformed or invalid existing configuration during initialization', () => {
    setup(); mkdirSync(path.dirname(userConfigPath()), { recursive: true });
    for (const text of ['{"apiKey":"isolated-fixture-secret",', '{"providers":[],"apiKey":"isolated-fixture-secret"}']) {
      writeFileSync(userConfigPath(), text);
      for (const read of [readUserConfig, ensureUserConfig]) {
        let caught: unknown;
        try { read(); } catch (error) { caught = error; }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).not.toContain('isolated-fixture-secret');
      }
      expect(readFileSync(userConfigPath(), 'utf8')).toBe(text);
    }
  });

  it('validates and clones optional fields without retaining caller-owned objects', () => {
    const input = config();
    const result = validateUserConfig(input);
    input.providers.local!.model = 'changed'; delete input.providers.remote;
    expect(result).toEqual(config());
    expect(validateUserConfig({})).toEqual({ providers: {} });
    expect(validateUserConfig({ providers: { local: { baseURL: 'http://[::1]:1234/v1' } } })).toEqual({ providers: { local: { baseURL: 'http://[::1]:1234/v1' } } });
  });

  it.each([
    null, [], { providers: [] }, { providers: null }, { extra: true },
    { defaultProvider: 'missing', providers: {} },
    { providers: { 'bad name': { baseURL: 'https://model.example' } } },
    { providers: { local: { baseURL: 'https://model.example', unexpected: true } } },
    { providers: { local: { baseURL: 'not-a-url' } } },
    { providers: { local: { baseURL: 'http://model.example' } } },
    { providers: { local: { baseURL: 'https://model.example', protocol: 'other' } } },
    { providers: { local: { baseURL: 'https://model.example', model: '' } } },
    { providers: { local: { baseURL: 'https://model.example', model: 'x'.repeat(513) } } },
    { providers: { local: { baseURL: 'https://model.example', model: 'line\nbreak' } } },
    { providers: { local: { baseURL: 'https://model.example', apiKeyEnv: 'not a variable' } } },
    { providers: { local: { baseURL: 'https://model.example', apiKey: '' } } },
    { providers: { local: { baseURL: 'https://model.example', apiKey: 'a'.repeat(16_385) } } },
    { providers: { local: { baseURL: 'https://model.example', apiKey: 'fixture', apiKeyEnv: 'FIXTURE_KEY' } } },
  ])('rejects unsupported configuration (%#)', value => {
    expect(() => validateUserConfig(value)).toThrow('config');
  });

  it('keeps the previous file intact when the replacement does not validate', () => {
    const directory = setup(); writeUserConfig(config());
    const before = readFileSync(userConfigPath(), 'utf8');
    expect(() => writeUserConfig({ ...config(), defaultProvider: 'missing' })).toThrow('defaultProvider');
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(before);
    expect(readdirSync(directory)).toEqual(['config.json']);
  });

  it('persists ordered provider groups, approved model aliases and role assignments without retaining caller-owned objects', () => {
    setup();
    const input = groupedConfig();
    const result = validateUserConfig(input);
    writeUserConfig(input);
    expect(readUserConfig()).toEqual(groupedConfig());
    input.providerGroups!.cluster!.providers.reverse();
    input.providerGroups!.cluster!.model = 'changed';
    input.modelBindings!.quick!.description = 'Changed description';
    input.modelRoles!.fast = 'reason';
    expect(result).toEqual(groupedConfig());
    expect(readUserConfig()).toEqual(groupedConfig());
    expect(validateUserConfig(config())).toEqual(config());
  });

  it('accepts eight distinct providers, the effective default protocol, 512-character models and 240-character descriptions', () => {
    const providers = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`p${index}`, { baseURL: `https://p${index}.example/v1`, ...(index % 2 ? { protocol: 'chat-completions' } : {}) }]));
    const input = {
      providers, defaultProvider: 'all', providerGroups: { all: { providers: Object.keys(providers), model: 'g'.repeat(512) } },
      modelBindings: { approved: { provider: 'all', model: 'm'.repeat(512), description: 'd'.repeat(240) } },
      modelRoles: { fast: 'approved', standard: 'approved', strong: 'approved' },
    };
    expect(validateUserConfig(input)).toEqual(input);
    expect(validateUserConfig({ providers, providerGroups: {}, modelBindings: {}, modelRoles: {} })).toEqual({ providers, providerGroups: {}, modelBindings: {}, modelRoles: {} });
  });

  it.each([
    { providerGroups: null }, { providerGroups: [] },
    { providerGroups: { cluster: { providers: ['local'] } } },
    { providerGroups: { cluster: { providers: Array.from({ length: 9 }, () => 'local') } } },
    { providerGroups: { cluster: { providers: ['local', 'local'] } } },
    { providerGroups: { cluster: { providers: ['local', 'missing'] } } },
    { providerGroups: { cluster: { providers: ['local', 'remote'] } } },
    { providerGroups: { cluster: { providers: ['local', 'backup'] }, nested: { providers: ['cluster', 'backup'] } } },
    { providerGroups: { local: { providers: ['local', 'backup'] } } },
    { providerGroups: { 'bad name': { providers: ['local', 'backup'] } } },
    { providerGroups: { cluster: { providers: ['local', 'backup'], unexpected: true } } },
    { providerGroups: { cluster: { providers: ['local', 'backup'], model: '' } } },
    { providerGroups: { cluster: { providers: ['local', 'backup'], model: 'm'.repeat(513) } } },
    { providerGroups: { cluster: { providers: ['local', 'backup'], model: 'line\nbreak' } } },
    { modelBindings: null }, { modelBindings: [] },
    { modelBindings: { 'bad name': { provider: 'local', model: 'ok' } } },
    { modelBindings: { quick: { provider: 'missing', model: 'ok' } } },
    { modelBindings: { quick: { provider: 'local', model: 'ok', allowed: true } } },
    { modelBindings: { quick: { provider: 'local' } } },
    { modelBindings: { quick: { provider: 'local', model: '' } } },
    { modelBindings: { quick: { provider: 'local', model: 'm'.repeat(513) } } },
    { modelBindings: { quick: { provider: 'local', model: 'has\u200bformat' } } },
    { modelBindings: { quick: { provider: 'local', model: 'ok', description: 'd'.repeat(241) } } },
    { modelBindings: { quick: { provider: 'local', model: 'ok', description: 'line\nbreak' } } },
    { modelRoles: null }, { modelRoles: [] },
    { modelRoles: { unknown: 'quick' } },
    { modelRoles: { fast: 'missing' } },
    { modelRoles: { strong: 'exact/model:preview' } },
    { modelRoles: { fast: 'inherit' } },
    { defaultProvider: 'missing-group' },
  ].map((patch, index) => ({ patch, index })))('rejects invalid group and alias references atomically (#$index)', ({ patch }) => {
    const directory = setup();
    writeUserConfig(groupedConfig());
    const before = readFileSync(userConfigPath(), 'utf8');
    let error: unknown;
    try { writeUserConfig({ ...groupedConfig(), ...patch } as UserConfig); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('isolated-fixture-secret');
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(before);
    expect(readdirSync(directory)).toEqual(['config.json']);
  });

  it('bounds file size when reading and writing without discarding a previous configuration', () => {
    setup(); writeUserConfig(config()); const before = readFileSync(userConfigPath(), 'utf8');
    const providers = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`provider${index}`, { baseURL: 'https://model.example/v1', apiKey: 'x'.repeat(16_000) }]));
    expect(() => writeUserConfig({ providers })).toThrow('exceeds 1 MiB');
    expect(readFileSync(userConfigPath(), 'utf8')).toBe(before);
    writeFileSync(userConfigPath(), ' '.repeat(1_048_577));
    expect(() => readUserConfig()).toThrow('exceeds 1 MiB');
    expect(() => ensureUserConfig()).toThrow('exceeds 1 MiB');
    expect(statSync(userConfigPath()).size).toBe(1_048_577);
  });

  it('reports filesystem failures and cleans incomplete temporary writes', () => {
    const directory = setup(); mkdirSync(userConfigPath(), { recursive: true });
    expect(() => writeUserConfig(config())).toThrow('Cannot save user config.json');
    expect(readdirSync(directory)).toEqual(['config.json']);
    expect(statSync(userConfigPath()).isDirectory()).toBe(true);
    expect(() => readUserConfig()).toThrow('Cannot read user config.json');
  });

  it.skipIf(process.platform === 'win32')('creates private file and directory modes on POSIX', () => {
    const directory = setup(); ensureUserConfig();
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(userConfigPath()).mode & 0o777).toBe(0o600);
  });
});
