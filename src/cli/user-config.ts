import { linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { KodoError } from '../runtime/types.js';
import type { ModelProtocol } from '../runtime/types.js';

export interface ProviderConfig {
  baseURL: string;
  protocol?: ModelProtocol;
  model?: string;
  apiKeyEnv?: string;
  apiKey?: string;
}
export interface ProviderGroupConfig {
  providers: string[];
  model?: string;
}
export interface ModelAliasConfig {
  provider: string;
  model: string;
  description?: string;
}
export type ModelRole = 'fast' | 'standard' | 'strong';
export interface UserConfig {
  defaultProvider?: string;
  providers: Record<string, ProviderConfig>;
  providerGroups?: Record<string, ProviderGroupConfig>;
  modelBindings?: Record<string, ModelAliasConfig>;
  modelRoles?: Partial<Record<ModelRole, string>>;
}

const maximumBytes = 1_048_576;
const fields = new Set(['baseURL', 'protocol', 'model', 'apiKeyEnv', 'apiKey']);
const control = /[\p{Cc}\p{Cf}]/u;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const providerName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value) && !Object.hasOwn(Object.prototype, value);
const validModel = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 512 && !control.test(value);
function invalid(message: string): never { throw new KodoError('USER_CONFIG', `${message} Edit config.json or run kodo config.`); }

export function userConfigPath(): string {
  const root = process.env.KODO_HOME;
  if (root !== undefined && (!root.trim() || !path.isAbsolute(root) || control.test(root))) throw new KodoError('USER_CONFIG', 'KODO_HOME must be a nonempty absolute directory path.');
  return path.join(root ?? path.join(os.homedir(), '.kodo'), 'config.json');
}

/** Returns a fresh configuration containing only the supported user-editable fields. */
export function validateUserConfig(value: unknown): UserConfig {
  if (!record(value) || Object.keys(value).some(key => !['providers', 'defaultProvider', 'providerGroups', 'modelBindings', 'modelRoles'].includes(key))) invalid('User configuration contains unsupported fields.');
  const source = value.providers === undefined ? {} : value.providers;
  if (!record(source)) invalid('providers must be an object keyed by provider name.');
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, entry] of Object.entries(source)) {
    if (!providerName(name)) invalid('Provider names must contain 1-64 letters, digits, hyphens or underscores, starting with a letter or digit.');
    if (!record(entry) || Object.keys(entry).some(key => !fields.has(key))) invalid('A provider contains unsupported fields.');
    if (typeof entry.baseURL !== 'string' || !entry.baseURL.trim() || control.test(entry.baseURL)) invalid('Each provider requires a valid baseURL.');
    let url: URL;
    try { url = new URL(entry.baseURL); } catch { invalid('Each provider requires a valid baseURL.'); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) invalid('Provider baseURL must use HTTPS or loopback HTTP, without credentials, query parameters or fragments.');
    if (entry.protocol !== undefined && !['chat-completions', 'responses', 'anthropic'].includes(entry.protocol as string)) invalid('Provider protocol must be chat-completions, responses or anthropic.');
    if (entry.model !== undefined && !validModel(entry.model)) invalid('Provider model must contain 1-512 characters without control characters.');
    if (entry.apiKeyEnv !== undefined && (typeof entry.apiKeyEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/iu.test(entry.apiKeyEnv))) invalid('Provider apiKeyEnv must name an environment variable.');
    if (entry.apiKey !== undefined && (typeof entry.apiKey !== 'string' || !entry.apiKey.trim() || entry.apiKey.length > 16_384 || control.test(entry.apiKey))) invalid('Provider apiKey must be a nonempty value without control characters, up to 16 KiB.');
    if (entry.apiKeyEnv !== undefined && entry.apiKey !== undefined) invalid('A provider must use either apiKeyEnv or apiKey, not both.');
    providers[name] = {
      baseURL: entry.baseURL,
      ...(entry.protocol !== undefined ? { protocol: entry.protocol as ModelProtocol } : {}),
      ...(entry.model !== undefined ? { model: entry.model as string } : {}),
      ...(entry.apiKeyEnv !== undefined ? { apiKeyEnv: entry.apiKeyEnv as string } : {}),
      ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey as string } : {}),
    };
  }
  const providerGroups: Record<string, ProviderGroupConfig> = {};
  if (value.providerGroups !== undefined) {
    if (!record(value.providerGroups)) invalid('providerGroups must be an object keyed by group name.');
    for (const [name, entry] of Object.entries(value.providerGroups)) {
      if (!providerName(name) || Object.hasOwn(providers, name)) invalid('Provider group names must be valid names distinct from configured providers.');
      if (!record(entry) || Object.keys(entry).some(key => key !== 'providers' && key !== 'model')) invalid('A provider group contains unsupported fields.');
      if (!Array.isArray(entry.providers) || entry.providers.length < 2 || entry.providers.length > 8
        || entry.providers.some(member => typeof member !== 'string' || !Object.hasOwn(providers, member))
        || new Set(entry.providers).size !== entry.providers.length) invalid('A provider group requires 2-8 unique configured providers; nested groups are not supported.');
      const members = entry.providers as string[];
      if (new Set(members.map(member => providers[member]!.protocol ?? 'chat-completions')).size !== 1) invalid('All providers in a group must use the same protocol.');
      if (entry.model !== undefined && !validModel(entry.model)) invalid('Provider group model must contain 1-512 characters without control characters.');
      providerGroups[name] = { providers: [...members], ...(entry.model !== undefined ? { model: entry.model as string } : {}) };
    }
  }
  const hasProvider = (name: unknown): name is string => typeof name === 'string' && (Object.hasOwn(providers, name) || Object.hasOwn(providerGroups, name));
  if (value.defaultProvider !== undefined && !hasProvider(value.defaultProvider)) invalid('defaultProvider must name a configured provider or provider group.');
  const modelBindings: Record<string, ModelAliasConfig> = {};
  if (value.modelBindings !== undefined) {
    if (!record(value.modelBindings)) invalid('modelBindings must be an object keyed by approved model alias.');
    for (const [alias, entry] of Object.entries(value.modelBindings)) {
      if (!providerName(alias)) invalid('Model aliases must contain 1-64 letters, digits, hyphens or underscores, starting with a letter or digit.');
      if (!record(entry) || Object.keys(entry).some(key => !['provider', 'model', 'description'].includes(key))) invalid('A model binding contains unsupported fields.');
      if (!hasProvider(entry.provider)) invalid('Each model binding must reference a configured provider or provider group.');
      if (!validModel(entry.model)) invalid('A model binding requires a model containing 1-512 characters without control characters.');
      if (entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > 240 || control.test(entry.description))) invalid('Model binding descriptions must contain at most 240 characters without control characters.');
      modelBindings[alias] = { provider: entry.provider, model: entry.model, ...(entry.description !== undefined ? { description: entry.description as string } : {}) };
    }
  }
  const modelRoles: Partial<Record<ModelRole, string>> = {};
  if (value.modelRoles !== undefined) {
    if (!record(value.modelRoles)) invalid('modelRoles must be an object with fast, standard or strong roles.');
    for (const [role, alias] of Object.entries(value.modelRoles)) {
      if (!['fast', 'standard', 'strong'].includes(role) || typeof alias !== 'string' || !Object.hasOwn(modelBindings, alias)) invalid('Model roles must reference approved model aliases using fast, standard or strong.');
      modelRoles[role as ModelRole] = alias;
    }
  }
  return {
    ...(value.defaultProvider !== undefined ? { defaultProvider: value.defaultProvider as string } : {}), providers,
    ...(value.providerGroups !== undefined ? { providerGroups } : {}),
    ...(value.modelBindings !== undefined ? { modelBindings } : {}),
    ...(value.modelRoles !== undefined ? { modelRoles } : {}),
  };
}

