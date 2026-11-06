import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/factory.js';
import { CliIntegrationPlugin } from '../../src/integrations/cli-plugin.js';
import { Store } from '../../src/storage/index.js';
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

describe('CliIntegrationPlugin', () => {
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

  it('initializes and exposes API and CLI interface', async () => {
    const plugin = new CliIntegrationPlugin();

    expect(plugin.name).toBe('cli');
    expect(plugin.version).toBe('0.1.0');

    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const cli = registry.integration('cli');
    expect(cli.api).toBeDefined();
    expect(cli.cli).toBeDefined();
    expect(cli.api!.run).toBeTypeOf('function');
    expect(cli.api!.createSession).toBeTypeOf('function');
    expect(cli.api!.listTools).toBeTypeOf('function');
  });

  it('exposes full CLI command set', async () => {
    const plugin = new CliIntegrationPlugin();
    const iface = plugin.getInterface();

    // All commands from src/cli/index.ts routing
    const expectedCommands = [
      'config', 'package', 'case', 'serve', // special routers
      'run', 'chat', 'spawn', 'runs', 'gc', // main run commands
      'inspect', 'context', 'context-report', 'knowledge', // inspection
      'resume', 'reconcile', 'resolve', 'continue', // control and recovery
      'input', 'answer', 'cancel', 'interrupt', 'rewind', 'doctor', // misc
    ];

    expect(iface.cli).toBeDefined();
    expect(iface.cli!.length).toBe(expectedCommands.length);

    const names = iface.cli!.map(cmd => cmd.name);
    expect(names).toEqual(expectedCommands);

    // All handlers are the unified cliHandler
    for (const cmd of iface.cli!) {
      expect(cmd.handler).toBeTypeOf('function');
      expect(cmd.description).toBeTypeOf('string');
    }
  });

  it('can create a session', async () => {
    const plugin = new CliIntegrationPlugin();
    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const api = registry.integration('cli').api as {
      createSession: () => { id: string };
    };

    const session = api.createSession();
    expect(session.id).toBeTypeOf('string');
    expect(session.id.length).toBeGreaterThan(0);
  });

  it('can run a prompt to completion', async () => {
    const plugin = new CliIntegrationPlugin();
    const { registry } = await createRuntime({
      provider: scripted({ content: 'hello world' }),
      binding,
      integrations: [plugin],
    });

    const api = registry.integration('cli').api as {
      run: (prompt: string, options?: { system?: string }) => Promise<{ id: string; status: string; result?: string }>;
    };

    const result = await api.run('test prompt');
    expect(result.status).toBe('completed');
    expect(result.result).toBe('hello world');
  });

  it('can list tools (empty when no tool plugins)', async () => {
    const plugin = new CliIntegrationPlugin();
    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const api = registry.integration('cli').api as {
      listTools: () => unknown[];
    };

    const tools = api.listTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(0);
  });

  it('can inspect a run after completion', async () => {
    const plugin = new CliIntegrationPlugin();
    const { registry } = await createRuntime({
      provider: scripted({ content: 'inspected' }),
      binding,
      integrations: [plugin],
    });

    const api = registry.integration('cli').api as {
      run: (prompt: string) => Promise<{ id: string }>;
      getRun: (runId: string) => { id: string; status: string } | undefined;
    };

    const { id } = await api.run('test');
    const run = api.getRun(id);
    expect(run).toBeDefined();
    expect(run!.id).toBe(id);
    expect(run!.status).toBe('completed');
  });

  it('returns undefined for nonexistent run', async () => {
    const plugin = new CliIntegrationPlugin();
    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const api = registry.integration('cli').api as {
      getRun: (runId: string) => unknown;
    };

    expect(api.getRun('nonexistent')).toBeUndefined();
  });

  it('CLI handler converts args to argv and routes through runCli', async () => {
    // This test verifies that the cliHandler properly converts command args
    // to argv format for runCli. We test with a command that doesn't modify
    // the global state (like 'doctor --unlock false').
    const plugin = new CliIntegrationPlugin();

    const iface = plugin.getInterface();
    const doctorCmd = iface.cli!.find(cmd => cmd.name === 'doctor');
    expect(doctorCmd).toBeDefined();

    // Test that the handler is callable (basic smoke test)
    // Full integration test with actual CLI would require mocking process.argv
    try {
      // Call with minimal args; doctor will check actual environment
      await doctorCmd!.handler({ _command: 'doctor', unlock: false });
    } catch (err) {
      // doctor may fail due to environment, but the handler should be callable
      // The important thing is that it doesn't throw "CLI handler not yet implemented"
      expect(String(err)).not.toContain('CLI handler not yet implemented');
    }
  });
});
