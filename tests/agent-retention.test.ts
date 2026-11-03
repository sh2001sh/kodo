import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, digest } from '../src/storage/index.js';
import { AgentRetention, retentionTools } from '../src/agents/retention.js';
import { parseCard } from '../src/agents/card.js';
import { submitReport } from '../src/runtime/report.js';
import { defaultBudget } from '../src/runtime/types.js';
import type { Card, Run, Session } from '../src/runtime/types.js';

const opened: { store: Store; root: string }[] = [];
afterEach(() => { for (const { store, root } of opened.splice(0)) { store.close(); if (!path.relative(os.tmpdir(), root).startsWith('kodo-retention-')) throw new Error('unexpected temporary directory'); rmSync(root, { recursive: true, force: true }); } });
const card = (): Card => parseCard(`---
schema_version: 2
id: example/reviewer
version: 1.0.0
name: Fixture reviewer
description: Review a bounded change.
catalog: { path: engineering/review }
routing: { use_when: [Review completed changes], mode: read }
inputs: [{name: requirement, kind: text, required: true}]
report: [{name: findings, kind: list, required: true}]
capabilities: { tools: [file.read] }
constraints: { permissions: [read], scope: { read: [src], write: [] } }
derivation: { allowed: true }
---
Inspect the supplied change and report concrete findings.
`);

/** Isolated synthetic execution records exercise retention without a model or a real user approval. */
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kodo-retention-'));
  const store = new Store(path.join(root, 'state'));
  opened.push({ store, root });
  const session: Session = { id: 'fixture-session', workspace: root, permissions: ['read', 'write', 'exec'], budget: { ...defaultBudget, maxContextTokens: 64000, maxOutputTokens: 4096 }, tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, createdAt: new Date().toISOString() };
  store.putSession(session);
  const main: Run = { id: 'fixture-main', sessionId: session.id, objective: 'Synthetic retention fixture', status: 'completed', card: card(), binding: { model: 'fixture', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'KODO_RETENTION_FIXTURE' }, contextRef: store.blob([]), step: 1, cancelRequested: false, createdAt: session.createdAt };
  store.putRun(main);
  const child = (id = 'fixture-child'): Run => {
    const source: Run = { ...main, id, parentId: main.id, permissions: ['read'], scope: { read: ['src'], write: [] }, resultRef: store.blob({ text: 'Synthetic fixture result.', quality: { status: 'not_checked' } }) };
    store.putRun(source);
    store.putCall({ id: `${id}:model`, runId: id, step: 0, kind: 'model', name: 'synthetic-fixture', status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef: store.blob({ fixture: true }) });
    store.putCall({ id: `${id}:read`, runId: id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef: store.blob({ id: 'read', name: 'file.read', arguments: JSON.stringify({ path: 'src/example.ts' }) }), resultRef: store.blob({ content: 'fixture' }) });
    submitReport(store, source, { findings: [] });
    return source;
  };
  return { store, root, session, main, child, retention: new AgentRetention(store) };
}

