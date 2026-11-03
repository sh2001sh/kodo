import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { agentCommand } from '../src/tui/agents.js';
import type { AgentCaseHost } from '../src/tui/agent-cases.js';
import type { AgentCommandContext, TuiPanel } from '../src/tui/types.js';
import { CaseRunStore } from '../src/cases/store.js';
import { caseDigest, freezeCase } from '../src/cases/schema.js';
import { exportPackage } from '../src/packages/archive.js';
import { PackageRegistry } from '../src/packages/registry.js';
import { answer, binding, fixture, temp } from './helpers.js';

const definition = { schema_version: 1, id: 'fixture/plain-text', version: '1.0.0', name: 'Plain-text fixture', objective: 'Return the fixture answer.', inputs: { files: [] }, assertions: [{ type: 'output', equals: 'done' }] };
async function install(registry: PackageRegistry, version = '1.0.0'): Promise<void> {
  const source = temp(), archive = path.join(source, 'agent.zip');
  await writeFile(path.join(source, 'AGENT.md'), `---\nschema_version: 1\nid: example/fixture\nversion: ${version}\nname: Plain-text fixture\ndescription: Return the requested plain-text answer.\ncapabilities: { tools: [file.read] }\n---\nReturn the requested plain-text fixture answer.`);
  await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.test/case-fixture' }, files: [{ path: 'AGENT.md', distributable: true }] }, archive);
  await registry.import(archive);
}
function setup() {
  let output = 'done'; const complete = vi.fn(async () => answer(output));
  const { app, root, runId } = fixture({ complete });
  const registry = new PackageRegistry(path.join(root, '.packages'));
  const host: AgentCaseHost = { binding, permissions: ['read'], hostPolicyDigest: async () => caseDigest({ host: 'isolated-fixture-policy' }), execute: vi.fn(async (input, installed) => {
    const card = await registry.activate(app, installed.card.id, installed.card.version, { workspace: input.workspace, signal: input.signal });
    const run = app.createRun({ objective: input.objective, workspace: input.workspace, binding, card, permissions: input.permissions, scope: input.scope });
    input.recordExecution?.(run.id);
    const abort = () => app.coordinator.cancel(run.id);
    input.signal.addEventListener('abort', abort, { once: true });
    try { const completed = await app.run(run.id); return { runId: completed.id, status: completed.status, output: completed.resultRef ? app.store.readBlob<{ text: string }>(completed.resultRef).text : '' }; }
    finally { input.signal.removeEventListener('abort', abort); }
  }) };
  const context: AgentCommandContext & { caseHost: AgentCaseHost } = { app, workspace: root, runId, registry, startTask: vi.fn(async () => {}), wake: vi.fn(), caseHost: host };
  return { app, root, runId, registry, context, complete, host, setOutput: (value: string) => { output = value; } };
}
function confirmation(panel: TuiPanel): string[] {
  const command = panel.items?.find(item => item.id === 'confirm')?.command;
  if (!command) throw new Error('fixture expected a case confirmation');
  return command.slice('/agents '.length).split(' ');
}
async function execute(context: AgentCommandContext & { caseHost: AgentCaseHost }, caseFile: string, version = '1.0.0'): Promise<string> {
  const preview = await agentCommand(context, ['test', `example/fixture@${version}`, caseFile]);
  const result = await agentCommand(context, confirmation(preview));
  return result.lines[0]!.slice('Case run: '.length);
}

