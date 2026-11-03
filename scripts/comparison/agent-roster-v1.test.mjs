import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { delegationMetrics, experimentPlan, FACTORS, main, resolveTeamContracts, summarize } from './agent-roster-v1.mjs';

test('adoption arms are independent and second model only repeats R0/RABC', () => {
  const plan = experimentPlan({ models: ['first', 'second'] });
  assert.equal(plan.length, 28);
  assert.deepEqual([...new Set(plan.filter(cell => cell.model === 'second').map(cell => cell.arm))], ['R0', 'RABC']);
  assert.deepEqual(FACTORS.RB, { A: false, B: true, C: false });
  assert.equal(plan[0].task, 'ky');
  assert.ok(plan.findIndex(cell => cell.task === 'frontend-backend') > plan.findLastIndex(cell => cell.task === 'ky'));
  const benefit = experimentPlan({ models: ['first', 'second'], kind: 'benefit' });
  assert.equal(benefit.length, 16);
  assert.deepEqual([...new Set(benefit.map(cell => cell.arm))], ['solo', 'fixed-team']);
});

test('insufficient repeats and incomplete matrices remain descriptive', () => {
  const plan = experimentPlan({ models: ['first', 'second'], repeats: 1 });
  assert.equal(summarize(plan, plan.map(cell => ({ key: cell.key }))).descriptiveOnly, true);
  assert.equal(summarize(experimentPlan({ models: ['first', 'second'] }), []).descriptiveOnly, true);
  assert.throws(() => experimentPlan({ models: ['first', 'first'] }), /distinct/);
  assert.throws(() => experimentPlan({ models: ['first', 'second'], repeats: 0 }), /positive/);
});

test('fixed teams share host-created contract artifacts and reject absent contracts', () => {
  const team = [{ agent: 'kodo/implementer', slots: { requirement: 'Implement behavior', contract: '$contract:behavior' } }, { agent: 'kodo/tester', slots: { behavior_contract: '$contract:behavior' } }];
  const created = [];
  const resolved = resolveTeamContracts(team, { behavior: 'Inputs and outputs are fixed.' }, (name, content) => { created.push({ name, content }); return 'artifact-1'; });
  assert.equal(created.length, 1);
  assert.equal(resolved[0].slots.contract, 'artifact-1');
  assert.equal(resolved[1].slots.behavior_contract, 'artifact-1');
  assert.equal(team[0].slots.contract, '$contract:behavior');
  assert.throws(() => resolveTeamContracts(team, {}, () => 'unused'), /unknown team contract/);
});

test('metrics count discovery rows, rank, slot failures and report corrections separately', () => {
  const result = delegationMetrics({ initialMembers: ['known'], calls: [
    { name: 'agent.directory', result: { cards: [], nodes: [{ path: 'code' }] } },
    { name: 'agent.search', result: { cards: [{ id: 'tester' }, { id: 'reviewer' }] } },
    { name: 'spawn_agent', status: 'failed', result: { error: 'INPUT_SLOTS: missing contract' } },
    { name: 'spawn_agent', status: 'succeeded', arguments: { agent: 'reviewer' } },
    { name: 'agent.search', result: { status: 'budget_exhausted', cards: [] } },
  ], children: [{ card: { id: 'reviewer', routing: { mode: 'review' } } }], events: [{ type: 'report.correction_requested' }, { type: 'child.prefix_shared', data: { toolsEqual: false } }] });
  assert.equal(result.firstSelectionRank, 3);
  assert.equal(result.delegationCalls, 2);
  assert.equal(result.spawnedChildren, 1);
  assert.equal(result.returnedMembers, 2);
  assert.equal(result.returnedCategories, 1);
  assert.equal(result.budgetExhausted, 1);
  assert.equal(result.slotValidationErrors, 1);
  assert.equal(result.reportCorrections, 1);
});

test('selection rank resolves immutable versions and temporary member provenance', () => {
  const initialMembers = [{ id: 'kodo/explorer', version: '1.0.0' }, { id: 'kodo/reviewer', version: '2.0.0' }];
  const calls = [{ name: 'spawn_agent', status: 'succeeded', arguments: { agent: 'kodo/reviewer@2.0.0' } }];
  assert.equal(delegationMetrics({ initialMembers, calls, children: [], events: [] }).firstSelectionRank, 2);
  calls[0].arguments.agent = 'kodo/reviewer@1.0.0';
  assert.equal(delegationMetrics({ initialMembers, calls, children: [], events: [] }).firstSelectionRank, null);
  calls[0].arguments.agent = 'tmp:reviewer-test';
  calls[0].result = { id: 'child-1' };
  const children = [{ id: 'child-1', card: { id: 'tmp:reviewer-test', derivedFrom: { id: 'kodo/reviewer', version: '2.0.0' } } }];
  assert.equal(delegationMetrics({ initialMembers, calls, children, events: [] }).firstSelectionRank, 2);
});

