import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { listProviderModels } from '../providers/model-list.js';
import type { ProviderModel } from '../providers/model-list.js';
import { KodoError } from '../runtime/types.js';
import type { ModelProtocol } from '../runtime/types.js';
import { terminalText } from './terminal.js';
import { ensureUserConfig, readUserConfig, userConfigPath, validateUserConfig, writeUserConfig } from './user-config.js';
import type { ModelRole, ProviderConfig, UserConfig } from './user-config.js';

const help = `kodo config                         (interactive provider setup)
kodo config init                    (create ~/.kodo/config.json if missing)
kodo config path
kodo config list | show              (API keys are redacted)
kodo config add <name> --base-url URL [--protocol chat-completions|responses|anthropic]
                [--api-key-env NAME] [--model NAME]
kodo config use <name>
kodo config remove <name>
kodo config merge <group> <provider1> <provider2> ... [--model ID]
kodo config unmerge <group>
kodo config model add <alias> --provider ID [--model ID] [--description TEXT]
kodo config model remove <alias>
kodo config role <fast|standard|strong> <alias|inherit>
Use the interactive setup or edit config.json to save a local API key.
Interactive setup fetches /models so you can select a default model.
Use /model in the TUI to change models. KODO_HOME overrides ~/.kodo.
Existing providers keep settings that are not explicitly supplied.`;

interface ConfigInput extends Readable { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown }
interface ConfigOutput extends Writable { isTTY?: boolean }
export interface ConfigCommandStreams { stdin?: ConfigInput; stdout?: ConfigOutput }

const owns = (config: UserConfig, name: string): boolean => Object.hasOwn(config.providers, name);
const redacted = (config: UserConfig): UserConfig => ({
  ...config,
  providers: Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, {
    ...provider, ...(provider.apiKey === undefined ? {} : { apiKey: '[REDACTED]' }),
  }])),
});

/** Run the provider wizard before the first interactive TUI session. */
export async function ensureInteractiveProviderConfig(streams: ConfigCommandStreams = {}): Promise<UserConfig> {
  const existing = readUserConfig();
  if (Object.keys(existing.providers).length) return existing;
  const input = streams.stdin ?? process.stdin;
  const output = streams.stdout ?? process.stdout;
  if (!input.isTTY || !output.isTTY) return existing;
  await configCommand([], streams);
  return readUserConfig();
}

