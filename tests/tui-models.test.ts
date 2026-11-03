import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { PackageRegistry } from '../src/packages/registry.js';
import { TuiController } from '../src/tui/controller.js';
import { parseCommand, quoteArgument } from '../src/tui/commands.js';
import type { TuiOptions } from '../src/tui/types.js';
import type { Provider } from '../src/runtime/types.js';
import { answer, binding, fixture, scripted } from './helpers.js';

type Models = { id: string; name?: string }[];
type ModelConfig = NonNullable<TuiOptions['modelConfig']>;
const controllers: TuiController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.close(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => await new Promise<void>(resolve => setImmediate(resolve));
function setup(extra: Partial<ModelConfig> = {}, provider: Provider = scripted(answer())) {
  const env = fixture(provider);
  const config: ModelConfig = {
    path: path.join(env.root, '.kodo', 'config.json'), provider: 'first',
    providers: [{ id: 'first', model: binding.model }, { id: 'second', model: 'second-default' }],
    listModels: vi.fn(async () => [{ id: 'advertised-model', name: 'Advertised model' }]),
    select: vi.fn(async (_provider, model) => ({ ...binding, model })), ...extra,
  };
  const controller = new TuiController({ app: env.app, workspace: env.root, binding, permissions: ['read', 'write'], registry: new PackageRegistry(path.join(env.root, '.packages')), restore: () => {}, modelConfig: config });
  controllers.push(controller);
  return { ...env, controller, config };
}

describe('TUI provider and model selection', () => {
  it('fetches selectable metadata without generating or creating a run, and does not block submit', async () => {
    const pending = deferred<Models>();
    const complete = vi.fn<Provider['complete']>();
    const env = setup({ listModels: vi.fn(() => pending.promise) }, { complete });
    await env.controller.submit('/model');
    expect(env.controller.snapshot().panel?.lines).toContain('Loading models…');
    expect(env.controller.snapshot().busy).toBe(false);
    expect(env.config.listModels).toHaveBeenCalledWith('first', expect.any(AbortSignal));
    expect(env.config.select).not.toHaveBeenCalled();
    pending.resolve([{ id: 'actual/model-v2', name: 'Friendly display name' }]); await flush();
    expect(env.controller.snapshot().panel?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'model:actual/model-v2', label: 'actual/model-v2', detail: 'Friendly display name', command: '/model select "first" "actual/model-v2"' }),
      expect.objectContaining({ id: 'provider:second', command: '/model provider "second"' }),
    ]));
    expect(complete).not.toHaveBeenCalled();
    expect(env.app.runs().items).toHaveLength(1);
  });

  it('browses another provider without changing the selected connection and persists the chosen model', async () => {
    const env = setup({ select: vi.fn(async (_provider, model) => ({ ...binding, model, baseURL: 'http://localhost:1234/v1' })) });
    await env.controller.submit('/model provider second'); await flush();
    expect(env.config.listModels).toHaveBeenCalledWith('second', expect.any(AbortSignal));
    expect(env.controller.snapshot().model).toBe(binding.model);
    expect(env.config.select).not.toHaveBeenCalled();
    const choice = env.controller.snapshot().panel?.items?.find(item => item.id === 'model:advertised-model');
    await env.controller.submit(choice!.command!);
    expect(env.config.select).toHaveBeenCalledExactlyOnceWith('second', 'advertised-model');
    expect(env.controller.snapshot().model).toBe('advertised-model');
    expect(env.controller.snapshot().notice).toContain('/new');
    await env.controller.submit('/settings');
    expect(env.controller.snapshot().panel?.lines).toContain('Provider: second');
    expect(env.controller.snapshot().panel?.lines).toContain(`User config: ${env.config.path}`);
  });

  it('keeps continued runs on their original binding and applies the selection to the next new session', async () => {
    const env = setup({}, scripted(answer('first'), answer('follow-up'), answer('new session')));
    await env.controller.submit('first'); await expect.poll(() => env.controller.snapshot().busy).toBe(false);
    const first = env.controller.snapshot().runId!;
    await env.controller.submit('/model select second chosen-model');
    expect(env.controller.snapshot().model).toBe(binding.model);
    expect(env.controller.snapshot().panel?.lines.join('\n')).toContain('fixed; use /new');
    await env.controller.submit('follow-up'); await expect.poll(() => env.controller.snapshot().busy).toBe(false);
    const continued = env.app.store.run(env.controller.snapshot().runId!);
    expect(continued.continuationOf).toBe(first);
    expect(continued.binding.model).toBe(binding.model);
    await env.controller.submit('/new'); await env.controller.submit('new session');
    await expect.poll(() => env.controller.snapshot().busy).toBe(false);
    expect(env.app.store.run(first).binding.model).toBe(binding.model);
    expect(env.app.store.run(env.controller.snapshot().runId!).binding.model).toBe('chosen-model');
  });

  it('preserves the selected binding and provider when configuration persistence fails', async () => {
    const env = setup({ select: vi.fn(async () => { throw new Error('Configuration is not writable.'); }) });
    await expect(env.controller.submit('/model select second unsaved-model')).rejects.toThrow('not writable');
    expect(env.controller.snapshot().model).toBe(binding.model);
    await env.controller.submit('/settings');
    expect(env.controller.snapshot().panel?.lines).toContain('Provider: first');
  });

  it('validates providers before querying or saving and preserves legacy direct model entry', async () => {
    const env = setup();
    await expect(env.controller.submit('/model provider missing')).rejects.toThrow('Unknown provider');
    await expect(env.controller.submit('/model select missing model')).rejects.toThrow('Unknown provider');
    expect(env.config.listModels).not.toHaveBeenCalled(); expect(env.config.select).not.toHaveBeenCalled();
    await env.controller.submit('/model manual-model');
    expect(env.config.select).toHaveBeenCalledExactlyOnceWith('first', 'manual-model');
    expect(env.controller.snapshot().model).toBe('manual-model');
  });

  it('preserves exact model IDs including spaces and quotes, and accepts IDs of up to 512 characters', async () => {
    const model = 'vendor/model \\"version 2"\\';
    const env = setup({ listModels: vi.fn(async () => [{ id: model }]) });
    await env.controller.submit('/model'); await flush();
    await env.controller.submit(env.controller.snapshot().panel!.items!.find(item => item.id === `model:${model}`)!.command!);
    expect(env.config.select).toHaveBeenLastCalledWith('first', model);
    await env.controller.submit(`/model select first ${quoteArgument('x'.repeat(512))}`);
    expect(env.controller.snapshot().model).toBe('x'.repeat(512));
    await expect(env.controller.submit(`/model select first ${quoteArgument('x'.repeat(513))}`)).rejects.toThrow('Invalid model name');
    await expect(env.controller.submit('/model select first "bad\nmodel"')).rejects.toThrow('Invalid model name');
    expect(env.config.select).toHaveBeenCalledTimes(2);
    for (const value of ['C:\\folder with spaces\\', '\\\\server\\path', 'slashes\\\\"quote"', '$(literal) `literal`']) {
      expect(parseCommand(`/model ${quoteArgument(value)}`)).toEqual(['/model', value]);
    }
  });

  it.each(['empty', 'failure'])('keeps provider choices and manual entry available after an %s model list', async outcome => {
    const env = setup({ listModels: vi.fn(async () => { if (outcome === 'failure') throw new Error('Connection failed.'); return []; }) });
    await env.controller.submit('/model provider second'); await flush();
    const panel = env.controller.snapshot().panel!;
    expect(panel.lines.join('\n')).toContain(outcome === 'empty' ? 'No models returned' : 'Connection failed.');
    expect(panel.items?.filter(item => item.id.startsWith('model:'))).toHaveLength(0);
    expect(panel.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'provider:first' }),
      expect.objectContaining({ id: 'manual', input: '/model select "second" ' }),
    ]));
    await env.controller.submit(`${panel.items!.find(item => item.id === 'manual')!.input!}manual-model`);
    expect(env.config.select).toHaveBeenCalledWith('second', 'manual-model');
  });

  it('supports a current connection without a configured provider', async () => {
    const env = setup({ provider: undefined, providers: [] });
    await env.controller.submit('/model'); await flush();
    expect(env.config.listModels).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    await env.controller.submit(env.controller.snapshot().panel!.items!.find(item => item.id === 'model:advertised-model')!.command!);
    expect(env.config.select).toHaveBeenCalledWith(undefined, 'advertised-model');
  });

  it.each(['dismiss', 'help', 'permissions', 'task', 'interrupt', 'quit', 'close'])('aborts metadata loading on %s and ignores a late successful response', async action => {
    const pending = deferred<Models>(); let signal!: AbortSignal;
    const env = setup({ listModels: vi.fn((_provider, requestSignal) => { signal = requestSignal; return pending.promise; }) });
    await env.controller.submit('/model');
    if (action === 'dismiss') env.controller.dismissPanel();
    else if (action === 'interrupt') await env.controller.interrupt();
    else if (action === 'quit') await env.controller.quit();
    else if (action === 'close') await env.controller.close();
    else await env.controller.submit(action === 'task' ? 'ordinary task' : `/${action}`);
    expect(signal.aborted).toBe(true);
    pending.resolve([{ id: 'stale-model' }]); await flush();
    expect(env.controller.snapshot().panel?.items?.some(item => item.id === 'model:stale-model')).not.toBe(true);
    expect(env.controller.snapshot().panel?.lines ?? []).not.toContain('Loading models…');
    if (action === 'task') await expect.poll(() => env.controller.snapshot().busy).toBe(false);
    if (action === 'quit') expect(env.controller.snapshot().quitting).toBe(true);
  });

  it('ignores late failures after navigation and replaces earlier provider requests', async () => {
    const first = deferred<Models>(); const second = deferred<Models>();
    const requests: AbortSignal[] = [];
    const env = setup({ listModels: vi.fn((provider, signal) => { requests.push(signal); return provider === 'first' ? first.promise : second.promise; }) });
    await env.controller.submit('/model');
    await env.controller.submit('/model provider second');
    expect(requests[0]!.aborted).toBe(true); expect(requests[1]!.aborted).toBe(false);
    first.reject(new Error('Stale failure.')); await flush();
    expect(env.controller.snapshot().panel?.title).toContain('second');
    expect(env.controller.snapshot().panel?.lines).toContain('Loading models…');
    second.resolve([{ id: 'fresh-model' }]); await flush();
    expect(env.controller.snapshot().panel?.items?.some(item => item.id === 'model:fresh-model')).toBe(true);
    const late = deferred<Models>();
    env.config.listModels = vi.fn(() => late.promise);
    await env.controller.submit('/model'); await env.controller.submit('/settings');
    late.reject(new Error('Another stale failure.')); await flush();
    expect(env.controller.snapshot().panel?.title).toBe('Host settings');
    expect(env.controller.snapshot().notice).toBeUndefined();
  });
});
