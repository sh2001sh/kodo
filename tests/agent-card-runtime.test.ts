import path from 'node:path';
import { Ajv } from 'ajv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import type { ApplicationOptions } from '../src/application/index.js';
import { parseCard } from '../src/agents/card.js';
import { reportCompleteness, submitReport } from '../src/runtime/report.js';
import { checkCompletion } from '../src/runtime/completion.js';
import { inspectRun } from '../src/runtime/inspection.js';
import { intersectFileScopes, resolveScopeVariables } from '../src/runtime/scope.js';
import { KodoError } from '../src/runtime/types.js';
import type { Card, Run } from '../src/runtime/types.js';
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
  const parent = app.createRun({ objective: 'Deliver the feature', workspace: root, binding, permissions: ['read', 'write', 'exec'], card, ...(mainScope ? { scope: mainScope } : {}) });
  return { app, root, parent };
}
/** Host-shaped spawn: a child inherits the parent card and may only narrow permissions/scope. */
function spawn(app: Application, parent: Run, args: Record<string, unknown> = {}): Run {
  const request = { objective: 'Inspect this module', ...args };
  const value = app.coordinator.mailbox.execute(parent, 'spawn', 'spawn_agent', app.coordinator.mailbox.validate(parent, 'spawn_agent', JSON.stringify(request))) as { id: string };
  return app.store.run(value.id);
}

describe('scope helpers', () => {
  it('intersects directory roots without expanding current files and resolves project lists', () => {
    expect(intersectFileScopes({ read: ['src', 'docs'], write: ['src'] }, { read: ['src/feature'], write: ['src/feature', 'tests'] })).toEqual({ read: ['src/feature'], write: ['src/feature'] });
    expect(intersectFileScopes({}, { write: [] })).toEqual({ write: [] });
    expect(resolveScopeVariables({ write: ['${project.tests}'] }, { 'project.tests': ['tests/unit', 'tests/integration'] })).toEqual({ write: ['tests/unit', 'tests/integration'] });
    expect(() => resolveScopeVariables({ write: ['${project.tests}'] })).toThrow('unresolved scope variable');
  });
});

describe('child inheritance and shared write admission', () => {
  it('inherits the parent card and keeps the host overlap checks from the kernel fix', () => {
    const card = member();
    const { app, parent } = setup(card);
    const child = spawn(app, parent, { scope: { write: ['src/feature'] } });
    expect(child.card.digest).toBe(parent.card.digest);
    expect(child.permissions).toEqual(app.store.session(parent.sessionId).permissions);
    expect(child.scope?.write).toEqual(['src/feature']);
    // A second live writer on the same roots is rejected whole.
    expect(() => spawn(app, parent, { scope: { write: ['src/feature/entry.ts'] } })).toThrow(/overlaps child/u);
    expect(app.store.listRuns(parent.sessionId)).toHaveLength(2);
    expect(spawn(app, parent, { scope: { write: ['docs'] } })).toHaveProperty('parentId', parent.id);
  });

  it('rejects removed card-selection arguments and unknown tools', () => {
    const { app, parent } = setup(member());
    expect(spawn(app, parent, { permissions: ['read'] }).permissions).toEqual(['read']);
    for (const removed of [{ agent: 'local/member@1.0.0' }, { slots: { goal: 'x' } }, { configuration: { instructions: 'x' } }, { card_id: 'local/member', card_version: '1.0.0' }]) {
      expect(() => spawn(app, parent, removed)).toThrow(/schema/u);
    }
    expect(() => app.registerCard({ ...member(), id: 'local/bad', tools: [...member().tools, 'workspace.integrate'] })).toThrow(KodoError);
  });
});

describe('report completeness, acceptance and parent judgment', () => {
  function reportingCard() { return member({ routing: { use_when: ['Read'], mode: 'read' }, report: [{ name: 'checks', kind: 'calls', required: true }, { name: 'open_issues', kind: 'list', required: true }] }); }

  it('records settled call status separately from report completeness', () => {
    const card = reportingCard();
    const { app, parent } = setup(card);
    const child = spawn(app, parent);
    app.store.putCall({ id: 'check', runId: child.id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', requestRef: app.store.blob({}), resultRef: app.store.blob({ exitCode: 1 }), reservedTokens: 0 });
    const result = submitReport(app.store, child, { checks: ['check'], open_issues: ['check returned exit code 1'] });
    expect(result.report.calls).toEqual([expect.objectContaining({ id: 'check', status: 'succeeded', exitCode: 1 })]);
    expect(reportCompleteness(app.store, child)).toMatchObject({ status: 'complete', passed: true });
    expect(app.coordinator.mailbox.specs(child).some(spec => spec.name === 'report.submit')).toBe(true);
    expect(app.coordinator.mailbox.specs(app.store.run(parent.id)).some(spec => spec.name === 'report.submit')).toBe(false);
  });

  it('requires all report fields and already-settled references from the reporting run', () => {
    const card = reportingCard();
    const { app, parent } = setup(card);
    const child = spawn(app, parent);
    app.store.putCall({ id: 'parent-check', runId: parent.id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', requestRef: app.store.blob({}), reservedTokens: 0 });
    expect(() => submitReport(app.store, child, { checks: [] })).toThrow('open_issues: required');
    expect(() => submitReport(app.store, child, { checks: ['parent-check'], open_issues: [] })).toThrow('settled tool call from this run');
    expect(reportCompleteness(app.store, child).status).toBe('missing');
  });

  it('exposes the exact card report schema without changing it as evidence accumulates', () => {
    const card = reportingCard();
    const { app, parent } = setup(card);
    const child = spawn(app, parent);
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
    const child = spawn(app, parent);
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
    const child = spawn(app, parent);
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
    const child = spawn(app, parent);
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
    const unfinished = spawn(app, parent);
    expect((await checkCompletion(app.coordinator, unfinished, answer(), signal)).kind).toBe('continue');
    expect((await checkCompletion(app.coordinator, app.store.run(unfinished.id), answer(), signal)).kind).toBe('continue');
    expect(await checkCompletion(app.coordinator, app.store.run(unfinished.id), answer(), signal)).toMatchObject({ kind: 'fail', error: expect.stringContaining('REPORT_INCOMPLETE') });
  });

  it('paginates structured reports independently and keeps call evidence subject to inspection permission', () => {
    const card = reportingCard();
    const { app, parent } = setup(card);
    const child = spawn(app, parent);
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
    const parent = app.createRun({ objective: 'Inspect the entry file', workspace: root, binding, permissions: ['read'], card });
    childId = spawn(app, parent).id;
    expect((await app.run(parent.id)).status).toBe('completed');
    expect(app.store.run(childId).status).toBe('completed');
    expect(app.store.calls(childId).find(item => item.name === 'report.submit')?.status).toBe('succeeded');
    const notification = app.store.message(`terminal:${childId}`)!;
    expect(JSON.parse(notification.content)).toMatchObject({ reportCompleteness: { status: 'complete', passed: true }, hostAcceptance: { status: 'not_checked' }, parentJudgment: { status: 'not_checked' } });
    expect(JSON.parse(notification.content).reportCompleteness.report).toBeUndefined();
  });
});