describe('TUI frozen cases and verified local evolution', () => {
  it('freezes the previewed definition, then executes through the same application only after confirmation', async () => {
    const { context, root, registry, complete, host, app } = setup();
    await install(registry);
    const file = path.join(root, 'case.json'); await writeFile(file, JSON.stringify(definition));
    const preview = await agentCommand(context, ['test', 'example/fixture@1.0.0', file]);
    expect(preview.title).toBe('Confirm frozen case execution');
    expect(host.execute).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
    await writeFile(file, JSON.stringify({ ...definition, objective: 'A later unconfirmed file edit.' }));
    const result = await agentCommand(context, confirmation(preview));
    const id = result.lines[0]!.slice('Case run: '.length), record = new CaseRunStore(app.store).get(id);
    expect(record).toMatchObject({ status: 'passed', caseDigest: freezeCase(definition).digest, target: { id: 'example/fixture', version: '1.0.0' } });
    expect(record.execution?.runId).toBeTruthy();
    expect(app.store.run(record.execution!.runId!).sessionId).not.toBe(app.store.run(context.runId!).sessionId);
    expect(complete.mock.calls.length).toBeGreaterThan(0);
    expect(await registry.current('example/fixture')).toBeUndefined();
    await expect(agentCommand(context, confirmation(preview))).rejects.toThrow('expired');
  });

  it('compares matching cases and confirms adoption and rollback using the registry verified operations', async () => {
    const { context, root, registry } = setup();
    await install(registry); await install(registry, '1.1.0');
    const file = path.join(root, 'case.json'); await writeFile(file, JSON.stringify(definition));
    const baseline = await execute(context, file);
    const firstAdoption = await agentCommand(context, ['adopt', 'example/fixture@1.0.0', '--runs', baseline]);
    expect(await registry.current('example/fixture')).toBeUndefined();
    await agentCommand(context, confirmation(firstAdoption));
    expect((await registry.current('example/fixture'))?.version).toBe('1.0.0');
    const candidate = await execute(context, file, '1.1.0');
    const comparison = await agentCommand(context, ['compare', baseline, candidate]);
    expect(comparison.lines).toContain('Comparable conditions: yes');
    expect(comparison.lines).toContain('Candidate passed without regressions: yes');
    const adoption = await agentCommand(context, ['adopt', 'example/fixture@1.1.0', '--runs', candidate]);
    await agentCommand(context, confirmation(adoption));
    expect(await registry.current('example/fixture')).toMatchObject({ version: '1.1.0', previous: { version: '1.0.0' }, verification: { runIds: [candidate], comparedRunIds: [baseline] } });
    const rollback = await agentCommand(context, ['rollback', 'example/fixture', '--runs', baseline]);
    await agentCommand(context, confirmation(rollback));
    expect((await registry.current('example/fixture'))?.version).toBe('1.0.0');
  });

  it('retains failing evidence and refuses superseded passing evidence for adoption', async () => {
    const { context, root, registry, app, setOutput } = setup();
    await install(registry);
    const file = path.join(root, 'case.json'); await writeFile(file, JSON.stringify(definition));
    const passed = await execute(context, file);
    setOutput('different answer'); const failed = await execute(context, file);
    const records = new CaseRunStore(app.store);
    expect(records.get(failed).status).toBe('failed');
    const stale = await agentCommand(context, ['adopt', 'example/fixture@1.0.0', '--runs', passed]);
    await expect(agentCommand(context, confirmation(stale))).rejects.toThrow('superseded');
    const failure = await agentCommand(context, ['adopt', 'example/fixture@1.0.0', '--runs', failed]);
    await expect(agentCommand(context, confirmation(failure))).rejects.toThrow('candidate evidence failed');
    expect(await registry.current('example/fixture')).toBeUndefined();
    expect((await agentCommand(context, ['cases', 'show', failed])).lines.join('\n')).toContain('failed');
  });

  it('refuses changed host conditions and unconfigured assertion commands before model execution', async () => {
    const { context, root, registry, host, complete } = setup();
    await install(registry);
    const file = path.join(root, 'case.json'); await writeFile(file, JSON.stringify(definition));
    const preview = await agentCommand(context, ['test', 'example/fixture@1.0.0', file]);
    context.caseHost = { ...host, permissions: ['read', 'write'] };
    await expect(agentCommand(context, confirmation(preview))).rejects.toThrow('execution policy changed');
    await writeFile(file, JSON.stringify({ ...definition, assertions: [{ type: 'command', command: 'unconfigured', exitCode: 0 }] }));
    await expect(agentCommand(context, ['test', 'example/fixture@1.0.0', file])).rejects.toThrow('not configured by the host');
    expect(host.execute).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  });

  it('uses the confirmation command signal after the preview command has ended', async () => {
    const { context, root, registry, host, app } = setup();
    await install(registry);
    const file = path.join(root, 'case.json'); await writeFile(file, JSON.stringify(definition));
    const previewControl = new AbortController(), confirmControl = new AbortController();
    context.caseHost = { ...host, signal: previewControl.signal };
    const preview = await agentCommand(context, ['test', 'example/fixture@1.0.0', file]);
    previewControl.abort();
    context.caseHost = { ...host, signal: confirmControl.signal };
    const result = await agentCommand(context, confirmation(preview));
    const id = result.lines[0]!.slice('Case run: '.length);
    expect(new CaseRunStore(app.store).get(id).status).toBe('passed');
    expect(confirmControl.signal.aborted).toBe(false);
  });
});
