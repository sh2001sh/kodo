// compaction-v3: off / mask / summary on the frozen continuation tasks A/B.
// Registration r2 (2026-10-24, batch 1 of docs/kodo-next-optimization-plan.md)
// replaces the T8 runner logic; r3 re-registers it unchanged for the batch-5
// estimator fix; T8 evidence keeps its own registration snapshot
// in its summary.json and is not rescored by this version.
// Verdict: passed only when the registered matrix is complete and valid, every
// arm meets the absolute delivery floor, the summary arm installs summaries with
// no deterministic failure, and its measured total does not exceed off. Any
// unknown usage makes the cost comparison, and therefore the verdict, inconclusive.

import console from 'node:console';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { fixtures, seedWorkspace } from './continuation/fixtures.mjs';
import { dryBinding, errorText, eventCounts, finalText, parseArgs, relayBinding, resolveCredentials, runNode, sessionUsage, stamp, writeJson } from './v3-eval-common.mjs';
import { deliveryCheck, protectedSnapshot, treeDigest } from './v3-eval-ledger.mjs';
import { completeness, fatalRules, parsePrices, prepareOutput, priceLedger, runMatrix, writeRegistration } from './v3-eval-matrix.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REGISTRATION = Object.freeze({
  id: 'compaction-v3-r3-20261024', window: 65_536, output: 8_192, repeats: 2,
  arms: Object.freeze({ off: null, mask: { strategy: 'mask' }, summary: { strategy: 'summary' } }),
  qualityFloor: 0.75,
  passLine: { deterministicFailures: 0, costNotAboveOff: true }, observations: ['compactionShare', 'uncachedInputVsOff', 'outputVsOff', 'wallVsOff'],
  stopRules: ['relay rejection', 'matrix call/token budget', 'protected-path violation', 'unreconciled relay usage', 'two consecutive provider-failure cells'],
  revisions: ['2026-10-24: maintenance share < 15% demoted from pass line to observation', '2026-10-24 r2: whole-matrix stop, completeness, quality floor, unknown usage => inconclusive', '2026-10-24 r3: same runner; runtime estimator calibrates across the trailing kernel-state message (batch 5), hypothesis: summary triggers later with fewer installs and no request above the hard window'],
});
const TOOLS = ['file.read', 'file.list', 'file.search', 'file.apply_patch', 'file.patch', 'shell.exec', 'process.exec', 'history.read', 'history.search', 'todo.read', 'todo.write'];
const DETERMINISTIC = /SUMMARY_(EMPTY|NO_GAIN|WINDOW)/u;
const OPTIONS = {
  'dry-run': { kind: 'boolean', default: false }, run: { kind: 'boolean', default: false },
  model: { kind: 'string', default: 'deepseek-v4.1-flash' }, provider: { kind: 'string', default: 'codego1' },
  'provider-config': { kind: 'string', default: undefined }, out: { kind: 'string', default: undefined },
  arms: { kind: 'list', default: Object.keys(REGISTRATION.arms) }, tasks: { kind: 'list', default: ['task-a', 'task-b'] },
  repeats: { kind: 'integer', default: REGISTRATION.repeats }, 'work-input': { kind: 'integer', default: 0 }, 'max-calls': { kind: 'integer', default: 64 }, 'max-tokens': { kind: 'integer', default: 4_000_000 },
  'matrix-calls': { kind: 'integer', default: 600 }, 'matrix-tokens': { kind: 'integer', default: 20_000_000 }, prices: { kind: 'string', default: undefined },
};

/** Ordered cell keys; the arm order rotates per repeat so no arm always runs first. */
export function compactionPlan(tasks, arms, repeats) {
  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat++) for (const task of tasks) {
    const shift = (repeat - 1) % arms.length;
    for (const arm of [...arms.slice(shift), ...arms.slice(0, shift)]) plan.push(`${task}:${arm}:${repeat}`);
  }
  return plan;
}

function card(app, fixture, tools) {
  return app.parseCard(`---
schema_version: 1
id: v3-eval/${fixture.id}
version: 1.0.0
name: Continuation ${fixture.id}
description: Read the project docs, repair the pager and verify.
capabilities:
  tools: ${JSON.stringify(tools)}
---
Work directly in the current workspace. Read the documentation and source you need, fix the defect, run \`node verify.mjs\` until it passes, and finish with a short delivery summary of what changed and what you verified.
Do not modify verify.mjs, docs/ or src/legacy.js. Do not claim checks you did not run.`);
}

