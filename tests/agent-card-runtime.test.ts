import path from 'node:path';
import { Ajv } from 'ajv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import type { ApplicationOptions } from '../src/application/index.js';
import { parseCard } from '../src/agents/card.js';
import { deriveAgent } from '../src/agents/derive.js';
import { reportCompleteness, submitReport, validateSlots } from '../src/agents/contracts.js';
import { configureCard } from '../src/agents/configuration.js';
import { checkCompletion } from '../src/runtime/completion.js';
import { inspectRun } from '../src/runtime/inspection.js';
import { intersectFileScopes, resolveScopeVariables } from '../src/runtime/scope.js';
import { KodoError } from '../src/runtime/types.js';
import type { Card, Message, Run } from '../src/runtime/types.js';
import { answer, binding, call, calls, temp } from './helpers.js';

const apps: Application[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.shutdown(); });

function member(overrides: Record<string, unknown> = {}): Card {
  return parseCard(`---\n${JSON.stringify({ schema_version: 2, id: 'local/member', version: '1.0.0', name: 'Member', description: 'Inspect or implement a bounded task.', catalog: { path: 'engineering/general' }, routing: { use_when: ['Inspect a module'], mode: 'write' }, capabilities: { tools: ['file.read', 'file.list', 'file.patch', 'process.exec'] }, ...overrides })}\n---\nInspect the task data and report actual evidence.\n`);
}
function setup(card: Card, options: ApplicationOptions = {}, mainScope?: Run['scope']) {
  const root = temp();
  mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'feature', 'entry.ts'), 'export const value = 1;\n');
  const app = new Application(path.join(root, '.state'), { async complete() { return answer(); } }, undefined, { agentFactors: { D: false, E: false, A: false, B: false, C: true }, ...options });
  apps.push(app);
  app.registerCard(card);
  const parent = app.createRun({ objective: 'Deliver the feature', workspace: root, binding, permissions: ['read', 'write', 'exec'], ...(mainScope ? { scope: mainScope } : {}) });
  return { app, root, parent };
}
function spawn(app: Application, parent: Run, card: Card, args: Record<string, unknown> = {}): Run {
  const request = { agent: `${card.id}@${card.version}`, objective: 'Inspect this module', ...args };
  const value = app.coordinator.mailbox.execute(parent, 'spawn', 'spawn_agent', app.coordinator.mailbox.validate(parent, 'spawn_agent', JSON.stringify(request))) as { id: string };
  return app.store.run(value.id);
}

