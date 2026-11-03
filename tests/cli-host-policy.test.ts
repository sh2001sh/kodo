import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { cliSandboxPolicy, cliToolPolicy, cliCompactionPolicy, cliAssemblyPolicy, readHostState, writeHostState } from '../src/cli/host-state.js';
import { temp } from './helpers.js';

describe('CLI trusted host policies', () => {
  it('round-trips the interactive approval marker and rejects non-boolean values', () => {
    const root = temp();
    const host = { sessionId: 'session', runIds: ['run'], questionIds: [] };
    for (const tuiApproval of [true, false]) {
      writeHostState(root, [{ ...host, tuiApproval }]);
      expect(readHostState(root)).toEqual([{ ...host, tuiApproval }]);
    }
    writeHostState(root, [host]);
    expect(readHostState(root)).toEqual([host]);
    for (const tuiApproval of ['ask', 'yolo', 1, null, {}]) {
      writeFileSync(path.join(root, 'cli-host.json'), JSON.stringify([{ ...host, tuiApproval }]), 'utf8');
      expect(() => readHostState(root)).toThrow('tuiApproval must be a boolean');
    }
  });

  it('enables conditional summary compaction by default and supports an explicit library opt-out', async () => {
    const enabled = new Application(path.join(temp(), 'enabled'));
    const disabled = new Application(path.join(temp(), 'disabled'), undefined, undefined, { compaction: false });
    try {
      expect(enabled.coordinator.compaction).toEqual({ strategy: 'summary', triggerRatio: 0.8 });
      expect(disabled.coordinator.compaction).toBeUndefined();
    } finally {
      await enabled.shutdown();
      await disabled.shutdown();
    }
  });

  it('keeps tool networking off by default and requires explicit network host authorization', () => {
    expect(cliToolPolicy({})).toBeUndefined();
    expect(cliToolPolicy({ webfetch: true, 'web-hosts': 'example.org,docs.example.org' })).toEqual({ webFetch: { enabled: true, allowedHosts: ['example.org', 'docs.example.org'] } });
    expect(() => cliToolPolicy({ 'web-hosts': 'example.org' })).toThrow('requires --webfetch');
    expect(() => cliToolPolicy({ webfetch: true, 'web-hosts': 'https://example.org' })).toThrow();
    expect(() => cliToolPolicy({ 'shell-program': './bash' })).toThrow('absolute Bash');
  });

  it('persists complete native resource policy and detached LSP config across host restarts', () => {
    const root = temp(); const lsp = { servers: [{ id: 'typescript', program: process.execPath, args: ['language-server.js'], languages: { '.ts': 'typescript' } }], timeoutMs: 1000 };
    const config = path.join(root, 'lsp.json'); writeFileSync(config, JSON.stringify(lsp), 'utf8');
    const tools = cliToolPolicy({ 'lsp-config': config, 'shell-program': path.join(root, process.platform === 'win32' ? 'bash.exe' : 'bash'), webfetch: true, 'web-hosts': 'example.org' });
    const sandbox = { network: 'none' as const, resources: { maxProcesses: 1, ...(process.platform === 'darwin' ? {} : { memoryBytes: 128 * 1024 * 1024 }) } };
    writeHostState(root, [{ sessionId: 'session', runIds: ['run'], questionIds: [], sandbox, tools }]);
    writeFileSync(config, JSON.stringify({ servers: [] }), 'utf8');
    expect(readHostState(root)).toEqual([{ sessionId: 'session', runIds: ['run'], questionIds: [], sandbox, tools }]);
    expect(readHostState(root)[0]!.tools!.lsp).toEqual(lsp);
  });

  it('rejects tool configuration attempting to override host isolation or malformed persisted state', () => {
    const root = temp(); const config = path.join(root, 'lsp.json');
    writeFileSync(config, JSON.stringify({ servers: [], sandbox: { network: 'allow' } }), 'utf8');
    expect(() => cliToolPolicy({ 'lsp-config': config })).toThrow('host-controlled');
    writeFileSync(config, JSON.stringify({ servers: [{ id: 'untrusted', program: process.execPath, args: [], languages: { '.ts': 'typescript' }, env: { SECRET: 'unexpected' } }] }), 'utf8');
    expect(() => cliToolPolicy({ 'lsp-config': config })).toThrow('invalid CLI language server fields');
    writeFileSync(path.join(root, 'cli-host.json'), JSON.stringify([{ sessionId: 'session', runIds: [], questionIds: [], sandbox: { network: 'none', resources: { memoryBytes: -1 } } }]), 'utf8');
    expect(() => readHostState(root)).toThrow('positive safe integer');
    writeFileSync(path.join(root, 'cli-host.json'), JSON.stringify([{ sessionId: 'session', runIds: [], questionIds: [], tools: { shellProgram: 'relative/bash' } }]), 'utf8');
    expect(() => readHostState(root)).toThrow('absolute trusted');
  });

  it('requires native sandbox selection for resource policies and validates JSON before running', () => {
    const root = temp(); const config = path.join(root, 'resources.json'); writeFileSync(config, JSON.stringify({ maxProcesses: 1 }), 'utf8');
    expect(() => cliSandboxPolicy({ 'sandbox-resources': config })).toThrow('require --sandbox');
    expect(cliSandboxPolicy({ sandbox: true, 'sandbox-resources': config })).toEqual({ network: 'none', resources: { maxProcesses: 1 } });
    writeFileSync(config, '{ broken', 'utf8');
    expect(() => cliSandboxPolicy({ sandbox: true, 'sandbox-resources': config })).toThrow('readable JSON');
  });

  it('parses and persists the experimental compaction policy as trusted host state', () => {
    expect(cliCompactionPolicy({})).toBeUndefined();
    expect(cliCompactionPolicy({ compaction: 'off' })).toBe(false);
    expect(cliCompactionPolicy({ compaction: 'hybrid' })).toEqual({ strategy: 'hybrid' });
    expect(cliCompactionPolicy({ compaction: 'mask', 'compaction-work-tokens': '65536' })).toEqual({ strategy: 'mask', workInputTokens: 65_536 });
    expect(() => cliCompactionPolicy({ compaction: 'semantic' })).toThrow('off, mask, summary or hybrid');
    expect(() => cliCompactionPolicy({ 'compaction-work-tokens': '65536' })).toThrow('require --compaction');
    expect(() => cliCompactionPolicy({ compaction: 'hybrid', 'compaction-work-tokens': '0' })).toThrow();
    expect(() => cliCompactionPolicy({ compaction: 'hybrid', 'compaction-work-tokens': 'many' })).toThrow('positive integer');
    expect(cliCompactionPolicy({ compaction: 'summary', 'compaction-trigger-ratio': '0.8' })).toEqual({ strategy: 'summary', triggerRatio: 0.8 });
    expect(() => cliCompactionPolicy({ compaction: 'summary', 'compaction-trigger-ratio': '0.99' })).toThrow();
    expect(() => cliCompactionPolicy({ compaction: 'summary', 'compaction-trigger-ratio': '0.8', 'compaction-work-tokens': '4096' })).toThrow();

    const root = temp();
    const compaction = { strategy: 'hybrid' as const, workInputTokens: 32_768 };
    writeHostState(root, [{ sessionId: 'session', runIds: ['run'], questionIds: [], compaction }]);
    expect(readHostState(root)).toEqual([{ sessionId: 'session', runIds: ['run'], questionIds: [], compaction }]);
    writeFileSync(path.join(root, 'cli-host.json'), JSON.stringify([{ sessionId: 'session', runIds: [], questionIds: [], compaction: { strategy: 'unknown' } }]), 'utf8');
    expect(() => readHostState(root)).toThrow('mask, summary or hybrid');
    writeFileSync(path.join(root, 'cli-host.json'), JSON.stringify([{ sessionId: 'session', runIds: [], questionIds: [], compaction: { strategy: 'hybrid', workInputTokens: 1 } }]), 'utf8');
    expect(() => readHostState(root)).toThrow('workInputTokens');
  });

  it('parses and persists deterministic assembly without accepting malformed policy', () => {
    expect(cliAssemblyPolicy({})).toBeUndefined();
    expect(cliAssemblyPolicy({ assembly: 'deterministic' })).toEqual({ strategy: 'deterministic' });
    expect(cliAssemblyPolicy({ assembly: 'deterministic', 'assembly-work-tokens': '65536', 'assembly-evidence-tokens': '6553' })).toEqual({ strategy: 'deterministic', workInputTokens: 65_536, evidenceInputTokens: 6_553 });
    expect(() => cliAssemblyPolicy({ assembly: 'model' })).toThrow('deterministic');
    expect(() => cliAssemblyPolicy({ 'assembly-evidence-tokens': '6553' })).toThrow('require --assembly');
    expect(() => cliAssemblyPolicy({ assembly: 'deterministic', 'assembly-evidence-tokens': '1' })).toThrow('evidenceInputTokens');
    expect(() => cliAssemblyPolicy({ assembly: 'deterministic', 'assembly-work-tokens': 'many' })).toThrow('positive integer');

    const root = temp();
    const assembly = { strategy: 'deterministic' as const, workInputTokens: 65_536, evidenceInputTokens: 6_553 };
    writeHostState(root, [{ sessionId: 'session', runIds: ['run'], questionIds: [], assembly }]);
    expect(readHostState(root)).toEqual([{ sessionId: 'session', runIds: ['run'], questionIds: [], assembly }]);
    writeFileSync(path.join(root, 'cli-host.json'), JSON.stringify([{ sessionId: 'session', runIds: [], questionIds: [], assembly: { strategy: 'deterministic', extra: true } }]), 'utf8');
    expect(() => readHostState(root)).toThrow('assembly requires deterministic');
    writeFileSync(path.join(root, 'cli-host.json'), JSON.stringify([{ sessionId: 'session', runIds: [], questionIds: [], assembly, typoAssembly: true }]), 'utf8');
    expect(() => readHostState(root)).toThrow('invalid local execution bindings');
  });
});
