import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { PackageRegistry } from '../src/packages/registry.js';
import { TuiController } from '../src/tui/controller.js';
import { auxiliaryCommands, mainCommands, parseCommand } from '../src/tui/commands.js';
import type { TuiOptions } from '../src/tui/types.js';
import type { ModelBinding, Provider } from '../src/runtime/types.js';
import { answer, binding, fixture, scripted } from './helpers.js';

type ModelConfig = NonNullable<TuiOptions['modelConfig']>;
type Models = Awaited<ReturnType<ModelConfig['listModels']>>;
const controllers: TuiController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.close(); });
const flush = async () => await new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(extra: Partial<ModelConfig> = {}, provider: Provider = scripted(answer())) {
  const env = fixture(provider);
  const config: ModelConfig = {
    path: path.join(env.root, '.kodo', 'config.json'), provider: 'alpha',
    providers: [{ id: 'alpha', model: binding.model }, { id: 'beta', model: 'beta-model' }, { id: 'empty' }, { id: 'pool', model: 'shared-model', members: ['alpha', 'beta'] }],
    listModels: vi.fn(async () => [{ id: 'advertised-model' }]),
    select: vi.fn(async (_provider, model) => ({ ...binding, model })),
    selectProvider: vi.fn(async id => ({ ...binding, model: config.providers.find(item => item.id === id)?.model ?? '', baseURL: `https://${id}.example/v1` })),
    mergeProviders: vi.fn(async (id, members) => { config.providers = [...config.providers, { id, members }]; }),
    ...extra,
  };
  const controller = new TuiController({ app: env.app, workspace: env.root, binding, permissions: ['read', 'write'], registry: new PackageRegistry(path.join(env.root, '.packages')), restore: () => {}, modelConfig: config });
  controllers.push(controller);
  return { ...env, controller, config };
}

