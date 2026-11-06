import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/factory.js';
import { PluginRegistry } from '../src/plugin-registry.js';
import { RuntimeCore } from '../src/core/runtime.js';
import type { CapabilityPlugin, IntegrationPlugin, ToolPlugin } from '../src/plugins/index.js';
import type { Message } from '../src/runtime/types.js';
import { answer, binding, call, calls, scripted } from './helpers.js';

const echo = (log: string[] = []): ToolPlugin => ({
  name: 'echo-tools',
  tools: [{ name: 'echo', description: 'Echo the text', parameters: { type: 'object', properties: { text: { type: 'string' } } } }],
  initialize: () => { log.push('init echo'); },
  execute: (_name, args) => ({ echoed: (args as { text: string }).text }),
  cleanup: () => { log.push('cleanup echo'); },
});

describe('createRuntime', () => {
  it('runs a bare model loop with no plugins', async () => {
    const { runtime, shutdown } = await createRuntime({ provider: scripted(answer('hello')), binding });
    const run = await runtime.run('hi');
    expect(run).toMatchObject({ status: 'completed', result: 'hello', step: 1, usage: { input: 60, output: 20 } });
    expect(runtime.toolSpecs).toEqual([]);
    await shutdown();
  });

  it('dispatches tool calls to the owning plugin and feeds results back', async () => {
    const seen: Message[][] = [];
    const provider = scripted(calls(call('echo', { text: 'ping' }, 'c1')), async request => { seen.push(request.messages); return answer('pong'); });
    const { runtime, shutdown } = await createRuntime({ provider, binding, tools: [echo()] });
    const run = await runtime.run('say ping', { system: 'be brief' });
    expect(run.status).toBe('completed');
    expect(seen[0]!.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ echoed: 'ping' }) });
    expect(runtime.toolSpecs.map(tool => tool.name)).toEqual(['echo']);
    await shutdown();
  });

  it('turns unknown tools, bad JSON and tool errors into tool results', async () => {
    const failing: ToolPlugin = { name: 'boom', tools: [{ name: 'boom', description: '', parameters: {} }], execute: () => { throw new Error('exploded'); } };
    const results: string[] = [];
    const provider = scripted(
      calls(call('missing', {}, 'a'), { id: 'b', name: 'boom', arguments: '{nope' }, call('boom', {}, 'c')),
      async request => { results.push(...request.messages.filter(m => m.role === 'tool').map(m => m.content)); return answer(); },
    );
    const { runtime } = await createRuntime({ provider, binding, tools: [failing] });
    expect((await runtime.run('go')).status).toBe('completed');
    expect(results.map(text => (JSON.parse(text) as { error: string }).error)).toEqual([
      'TOOL_NOT_FOUND: missing', 'INVALID_ARGUMENTS: tool arguments are not valid JSON', 'INTERNAL: Error: exploded',
    ]);
  });

  it('calls capability hooks in order and lets beforeCompletion deny once', async () => {
    const events: string[] = [];
    let denied = false;
    const capability: CapabilityPlugin = {
      name: 'audit', version: '1.0.0',
      hooks: {
        beforeModelCall: (run, messages) => { events.push(`model:${run.step}`); return [...messages, { role: 'user', content: 'injected' }]; },
        afterToolResult: (_run, toolCall) => { events.push(`tool:${toolCall.name}:${toolCall.status}`); },
        beforeCompletion: () => { events.push('complete?'); if (!denied) { denied = true; return { deny: 'verify first' }; } },
      },
    };
    const requests: Message[][] = [];
    const record = (response: ReturnType<typeof answer>) => async (request: { messages: Message[] }) => { requests.push(request.messages); return response; };
    const provider = scripted(record(calls(call('echo', { text: 'x' }))), record(answer('first')), record(answer('second')));
    const { runtime } = await createRuntime({ provider, binding, capabilities: [capability], tools: [echo()] });
    const run = await runtime.run('task');
    expect(run).toMatchObject({ status: 'completed', result: 'second', step: 3 });
    expect(events).toEqual(['model:0', 'tool:echo:succeeded', 'model:1', 'complete?', 'model:2', 'complete?']);
    expect(requests[0]!.at(-1)).toEqual({ role: 'user', content: 'injected' });
    // The hook changes the request only; the transcript keeps the deny notice, not the injection.
    expect(run.messages.filter(m => m.role === 'user').map(m => m.content)).toEqual(['task', 'verify first']);
  });

  it('fails the run on provider errors and step limits, and notifies onRunFailed', async () => {
    const failures: string[] = [];
    const capability: CapabilityPlugin = { name: 'watch', version: '1', hooks: { onRunFailed: run => { failures.push(run.error!); } } };
    const broken = { async complete(): Promise<never> { throw new Error('offline'); } };
    const a = await createRuntime({ provider: broken, binding, capabilities: [capability] });
    expect((await a.runtime.run('x')).status).toBe('failed');
    const b = await createRuntime({ provider: scripted(calls(call('echo', { text: '1' })), calls(call('echo', { text: '2' }))), binding, tools: [echo()], capabilities: [capability], maxSteps: 2 });
    expect((await b.runtime.run('loop')).error).toBe('STEP_LIMIT: run exceeded 2 model rounds');
    expect(failures).toEqual(['INTERNAL: Error: offline', 'STEP_LIMIT: run exceeded 2 model rounds']);
  });

  it('cancels an in-flight run through the provider signal', async () => {
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const provider = scripted(async (_request, signal) => {
      started();
      return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    });
    const { runtime } = await createRuntime({ provider, binding });
    const run = runtime.startRun(runtime.createSession().id, 'wait');
    const pending = runtime.advance(run.id);
    expect(runtime.advance(run.id)).toBe(pending);
    await waiting;
    runtime.cancel(run.id);
    expect((await pending).status).toBe('cancelled');
  });

  it('exposes integration entry points that drive the core', async () => {
    let core: RuntimeCore | undefined;
    const integration: IntegrationPlugin = {
      name: 'embed',
      initialize: runtime => { core = runtime; },
      getInterface: () => ({ api: { ask: (prompt: string) => core!.run(prompt) } }),
    };
    const { registry } = await createRuntime({ provider: scripted(answer('42')), binding, integrations: [integration] });
    const api = registry.integration('embed').api as { ask: (prompt: string) => Promise<{ result?: string }> };
    expect((await api.ask('meaning?')).result).toBe('42');
    expect(() => registry.integration('other')).toThrow(/PLUGIN_NOT_FOUND|not initialised/);
  });
});