test('follow-up metrics separate attempts, committed runs and reused agent identities', () => {
  const card = { id: 'kodo/explorer', routing: { mode: 'read' } };
  const first = { id: 'run-1', agentId: 'agent-1', card };
  const children = [first, { id: 'run-2', agentId: 'agent-1', card }, { id: 'run-3', agentId: 'agent-1', card }, { id: 'run-4', agentId: 'agent-2', card }, first];
  const metrics = delegationMetrics({ children, calls: [
    { name: 'spawn_agent', status: 'succeeded', result: { id: 'run-1' } },
    { name: 'followup_task', status: 'succeeded', result: { id: 'run-2' } },
    { name: 'followup_task', status: 'succeeded', result: { id: 'run-2' } },
    { name: 'followup_task', status: 'failed', result: { id: 'run-4', error: 'AGENT_BUSY' } },
  ], events: [
    { type: 'agent.followup', data: { result: { id: 'run-2' } } },
    { type: 'agent.followup', data: { result: { id: 'run-3' } } },
    { type: 'agent.followup', data: { result: { id: 'run-3' } } },
  ] });
  assert.equal(metrics.delegationCalls, 1);
  assert.equal(metrics.spawnedChildren, 5); // Historical raw child-row metric remains unchanged.
  assert.equal(metrics.followupCalls, 3);
  assert.equal(metrics.successfulFollowupCalls, 2);
  assert.equal(metrics.childRuns, 4);
  assert.equal(metrics.distinctChildAgents, 2); // Sharing a card does not imply sharing an agent.
  assert.equal(metrics.followupRuns, 2);
  assert.equal(metrics.reusedChildAgents, 1);
});

test('legacy identity follows only a terminal same-parent same-session continuation chain', () => {
  const base = { parentId: 'main', sessionId: 'session', status: 'completed', card: { id: 'kodo/explorer' } };
  const children = [
    { ...base, id: 'old-1' },
    { ...base, id: 'old-2', continuationOf: 'old-1' },
    { ...base, id: 'old-3', continuationOf: 'old-2' },
    { ...base, id: 'other-parent', parentId: 'other-main', continuationOf: 'old-1' },
    { ...base, id: 'other-session', sessionId: 'other-session', continuationOf: 'old-1' },
    { ...base, id: 'missing-source', continuationOf: 'missing' },
  ];
  const metrics = delegationMetrics({ children, calls: [], events: [{ type: 'agent.followup', data: { result: { id: 'old-3' } } }] });
  assert.equal(metrics.childRuns, 6);
  assert.equal(metrics.distinctChildAgents, 4);
  assert.equal(metrics.followupCalls, 0);
  assert.equal(metrics.followupRuns, 1);
  assert.equal(metrics.reusedChildAgents, 1);
});

test('follow-up calls without a recorded child do not invent reuse or a committed run', () => {
  const metrics = delegationMetrics({ children: [], calls: [
    { name: 'followup_task', status: 'succeeded', result: { id: 'absent' } },
  ], events: [{ type: 'agent.followup', data: { result: { id: 'absent' } } }] });
  assert.equal(metrics.followupCalls, 1);
  assert.equal(metrics.successfulFollowupCalls, 1);
  assert.equal(metrics.childRuns, 0);
  assert.equal(metrics.distinctChildAgents, 0);
  assert.equal(metrics.followupRuns, 0);
  assert.equal(metrics.reusedChildAgents, 0);
});

test('dry run freezes task inputs and emits no model results', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-roster-runner-'));
  try {
    const fixture = path.join(root, 'fixture');
    mkdirSync(fixture);
    writeFileSync(path.join(fixture, 'input.txt'), 'frozen source');
    const manifest = path.join(root, 'manifest.json');
    writeFileSync(manifest, JSON.stringify({ tasks: ['ky', 'frontend-backend'].map(id => ({ id, source: './fixture', objective: `Implement the ${id} task.`, acceptance: { program: '$node', args: ['--version'] }, protected: ['input.txt'] })) }));
    const out = path.join(root, 'out');
    const report = await main(['--dry-run', '--manifest', manifest, '--out', out, '--models', 'first,second']);
    assert.equal(report.dryRun, true);
    assert.equal(report.descriptiveOnly, true);
    assert.equal(report.coverage.complete, false);
    assert.equal(JSON.parse(readFileSync(path.join(out, 'dry-run.json'), 'utf8')).noModelCalls, true);
    assert.equal(readFileSync(path.join(out, 'fixtures', 'ky', 'input.txt'), 'utf8'), 'frozen source');
    assert.equal(JSON.parse(readFileSync(path.join(out, 'registration.json'), 'utf8')).registration.id, 'agent-roster-v1');
    await assert.rejects(() => main(['--dry-run', '--manifest', manifest, '--out', out, '--models', 'first,second']), /not empty/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