/** Provider management never opens a runtime store or generates a model response. */
export async function configCommand(args: string[], streams: ConfigCommandStreams = {}): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
      'base-url': { type: 'string' }, protocol: { type: 'string' }, 'api-key-env': { type: 'string' }, model: { type: 'string' },
      provider: { type: 'string' }, description: { type: 'string' },
    } });
  } catch { throw new KodoError('ARGUMENTS', 'Invalid config options; use kodo config --help.'); }
  const { values, positionals } = parsed;
  const input = streams.stdin ?? process.stdin;
  const output = streams.stdout ?? process.stdout;
  const print = (value: string): void => { output.write(`${value}\n`); };
  if (values.help) { print(help); return; }
  const [command, name] = positionals;
  const mutations = ['base-url', 'protocol', 'api-key-env', 'model', 'provider', 'description'] as const;
  const allowedOptions = command === 'add' ? ['base-url', 'protocol', 'api-key-env', 'model']
    : command === 'merge' ? ['model'] : command === 'model' && name === 'add' ? ['provider', 'model', 'description'] : [];
  if (mutations.some(key => values[key] !== undefined && !allowedOptions.includes(key))) throw new KodoError('ARGUMENTS', 'Options do not apply to this config command; use kodo config --help.');
  if (!command) {
    if (input.isTTY && output.isTTY && !values.json) await configureInteractively(input, output);
    else {
      const config = redacted(readUserConfig());
      if (!values.json) print(`${help}\n\nConfig: ${terminalText(userConfigPath())}`);
      print(JSON.stringify(config, null, 2));
    }
    return;
  }
  if (!['init', 'path', 'list', 'show', 'add', 'use', 'remove', 'merge', 'unmerge', 'model', 'role'].includes(command)) throw new KodoError('ARGUMENTS', 'Unknown config command; use kodo config --help.');
  const count = command === 'merge' ? positionals.length >= 4 && positionals.length <= 10
    : command === 'model' ? ['add', 'remove'].includes(name ?? '') && positionals.length === 3
      : positionals.length === (command === 'role' ? 3 : ['add', 'use', 'remove', 'unmerge'].includes(command) ? 2 : 1);
  if (!count) throw new KodoError('ARGUMENTS', 'Invalid config command arguments; use kodo config --help.');
  if (command === 'path') { print(terminalText(userConfigPath())); return; }
  if (command === 'init') {
    ensureUserConfig();
    print(values.json ? JSON.stringify({ path: userConfigPath() }) : `Config ready: ${terminalText(userConfigPath())}`);
    return;
  }
  const config = readUserConfig();
  if (command === 'list' || command === 'show') { print(JSON.stringify(redacted(config), null, 2)); return; }
  if (command === 'add') {
    const previous = owns(config, name!) ? config.providers[name!] : undefined;
    const baseURL = values['base-url'] ?? previous?.baseURL;
    if (!baseURL) throw new KodoError('ARGUMENTS', 'A new provider requires --base-url.');
    const provider: ProviderConfig = {
      ...previous, baseURL,
      ...(values.protocol === undefined ? {} : { protocol: values.protocol as ModelProtocol }),
      ...(values.model === undefined ? {} : { model: values.model }),
      ...(values['api-key-env'] === undefined ? {} : { apiKeyEnv: values['api-key-env'] }),
    };
    if (values['api-key-env'] !== undefined) delete provider.apiKey;
    config.providers = { ...config.providers, [name!]: provider };
    config.defaultProvider ??= name;
  } else if (command === 'merge') {
    const members = positionals.slice(2);
    const previous = config.providerGroups && Object.hasOwn(config.providerGroups, name!) ? config.providerGroups[name!] : undefined;
    const model = values.model ?? previous?.model ?? (owns(config, members[0]!) ? config.providers[members[0]!]!.model : undefined);
    config.providerGroups = { ...config.providerGroups, [name!]: { providers: members, ...(model === undefined ? {} : { model }) } };
  } else if (command === 'model') {
    const alias = positionals[2]!;
    if (name === 'add') {
      const provider = values.provider;
      if (!provider || !owns(config, provider) && !(config.providerGroups && Object.hasOwn(config.providerGroups, provider))) throw new KodoError('CONFIG_PROVIDER', 'Model aliases require --provider naming a configured provider or group.');
      const model = values.model ?? (owns(config, provider) ? config.providers[provider]!.model : config.providerGroups![provider]!.model);
      if (!model) throw new KodoError('CONFIG_MODEL', 'This provider has no default model; supply --model for the alias.');
      const description = values.description ?? (config.modelBindings && Object.hasOwn(config.modelBindings, alias) ? config.modelBindings[alias]?.description : undefined);
      config.modelBindings = { ...config.modelBindings, [alias]: { provider, model, ...(description === undefined ? {} : { description }) } };
    } else {
      if (!config.modelBindings || !Object.hasOwn(config.modelBindings, alias)) throw new KodoError('CONFIG_MODEL', 'Unknown model alias. Use kodo config list.');
      if (Object.values(config.modelRoles ?? {}).includes(alias)) throw new KodoError('CONFIG_REFERENCE', 'This model alias is assigned to a role. Set that role to inherit or another alias before removing it.');
      delete config.modelBindings[alias];
    }
  } else if (command === 'role') {
    if (!['fast', 'standard', 'strong'].includes(name!)) throw new KodoError('ARGUMENTS', 'Model role must be fast, standard or strong.');
    const alias = positionals[2]!;
    if (alias === 'inherit') {
      if (config.modelRoles) delete config.modelRoles[name as ModelRole];
    } else {
      if (!config.modelBindings || !Object.hasOwn(config.modelBindings, alias)) throw new KodoError('CONFIG_MODEL', 'Model roles require an approved model alias. Use kodo config model add first.');
      config.modelRoles = { ...config.modelRoles, [name!]: alias };
    }
  } else if (command === 'use') {
    if (!owns(config, name!) && !(config.providerGroups && Object.hasOwn(config.providerGroups, name!))) throw new KodoError('CONFIG_PROVIDER', 'Unknown provider or provider group. Use kodo config list.');
    config.defaultProvider = name;
  } else {
    if (command === 'unmerge') {
      if (!config.providerGroups || !Object.hasOwn(config.providerGroups, name!)) throw new KodoError('CONFIG_PROVIDER', 'Unknown provider group. Use kodo config list.');
    } else if (!owns(config, name!)) throw new KodoError('CONFIG_PROVIDER', 'Unknown provider. Use kodo config list.');
    if (Object.values(config.providerGroups ?? {}).some(group => group.providers.includes(name!))) throw new KodoError('CONFIG_REFERENCE', 'This provider belongs to a group. Update or unmerge the group before removing it.');
    if (Object.values(config.modelBindings ?? {}).some(binding => binding.provider === name)) throw new KodoError('CONFIG_REFERENCE', 'This provider or group has approved model aliases. Remove or update those aliases before removing it.');
    if (command === 'unmerge') delete config.providerGroups![name!];
    else {
      delete config.providers[name!];
    }
    if (config.defaultProvider === name) delete config.defaultProvider;
  }
  writeUserConfig(config);
  print(values.json ? JSON.stringify(redacted(config), null, 2) : `Configuration saved: ${terminalText(userConfigPath())}`);
}

