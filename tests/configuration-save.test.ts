import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { parseCard } from '../src/agents/card.js';
import { saveConfigurationDraft } from '../src/agents/configuration-save.js';
import { writeAgentDraft } from '../src/agents/authoring.js';
import { agentAuthoringCommand } from '../src/agents/authoring-cli.js';
import { exportPackage, importPackage } from '../src/packages/archive.js';
import type { Provider } from '../src/runtime/types.js';
import { answer, binding, fixture, temp } from './helpers.js';

const instructions = 'Compare documented and implemented behaviour; cite both sources for each difference.';
function spawnConfigured(app: Application, runId: string, configuration: Record<string, unknown> = { instructions, tools: ['file.search', 'file.read'] }): string {
  return app.store.transaction(() => {
    const run = app.store.run(runId);
    const args = app.coordinator.mailbox.validate(run, 'spawn_agent', JSON.stringify({ objective: 'Review the pager', permissions: ['read'], configuration }));
    return (app.coordinator.mailbox.execute(run, 'spawn-call', 'spawn_agent', args) as { id: string }).id;
  });
}
const complete = (app: Application, id: string): unknown => app.store.updateRun(id, { status: 'completed', resultRef: app.store.blob({ text: 'Reviewed.', quality: { status: 'not_checked' } }) });