/** Zero-cost provider: reads the registered docs in order, answers summaries, then finishes. */
function dryProvider(fixture) {
  let reads = 0;
  return { async complete(request) {
    const usage = { input: 1000, output: 50 };
    if (request.toolChoice === 'none') return { message: { role: 'assistant', content: 'Goal: fix pager. Constraint: MAX_PAGE_SIZE stays 37. Next: run node verify.mjs.' }, finishReason: 'stop', usage };
    if (reads < fixture.dryRunReadFiles.length) {
      const file = fixture.dryRunReadFiles[reads++];
      return { message: { role: 'assistant', content: null, tool_calls: [{ id: `read-${reads}`, name: 'file.read', arguments: JSON.stringify({ path: file }) }] }, finishReason: 'tool_calls', usage };
    }
    return { message: { role: 'assistant', content: 'Dry run finished without repairing the pager.' }, finishReason: 'stop', usage };
  } };
}

async function execute(app, cli, fixture, workspace, binding, result) {
  const exposed = new Set(app.coordinator.tools.specs(TOOLS, { permissions: ['read', 'write', 'exec'] }).map(spec => spec.name));
  const run = app.createRun({ objective: fixture.objective, workspace, binding, card: card(app, fixture, TOOLS.filter(name => exposed.has(name))), permissions: ['read', 'write', 'exec'],
    budget: { maxContextTokens: REGISTRATION.window, maxOutputTokens: REGISTRATION.output, maxModelCalls: cli['max-calls'], maxTokens: cli['max-tokens'], maxToolCalls: 200, maxDurationMs: 900_000 } });
  const final = await app.run(run.id).catch(error => ({ ...app.store.run(run.id), error: errorText(error) }));
  const failed = app.store.events(run.id).filter(event => event.type === 'context.summary.failed').map(event => String(event.data.reason ?? ''));
  Object.assign(result, {
    status: final.status, error: final.error ?? null, usage: sessionUsage(app.store, run.sessionId),
    compaction: eventCounts(app.store, run.id, 'context.'),
    summaryFailures: failed, deterministicFailures: failed.filter(reason => DETERMINISTIC.test(reason)),
    finalText: finalText(app.store, app.store.run(run.id)).slice(0, 2000),
  });
}