describe('TUI providers and merged catalogues', () => {
  it('exposes a searchable auxiliary provider page with defaults, groups and sources without model requests', async () => {
    const complete = vi.fn<Provider['complete']>(); const env = setup({}, { complete });
    expect(mainCommands).toHaveLength(12);
    expect(auxiliaryCommands).toContainEqual(expect.objectContaining({ id: 'providers', command: '/providers' }));
    await env.controller.submit('/providers');
    const panel = env.controller.snapshot().panel!;
    expect(panel.title).toBe('Providers');
    expect(panel.hint).toContain('Type to filter');
    expect(panel.items).toContainEqual(expect.objectContaining({ id: 'provider:alpha', label: 'Provider: alpha (selected)', detail: `Model: ${binding.model}` }));
    expect(panel.items).toContainEqual(expect.objectContaining({ id: 'provider:pool', label: 'Group: pool', detail: 'Model: shared-model · Sources: alpha, beta' }));
    expect(panel.items).toContainEqual(expect.objectContaining({ id: 'merge', input: '/providers merge ' }));
    expect(panel.lines.join('\n')).toContain('/providers merge shared provider-a provider-b');
    expect(env.config.selectProvider).not.toHaveBeenCalled(); expect(env.config.listModels).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    expect(env.app.runs().items).toHaveLength(1);
  });

  it('saves provider selection for new sessions and keeps current and continued runs unchanged', async () => {
    const env = setup({}, scripted(answer('first'), answer('continued'), answer('new')));
    await env.controller.submit('first'); await expect.poll(() => env.controller.snapshot().busy).toBe(false);
    const original = env.controller.snapshot().runId!;
    await env.controller.submit('/providers select beta');
    expect(env.config.selectProvider).toHaveBeenCalledExactlyOnceWith('beta');
    expect(env.controller.snapshot().model).toBe(binding.model);
    expect(env.controller.snapshot().notice).toContain('/new');
    expect(env.controller.snapshot().panel?.items).toContainEqual(expect.objectContaining({ id: 'provider:beta', label: 'Provider: beta (selected)' }));
    await env.controller.submit('continued'); await expect.poll(() => env.controller.snapshot().busy).toBe(false);
    expect(env.app.store.run(env.controller.snapshot().runId!).binding).toEqual(binding);
    await env.controller.submit('/new'); await env.controller.submit('new'); await expect.poll(() => env.controller.snapshot().busy).toBe(false);
    expect(env.app.store.run(env.controller.snapshot().runId!).binding).toMatchObject({ model: 'beta-model', baseURL: 'https://beta.example/v1' });
    expect(env.app.store.run(original).binding).toEqual(binding);
    expect(env.config.select).not.toHaveBeenCalled();
  });

  it('opens model selection for a provider with no default model instead of carrying over the previous model', async () => {
    const pending = deferred<Models>(); const env = setup({ listModels: vi.fn(() => pending.promise) });
    await env.controller.submit('/providers empty');
    expect(env.config.selectProvider).toHaveBeenCalledExactlyOnceWith('empty');
    expect(env.controller.snapshot().model).toBe('Not configured');
    expect(env.controller.snapshot().panel?.title).toBe('Models · empty');
    expect(env.controller.snapshot().panel?.lines).toContain('Loading models…');
    expect(env.controller.snapshot().notice).toContain('Choose a model first');
    expect(env.config.listModels).toHaveBeenCalledWith('empty', expect.any(AbortSignal));
    pending.resolve([{ id: 'empty-provider-model' }]); await flush();
    const row = env.controller.snapshot().panel!.items!.find(item => item.id === 'model:empty-provider-model')!;
    await env.controller.submit(row.command!);
    expect(env.config.select).toHaveBeenCalledWith('empty', 'empty-provider-model');
  });

  it('preserves the selection when saving fails and rejects unknown providers before calling the host', async () => {
    const env = setup({ selectProvider: vi.fn(async () => { throw new Error('Provider configuration is not writable.'); }) });
    await expect(env.controller.submit('/providers select missing')).rejects.toThrow('Unknown provider');
    await expect(env.controller.submit('/providers select *')).rejects.toThrow('Unknown provider');
    expect(env.config.selectProvider).not.toHaveBeenCalled();
    await expect(env.controller.submit('/providers select beta')).rejects.toThrow('not writable');
    expect(env.controller.snapshot().model).toBe(binding.model);
    await env.controller.submit('/providers');
    expect(env.controller.snapshot().panel?.items).toContainEqual(expect.objectContaining({ id: 'provider:alpha', label: 'Provider: alpha (selected)' }));
  });

  it('refreshes group descriptors after merging without changing the selected provider or model', async () => {
    const env = setup();
    await env.controller.submit('/providers merge merged beta alpha');
    expect(env.config.mergeProviders).toHaveBeenCalledExactlyOnceWith('merged', ['beta', 'alpha']);
    expect(env.config.selectProvider).not.toHaveBeenCalled(); expect(env.config.select).not.toHaveBeenCalled();
    expect(env.controller.snapshot().model).toBe(binding.model);
    expect(env.controller.snapshot().notice).toContain('Select it');
    expect(env.controller.snapshot().panel?.items).toContainEqual(expect.objectContaining({ id: 'provider:merged', detail: 'Choose a model · Sources: beta, alpha', command: '/providers select "merged"' }));
    await env.controller.submit('/model provider merged'); await flush();
    expect(env.config.listModels).toHaveBeenCalledWith('merged', expect.any(AbortSignal));
    expect(env.controller.snapshot().panel?.lines).toContain('Sources: beta, alpha');
  });

  it('shows rejected group saves without changing provider selection and validates merge command arity', async () => {
    const env = setup({ mergeProviders: vi.fn(async () => { throw new Error('A member provider is unavailable.'); }) });
    await expect(env.controller.submit('/providers merge group alpha')).rejects.toThrow('Use /providers merge');
    expect(env.config.mergeProviders).not.toHaveBeenCalled();
    await expect(env.controller.submit('/providers merge group alpha beta')).rejects.toThrow('unavailable');
    expect(env.controller.snapshot().model).toBe(binding.model);
    expect(env.config.providers.some(item => item.id === 'group')).toBe(false);
    expect(env.config.selectProvider).not.toHaveBeenCalled();
  });

  it('lists duplicate model IDs from all providers with distinct identities and selects their actual source', async () => {
    const env = setup({ listModels: vi.fn(async () => [
      { id: 'same-model', provider: 'alpha', name: 'Alpha display' },
      { id: 'same-model', provider: 'beta', name: 'Beta display' },
      { id: 'missing-source' },
    ]) });
    await env.controller.submit('/model all'); await flush();
    expect(env.config.listModels).toHaveBeenCalledWith('*', expect.any(AbortSignal));
    const models = env.controller.snapshot().panel!.items!.filter(item => item.id.startsWith('model:'));
    expect(new Set(models.map(item => item.id)).size).toBe(3);
    expect(models[0]).toMatchObject({ label: 'same-model · alpha', detail: 'Alpha display · Provider: alpha' });
    expect(models[1]).toMatchObject({ label: 'same-model · beta', detail: 'Beta display · Provider: beta' });
    expect(models[2]).toMatchObject({ disabled: true }); expect(models[2]!.command).toBeUndefined();
    expect(env.controller.snapshot().panel!.items!.some(item => item.id === 'manual')).toBe(false);
    expect(parseCommand(models[1]!.command!)).toEqual(['/model', 'select', 'beta', 'same-model']);
    await env.controller.submit(models[1]!.command!);
    expect(env.config.select).toHaveBeenCalledExactlyOnceWith('beta', 'same-model');
    await expect(env.controller.submit('/model select * same-model')).rejects.toThrow('Unknown provider');
    expect(env.config.select).toHaveBeenCalledTimes(1);
  });

  it('shows group model sources and selects the group while preserving the exact model ID', async () => {
    const model = 'vendor/model "v2"\\';
    const env = setup({ listModels: vi.fn(async () => [{ id: model, provider: 'pool', sources: ['alpha', 'beta'] }]) });
    await env.controller.submit('/model provider pool'); await flush();
    const row = env.controller.snapshot().panel!.items!.find(item => item.id === `model:${model}`)!;
    expect(row.detail).toBe('Sources: alpha, beta');
    expect(parseCommand(row.command!)).toEqual(['/model', 'select', 'pool', model]);
    await env.controller.submit(row.command!);
    expect(env.config.select).toHaveBeenCalledWith('pool', model);
    await env.controller.submit('/settings');
    expect(env.controller.snapshot().panel?.lines).toContain('Provider: pool (group)');
    expect(env.controller.snapshot().panel!.lines.length).toBeLessThanOrEqual(8);
  });

  it('supports older hosts with no provider-selection or merge callback', async () => {
    const env = setup({ selectProvider: undefined, mergeProviders: undefined });
    await env.controller.submit('/providers select beta'); await flush();
    expect(env.controller.snapshot().model).toBe(binding.model);
    expect(env.config.select).not.toHaveBeenCalled();
    expect(env.config.listModels).toHaveBeenCalledWith('beta', expect.any(AbortSignal));
    await expect(env.controller.submit('/providers merge merged alpha beta')).rejects.toThrow('does not support provider groups');
  });

  it('cancels aggregate metadata requests on provider navigation and ignores late failures', async () => {
    const pending = deferred<Models>(); let signal!: AbortSignal;
    const env = setup({ listModels: vi.fn((_provider, abort) => { signal = abort; return pending.promise; }) });
    await env.controller.submit('/model all');
    expect(env.controller.snapshot().busy).toBe(false);
    await env.controller.submit('/providers'); expect(signal.aborted).toBe(true);
    pending.reject(new Error('Stale metadata failure')); await flush();
    expect(env.controller.snapshot().panel?.title).toBe('Providers'); expect(env.controller.snapshot().notice).toBeUndefined();
    expect(env.config.selectProvider).not.toHaveBeenCalled();
  });

  it('cancels aggregate loading on exit and ignores a late successful response', async () => {
    const pending = deferred<Models>(); let signal!: AbortSignal;
    const env = setup({ listModels: vi.fn((_provider, abort) => { signal = abort; return pending.promise; }) });
    await env.controller.submit('/model all'); await env.controller.quit();
    expect(signal.aborted).toBe(true); expect(env.controller.snapshot().quitting).toBe(true);
    pending.resolve([{ id: 'late-model', provider: 'beta' }]); await flush();
    expect(env.controller.snapshot().panel).toBeUndefined(); expect(env.config.select).not.toHaveBeenCalled();
  });

  it('keeps unified-list failures visible with provider navigation available', async () => {
    const env = setup({ listModels: vi.fn(async () => { throw new Error('Every provider is unavailable.'); }) });
    await env.controller.submit('/model all'); await flush();
    expect(env.controller.snapshot().panel?.lines.join('\n')).toContain('Every provider is unavailable');
    expect(env.controller.snapshot().panel?.items).toContainEqual(expect.objectContaining({ id: 'providers', command: '/providers' }));
    expect(env.config.select).not.toHaveBeenCalled();
  });

  it('shows partial provider failures alongside usable models and clears warnings after a successful refresh', async () => {
    const env = setup();
    env.config.listModels = vi.fn(async () => {
      env.config.lastModelWarnings = ['beta: model list unavailable'];
      return [{ id: 'available-model', provider: 'alpha' }];
    });
    await env.controller.submit('/model all'); await flush();
    expect(env.controller.snapshot().panel?.lines).toContain('Warning: beta: model list unavailable');
    expect(env.controller.snapshot().panel?.items).toContainEqual(expect.objectContaining({ label: 'available-model · alpha', command: '/model select "alpha" "available-model"' }));
    env.config.listModels = vi.fn(async () => { env.config.lastModelWarnings = []; return [{ id: 'recovered-model', sources: ['alpha', 'beta'] }]; });
    await env.controller.submit('/model provider pool'); await flush();
    expect(env.controller.snapshot().panel?.lines.some(line => line.startsWith('Warning:'))).toBe(false);
    expect(env.controller.snapshot().panel?.items).toContainEqual(expect.objectContaining({ label: 'recovered-model', detail: 'Sources: alpha, beta' }));
  });

  it('renders a child provider change as one notice without changing the main model or running evaluation prompts', async () => {
    const complete = vi.fn<Provider['complete']>().mockResolvedValue(answer('Main reply'));
    const env = setup({}, { complete });
    await env.controller.submit(`/resume ${env.runId}`);
    const parent = env.app.store.run(env.runId); const childBinding: ModelBinding = { ...binding, model: 'child-model' };
    env.app.store.putRun({ ...parent, id: 'child-route', parentId: parent.id, status: 'completed', binding: childBinding });
    env.app.store.event('child-route', 'model.provider_changed', { from: 'alpha', to: 'beta', model: 'child-model', reason: 'Primary provider unavailable', costChange: 'unknown' });
    const notices = env.controller.snapshot().entries.filter(entry => entry.title === 'Provider changed');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('alpha → beta'); expect(notices[0]!.text).toContain('child-model'); expect(notices[0]!.text).toContain('Cost change unknown');
    expect(env.controller.snapshot().model).toBe(binding.model); expect(env.app.store.run(parent.id).binding).toEqual(binding);
    expect(complete).not.toHaveBeenCalled(); expect(env.config.select).not.toHaveBeenCalled(); expect(env.config.selectProvider).not.toHaveBeenCalled();
    env.app.store.updateRun(parent.id, { status: 'completed' });
    await env.controller.submit('/new'); await env.controller.submit('Main task'); await expect.poll(() => env.controller.snapshot().busy).toBe(false);
    expect(complete).toHaveBeenCalledOnce(); expect(env.app.store.run(env.controller.snapshot().runId!).binding.model).toBe(binding.model);
  });
});
