import { describe, it, expect } from 'vitest';
import { TuiIntegrationPlugin } from '../../src/integrations/tui-plugin.js';
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

describe('TuiIntegrationPlugin', () => {
  it('initializes and exposes API and CLI interface', async () => {
    const plugin = new TuiIntegrationPlugin();

    expect(plugin.name).toBe('tui');
    expect(plugin.version).toBe('0.1.0');

    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const tui = registry.integration('tui');
    expect(tui.api).toBeDefined();
    expect(tui.cli).toBeDefined();
    expect(tui.api!.start).toBeTypeOf('function');
  });

  it('exposes 1 CLI command', async () => {
    const plugin = new TuiIntegrationPlugin();
    const iface = plugin.getInterface();

    expect(iface.cli).toHaveLength(1);
    const names = iface.cli?.map(cmd => cmd.name);
    expect(names).toEqual(['chat']);
  });
});
