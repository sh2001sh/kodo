import { createHash } from 'node:crypto';
import { KodoError } from '../runtime/types.js';
import type { ModelBinding } from '../runtime/types.js';
import { listProviderModels } from '../providers/model-list.js';
import type { TuiOptions } from '../tui/types.js';
import { readUserConfig, userConfigPath, validateUserConfig, writeUserConfig } from './user-config.js';
import type { ModelRole, UserConfig } from './user-config.js';

const legacyCredential = (): string => process.env.KODO_API_KEY ? 'KODO_API_KEY' : 'OPENAI_API_KEY';
const credentialName = (id: string, baseURL: string): string => `KODO_PROVIDER_${createHash('sha256').update(`${id}\0${baseURL}`).digest('hex').slice(0, 24).toUpperCase()}_API_KEY`;
const hasConnection = (config: UserConfig, id: string): boolean => Object.hasOwn(config.providers, id) || Object.hasOwn(config.providerGroups ?? {}, id);

export const hasModelCredentials = (binding: ModelBinding): boolean => [binding, ...binding.fallbacks ?? []].some(route => Boolean(process.env[route.apiKeyEnv]));

/** Only environment references enter durable bindings; configured secrets stay in this host process. */
export function hydrateConfigCredentials(config: UserConfig): void {
  config = validateUserConfig(config);
  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.apiKey !== undefined) process.env[credentialName(id, provider.baseURL)] = provider.apiKey;
  }
}

/** Explicit CLI fields override one provider; group connection fields stay independently pinned. */
export function resolveConfiguredBinding(values: Record<string, unknown> = {}, config: UserConfig = readUserConfig()): { binding: ModelBinding; provider?: string } {
  config = validateUserConfig(config);
  const names = [...Object.keys(config.providers), ...Object.keys(config.providerGroups ?? {})];
  const id = values.provider ?? process.env.KODO_PROVIDER ?? config.defaultProvider ?? (names.length === 1 ? names[0] : undefined);
  if (id !== undefined && (typeof id !== 'string' || !hasConnection(config, id))) throw new KodoError('PROVIDER_CONFIG', 'Unknown provider. Run kodo config list or kodo config add.');
  const get = (key: string): string | undefined => {
    const value = values[key];
    if (value !== undefined && typeof value !== 'string') throw new KodoError('ARGUMENTS', 'Provider options require string values.');
    return value;
  };
  hydrateConfigCredentials(config);
  const cache = get('prompt-cache') ?? process.env.KODO_PROMPT_CACHE;
  const group = typeof id === 'string' ? config.providerGroups?.[id] : undefined;
  if (group) {
    if (['base-url', 'api-key-env', 'protocol'].some(key => get(key) !== undefined)) throw new KodoError('PROVIDER_CONFIG', 'A provider group keeps each connection pinned. Select one provider to override connection options.');
    const routes = group.providers.map(member => resolveConfiguredBinding({ provider: member, model: get('model') ?? group.model ?? '', ...(cache === undefined ? {} : { 'prompt-cache': cache }) }, config).binding);
    return { provider: id as string, binding: { ...routes[0]!, fallbacks: routes.slice(1) } };
  }
  const provider = typeof id === 'string' ? config.providers[id] : undefined;
  const binding: ModelBinding = {
    model: get('model') ?? (provider ? provider.model ?? '' : process.env.KODO_MODEL ?? ''),
    baseURL: get('base-url') ?? provider?.baseURL ?? process.env.KODO_BASE_URL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    apiKeyEnv: get('api-key-env') ?? (provider ? provider.apiKeyEnv ?? credentialName(id as string, provider.baseURL) : legacyCredential()),
    protocol: (get('protocol') ?? (provider ? provider.protocol ?? 'chat-completions' : process.env.KODO_PROTOCOL ?? 'chat-completions')) as ModelBinding['protocol'],
    ...(typeof id === 'string' ? { provider: id } : {}),
    ...(cache !== undefined ? { promptCache: cache as 'off' | 'session' } : {}),
  };
  return { binding, ...(typeof id === 'string' ? { provider: id } : {}) };
}

/** Configured aliases are the entire allowed range; an empty map freezes an empty range for new sessions. */
export function configuredAgentModels(config: UserConfig = readUserConfig()): {
  modelBindings: Record<string, ModelBinding>;
  modelRoles: Partial<Record<ModelRole, string>>;
  modelBindingDescriptions: Record<string, string>;
} {
  config = validateUserConfig(config);
  return {
    modelBindings: Object.fromEntries(Object.entries(config.modelBindings ?? {}).map(([alias, entry]) => [alias, resolveConfiguredBinding({ provider: entry.provider, model: entry.model }, config).binding])),
    modelRoles: { ...config.modelRoles },
    modelBindingDescriptions: Object.fromEntries(Object.entries(config.modelBindings ?? {}).flatMap(([alias, entry]) => entry.description ? [[alias, entry.description]] : [])),
  };
}