describe('reviewed retention of executed member cards', () => {
  it('keeps proposals and model retention requests unregistered until an explicit host decision', () => {
    const { store, session, main, child, retention } = setup();
    const source = child();
    const proposal = retention.propose(session.id, { run_id: source.id, name: 'Retained reviewer' }, main.id);
    expect(proposal.card.tools).toEqual(source.card.tools);
    expect(proposal.card.constraints).toEqual(source.card.constraints);
    expect(proposal.evidence).toMatchObject({ runStatus: 'completed', reportCompleteness: { status: 'complete' }, hostAcceptance: { status: 'not_checked' }, mainAcceptance: { status: 'not_recorded' }, toolsUsed: ['file.read'] });
    expect(() => store.card(proposal.card.id, proposal.card.version)).toThrow();
    const request = retention.requestRetention(session.id, { draft_id: proposal.id, digest: proposal.digest }, main.id);
    expect(request.status).toBe('requested');
    expect(store.events(main.id, { types: ['agent.approval'] })).toHaveLength(0);
    expect(() => store.card(proposal.card.id, proposal.card.version)).toThrow();
    const approved = retention.approve(proposal.id, proposal.digest, { source: 'cli', userEventId: 'fixture-approval-1' });
    expect(approved.status).toBe('approved');
    expect(store.card(proposal.card.id, proposal.card.version).digest).toBe(proposal.card.digest);
    expect(store.events(main.id, { types: ['agent.approval'] })[0]?.data).toMatchObject({ draft_id: proposal.id, draft_digest: proposal.digest, decision: 'approve', source: 'terminal_key', user_event_id: 'fixture-approval-1' });
  });

  it('requires confirmation of the new digest after editing and retains immutable registered versions', () => {
    const { store, session, child, retention } = setup();
    const source = child();
    const original = retention.propose(session.id, { run_id: source.id, name: 'Original label' });
    retention.approve(original.id, original.digest, { source: 'web_button', userEventId: 'fixture-original' });
    const edited = retention.edit(original.id, original.digest, { name: 'Revised label', catalog: { path: 'engineering/inspection' } });
    expect(edited.id).toBe(original.id);
    expect(edited.digest).not.toBe(original.digest);
    expect(edited.status).toBe('draft');
    expect(edited.card.version).not.toBe(original.card.version);
    expect(() => retention.approve(edited.id, original.digest, { source: 'web_button', userEventId: 'fixture-stale' })).toThrow('draft changed');
    expect(() => store.card(edited.card.id, edited.card.version)).toThrow();
    retention.approve(edited.id, edited.digest, { source: 'workbench', userEventId: 'fixture-current' });
    expect(store.card(original.card.id, original.card.version).name).toBe('Original label');
    expect(store.card(edited.card.id, edited.card.version).name).toBe('Revised label');
  });

  it('keeps one draft per source and creates a fresh revision when proposed again', () => {
    const { session, child, retention } = setup();
    const source = child();
    const first = retention.propose(session.id, { run_id: source.id, name: 'Reviewer' });
    const second = retention.propose(session.id, { run_id: source.id, name: 'Reviewer' });
    expect(second.id).toBe(first.id);
    expect(second.digest).not.toBe(first.digest);
    expect(retention.list(session.id)).toHaveLength(1);
  });

  it('mutes later proposals after two distinct declines and persists the preference across service instances', () => {
    const { store, session, child, retention } = setup();
    const first = retention.propose(session.id, { run_id: child('first').id, name: 'First proposal' });
    retention.decide(first.id, first.digest, 'skip', { source: 'cli', userEventId: 'fixture-skip-1' });
    retention.decide(first.id, first.digest, 'skip', { source: 'cli', userEventId: 'fixture-skip-1-repeated' });
    const second = retention.propose(session.id, { run_id: child('second').id, name: 'Second proposal' });
    expect(second.silent).toBe(false);
    retention.decide(second.id, second.digest, 'reject', { source: 'cli', userEventId: 'fixture-skip-2' });
    const reopened = new AgentRetention(store);
    const third = reopened.propose(session.id, { run_id: child('third').id, name: 'Third proposal' });
    expect(third.silent).toBe(true);
    expect(third.status).toBe('draft');
    expect(() => store.card(third.card.id, third.card.version)).toThrow();
    expect(reopened.list().every(draft => draft.silent)).toBe(true);
  });

  it('does not generate proposals in off mode and exposes no available retention tools', () => {
    const { store, session, child } = setup();
    const source = child();
    const retention = new AgentRetention(store, { mode: 'off' });
    expect(() => retention.propose(session.id, { run_id: source.id, name: 'Unused proposal' })).toThrow('disabled');
    expect(retention.list()).toEqual([]);
    expect(retentionTools(retention).every(tool => tool.available === false)).toBe(true);
  });

  it('copies actual derivation instructions and treats an approval event id as idempotent', () => {
    const { store, session, child, retention } = setup();
    const source = child();
    const prompt = `${source.card.prompt}\nOnly inspect documentation changes.`;
    store.updateRun(source.id, { card: { ...source.card, prompt, digest: digest(prompt), derivedFrom: { id: source.card.id, version: source.card.version, digest: source.card.digest } } });
    const proposal = retention.propose(session.id, { run_id: source.id, name: 'Documentation reviewer' });
    expect(proposal.card.prompt).toContain('Only inspect documentation changes.');
    const action = { source: 'conversation' as const, userEventId: 'fixture-explicit-action' };
    retention.approve(proposal.id, proposal.digest, action);
    retention.approve(proposal.id, proposal.digest, action);
    expect(store.events(proposal.ownerRun, { types: ['agent.approval'] })).toHaveLength(1);
  });

  it('model-facing tools leave a review request that survives reopening storage', async () => {
    const { store, session, main, child, retention } = setup();
    const source = child();
    const [propose, retain] = retentionTools(retention);
    const context = { run: main, session, signal: new AbortController().signal, markEffectStarted: () => {} };
    const proposal = await propose!.execute(context, { run_id: source.id, name: 'Persistent review request' }) as { draft_id: string; digest: string };
    expect(await retain!.execute(context, { draft_id: proposal.draft_id, digest: proposal.digest })).toMatchObject({ status: 'requested', requiresUserAction: true });
    const directory = store.directory;
    const resource = opened.find(item => item.store === store)!;
    store.close();
    resource.store = new Store(directory);
    const reopened = new AgentRetention(resource.store);
    const draft = reopened.get(proposal.draft_id);
    expect(draft).toMatchObject({ digest: proposal.digest, status: 'requested' });
    expect(() => resource.store.card(draft.card.id, draft.card.version)).toThrow();
    reopened.approve(draft.id, draft.digest, { source: 'terminal_key', userEventId: 'fixture-after-restart' });
    expect(resource.store.card(draft.card.id, draft.card.version).name).toBe('Persistent review request');
  });

  it('rolls back the approval when the host cannot register the card', () => {
    const { store, session, child } = setup();
    const source = child();
    const retention = new AgentRetention(store, { registerCard: () => { throw new Error('fixture registry unavailable'); } });
    const draft = retention.propose(session.id, { run_id: source.id, name: 'Review before adoption' });
    expect(() => retention.approve(draft.id, draft.digest, { source: 'cli', userEventId: 'fixture-register-failure' })).toThrow('registry unavailable');
    expect(retention.get(draft.id).status).toBe('draft');
    expect(store.events(draft.ownerRun, { types: ['agent.approval'] })).toHaveLength(0);
    expect(store.agentDrafts.action('fixture-register-failure')).toBeUndefined();
  });
});