describe('saving an ad-hoc configuration as a card version', () => {
  it.each([true, false, undefined])('preserves the explicit nudge policy through configuration and saved YAML (value=%s)', nudges => {
    const { app, root } = fixture();
    const card = parseCard(`---\nschema_version: 1\nid: local/nudge-policy\nversion: 1.0.0\nname: Nudge policy\ndescription: Preserve the selected progress advice.\n${nudges === undefined ? '' : `nudges: ${nudges}\n`}capabilities:\n  tools: [file.read, file.search]\n---\nInspect the requested files.`);
    const main = app.createRun({ objective: 'Inspect.', workspace: root, binding, card, permissions: ['read'] });
    const childId = spawnConfigured(app, main.id);
    complete(app, childId);
    expect(app.store.run(childId).card.nudges).toBe(nudges);
    const draft = saveConfigurationDraft({ store: app.store, sessionId: main.sessionId, runId: childId, id: 'local/nudge-saved' });
    expect(parseCard(draft.cardContent).nudges).toBe(nudges);
  });

  it('reproduces the recorded configuration in a fresh registry and run, with provenance kept local', async () => {
    const { app, runId } = fixture();
    const childId = spawnConfigured(app, runId); complete(app, childId);
    const child = app.store.run(childId);
    const draft = saveConfigurationDraft({ store: app.store, sessionId: child.sessionId, runId: childId, id: 'local/pager-review' });
    expect(draft).toMatchObject({ mode: 'configuration-draft', version: '0.1.0', origin: { runId: childId, quality: 'not_checked', derivedFrom: child.card.derivedFrom, evidence: 'single-run' } });
    expect(draft.cardContent).toContain(instructions);
    expect(draft.cardContent).toContain('single evidence, not proof of reuse');
    expect(draft.cardContent).not.toContain(childId);
    const root = temp();
    const written = await writeAgentDraft(draft, { directory: path.join(root, 'agent'), license: 'MIT', sourceUrl: 'https://example.test/pager' });
    const archive = path.join(root, 'agent.zip'); await exportPackage(written.directory, written.declaration, archive);
    const imported = await importPackage(archive, path.join(root, 'registry'));
    expect(imported.manifest.files.map(file => file.path)).toEqual(['AGENT.md']);
    expect(imported.card).toMatchObject({ id: 'local/pager-review', version: '0.1.0', tools: ['file.read', 'file.search'] });
    expect(imported.card.prompt).toContain(child.card.prompt);
    // A clean host runs the imported card with exactly the saved tool set and method.
    const seen: { tools: string[]; system: string }[] = [];
    const provider: Provider = { async complete(request) { seen.push({ tools: request.tools.map(tool => tool.name), system: JSON.stringify(request.messages) }); return answer('Done.'); } };
    const fresh = new Application(path.join(root, '.fresh'), provider);
    try {
      fresh.registerCard(imported.card);
      const run = fresh.createRun({ objective: 'Review the pager.', workspace: root, binding, card: imported.card, permissions: ['read'] });
      expect((await fresh.run(run.id)).status).toBe('completed');
      expect(seen[0]!.tools).toEqual(expect.arrayContaining(['file.read', 'file.search']));
      expect(seen[0]!.tools).not.toContain('file.patch');
      expect(seen[0]!.system).toContain(instructions);
    } finally { await fresh.shutdown(); }
  });

  it('refuses other sessions, unconfigured or unfinished runs, and existing versions', async () => {
    const { app, runId } = fixture();
    const childId = spawnConfigured(app, runId);
    const sessionId = app.store.run(childId).sessionId;
    const save = (overrides: Record<string, unknown> = {}) => () => saveConfigurationDraft({ store: app.store, sessionId, runId: childId, id: 'local/pager-review', ...overrides });
    expect(save()).toThrow('must be completed');
    complete(app, childId);
    expect(save({ sessionId: 'another' })).toThrow('authorized session');
    expect(save({ runId })).toThrow('did not use an ad-hoc configuration');
    expect(save({ id: 'Bad Id' })).toThrow('author/name');
    const root = temp(); const directory = path.join(root, 'agent');
    const draft = saveConfigurationDraft({ store: app.store, sessionId, runId: childId, id: 'local/pager-review' });
    await writeAgentDraft(draft, { directory, license: 'MIT', sourceUrl: 'https://example.test/pager' });
    const original = await readFile(path.join(directory, 'AGENT.md'), 'utf8');
    await expect(writeAgentDraft({ ...draft, version: '0.1.0' }, { directory, license: 'MIT', sourceUrl: 'https://example.test/pager' })).rejects.toThrow();
    expect(await readFile(path.join(directory, 'AGENT.md'), 'utf8')).toBe(original);
  });

  it('refuses to distribute workspace paths or explicitly private values found in the instructions', () => {
    const { app, root, runId } = fixture();
    const leaky = spawnConfigured(app, runId, { instructions: `Read ${path.join(root, 'notes.txt')} first.`, tools: ['file.read'] });
    const named = spawnConfigured(app, runId, { instructions: 'Check the Acme-Customer-17 contract.', tools: ['file.read'] });
    complete(app, leaky); complete(app, named);
    const sessionId = app.store.run(leaky).sessionId;
    expect(() => saveConfigurationDraft({ store: app.store, sessionId, runId: leaky, id: 'local/leaky' })).toThrow('private');
    expect(() => saveConfigurationDraft({ store: app.store, sessionId, runId: named, id: 'local/named', privateValues: ['Acme-Customer-17'] })).toThrow('private');
  });

  it('saves offline through the CLI without model options', async () => {
    const root = temp(); const state = path.join(root, '.state');
    const app = new Application(state, { async complete() { return answer(); } });
    const main = app.createRun({ objective: 'Inspect.', workspace: root, binding, permissions: ['read', 'write'] });
    await app.coordinator.tools.execute(main.id, 'todo.write', { expectedRevision: 0, items: [{ id: 'review', content: 'Review the recorded configuration', status: 'in_progress', executor: 'agent' }] }, new AbortController().signal);
    const childId = spawnConfigured(app, main.id); complete(app, childId);
    const sessionId = app.store.run(childId).sessionId;
    await app.shutdown();
    const common = ['--session', sessionId, '--id', 'local/pager-review', '--source-url', 'https://example.test/pager', '--data-dir', state, '--json'];
    await expect(agentAuthoringCommand(['save-config', childId, ...common, '--output', path.join(root, 'x'), '--model', 'm'])).rejects.toThrow('do not apply');
    expect(existsSync(path.join(root, 'x'))).toBe(false);
    const output: string[] = [];
    await agentAuthoringCommand(['save-config', childId, ...common, '--output', path.join(root, 'agent'), '--archive', path.join(root, 'agent.zip')], { output: text => output.push(text) });
    expect(JSON.parse(output[0]!)).toMatchObject({ id: 'local/pager-review', mode: 'configuration-draft', origin: { runId: childId, evidence: 'single-run' }, verification: 'draft-not-case-verified' });
    expect(existsSync(path.join(root, 'agent.zip'))).toBe(true);
  });
});