/** The terminal saves user selections; active runs retain their frozen runtime bindings. */
export function tuiModelConfig(initial: { binding: ModelBinding; provider?: string }, config: UserConfig): NonNullable<TuiOptions['modelConfig']> {
  let selected = { ...initial, binding: structuredClone(initial.binding) };
  const connection = (id: string | undefined): ModelBinding => {
    if (id === selected.provider) return structuredClone(selected.binding);
    if (!id) throw new KodoError('PROVIDER_CONFIG', 'Select a configured provider with /providers or run kodo config.');
    return resolveConfiguredBinding({ provider: id }, readUserConfig()).binding;
  };
  const descriptors = (current: UserConfig) => [
    ...Object.entries(current.providers).map(([id, provider]) => ({ id, ...(provider.model ? { model: provider.model } : {}) })),
    ...Object.entries(current.providerGroups ?? {}).map(([id, group]) => ({ id, members: [...group.providers], ...(group.model ? { model: group.model } : {}) })),
  ];
  const host: NonNullable<TuiOptions['modelConfig']> = {
    path: userConfigPath(), provider: initial.provider, providers: descriptors(config), lastModelWarnings: [],
    listModels: async (id, signal) => {
      if (id !== '*' && id === selected.provider && (id === undefined || !config.providerGroups?.[id])) {
        const models = await listProviderModels(connection(id), signal);
        signal.throwIfAborted(); host.lastModelWarnings = [];
        return models;
      }
      const current = readUserConfig();
      const group = id === undefined ? undefined : current.providerGroups?.[id];
      if (id !== '*' && !group) {
        const models = await listProviderModels(connection(id), signal);
        signal.throwIfAborted(); host.lastModelWarnings = [];
        return models;
      }
      const members = group?.providers ?? Object.keys(current.providers);
      if (!members.length) throw new KodoError('PROVIDER_CONFIG', 'No providers are configured. Run kodo config.');
      const results = await Promise.allSettled(members.map(async member => ({ member, models: await listProviderModels(resolveConfiguredBinding({ provider: member }, current).binding, signal) })));
      signal.throwIfAborted();
      const warnings = results.flatMap((result, index) => result.status === 'rejected' ? [`Provider ${members[index]} could not load its models. Check its connection or credentials with kodo config.`] : []);
      const available = results.flatMap(result => result.status === 'fulfilled' ? result.value.models.map(model => ({ ...model, provider: result.value.member })) : []);
      if (!available.length) throw new KodoError('MODEL_LIST_UNAVAILABLE', 'None of the selected providers returned models. Check kodo config, retry, or enter an exact model ID manually.');
      host.lastModelWarnings = warnings;
      if (!group) return available.sort((a, b) => a.id.localeCompare(b.id) || a.provider.localeCompare(b.provider));
      const models = new Map<string, { id: string; name?: string; provider: string; sources: string[] }>();
      for (const model of available) {
        const existing = models.get(model.id);
        if (existing) existing.sources.push(model.provider);
        else models.set(model.id, { id: model.id, ...(model.name ? { name: model.name } : {}), provider: id!, sources: [model.provider] });
      }
      return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
    select: (id, model) => {
      const base = connection(id);
      const binding = { ...base, model, ...(base.fallbacks ? { fallbacks: base.fallbacks.map(route => ({ ...route, model })) } : {}) };
      if (id) {
        const current = readUserConfig();
        if (!hasConnection(current, id)) throw new KodoError('PROVIDER_CONFIG', 'This provider is no longer configured. Run kodo config.');
        const next = Object.hasOwn(current.providers, id)
          ? { ...current, defaultProvider: id, providers: { ...current.providers, [id]: { ...current.providers[id]!, model } } }
          : { ...current, defaultProvider: id, providerGroups: { ...current.providerGroups, [id]: { ...current.providerGroups![id]!, model } } };
        writeUserConfig(next); host.providers = descriptors(next);
      }
      selected = { binding, ...(id ? { provider: id } : {}) };
      return structuredClone(binding);
    },
    selectProvider: id => {
      const current = readUserConfig();
      const binding = resolveConfiguredBinding({ provider: id }, current).binding;
      writeUserConfig({ ...current, defaultProvider: id });
      selected = { binding, provider: id }; host.providers = descriptors(current);
      return structuredClone(binding);
    },
    mergeProviders: (name, members) => {
      const current = readUserConfig();
      const model = current.providerGroups?.[name]?.model ?? current.providers[members[0] ?? '']?.model;
      const next = validateUserConfig({ ...current, providerGroups: { ...current.providerGroups, [name]: { providers: members, ...(model ? { model } : {}) } } });
      writeUserConfig(next); host.providers = descriptors(next);
    },
  };
  return host;
}