async function configureInteractively(input: ConfigInput, output: ConfigOutput): Promise<void> {
  const config = readUserConfig();
  const controller = new AbortController();
  const cancelled = new KodoError('CANCELLED', 'Configuration cancelled; no changes were saved.');
  let muted = false;
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { if (!muted) output.write(chunk); callback(); } });
  const wasRaw = input.isRaw;
  const lines = createInterface({ input, output: sink, terminal: true, historySize: 0 });
  const interrupt = (): void => { controller.abort(cancelled); };
  lines.on('SIGINT', interrupt);
  lines.on('close', interrupt);
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const question = async (prompt: string, secret = false): Promise<string> => {
    controller.signal.throwIfAborted();
    if (secret) { output.write(prompt); muted = true; }
    try {
      return await new Promise<string>((resolve, reject) => {
        const cleanup = (): void => { controller.signal.removeEventListener('abort', abort); };
        const abort = (): void => { cleanup(); reject(controller.signal.reason); };
        controller.signal.addEventListener('abort', abort, { once: true });
        lines.question(secret ? '' : prompt, { signal: controller.signal }, answer => { cleanup(); resolve(answer.trim()); });
      });
    } finally { muted = false; if (secret) output.write('\n'); }
  };
  try {
    output.write(`Kodo provider configuration\nConfig: ${terminalText(userConfigPath())}\n`);
    const name = await question('Provider name: ');
    const previous = owns(config, name) ? config.providers[name] : undefined;
    if (previous) output.write('Editing an existing provider. Empty answers keep current values.\n');
    const protocol = await selectProtocol(previous?.protocol, question, output);
    const example = protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
    let baseURL = await question(`Base URL (example: ${example})${previous ? ` [${terminalText(previous.baseURL)}]` : ''}: `) || previous?.baseURL;
    if (!baseURL) throw new KodoError('CONFIG_PROVIDER', 'A provider requires a base URL.');
    validateUserConfig({ providers: { [name]: { baseURL, protocol } } });
    baseURL = await resolveVersionedBaseURL(baseURL, protocol, question, output);
    const provider: ProviderConfig = { ...previous, baseURL, protocol: protocol as ModelProtocol };
    // Validate the public fields before asking for credentials; never echo the credential value in a validation error.
    validateUserConfig({ providers: { [name]: { baseURL, protocol } } });
    const apiKey = await question('API key (hidden; Enter keeps the current source or uses an environment variable): ', true);
    if (apiKey) { provider.apiKey = apiKey; delete provider.apiKeyEnv; }
    else if (!previous?.apiKey) {
      provider.apiKeyEnv = await question(`API key environment variable [${previous?.apiKeyEnv ?? 'KODO_API_KEY'}]: `) || previous?.apiKeyEnv || 'KODO_API_KEY';
      delete provider.apiKey;
    }
    validateUserConfig({ providers: { [name]: provider } });
    const model = await selectProviderModel(provider, question, output, controller.signal);
    if (model) provider.model = model;
    const defaultChoice = !config.defaultProvider || config.defaultProvider === name;
    const use = await question(`Use as default provider? [${defaultChoice ? 'Y/n' : 'y/N'}]: `);
    if (use && !/^(?:y|yes|n|no)$/iu.test(use)) throw new KodoError('ARGUMENTS', 'Answer yes or no for the default provider.');
    config.providers = { ...config.providers, [name]: provider };
    if (defaultChoice ? !/^n(?:o)?$/iu.test(use) : /^y(?:es)?$/iu.test(use)) config.defaultProvider = name;
    controller.signal.throwIfAborted();
    writeUserConfig(config);
    output.write('Configuration saved. Start kodo; use /model to change models.\n');
  } finally {
    muted = false;
    lines.removeListener('SIGINT', interrupt);
    lines.removeListener('close', interrupt);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    lines.close(); sink.end();
    if (input.isTTY && input.setRawMode && input.isRaw !== wasRaw) input.setRawMode(Boolean(wasRaw));
  }
}