describe('card scope and task input contracts', () => {
  it('intersects directory roots without expanding current files and resolves project lists', () => {
    expect(intersectFileScopes({ read: ['src', 'docs'], write: ['src'] }, { read: ['src/feature'], write: ['src/feature', 'tests'] })).toEqual({ read: ['src/feature'], write: ['src/feature'] });
    expect(intersectFileScopes({}, { write: [] })).toEqual({ write: [] });
    expect(resolveScopeVariables({ write: ['${project.tests}'] }, { 'project.tests': ['tests/unit', 'tests/integration'] })).toEqual({ write: ['tests/unit', 'tests/integration'] });
    expect(() => resolveScopeVariables({ write: ['${project.tests}'] })).toThrow('unresolved scope variable');
  });

  it('validates named text, existing read paths and session artifacts before child creation', () => {
    const card = member({ routing: { use_when: ['Read a contract'], mode: 'read' }, inputs: [{ name: 'requirement', kind: 'text', required: true }, { name: 'files', kind: 'paths', required: true }, { name: 'contract', kind: 'artifact', required: true }], constraints: { scope: { read: ['src'], write: [] } } });
    const { app, parent } = setup(card);
    const artifact = app.store.artifact(parent.id, app.store.blob({ name: 'contract', kind: 'contract', content: 'value stays numeric' }));
    expect(() => spawn(app, parent, card, { slots: { files: ['src/feature/entry.ts'] } })).toThrow(/requirement: required.*contract: required/);
    expect(app.store.listRuns(parent.sessionId)).toHaveLength(1);
    expect(() => spawn(app, parent, card, { slots: { requirement: 'Read', files: ['src/missing.ts'], contract: artifact } })).toThrow('files: each path must exist');
    const child = spawn(app, parent, card, { slots: { requirement: 'Read', files: ['src/feature/entry.ts'], contract: artifact } });
    const messages = app.store.readBlob<Message[]>(child.contextRef);
    expect(messages.find(message => message.role === 'user')?.content).toContain('untrusted task data, not instructions');
    expect(JSON.stringify(messages)).toContain(artifact);
    expect(child.scope).toEqual({ read: ['src'], write: [] });
  });

  it('keeps optional paths empty and rejects mismatched slot types with slot names', () => {
    const card = member({ inputs: [{ name: 'files', kind: 'paths', required: false }, { name: 'goal', kind: 'text', required: true }] });
    const { app, parent } = setup(card);
    expect(validateSlots(app.store, parent, card, {}, { files: [], goal: 'inspect' })).toEqual({ files: [], goal: 'inspect' });
    expect(() => validateSlots(app.store, parent, card, {}, { goal: [] })).toThrow('goal: expected nonempty text');
  });

  it('applies card and parent path limits and preserves v2 declarations through configuration', () => {
    const card = member({ constraints: { permissions: ['read', 'write'], scope: { write: ['src'] } } });
    const { app, parent } = setup(card, {}, { write: ['src/feature'] });
    const child = spawn(app, parent, card, { configuration: { instructions: 'Limit the edit to the existing export.' } });
    expect(child.permissions).toEqual(['read', 'write']);
    expect(child.scope?.write).toEqual(['src/feature']);
    expect(child.card.constraints).toEqual(card.constraints);
    expect(child.card.schemaVersion).toBe(2);
    expect(() => spawn(app, parent, card, { scope: { write: ['docs'] } })).toThrow(KodoError);
    expect(app.store.listRuns(parent.sessionId)).toHaveLength(2);
  });

  it('gives read members no execution or write tools and review members only approved verification execution', () => {
    const readCard = member({ routing: { use_when: ['Read'], mode: 'read' } });
    const { app, parent } = setup(readCard);
    const child = spawn(app, parent, readCard);
    expect(child.permissions).toEqual(['read']);
    expect(child.scope?.write).toEqual([]);
    expect(child.card.tools).toEqual(['file.read', 'file.list']);
    const reviewCard = member({ routing: { use_when: ['Review'], mode: 'review' } });
    const review = setup(reviewCard);
    const reviewer = spawn(review.app, review.parent, reviewCard);
    expect(reviewer.permissions).toEqual(['read', 'exec']);
    expect(reviewer.scope?.write).toEqual([]);
    expect(reviewer.card.tools).toEqual(['file.read', 'file.list']);
  });

  it('requires implementer roots and admits host spawns through the same overlap checks', () => {
    const card = member({ id: 'kodo/implementer' });
    const { app, parent } = setup(card);
    expect(() => spawn(app, parent, card)).toThrow('implementer requires explicit');
    const child = app.coordinator.mailbox.spawnHost(parent.id, { agent: card.id, objective: 'One module', scope: { write: ['src/feature'] } });
    expect(app.store.run(child.id as string).parentId).toBe(parent.id);
    expect(app.store.events(child.id as string, { types: ['agent.spawned'] })[0]?.data.origin).toBe('host');
    expect(() => spawn(app, parent, card, { scope: { write: ['src/feature'] } })).toThrow('overlaps child');
  });
});

