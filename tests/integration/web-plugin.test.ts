import { describe, it, expect } from 'vitest';
import { WebIntegrationPlugin } from '../../src/integrations/web-plugin.js';
import { createRuntime } from '../../src/factory.js';
import type { ModelBinding, Provider } from '../../src/core/types.js';

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

describe('WebIntegrationPlugin', () => {
  it('initializes and exposes API and CLI interface', async () => {
    const plugin = new WebIntegrationPlugin();

    expect(plugin.name).toBe('web');
    expect(plugin.version).toBe('0.1.0');

    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const web = registry.integration('web');
    expect(web.api).toBeDefined();
    expect(web.cli).toBeDefined();
    expect(web.api!.start).toBeTypeOf('function');
    expect(web.api!.stop).toBeTypeOf('function');
  });

  it('exposes 1 CLI command', async () => {
    const plugin = new WebIntegrationPlugin();
    const iface = plugin.getInterface();

    expect(iface.cli).toHaveLength(1);
    const names = iface.cli?.map(cmd => cmd.name);
    expect(names).toEqual(['serve']);
  });

  it('throws when start is called without Application', async () => {
    const plugin = new WebIntegrationPlugin();
    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const api = registry.integration('web').api as {
      start: (options: unknown) => Promise<unknown>;
    };

    await expect(api.start({ workspace: '.' })).rejects.toThrow(
      'WebIntegrationPlugin.start requires an Application instance'
    );
  });
});
