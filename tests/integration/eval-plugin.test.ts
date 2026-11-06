import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/factory.js';
import { EvalIntegrationPlugin } from '../../src/integrations/eval-plugin.js';
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

describe('EvalIntegrationPlugin', () => {
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

  it('initializes with Store and exposes eval API interface', async () => {
    const plugin = new EvalIntegrationPlugin();

    expect(plugin.name).toBe('eval');
    expect(plugin.version).toBe('0.1.0');

    // Create runtime with store
    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      store,
      integrations: [plugin],
    });

    // Verify plugin is registered
    const evalIntegration = registry.integration('eval');
    expect(evalIntegration).toBeDefined();
    expect(evalIntegration.api).toBeDefined();
    expect(evalIntegration.cli).toBeDefined();
  });

  it('throws error when initialized without Store', async () => {
    const plugin = new EvalIntegrationPlugin();

    // Should throw because Store is required
    await expect(
      createRuntime({
        provider: scripted(),
        binding,
        integrations: [plugin],
      })
    ).rejects.toThrow('EvalIntegrationPlugin requires a Store instance');
  });

  it('exposes CLI commands', async () => {
    const plugin = new EvalIntegrationPlugin();
    const iface = plugin.getInterface();

    expect(iface.cli).toBeDefined();
    expect(iface.cli).toHaveLength(6);

    const commandNames = iface.cli?.map(cmd => cmd.name);
    expect(commandNames).toContain('freeze');
    expect(commandNames).toContain('run');
    expect(commandNames).toContain('list');
    expect(commandNames).toContain('compare');
    expect(commandNames).toContain('adopt');
    expect(commandNames).toContain('rollback');
  });

  it.skip('can freeze a case definition', async () => {
    // Skipped: needs full CaseRunStore integration and case execution
    const plugin = new EvalIntegrationPlugin();

    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      store,
      integrations: [plugin],
    });

    const evalApi = registry.integration('eval').api as {
      freeze: (def: unknown) => Promise<unknown>;
    };

    const definition = {
      name: 'test-case',
      objective: 'Test objective',
      assertions: [
        {
          type: 'exit_code',
          expected: 0,
        },
      ],
    };

    const frozen = await evalApi.freeze(definition);
    expect(frozen).toBeDefined();
    expect(frozen).toHaveProperty('frozen');
  });
});