async function runCell({ cli, credentials, key, remaining, outRoot }) {
  const [task, arm, repeat] = key.split(':');
  const fixture = fixtures.find(item => item.id === task);
  const dir = path.join(outRoot, `${task}-${arm}-${repeat}`);
  const workspace = path.join(dir, 'workspace');
  await mkdir(path.join(dir, 'wire'), { recursive: true });
  seedWorkspace(fixture, workspace);
  const before = protectedSnapshot(workspace, fixture.protected);
  const base = REGISTRATION.arms[arm];
  const compaction = base && cli['work-input'] ? { ...base, workInputTokens: cli['work-input'] } : base;
  let relay;
  let binding = dryBinding(cli.model, REGISTRATION.window, REGISTRATION.output);
  if (cli.run) ({ relay, binding } = await relayBinding({ directory: path.join(dir, 'wire'), credentials, model: cli.model, maxCalls: Math.min(cli['max-calls'], remaining.requests), maxTokens: Math.min(cli['max-tokens'], remaining.tokens), maxOutputTokens: REGISTRATION.output, contextTokens: REGISTRATION.window }));
  const { Application } = await import('../../dist/application/index.js');
  const app = new Application(path.join(dir, 'state'), cli.run ? undefined : dryProvider(fixture), undefined, { exploration: false, ...(compaction ? { compaction } : {}) });
  const result = { task, arm, repeat: Number(repeat), policy: compaction ?? null, status: null, error: null };
  try { await execute(app, cli, fixture, workspace, binding, result); }
  catch (error) { result.error = errorText(error); }
  finally {
    await app.shutdown().catch(error => { result.shutdownError = errorText(error); });
    if (relay) { await relay.close(); result.relay = { requests: relay.stats.requests, tokens: relay.stats.tokens, rejected: relay.stats.rejected, estimated: relay.stats.estimated }; }
  }
  const verify = runNode(['verify.mjs'], workspace);
  result.verifyExit = verify.exitCode;
  result.delivery = deliveryCheck({ status: result.status, finalText: result.finalText, acceptance: verify.exitCode === 0, before, after: protectedSnapshot(workspace, fixture.protected) });
  result.completed = result.delivery.ok;
  await writeJson(path.join(dir, 'report.json'), { ...result, verifyStdout: verify.stdout.slice(-4000) }, credentials?.key);
  return result;
}
function armTotals(results) {
  const byArm = {};
  for (const result of results) {
    const arm = (byArm[result.arm] ??= { runs: 0, completed: 0, totalTokens: 0, inputTokens: 0, cacheRead: 0, cacheWrite: 0, uncachedInput: 0, outputTokens: 0, wallMs: 0, compactionTokens: 0, unknownCalls: 0, deterministicFailures: 0, summaryFailures: 0, installs: 0, skips: 0, masked: 0, peakMainInput: 0 });
    const usage = result.usage ?? {};
    arm.runs++; arm.completed += result.completed ? 1 : 0;
    arm.totalTokens += usage.totalTokens ?? 0; arm.inputTokens += usage.inputTokens ?? 0; arm.cacheRead += usage.cacheRead ?? 0; arm.cacheWrite += usage.cacheWrite ?? 0;
    arm.uncachedInput += usage.uncachedInput ?? 0; arm.outputTokens += usage.outputTokens ?? 0; arm.wallMs += usage.wallMs ?? 0;
    arm.compactionTokens += usage.compactionTokens ?? 0;
    // A cell without any ledger (crashed before the run) is unknown spending too.
    arm.unknownCalls += result.usage ? usage.unknownCalls ?? 0 : 1;
    arm.deterministicFailures += result.deterministicFailures?.length ?? 0; arm.summaryFailures += result.summaryFailures?.length ?? 0;
    arm.installs += result.compaction?.['context.summary.installed'] ?? 0;
    arm.skips += result.compaction?.['context.summary.skipped'] ?? 0;
    arm.masked += (result.compaction?.['context.compacted'] ?? 0) + (result.compaction?.['context.archived'] ?? 0);
    arm.peakMainInput = Math.max(arm.peakMainInput, usage.peakMainInput ?? 0);
  }
  for (const arm of Object.values(byArm)) {
    arm.completionRate = arm.completed / arm.runs;
    arm.compactionShare = arm.totalTokens ? arm.compactionTokens / arm.totalTokens : 0;
    arm.usageComplete = arm.unknownCalls === 0;
  }
  return byArm;
}

const ratio = (value, base) => (base ? value / base : null);

/**
 * Verdict over a registered plan: 'invalid' (duplicate, unexpected or mixed-policy
 * cells), 'inconclusive' (missing cells or unknown usage), 'failed' or 'passed'.
 * `policyFor(arm)` is the compaction configuration the registration requires.
 */
export function summarize(results, { plan, policyFor = arm => REGISTRATION.arms[arm] ?? null, prices = null } = {}) {
  const byArm = armTotals(results);
  const matrix = completeness(plan ?? results.map(result => result.key), results, result => policyFor(result.arm));
  const summary = byArm.summary, off = byArm.off;
  const quality = Object.fromEntries(Object.entries(byArm).map(([name, arm]) => [name, arm.completionRate >= REGISTRATION.qualityFloor]));
  const costKnown = Boolean(summary?.usageComplete && off?.usageComplete);
  // Cost is priced when prices are registered, otherwise measured total tokens.
  const cost = summary && off ? {
    summary: priceLedger({ ...summary, complete: summary.usageComplete }, prices), off: priceLedger({ ...off, complete: off.usageComplete }, prices),
    basis: prices ? 'price' : 'tokens', certain: costKnown,
  } : null;
  const passLine = summary && off ? {
    // A summary arm that never installed a summary did not test the summary path.
    summaryExercised: summary.installs > 0,
    noDeterministicFailure: summary.deterministicFailures === REGISTRATION.passLine.deterministicFailures,
    qualityFloor: quality.summary && quality.off,
    completionNotBelowOff: summary.completionRate >= off.completionRate,
    costNotAboveOff: costKnown ? cost.summary.value <= cost.off.value : null,
  } : null;
  const observations = summary ? {
    compactionShare: summary.compactionShare, tokensVsOff: ratio(summary.totalTokens, off?.totalTokens), peakMainInputVsOff: ratio(summary.peakMainInput, off?.peakMainInput),
    uncachedInputVsOff: ratio(summary.uncachedInput, off?.uncachedInput), outputVsOff: ratio(summary.outputTokens, off?.outputTokens), wallVsOff: ratio(summary.wallMs, off?.wallMs),
  } : null;
  const reasons = [];
  if (!matrix.valid) reasons.push('MATRIX_INVALID');
  if (!matrix.complete) reasons.push('MATRIX_INCOMPLETE');
  if (!passLine) reasons.push('ARMS_MISSING');
  if (passLine && !costKnown) reasons.push('USAGE_UNKNOWN');
  const failedChecks = passLine ? Object.entries(passLine).filter(([, value]) => value === false).map(([name]) => name) : [];
  // Failed checks only count as a failure on a complete matrix; a partial one stays inconclusive.
  const verdict = !matrix.valid ? 'invalid' : !matrix.complete || !passLine ? 'inconclusive' : failedChecks.length ? 'failed' : reasons.length ? 'inconclusive' : 'passed';
  return { byArm, matrix, passLine, observations, cost, reasons: [...reasons, ...failedChecks], verdict, passed: verdict === 'passed' };
}

