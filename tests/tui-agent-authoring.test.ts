import path from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { agentCommand } from '../src/tui/agents.js';
import type { AgentAuthoringHost } from '../src/tui/agent-authoring.js';
import type { AgentCommandContext, TuiPanel } from '../src/tui/types.js';
import { inspectPackage } from '../src/packages/archive.js';
import { PackageRegistry } from '../src/packages/registry.js';
import { digest } from '../src/storage/index.js';
import { answer, binding, fixture } from './helpers.js';

const method = { name: 'Interface inspection', description: 'Inspect an interface against its consumers.', tools: ['file.read'], inputs: ['Provide the interface contract.'], steps: ['Read the contract and inspect its consumers.'], checks: ['Report contradictions and missing consumers, including an empty consumer set.'] };
function setup() {
  const { app, root, runId } = fixture();
  const complete = vi.fn(async () => answer(JSON.stringify(method)));
  const host: AgentAuthoringHost = { binding, allowedTools: ['file.read', 'file.list', 'file.search'], model: { complete } };
  const context: AgentCommandContext & { authoringHost: AgentAuthoringHost } = { app, workspace: root, runId, registry: new PackageRegistry(path.join(root, '.packages')), startTask: vi.fn(async () => {}), wake: vi.fn(), authoringHost: host };
  return { app, root, runId, context, complete };
}
function confirm(panel: TuiPanel): string[] {
  const command = panel.items?.find(item => item.id === 'confirm')?.command;
  if (!command) throw new Error('fixture expected authoring confirmation');
  return command.slice('/agents '.length).split(' ');
}
const options = ['--id', 'example/inspection', '--output', 'inspection', '--source-url', 'https://example.test/inspection'];

describe('TUI local Agent authoring', () => {
  it('calls the existing creation service only after confirmation and writes an unadopted distributable draft', async () => {
    const { context, root, complete } = setup();
    const panel = await agentCommand(context, ['new', 'Inspect interfaces and their consumers.', ...options]);
    expect(panel.title).toBe('Confirm agent creation');
    expect(complete).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'inspection'))).toBe(false);
    const result = await agentCommand(context, confirm(panel));
    expect(result.title).toBe('Agent draft created');
    expect(complete).toHaveBeenCalledTimes(1);
    const archive = await inspectPackage(path.join(root, 'inspection', 'agent.zip'));
    expect(archive.card).toMatchObject({ id: 'example/inspection', version: '0.1.0', tools: ['file.read'] });
    expect(archive.card.prompt).toContain(method.steps[0]);
    expect(await context.registry.current('example/inspection')).toBeUndefined();
    expect(context.app.store.registeredCards().some(card => card.id === 'example/inspection')).toBe(false);
    await expect(agentCommand(context, confirm(panel))).rejects.toThrow('expired');
  });

  it('extracts bounded task evidence through saveAgentMethod while preserving the source card', async () => {
    const { context, app, runId, root, complete } = setup();
    const run = app.store.updateRun(runId, { status: 'completed', resultRef: app.store.blob({ text: 'Synthetic evidence: examined the declared interface.', quality: { status: 'not_checked' } }) });
    const digest = run.card.digest;
    const panel = await agentCommand(context, ['method', runId, '--description', 'Inspect interfaces and their consumers.', ...options, '--tools', 'file.read']);
    expect(panel.title).toBe('Confirm method extraction');
    expect(complete).not.toHaveBeenCalled();
    await agentCommand(context, confirm(panel));
    const request = complete.mock.calls[0] as unknown[] | undefined;
    expect(JSON.stringify(request)).toContain('Synthetic evidence');
    expect(app.store.run(runId).card.digest).toBe(digest);
    expect((await inspectPackage(path.join(root, 'inspection', 'agent.zip'))).card.prompt).toContain(method.checks[0]);
  });

  it('creates an explicitly selected offline template without invoking a model', async () => {
    const { context, root, complete } = setup();
    const panel = await agentCommand(context, ['new', 'Inspect plain text.', ...options, '--template']);
    expect(panel.title).toBe('Confirm offline template creation');
    await agentCommand(context, confirm(panel));
    expect(complete).not.toHaveBeenCalled();
    expect((await inspectPackage(path.join(root, 'inspection', 'agent.zip'))).card.prompt).toContain('Offline template draft');
  });

  it('requires fresh confirmation when the selected model changes', async () => {
    const { context, root, complete } = setup();
    const panel = await agentCommand(context, ['new', 'Inspect plain text.', ...options]);
    context.authoringHost = { ...context.authoringHost, binding: { ...binding, model: 'another-host-model' } };
    await expect(agentCommand(context, confirm(panel))).rejects.toThrow('model or available tools changed');
    expect(complete).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'inspection'))).toBe(false);
  });

  it('does not substitute a template or write files when model extraction fails', async () => {
    const { context, root, complete } = setup();
    complete.mockImplementationOnce(async () => answer('invalid method JSON'));
    const panel = await agentCommand(context, ['new', 'Inspect plain text.', ...options]);
    await expect(agentCommand(context, confirm(panel))).rejects.toThrow('valid JSON');
    expect(existsSync(path.join(root, 'inspection'))).toBe(false);
    expect(await context.registry.list()).toEqual([]);
  });

  it('requires an explicit method capability choice when the source relies on a Skill', async () => {
    const { context, app, root, complete } = setup();
    const content = 'Inspect a supplied plain-text interface.';
    app.registerSkills([{ id: 'fixture', description: 'Synthetic interface fixture.', content, digest: digest(content) }]);
    const card = app.parseCard('---\nschema_version: 1\nid: example/skill-source\nversion: 1.0.0\nname: Skill fixture\ndescription: Inspect a supplied interface.\ncapabilities: { tools: [file.read, skill.load], skills: [fixture] }\n---\nLoad the fixture skill and inspect supplied material.');
    const source = app.createRun({ objective: 'Inspect synthetic material.', workspace: root, binding, card, permissions: ['read'] });
    app.store.updateRun(source.id, { status: 'completed', resultRef: app.store.blob({ text: 'Synthetic source result.' }) });
    context.runId = source.id;
    context.authoringHost = { ...context.authoringHost, allowedTools: ['file.read', 'skill.load'] };
    const args = ['method', source.id, '--description', 'Inspect interfaces with explicit text input.', ...options];
    await expect(agentCommand(context, args)).rejects.toThrow('source method references Skill');
    await expect(agentCommand(context, [...args, '--tools', 'skill.load'])).rejects.toThrow('does not include host extensions');
    expect((await agentCommand(context, [...args, '--tools', 'file.read'])).title).toBe('Confirm method extraction');
    expect(complete).not.toHaveBeenCalled();
  });
});
