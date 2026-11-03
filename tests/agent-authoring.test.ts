import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createAgentDraft, saveAgentMethod, writeAgentDraft } from '../src/agents/authoring.js';
import type { AgentDraftOptions, AgentMethod } from '../src/agents/authoring.js';
import { agentAuthoringCommand } from '../src/agents/authoring-cli.js';
import { exportPackage, importPackage } from '../src/packages/archive.js';
import { parseCard } from '../src/agents/card.js';
import { Store } from '../src/storage/index.js';
import { defaultBudget } from '../src/runtime/types.js';
import { answer, binding, scripted, temp } from './helpers.js';

const method = (): AgentMethod => ({ name: 'Evidence reviewer', description: 'Review a source tree and cite verified evidence.', tools: ['file.read', 'file.search'], inputs: ['Source tree and claims to check.'], steps: ['Locate code supporting each claim.', 'Follow callers and test references; distinguish facts from assumptions.'], checks: ['Cite evidence for each conclusion.', 'Reject an unsupported claim and test an empty input.'] });
const options = (): AgentDraftOptions => ({ description: 'Review source code with evidence and failure cases.', id: 'test/reviewer', allowedTools: ['file.read', 'file.search'], model: { provider: scripted(answer(JSON.stringify(method()))), binding } });
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function sourceFixture(): { app: { store: Store }; root: string; runId: string } {
  const root = temp(); const store = new Store(path.join(root, '.state')); stores.push(store);
  store.putSession({ id: 'session', workspace: root, permissions: ['read'], budget: { ...defaultBudget, maxContextTokens: 8192, maxOutputTokens: 1024 }, tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, createdAt: new Date().toISOString() });
  store.putRun({ id: 'run', sessionId: 'session', objective: 'Review the project with evidence.', status: 'queued', card: parseCard('---\nschema_version: 1\nid: test/source\nversion: 1.0.0\nname: Source\ndescription: Source fixture\ncapabilities:\n  tools: [file.read]\n---\nRead evidence.'), binding, contextRef: store.blob([]), step: 0, cancelRequested: false, createdAt: new Date().toISOString() });
  return { app: { store }, root, runId: 'run' };
}