describe('temporary card derivation', () => {
  it('canonicalizes overlays, persists one handle and keeps optional-to-required changes', () => {
    const card = member({ inputs: [{ name: 'goal', kind: 'text', required: true }, { name: 'files', kind: 'paths', required: false }], constraints: { scope: { write: ['src'] } } });
    const { app, parent } = setup(card);
    const first = deriveAgent(app.store, parent, `${card.id}@${card.version}`, { tools: ['file.read', 'file.list'], scope: { write: ['src/feature'] }, inputs_required: ['files'] });
    const again = deriveAgent(app.store, parent, `${card.id}@${card.version}`, { inputs_required: ['files'], scope: { write: ['src/feature'] }, tools: ['file.list', 'file.read'] });
    expect(again).toEqual(first);
    const record = app.store.derivedAgents.get(parent.sessionId, first.handle)!;
    expect(record.card.inputs?.every(field => field.required)).toBe(true);
    expect(record.card.constraints?.scope?.write).toEqual(['src/feature']);
    expect(app.store.events(parent.id, { types: ['agent.derived'] })).toHaveLength(1);
    const child = app.coordinator.mailbox.spawnHost(parent.id, { agent: first.handle, objective: 'Read', slots: { goal: 'Read', files: ['src/feature/entry.ts'] } });
    expect(app.store.run(child.id as string).card.id).toBe(first.handle);
    expect(() => app.store.card(first.handle, '0.0.0')).toThrow('not registered');
  });

  it('keeps one derivation level and requires named existing input declarations', () => {
    const card = member({ constraints: { scope: { write: ['src'] } }, inputs: [{ name: 'goal', kind: 'text', required: true }] });
    const { app, parent } = setup(card);
    const derived = deriveAgent(app.store, parent, `${card.id}@${card.version}`, {});
    expect(() => deriveAgent(app.store, parent, derived.handle, {})).toThrow('cannot be derived again');
    expect(() => deriveAgent(app.store, parent, `${card.id}@${card.version}`, { inputs_required: ['new_slot'] })).toThrow('inputs_required must be a subset');
    const configured = configureCard(card, { instructions: 'Report succinctly.' }, { permissions: ['read'], permissionOf: () => 'read' });
    expect(configured.constraints).toEqual(card.constraints);
    expect(configured.inputs).toEqual(card.inputs);
  });
});