function readExisting(): UserConfig | undefined {
  const file = userConfigPath();
  let bytes: Buffer;
  try {
    if (statSync(file).size > maximumBytes) invalid('User configuration exceeds 1 MiB.');
    bytes = readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof KodoError) throw error;
    throw new KodoError('USER_CONFIG_READ', 'Cannot read user config.json. Check its path and file permissions.');
  }
  if (bytes.length > maximumBytes) invalid('User configuration exceeds 1 MiB.');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { invalid('User config.json is not valid JSON.'); }
  return validateUserConfig(value);
}

export function readUserConfig(): UserConfig { return readExisting() ?? { providers: {} }; }

/** Publish a complete file from the same directory; initialization never replaces an existing file. */
function save(config: UserConfig, replace: boolean): void {
  const validated = validateUserConfig(config);
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(content, 'utf8') > maximumBytes) invalid('User configuration exceeds 1 MiB.');
  const file = userConfigPath();
  const temporary = path.join(path.dirname(file), `config.${randomUUID()}.tmp`);
  let failure: KodoError | undefined;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    if (replace) renameSync(temporary, file);
    else linkSync(temporary, file);
  } catch (error) {
    if (replace || (error as NodeJS.ErrnoException).code !== 'EEXIST') failure = new KodoError('USER_CONFIG_WRITE', 'Cannot save user config.json. Check its directory and file permissions; the previous configuration was retained.');
  }
  try { unlinkSync(temporary); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure = new KodoError('USER_CONFIG_WRITE', 'Cannot remove a temporary configuration file. Check the user configuration directory permissions.'); }
  if (failure) throw failure;
}

export function writeUserConfig(config: UserConfig): void { save(config, true); }

export function ensureUserConfig(): UserConfig {
  const existing = readExisting();
  if (existing) return existing;
  save({ providers: {} }, false);
  return readUserConfig();
}
