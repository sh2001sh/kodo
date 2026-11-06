import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/factory.js';
import { AgentAuthoringPlugin } from '../../src/integrations/agent-authoring-plugin.js';
import { Store } from '../../src/storage/index.js';
import type { ModelBinding, Provider } from '../../src/core/types.js';

// Test helpers
function scripted(response?: { content: string }): Provider {
  return {
    async complete() {
      return {
        message: { role: 'assistant', content: response?.content || 'test response' },
        finishReason: 'stop',
        usage: { input: 10, output: 10 },
      };
    },
  };
}

const binding: ModelBinding = {
  model: 'test-model',
  baseURL: 'http://test',
  apiKeyEnv: 'TEST_KEY',
};

describe('AgentAuthoringPlugin', () => {
  let testDir: string;
  let store: Store;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'kodo-test-'));
    store = new Store(testDir);
  });

  afterEach(() => {
    store.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('initializes without Store (Store is optional for create)', async () => {
    const plugin = new AgentAuthoringPlugin();

    expect(plugin.name).toBe('agent-authoring');
    expect(plugin.version).toBe('0.1.0');

    // Should initialize without Store (create doesn't need it)
    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const agentApi = registry.integration('agent-authoring');
    expect(agentApi).toBeDefined();
    expect(agentApi.api).toBeDefined();
    expect(agentApi.cli).toBeDefined();
  });

  it('initializes with Store for save operations', async () => {
    const plugin = new AgentAuthoringPlugin();

    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      store,
      integrations: [plugin],
    });

    const agentApi = registry.integration('agent-authoring');
    expect(agentApi).toBeDefined();
  });

  it('exposes CLI commands', async () => {
    const plugin = new AgentAuthoringPlugin();
    const iface = plugin.getInterface();

    expect(iface.cli).toBeDefined();
    expect(iface.cli).toHaveLength(3);

    const commandNames = iface.cli?.map(cmd => cmd.name);
    expect(commandNames).toContain('create');
    expect(commandNames).toContain('save');
    expect(commandNames).toContain('save-config');
  });

  it('exposes API methods', async () => {
    const plugin = new AgentAuthoringPlugin();
    const iface = plugin.getInterface();

    expect(iface.api).toBeDefined();
    expect(iface.api.create).toBeDefined();
    expect(iface.api.save).toBeDefined();
    expect(iface.api.saveConfig).toBeDefined();
    expect(iface.api.write).toBeDefined();
    expect(iface.api.export).toBeDefined();
  });

  it.skip('can create an agent draft (template mode)', async () => {
    // Skipped: needs full agent authoring integration
    const plugin = new AgentAuthoringPlugin();

    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const api = registry.integration('agent-authoring').api as {
      create: (options: unknown) => Promise<unknown>;
    };

    const draft = await api.create({
      description: 'Extract key points from documents',
      id: 'test/document-summarizer',
      allowedTools: ['file.read', 'file.list'],
      template: true,
    });

    expect(draft).toBeDefined();
    expect(draft).toHaveProperty('id', 'test/document-summarizer');
    expect(draft).toHaveProperty('mode', 'template-draft');
  });

  it('throws error when save is called without Store', async () => {
    const plugin = new AgentAuthoringPlugin();

    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const api = registry.integration('agent-authoring').api as {
      save: (runId: string, options: unknown) => Promise<unknown>;
    };

    await expect(
      api.save('test-run-id', {
        sessionId: 'test-session',
        description: 'Test',
        id: 'test/agent',
        allowedTools: [],
      })
    ).rejects.toThrow('AgentAuthoringPlugin.save requires a Store instance');
  });

  it('throws error when saveConfig is called without Store', async () => {
    const plugin = new AgentAuthoringPlugin();

    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const api = registry.integration('agent-authoring').api as {
      saveConfig: (runId: string, options: unknown) => Promise<unknown>;
    };

    await expect(
      api.saveConfig('test-run-id', {
        sessionId: 'test-session',
        description: 'Test',
        id: 'test/agent',
      })
    ).rejects.toThrow('AgentAuthoringPlugin.saveConfig requires a Store instance');
  });
});