async function selectProtocol(
  current: ModelProtocol | undefined,
  question: (prompt: string) => Promise<string>,
  output: ConfigOutput,
): Promise<ModelProtocol> {
  const protocols: ModelProtocol[] = ['chat-completions', 'responses', 'anthropic'];
  const fallback = current ?? 'chat-completions';
  output.write('Protocols:\n  1. chat-completions\n  2. responses\n  3. anthropic\n');
  for (;;) {
    const choice = await question(`Select protocol [1-3, Enter=${fallback}]: `);
    if (!choice) return fallback;
    const selected = /^\d+$/u.test(choice) ? protocols[Number(choice) - 1] : protocols.find(protocol => protocol === choice.toLowerCase());
    if (selected) return selected;
    output.write('Choose 1, 2 or 3, or enter a protocol name.\n');
  }
}

async function resolveVersionedBaseURL(
  baseURL: string,
  protocol: ModelProtocol,
  question: (prompt: string) => Promise<string>,
  output: ConfigOutput,
): Promise<string> {
  const url = new URL(baseURL);
  const path = url.pathname.replace(/\/+$/u, '');
  const version = /\/(v\d+)$/iu.exec(path)?.[1];
  if (version) {
    url.pathname = path;
    output.write(`API version path detected: /${version}.\n`);
    return url.toString();
  }
  if (protocol === 'anthropic') {
    output.write('Anthropic base URLs do not need /v1; Kodo adds /v1 to Anthropic request paths.\n');
    return baseURL;
  }
  for (;;) {
    const choice = await question(`Base URL has no trailing /v1. Add /v1 for ${protocol}? [Y/n]: `);
    if (!choice || /^y(?:es)?$/iu.test(choice)) {
      url.pathname = `${path}/v1`.replace(/^\/+/u, '/');
      const result = url.toString();
      output.write(`Using versioned base URL: ${terminalText(result)}\n`);
      return result;
    }
    if (/^n(?:o)?$/iu.test(choice)) {
      output.write('Keeping the base URL unchanged. Kodo appends protocol endpoint paths to it.\n');
      return baseURL;
    }
    output.write('Answer yes or no.\n');
  }
}

async function selectProviderModel(
  provider: ProviderConfig,
  question: (prompt: string) => Promise<string>,
  output: ConfigOutput,
  signal: AbortSignal,
): Promise<string | undefined> {
  const temporaryEnv = provider.apiKey === undefined ? undefined : `KODO_CONFIG_MODEL_KEY_${randomUUID().replace(/-/gu, '_').toUpperCase()}`;
  const apiKeyEnv = temporaryEnv ?? provider.apiKeyEnv ?? 'KODO_API_KEY';
  try {
    if (temporaryEnv) process.env[temporaryEnv] = provider.apiKey;
    for (;;) {
      let models: ProviderModel[] = [];
      output.write('Fetching provider models (/models)...\n');
      try {
        models = await listProviderModels({ baseURL: provider.baseURL, protocol: provider.protocol, apiKeyEnv, model: provider.model ?? '' }, signal);
        output.write(models.map((model, index) => `  ${index + 1}. ${terminalText(model.id)}${model.name && model.name !== model.id ? ` (${terminalText(model.name)})` : ''}\n`).join(''));
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof KodoError)) throw error;
        output.write(`Model list unavailable: ${terminalText(error.message)}\n`);
      }
      const options = `${models.length ? `1-${models.length}, ` : ''}m=manual, r=retry, s=skip${provider.model ? ', Enter=keep current' : ''}`;
      for (;;) {
        const choice = await question(`Select model [${options}]: `);
        if (choice.toLowerCase() === 'r') break;
        if (choice.toLowerCase() === 's' || !choice && provider.model) return provider.model;
        if (choice.toLowerCase() === 'm') {
          for (;;) {
            const model = await question(`Model ID${provider.model ? ` [${terminalText(provider.model)}]` : ' (blank to skip)'}: `) || provider.model;
            if (!model) return undefined;
            try { validateUserConfig({ providers: { selected: { ...provider, model } } }); return model; }
            catch (error) {
              if (!(error instanceof KodoError)) throw error;
              output.write('Model ID must contain 1-512 characters without control characters.\n');
            }
          }
        }
        const selected = /^\d+$/u.test(choice) ? models[Number(choice) - 1] : undefined;
        if (selected) return selected.id;
        output.write('Choose a listed model number, m for manual entry, r to retry, or s to skip.\n');
      }
    }
  } finally { if (temporaryEnv) delete process.env[temporaryEnv]; }
}