describe('conversational agent authoring', () => {
  it('extracts structured model instructions and creates an importable immutable capability package', async () => {
    const root = temp(); const draft = await createAgentDraft(options());
    expect(draft.mode).toBe('model-draft');
    expect(parseCard(draft.cardContent).tools).toEqual(['file.read', 'file.search']);
    expect(draft.cardContent).toContain('Locate code supporting each claim.');
    expect(draft.cardContent).toContain('Model-authored draft');
    const written = await writeAgentDraft(draft, { directory: path.join(root, 'agent'), license: 'MIT', sourceUrl: 'https://example.test/reviewer' });
    expect(await readFile(written.cardPath, 'utf8')).toBe(draft.cardContent);
    expect((await readFile(written.cardPath)).subarray(0, 3).toString('hex')).not.toBe('efbbbf');
    const archive = path.join(root, 'agent.zip'); await exportPackage(written.directory, written.declaration, archive);
    const imported = await importPackage(archive, path.join(root, 'registry'));
    expect(imported.card.id).toBe('test/reviewer');
    expect(imported.manifest.files.map(file => file.path)).toEqual(['AGENT.md']);
    await expect(writeAgentDraft(draft, { directory: written.directory, license: 'MIT', sourceUrl: 'https://example.test/reviewer' })).rejects.toThrow();
    expect(await readFile(written.cardPath, 'utf8')).toBe(draft.cardContent);
  });

  it('requires explicit template mode offline, labels its limitations, and never silently falls back', async () => {
    const offline = { ...options(), model: undefined };
    await expect(createAgentDraft(offline)).rejects.toThrow('choose template explicitly');
    const draft = await createAgentDraft({ ...offline, template: true });
    expect(draft.mode).toBe('template-draft');
    expect(draft.cardContent).toContain('no run was analyzed');
    await expect(createAgentDraft({ ...options(), template: true })).rejects.toThrow('choose model extraction');
    await expect(createAgentDraft({ ...options(), model: { provider: scripted(answer('```json\n{}\n```')), binding } })).rejects.toThrow('valid JSON');
  });

  it.each([
    ['{}', 'schema'],
    [JSON.stringify({ ...method(), steps: [] }), 'schema'],
    [JSON.stringify({ ...method(), unexpected: true }), 'schema'],
    [JSON.stringify({ ...method(), tools: ['process.exec'] }), 'capability'],
    [JSON.stringify({ ...method(), steps: ['   '] }), 'blank'],
    ['{"name":"one","name":"two"}', 'valid JSON'],
  ])('rejects invalid model output without publishing: %s', async (content, error) => {
    await expect(createAgentDraft({ ...options(), model: { provider: scripted(answer(content)), binding } })).rejects.toThrow(error);
  });

  it.each([
    'Use sk-abcdefghijklmnopqrstuvwxyz0123456789',
    'Read C:\\Users\\private\\secret.txt',
    'Read /home/alice/customer/report.txt',
    'Read /customer-files/report.txt',
    'Use password=internal-password',
    'Use https://alice:password@example.test/data',
    'Use https://example.test/data?token=internal-value',
    'Publish Confidential-Customer-17 facts',
  ])('rejects secrets, local paths and private values: %s', async step => {
    await expect(createAgentDraft({ ...options(), privateValues: ['Confidential-Customer-17'], model: { provider: scripted(answer(JSON.stringify({ ...method(), steps: [step] }))), binding } })).rejects.toThrow('private');
  });

  it('redacts source evidence before model extraction and preserves actual quality without claiming reuse', async () => {
    const { app, root, runId } = sourceFixture(); const source = app.store.run(runId);
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const resultRef = app.store.blob({ text: `Completed at ${root}; ${secret}; customer PrivateCustomer`, quality: { status: 'not_checked' } });
    app.store.updateRun(runId, { status: 'completed', resultRef });
    app.store.putCall({ id: 'source-tool', runId, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef: app.store.blob({ arguments: JSON.stringify({ path: 'private-customer-report.txt' }) }), resultRef: app.store.blob({ content: 'PrivateCustomer customer data' }) });
    const draft = await saveAgentMethod({ ...options(), store: app.store, sessionId: source.sessionId, runId, privateValues: ['PrivateCustomer'], model: { binding, provider: scripted(async request => {
      const user = request.messages.find(message => message.role === 'user')!;
      expect(user.content).toContain('sourceEvidence');
      expect(user.content).toContain('file.read');
      expect(user.content).toContain('[PRIVATE]');
      expect(user.content).not.toContain(secret);
      expect(user.content).not.toContain('PrivateCustomer');
      expect(user.content).not.toContain('private-customer-report.txt');
      expect(user.content).not.toContain(root.replaceAll('\\', '\\\\'));
      expect(user.content).not.toContain('apiKeyEnv');
      expect(request.tools).toEqual([]);
      return answer(JSON.stringify(method()));
    }) } });
    expect(draft.source).toEqual({ runId, quality: 'not_checked', calls: 1, evidenceTruncated: false });
    expect(draft.cardContent).not.toContain(runId);
    expect(draft.cardContent).not.toContain('PrivateCustomer');
  });

  it('refuses source runs outside the selected session, unfinished runs and template saves', async () => {
    const { app, runId } = sourceFixture(); const run = app.store.run(runId);
    const base = { ...options(), store: app.store, sessionId: run.sessionId, runId };
    await expect(saveAgentMethod({ ...base, sessionId: 'another-session' })).rejects.toThrow('authorized session');
    await expect(saveAgentMethod(base)).rejects.toThrow('must be completed');
    await expect(saveAgentMethod({ ...base, model: undefined, template: true })).rejects.toThrow('requires model-assisted');
  });

  it('bounds evidence, reports truncation, and propagates cancellation', async () => {
    const { app, runId } = sourceFixture(); const run = app.store.run(runId);
    app.store.updateRun(runId, { status: 'completed', resultRef: app.store.blob({ text: 'evidence '.repeat(2000), quality: { status: 'passed' } }) });
    const draft = await saveAgentMethod({ ...options(), store: app.store, sessionId: run.sessionId, runId });
    expect(draft.source).toMatchObject({ quality: 'passed', evidenceTruncated: true });
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    await expect(createAgentDraft({ ...options(), signal: controller.signal })).rejects.toThrow('cancelled');
  });

  it('rejects copying a source-specific relative filename into the reusable method', async () => {
    const { app, runId } = sourceFixture(); const run = app.store.run(runId);
    app.store.updateRun(runId, { status: 'completed', resultRef: app.store.blob({ text: 'reviewed' }) });
    app.store.putCall({ id: 'source-file', runId, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef: app.store.blob({ path: 'customer-report.txt' }) });
    await expect(saveAgentMethod({ ...options(), store: app.store, sessionId: run.sessionId, runId, model: { binding, provider: scripted(answer(JSON.stringify({ ...method(), steps: ['Always inspect customer-report.txt.'] }))) } })).rejects.toThrow('private');
  });

  it('validates metadata before creating files and refuses unbundled extension capabilities', async () => {
    const root = temp(); const draft = await createAgentDraft(options()); const directory = path.join(root, 'agent');
    await expect(writeAgentDraft(draft, { directory, license: 'MIT', sourceUrl: 'file:///private/project' })).rejects.toThrow('HTTP');
    expect(existsSync(directory)).toBe(false);
    const custom = await createAgentDraft({ description: 'Inspect using host extension.', id: 'test/custom', allowedTools: ['host.custom'], template: true });
    await expect(writeAgentDraft(custom, { directory, license: 'MIT', sourceUrl: 'https://example.test/project' })).rejects.toThrow('host registers extensions');
    expect(existsSync(directory)).toBe(false);
  });

  it('provides an offline CLI creation and export flow without handwritten AGENT.md', async () => {
    const root = temp(); const output: string[] = [];
    await agentAuthoringCommand(['create', 'Review source and cite evidence.', '--id', 'test/offline', '--output', path.join(root, 'agent'), '--source-url', 'https://example.test/project', '--template', '--archive', path.join(root, 'agent.zip'), '--json'], { output: text => output.push(text) });
    expect(JSON.parse(output[0]!)).toMatchObject({ id: 'test/offline', mode: 'template-draft', verification: 'draft-not-case-verified' });
    expect(existsSync(path.join(root, 'agent.zip'))).toBe(true);
    await expect(agentAuthoringCommand(['save', 'source', '--id', 'test/offline', '--output', path.join(root, 'other'), '--source-url', 'https://example.test/project'])).rejects.toThrow('--session');
  });
});