function fixtureDigests(tasks) {
  return Object.fromEntries(fixtures.filter(item => tasks.includes(item.id)).map(item => [item.id, { assets: treeDigest(item.assetsDir), protected: item.protected }]));
}

async function main() {
  const cli = parseArgs(process.argv.slice(2), OPTIONS);
  for (const arm of cli.arms) if (!(arm in REGISTRATION.arms)) throw new Error(`unknown arm ${arm}`);
  for (const task of cli.tasks) if (!fixtures.some(item => item.id === task)) throw new Error(`unknown task ${task}`);
  const prices = parsePrices(cli.prices);
  const credentials = cli.run ? await resolveCredentials({ providerConfig: cli['provider-config'], provider: cli.provider }) : undefined;
  const outRoot = path.resolve(cli.out ?? `.kodo/v3-compaction-${cli.run ? 'paid' : 'dry'}-${stamp()}`);
  prepareOutput(outRoot);
  const plan = compactionPlan(cli.tasks, cli.arms, cli.repeats);
  const policyFor = arm => (REGISTRATION.arms[arm] && cli['work-input'] ? { ...REGISTRATION.arms[arm], workInputTokens: cli['work-input'] } : REGISTRATION.arms[arm]);
  const settings = { ...cli, mode: cli.run ? 'paid' : 'dry-run', providerHost: credentials?.host ?? null, prices };
  writeRegistration(outRoot, { registration: REGISTRATION, plan, settings, fixtures: fixtureDigests(cli.tasks), repoRoot });
  let interrupted = null;
  process.once('SIGINT', () => { interrupted = 'INTERRUPTED'; console.error('stopping after the current cell'); });
  const { results, stop, spent } = await runMatrix({
    outRoot, plan, secret: credentials?.key, fatal: fatalRules(), budget: { requests: cli['matrix-calls'], tokens: cli['matrix-tokens'] }, shouldStop: () => interrupted,
    runCell: async (key, remaining) => {
      const result = await runCell({ cli, credentials, key, remaining, outRoot });
      console.error(`${key}: ${result.status} delivery=${result.delivery.ok ? 'ok' : result.delivery.reasons.join('+')} tokens=${result.usage?.totalTokens ?? '?'} unknown=${result.usage?.unknownCalls ?? '?'} installs=${result.compaction?.['context.summary.installed'] ?? 0}${result.error ? ` error=${result.error}` : ''}`);
      return result;
    },
  });
  if (stop) console.error(`matrix stopped at ${stop.at}: ${stop.reason}`);
  const report = { registration: REGISTRATION, mode: settings.mode, model: cli.model, workInputTokens: cli['work-input'] || null, providerHost: settings.providerHost, stop, spent, results, ...summarize(results, { plan, policyFor, prices }) };
  await writeJson(path.join(outRoot, 'summary.json'), report, credentials?.key);
  console.log(JSON.stringify({ out: outRoot, stop, byArm: report.byArm, passLine: report.passLine, observations: report.observations, verdict: report.verdict, reasons: report.reasons }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