describe('report completeness, acceptance and parent judgment', () => {
  function reportingCard() { return member({ routing: { use_when: ['Read'], mode: 'read' }, report: [{ name: 'checks', kind: 'calls', required: true }, { name: 'open_issues', kind: 'list', required: true }] }); }

  it('records settled call status separately from report completeness', () => {
    const card = reportingCard();
    const { app, parent } = setup(card);
    const child = spawn(app, parent, card);
    app.store.putCall({ id: 'check', runId: child.id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', requestRef: app.store.blob({}), resultRef: app.store.blob({ exitCode: 1 }), reservedTokens: 0 });
    const result = submitReport(app.store, child, { checks: ['check'], open_issues: ['check returned exit code 1'] });
    expect(result.report.calls).toEqual([expect.objectContaining({ id: 'check', status: 'succeeded', exitCode: 1 })]);
    expect(reportCompleteness(app.store, child)).toMatchObject({ status: 'complete', passed: true });
    expect(app.coordinator.mailbox.specs(child).some(spec => spec.name === 'report.submit')).toBe(true);
    expect(app.coordinator.mailbox.specs(parent).some(spec => spec.name === 'report.submit')).toBe(false);
  });

  it('requires all report fields and already-settled references from the reporting run', () => {
    const card = reportingCard();
    const { app, parent } = setup(card);
    const child = spawn(app, parent, card);
    app.store.putCall({ id: 'parent-check', runId: parent.id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', requestRef: app.store.blob({}), reservedTokens: 0 });
    expect(() => submitReport(app.store, child, { checks: [] })).toThrow('open_issues: required');
    expect(() => submitReport(app.store, child, { checks: ['parent-check'], open_issues: [] })).toThrow('settled tool call from this run');
    expect(reportCompleteness(app.store, child).status).toBe('missing');
  });

  it('exposes the exact card report schema without changing it as evidence accumulates', () => {
    const card = reportingCard();
    const { app, parent } = setup(card);
    const child = spawn(app, parent, card);
    const spec = app.coordinator.mailbox.specs(child).find(tool => tool.name === 'report.submit')!;
    const validate = new Ajv().compile(spec.parameters);
    expect(validate({ fields: { checks: [], open_issues: [] } })).toBe(true);
    expect(validate({ fields: { checks: [] } })).toBe(false);
    expect(validate({ fields: { checks: [], open_issues: [], summary: 'undeclared' } })).toBe(false);
    expect(validate({ fields: { checks: 'not a list', open_issues: [] } })).toBe(false);
    app.store.putCall({ id: 'synthetic:check', runId: child.id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', requestRef: app.store.blob(call('file.read', {}, 'check')), reservedTokens: 0 });
    expect(app.coordinator.mailbox.specs(child).find(tool => tool.name === 'report.submit')).toEqual(spec);
  });

  it('canonicalizes visible tool IDs once and keeps accepted references stable after ID reuse', () => {
    const { app, parent } = setup(reportingCard());
    const child = spawn(app, parent, reportingCard());
    // Isolated synthetic records model provider ID reuse; no checks are actually run.
    const recorded = { runId: child.id, step: 0, kind: 'tool' as const, name: 'file.read', status: 'succeeded' as const, effect: 'read' as const,
      requestRef: app.store.blob(call('file.read', {}, 'visible-check')), resultRef: app.store.blob({ exitCode: 1 }), reservedTokens: 0 };
    app.store.putCall({ ...recorded, id: 'first:visible-check' });
    const fields = { checks: ['visible-check'], open_issues: ['Synthetic check returned exit code 1.'] };
    const result = submitReport(app.store, child, fields);
    expect(fields.checks).toEqual(['visible-check']);
    expect(result.report.fields.checks).toEqual(['first:visible-check']);
    expect(result.report.calls).toMatchObject([{ id: 'first:visible-check', exitCode: 1 }]);
    app.store.putCall({ ...recorded, id: 'second:visible-check', step: 1 });
    expect(reportCompleteness(app.store, child)).toMatchObject({ status: 'complete', report: { fields: { checks: ['first:visible-check'] } } });
    expect(() => submitReport(app.store, child, fields)).toThrow('ambiguous');
    expect(submitReport(app.store, child, { ...fields, checks: ['second:visible-check'] }).report.fields.checks).toEqual(['second:visible-check']);
  });

  it('does not resolve a visible ID to an unfinished or another run\'s tool call', () => {
    const { app, parent } = setup(reportingCard());
    const child = spawn(app, parent, reportingCard());
    for (const status of ['planned', 'running', 'unknown'] as const) {
      app.store.putCall({ id: `synthetic:${status}`, runId: child.id, step: 0, kind: 'tool', name: 'file.read', status, effect: 'read', requestRef: app.store.blob(call('file.read', {}, status)), reservedTokens: 0 });
      expect(() => submitReport(app.store, child, { checks: [status], open_issues: [] })).toThrow('settled tool call from this run');
    }
    app.store.putCall({ id: 'parent:only', runId: parent.id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', requestRef: app.store.blob(call('file.read', {}, 'only')), reservedTokens: 0 });
    expect(() => submitReport(app.store, child, { checks: ['only'], open_issues: [] })).toThrow('settled tool call from this run');
    expect(reportCompleteness(app.store, child).status).toBe('missing');
  });

  it('uses bounded correction rounds and never labels a complete report as host acceptance', async () => {
    const card = reportingCard();
    const { app, parent } = setup(card);
    const child = spawn(app, parent, card);
    const signal = new AbortController().signal;
    const first = await checkCompletion(app.coordinator, child, answer('Read completed.'), signal);
    expect(first).toEqual({ kind: 'continue' });
    expect(app.store.events(child.id, { types: ['report.correction_requested'] })).toHaveLength(1);
    submitReport(app.store, app.store.run(child.id), { checks: [], open_issues: [] });
    const completed = await checkCompletion(app.coordinator, app.store.run(child.id), answer('Read completed.'), signal);
    expect(completed.kind).toBe('complete');
    if (completed.kind !== 'complete') throw new Error('completion expected');
    const result = app.store.readBlob<Record<string, unknown>>(completed.resultRef);
    expect(result.quality).toEqual({ status: 'not_checked' });
    expect(result.parentJudgment).toEqual({ status: 'not_checked' });
    expect(result.reportCompleteness).toMatchObject({ status: 'complete', passed: true });
    const unfinished = spawn(app, parent, card);
    expect((await checkCompletion(app.coordinator, unfinished, answer(), signal)).kind).toBe('continue');
    expect((await checkCompletion(app.coordinator, app.store.run(unfinished.id), answer(), signal)).kind).toBe('continue');
    expect(await checkCompletion(app.coordinator, app.store.run(unfinished.id), answer(), signal)).toMatchObject({ kind: 'fail', error: expect.stringContaining('REPORT_INCOMPLETE') });
  });

  it('paginates structured reports independently and keeps call evidence subject to inspection permission', () => {
    const card = reportingCard();
    const { app, parent } = setup(card);
    const child = spawn(app, parent, card);
    app.store.putCall({ id: 'exec-check', runId: child.id, step: 0, kind: 'tool', name: 'process.exec', status: 'succeeded', effect: 'read', requestRef: app.store.blob({}), resultRef: app.store.blob({ exitCode: 1 }), reservedTokens: 0 });
    submitReport(app.store, child, { checks: ['exec-check'], open_issues: ['A long pending issue '.repeat(100)] });
    const view = inspectRun(app.store, parent, { run_id: child.id, max_chars: 256 }) as { reportCompleteness: { status: string }; report: { text: string; next: { run_id: string; section: 'report'; content_offset: number; max_chars: number } }; hostAcceptance: { status: string } };
    expect(view.reportCompleteness.status).toBe('complete');
    expect(view.hostAcceptance.status).toBe('not_checked');
    expect(view.report.next.section).toBe('report');
    const second = inspectRun(app.store, parent, view.report.next) as { report: { contentOffset: number }; result: null };
    expect(second.report.contentOffset).toBe(256);
    expect(second.result).toBeNull();
    const narrow = inspectRun(app.store, { ...parent, permissions: ['read'] }, { run_id: child.id, max_chars: 32000 }) as { report: { text: string } };
    expect(JSON.parse(narrow.report.text)).toMatchObject({ fields: { checks: [] }, calls: [], omittedCalls: 1 });
  });

  it('runs the report tool through the coordinator and delivers separate outcome layers to the parent', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'entry.txt'), 'A checked source file.\n');
    let childId = '';
    const app: Application = new Application(path.join(root, '.state'), { async complete(request) {
      const runId = /Run ID: ([^. ]+)\./u.exec(request.messages[0]!.content!)![1]!;
      const current = app.store.run(runId);
      if (!current.parentId) return current.step === 0 ? calls(call('wait_for_events', { run_ids: [childId] })) : answer('Reviewed the member evidence.');
      if (current.step === 0) return calls(call('file.read', { path: 'entry.txt' }));
      if (current.step === 1) {
        const checked = request.messages.findLast(message => message.role === 'tool')!;
        if (checked.role !== 'tool') throw new Error('expected a visible tool result');
        return calls(call('report.submit', { fields: { checks: [checked.tool_call_id], open_issues: [] } }));
      }
      return answer('Read entry.txt and submitted the report.');
    } }, undefined, { agentFactors: { D: false, E: false, B: false, C: true } });
    apps.push(app);
    const card = reportingCard();
    app.registerCard(card);
    const parent = app.createRun({ objective: 'Inspect the entry file', workspace: root, binding, permissions: ['read'] });
    childId = spawn(app, parent, card).id;
    expect((await app.run(parent.id)).status).toBe('completed');
    expect(app.store.run(childId).status).toBe('completed');
    expect(app.store.calls(childId).find(item => item.name === 'report.submit')?.status).toBe('succeeded');
    const notification = app.store.message(`terminal:${childId}`)!;
    expect(JSON.parse(notification.content)).toMatchObject({ reportCompleteness: { status: 'complete', passed: true }, hostAcceptance: { status: 'not_checked' }, parentJudgment: { status: 'not_checked' } });
    expect(JSON.parse(notification.content).reportCompleteness.report).toBeUndefined();
  });
});