describe('PluginRegistry', () => {
  it('initialises capabilities, tools, integrations in order and cleans up in reverse', async () => {
    const log: string[] = [];
    const capability: CapabilityPlugin = { name: 'cap', version: '1', initialize: () => { log.push('init cap'); }, cleanup: () => { log.push('cleanup cap'); } };
    const integration: IntegrationPlugin = { name: 'int', initialize: () => { log.push('init int'); }, getInterface: () => ({}), cleanup: () => { log.push('cleanup int'); } };
    const registry = new PluginRegistry().registerIntegration(integration).registerTools(echo(log)).registerCapability(capability);
    expect(registry.listAvailable()).toEqual({ capabilities: ['cap'], tools: ['echo-tools'], integrations: ['int'] });
    await registry.initialize(new RuntimeCore(scripted(), binding));
    await registry.cleanup();
    expect(log).toEqual(['init cap', 'init echo', 'init int', 'cleanup int', 'cleanup echo', 'cleanup cap']);
  });

  it('rejects duplicate plugins, duplicate tool names and late registration', async () => {
    const registry = new PluginRegistry().registerTools(echo());
    expect(() => registry.registerTools(echo())).toThrow(/already registered/);
    await registry.initialize(new RuntimeCore(scripted(), binding));
    expect(() => registry.registerCapability({ name: 'late', version: '1' })).toThrow(/before initialisation/);
    const log: string[] = [];
    await expect(createRuntime({ provider: scripted(), binding, tools: [echo(log), { ...echo(log), name: 'copy' }] })).rejects.toThrow(/provided by both echo-tools and copy/);
    expect(log).toEqual(['init echo', 'init echo', 'cleanup echo', 'cleanup echo']);
  });

  it('rolls back already initialised plugins when one fails to initialise', async () => {
    const log: string[] = [];
    const bad: IntegrationPlugin = { name: 'bad', initialize: () => { throw new Error('no port'); }, getInterface: () => ({}) };
    await expect(createRuntime({ provider: scripted(), binding, tools: [echo(log)], integrations: [bad] })).rejects.toThrow('no port');
    expect(log).toEqual(['init echo', 'cleanup echo']);
  });
});
