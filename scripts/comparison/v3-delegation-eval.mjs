// delegation-explore T8: does the main agent use explore when investigation is
// broad, and stay direct when the path is known? Newly registered runner.
// Groups: research (unfamiliar repository, read-only, three located answers) with
// an explore arm and a Solo arm (explore/spawn_agent removed from the request
// tools), and small (known-path one-line fix) with the explore arm only.
// Pre-declared observation lines per model: research delegation >= 2/3; small
// delegation = 0; research success not below Solo.
// Revision 2026-10-24: the three-question research task was solved directly in
// about 20 tool calls by both models, below the point where delegation pays. A
// heavier survey group (eight independent questions across subsystems) is added
// with the same lines; answers are scored per numbered answer line.
// Revision 2026-10-24 (round 2): prompt-only triggering never fired, so the
// runtime explore nudge (default after 8 direct reads) is on in explore arms and
// off in Solo arms, where explore is not offered. Delegation after the nudge is
// recorded separately.

// Registration r2 (2026-10-24, batch 1 of docs/kodo-next-optimization-plan.md):
// one frozen src/ copy per matrix, whole-matrix stop, per-cell progress, delivery
// checks (non-empty reply, full protected set) and completeness; unknown usage
// leaves token comparisons inconclusive. The nudge is an explicit arm, not the
// runtime default, and T8 evidence keeps its own registration.

import console from 'node:console';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dryBinding, errorText, finalText, parseArgs, relayBinding, resolveCredentials, runNode, sessionUsage, stamp, writeJson } from './v3-eval-common.mjs';
import { deliveryCheck, protectedSnapshot, treeDigest } from './v3-eval-ledger.mjs';
import { completeness, fatalRules, prepareOutput, runMatrix, writeRegistration } from './v3-eval-matrix.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REGISTRATION = Object.freeze({
  id: 'delegation-explore-r3-20261027', window: 65_536, output: 8_192, repeats: 3,
  models: Object.freeze(['deepseek-v4.1-flash', 'deepseek-v4-pro']),
  cells: Object.freeze([['research', 'explore'], ['research', 'solo'], ['survey', 'explore'], ['survey', 'solo'], ['survey', 'nudge'], ['small', 'explore']]),
  // r2: the explore arm no longer relies on the runtime nudge default; the nudge is its own arm.
  arms: Object.freeze({ solo: Object.freeze({ delegation: false, exploreNudge: false }), explore: Object.freeze({ delegation: true, exploreNudge: false }), nudge: Object.freeze({ delegation: true, exploreNudge: 8 }) }),
  defaultCells: Object.freeze(['survey:explore', 'survey:solo']),
  lines: { researchDelegation: 2 / 3, smallDelegation: 0 },
});
const DELEGATION_TOOLS = new Set(['explore', 'spawn_agent']);
const OPTIONS = {
  'dry-run': { kind: 'boolean', default: false }, run: { kind: 'boolean', default: false },
  models: { kind: 'list', default: [...REGISTRATION.models] }, provider: { kind: 'string', default: 'codego1' },
  'provider-config': { kind: 'string', default: undefined }, out: { kind: 'string', default: undefined },
  cells: { kind: 'list', default: [...REGISTRATION.defaultCells] },
  unrestricted: { kind: 'boolean', default: false },
  assembly: { kind: 'boolean', default: false },
  'assembly-evidence-tokens': { kind: 'integer', default: 0 },
  'allow-unbuilt-ui': { kind: 'boolean', default: false },
  repeats: { kind: 'integer', default: REGISTRATION.repeats }, 'max-calls': { kind: 'integer', default: 160 }, 'max-tokens': { kind: 'integer', default: 3_000_000 },
  'matrix-calls': { kind: 'integer', default: 1_200 }, 'matrix-tokens': { kind: 'integer', default: 30_000_000 },
};

// Answers are pinned to the copied src/ tree; each item needs its file and its value.
const RESEARCH_ITEMS = [
  { label: 'session child limit', file: /runtime[\\/]types\.ts/u, value: /\b8\b/u },
  { label: 'explore report bound', file: /messaging[\\/]explore\.ts/u, value: /\b8[,_]?000\b/u },
  { label: 'summary recent-tail share', file: /runtime[\\/]compaction-trigger\.ts/u, value: /\b0\.3\b|30\s?%/u },
];
const RESEARCH_OBJECTIVE = `This workspace holds the src/ tree of an unfamiliar TypeScript agent runtime. Answer three questions, citing for each the workspace-relative file that defines the value:
1. What is the default limit on child agents a session may create?
2. At most how many characters of an explore child's report are delivered to the parent agent?
3. During summary compaction, what share of the free work budget is kept as the recent tail?
Do not modify any file. Finish with the three answers, each with its value and file path.`;
// Eight independent lookups across distinct subsystems; scored per numbered answer.
const SURVEY_ITEMS = [
  { label: 'session child limit', file: /runtime[\\/]types\.ts/u, value: /\b8\b/u },
  { label: 'explore report bound', file: /messaging[\\/]explore\.ts/u, value: /\b8[,_]?000\b/u },
  { label: 'summary recent-tail share', file: /runtime[\\/]compaction-trigger\.ts/u, value: /\b0\.3\b|30\s?%/u },
  { label: 'web collaboration summary limit', file: /web[\\/]collaboration\.ts/u, value: /\b600\b/u },
  { label: 'web recovery max items', file: /web[\\/]recovery\.ts/u, value: /\b200\b/u },
  { label: 'store busy timeout', file: /storage[\\/]index\.ts/u, value: /\b5[,_]?000\b/u },
  { label: 'package path length', file: /packages[\\/]schema\.ts/u, value: /\b240\b/u },
  { label: 'windows launcher compile timeout', file: /sandbox[\\/]windows[\\/]index\.ts/u, value: /\b30[,_]?000\b/u },
];
const SURVEY_OBJECTIVE = `This workspace holds the src/ tree of an unfamiliar TypeScript agent runtime. Answer eight independent questions, citing for each the workspace-relative file that defines the value:
1. What is the default limit on child agents a session may create?
2. At most how many characters of an explore child's report are delivered to the parent agent?
3. During summary compaction, what share of the free work budget is kept as the recent tail?
4. In the local web collaboration view, at most how many characters of a child's result summary are shown?
5. In the local web recovery view, what is the maximum number of items one request may return?
6. What SQLite busy timeout, in milliseconds, does the state store set?
7. What is the maximum length of a file path inside a capability package?
8. What timeout, in milliseconds, applies when compiling the Windows sandbox launcher?
Do not modify any file. Finish with eight numbered answer lines "N. value — path".`;
const SMALL_OBJECTIVE = 'src/slug.js: slugify() must collapse runs of hyphens into one ("a--b" -> "a-b"). Fix that function and run `node verify.mjs` until it passes. Do not modify verify.mjs. Finish with one sentence on the change.';

const VERIFY_SOURCE = "import assert from 'node:assert/strict';\nimport { slugify } from './src/slug.js';\nassert.equal(slugify('Hello  World'), 'hello-world');\nassert.equal(slugify('a--b'), 'a-b');\nassert.equal(slugify('-x---y-'), 'x-y');\nconsole.log('verify: ok');\n";

/** Seed a cell from the matrix's frozen src/ copy, never from the live tree. */
function seed(group, workspace, frozenSrc) {
  mkdirSync(workspace, { recursive: true });
  if (group !== 'small') { cpSync(frozenSrc, path.join(workspace, 'src'), { recursive: true }); return; }
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  writeFileSync(path.join(workspace, 'package.json'), '{ "type": "module" }\n');
  // Existing hyphens survive the first replace, so "a--b" stays "a--b" until fixed.
  writeFileSync(path.join(workspace, 'src/slug.js'), "export function slugify(text) {\n  return text.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');\n}\n");
  writeFileSync(path.join(workspace, 'verify.mjs'), VERIFY_SOURCE);
}

/** Ordered cell keys model:group:arm:repeat; arms of a group alternate order per repeat. */
export function delegationPlan(models, cells, repeats) {
  const plan = [];
  for (const model of models) for (let repeat = 1; repeat <= repeats; repeat++) {
    const ordered = repeat % 2 ? cells : [...cells].reverse();
    for (const [group, arm] of ordered) plan.push(`${model}:${group}:${arm}:${repeat}`);
  }
  return plan;
}

/** Each answer needs its value within 300 characters of a mention of its defining file. */
export function researchAnswers(text) {
  return RESEARCH_ITEMS.map(item => {
    const pattern = new RegExp(item.file.source, 'gu');
    for (const match of text.matchAll(pattern)) if (item.value.test(text.slice(Math.max(0, match.index - 300), match.index + 300))) return true;
    return false;
  });
}

/**
 * Split the final text at numbered answer markers ("1.", "**2.**", "3)") and score
 * each question. A reply may number twice (evidence list, then answer list), so
 * any block with the question's number that holds both its file and value counts.
 */
export function surveyAnswers(text) {
  const marks = [...text.matchAll(/(?:^|\n)[\s#*>-]*(\d{1,2})\s*[.):\]]/gu)].map(match => ({ number: Number(match[1]), index: match.index }));
  return SURVEY_ITEMS.map((item, position) => marks.some((mark, at) => {
    if (mark.number !== position + 1) return false;
    const block = text.slice(mark.index, marks[at + 1]?.index ?? text.length);
    return item.file.test(block) && item.value.test(block);
  }));
}

/** Solo removes the delegation tools from every request; the rest of the runtime is unchanged. */
function solo(provider) {
  return { complete: (request, signal, onText) => provider.complete({ ...request, tools: request.tools.filter(tool => !DELEGATION_TOOLS.has(tool.name)) }, signal, onText) };
}

/** Zero-cost provider: research main explores once if offered, children and other runs answer directly. */
function dryProvider(app) {
  return { async complete(request) {
    const usage = { input: 1000, output: 50 };
    const system = request.messages.find(message => message.role === 'system')?.content ?? '';
    const run = app().store.run(/Run ID: ([^. ]+)\./u.exec(system)?.[1]);
    const research = request.messages.some(message => message.role === 'user' && String(message.content).includes('unfamiliar TypeScript agent runtime'));
    if (!run.parentId && run.step === 0 && research && request.tools.some(tool => tool.name === 'explore')) {
      return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'explore-1', name: 'explore', arguments: JSON.stringify({ tasks: [{ prompt: 'Find the default session child limit.', scope: ['src'] }] }) }] }, finishReason: 'tool_calls', usage };
    }
    return { message: { role: 'assistant', content: 'Dry run: no answer.' }, finishReason: 'stop', usage };
  } };
}

async function execute(app, cli, { group, workspace, binding, readOnly }, result) {
  const permissions = readOnly ? ['read'] : ['read', 'write', 'exec'];
  const objective = { research: RESEARCH_OBJECTIVE, survey: SURVEY_OBJECTIVE, small: SMALL_OBJECTIVE }[group];
  const run = app.createRun({ objective, workspace, binding, permissions,
    budget: { maxContextTokens: REGISTRATION.window, maxOutputTokens: REGISTRATION.output, ...(cli.unrestricted ? {} : { maxModelCalls: cli['max-calls'], maxTokens: cli['max-tokens'], maxToolCalls: 200, maxDurationMs: 900_000 }) } });
  const final = await app.run(run.id).catch(error => ({ ...app.store.run(run.id), error: errorText(error) }));
  const mainCalls = app.store.calls(run.id).filter(call => call.kind === 'tool');
  const children = app.store.listRuns(run.sessionId).filter(child => child.parentId);
  const text = finalText(app.store, app.store.run(run.id));
  const nudge = app.store.events(run.id).find(event => event.type === 'delegation.nudged');
  const firstDelegation = mainCalls.find(call => DELEGATION_TOOLS.has(call.name));
  Object.assign(result, {
    status: final.status, error: final.error ?? null, usage: sessionUsage(app.store, run.sessionId),
    delegated: Boolean(firstDelegation),
    exploreCalls: mainCalls.filter(call => call.name === 'explore').length, spawnCalls: mainCalls.filter(call => call.name === 'spawn_agent').length,
    nudged: Boolean(nudge), nudgeReadCalls: nudge?.data.readCalls ?? null, delegatedAfterNudge: Boolean(nudge && firstDelegation && firstDelegation.step > Number(nudge.data.step)),
    children: children.length, childStatuses: children.map(child => child.status), mainToolCalls: mainCalls.length,
    answers: group === 'research' ? researchAnswers(text) : group === 'survey' ? surveyAnswers(text) : null, finalText: text.slice(0, 4000),
  });
}

/** Read-only groups protect the whole workspace; small protects verify.mjs and must pass it. */
function deliver(result, workspace, readOnly, before) {
  if (readOnly) {
    result.correct = result.answers?.filter(Boolean).length ?? 0;
    result.delivery = deliveryCheck({ status: result.status, finalText: result.finalText, acceptance: Boolean(result.answers?.every(Boolean)), before, after: protectedSnapshot(workspace, ['.']) });
  } else {
    const verify = runNode(['verify.mjs'], workspace);
    result.verifyExit = verify.exitCode;
    const intact = readFileSync(path.join(workspace, 'verify.mjs'), 'utf8') === VERIFY_SOURCE;
    result.delivery = deliveryCheck({ status: result.status, finalText: result.finalText, acceptance: verify.exitCode === 0 && intact, before, after: protectedSnapshot(workspace, ['verify.mjs']) });
  }
  result.success = result.delivery.ok;
}

async function runCell({ cli, credentials, key, remaining, outRoot, frozenSrc }) {
  const [model, group, arm, repeat] = key.split(':');
  const dir = path.join(outRoot, `${model}-${group}-${arm}-${repeat}`);
  const workspace = path.join(dir, 'workspace');
  await mkdir(path.join(dir, 'wire'), { recursive: true });
  seed(group, workspace, frozenSrc);
  const readOnly = group !== 'small';
  const before = protectedSnapshot(workspace, readOnly ? ['.'] : ['verify.mjs']);
  const policy = REGISTRATION.arms[arm];
  let relay;
  let binding = dryBinding(model, REGISTRATION.window, REGISTRATION.output);
  if (cli.run) ({ relay, binding } = await relayBinding({ directory: path.join(dir, 'wire'), credentials, model, ...(cli.unrestricted ? { unrestricted: true } : { maxCalls: Math.min(cli['max-calls'], remaining.requests), maxTokens: Math.min(cli['max-tokens'], remaining.tokens) }), maxOutputTokens: REGISTRATION.output, contextTokens: REGISTRATION.window }));
  const { Application, ModelProvider } = await import('../../dist/application/index.js');
  const base = cli.run ? new ModelProvider() : dryProvider(() => app);
  // The nudge setting is always explicit, so the runtime default never decides an arm.
  const app = new Application(path.join(dir, 'state'), policy.delegation ? base : solo(base), undefined, { exploreNudge: policy.exploreNudge, ...(cli.assembly ? { assembly: { strategy: 'deterministic', ...(cli['assembly-evidence-tokens'] ? { evidenceInputTokens: cli['assembly-evidence-tokens'] } : {}) } } : {}) });
  const result = { model, group, arm, repeat: Number(repeat), policy, status: null, error: null };
  try { await execute(app, cli, { group, workspace, binding, readOnly }, result); }
  catch (error) { result.error = errorText(error); }
  finally {
    await app.shutdown().catch(error => { result.shutdownError = errorText(error); });
    if (relay) { await relay.close(); result.relay = { requests: relay.stats.requests, tokens: relay.stats.tokens, rejected: relay.stats.rejected, estimated: relay.stats.estimated }; }
  }
  deliver(result, workspace, readOnly, before);
  await writeJson(path.join(dir, 'report.json'), result, credentials?.key);
  return result;
}
function cellTotals(results) {
  const cells = {};
  for (const result of results) {
    const cell = (cells[`${result.model}:${result.group}:${result.arm}`] ??= { runs: 0, delegated: 0, nudged: 0, delegatedAfterNudge: 0, succeeded: 0, correct: 0, totalTokens: 0, unknownCalls: 0, wallMs: 0, peakMainInput: 0, children: 0 });
    const usage = result.usage ?? {};
    cell.runs++; cell.delegated += result.delegated ? 1 : 0; cell.succeeded += result.success ? 1 : 0; cell.children += result.children ?? 0; cell.correct += result.correct ?? 0;
    cell.nudged += result.nudged ? 1 : 0; cell.delegatedAfterNudge += result.delegatedAfterNudge ? 1 : 0;
    cell.totalTokens += usage.totalTokens ?? 0; cell.wallMs += usage.wallMs ?? 0; cell.peakMainInput = Math.max(cell.peakMainInput, usage.peakMainInput ?? 0);
    cell.unknownCalls += result.usage ? usage.unknownCalls ?? 0 : 1;
  }
  for (const cell of Object.values(cells)) { cell.delegationRate = cell.delegated / cell.runs; cell.successRate = cell.succeeded / cell.runs; cell.usageComplete = cell.unknownCalls === 0; }
  return cells;
}

/** Explore-vs-Solo lines for one model and group; token ratios need complete usage on both sides. */
function groupLines(cells, model, group, line) {
  const explore = cells[`${model}:${group}:explore`], soloCell = cells[`${model}:${group}:solo`], nudge = cells[`${model}:${group}:nudge`];
  if (!explore && !nudge) return;
  if (explore) line[`${group}Delegation`] = explore.delegationRate >= REGISTRATION.lines.researchDelegation;
  if (nudge) line[`${group}DelegationWithNudge`] = nudge.delegationRate >= REGISTRATION.lines.researchDelegation;
  if (!explore || !soloCell) return;
  const known = explore.usageComplete && soloCell.usageComplete;
  line[`${group}SuccessNotBelowSolo`] = explore.successRate >= soloCell.successRate;
  line[`${group}TokensVsSolo`] = known && soloCell.totalTokens ? explore.totalTokens / soloCell.totalTokens : null;
  line[`${group}PeakMainVsSolo`] = soloCell.peakMainInput ? explore.peakMainInput / soloCell.peakMainInput : null;
}

/**
 * Per-cell rates and per-model observation lines. `matrixState` is 'invalid'
 * (duplicate, unexpected or mixed-policy cells), 'incomplete' (missing cells)
 * or 'complete'; lines from an incomplete or invalid matrix are not conclusions.
 */
export function summarize(results, { plan } = {}) {
  const cells = cellTotals(results);
  const matrix = completeness(plan ?? results.map(result => result.key), results, result => REGISTRATION.arms[result.arm]);
  const lines = {};
  for (const model of new Set(results.map(result => result.model))) {
    const small = cells[`${model}:small:explore`];
    lines[model] = { smallDelegation: small ? small.delegationRate === REGISTRATION.lines.smallDelegation : null };
    for (const group of ['research', 'survey']) groupLines(cells, model, group, lines[model]);
  }
  const usageComplete = Object.values(cells).every(cell => cell.usageComplete);
  const matrixState = !matrix.valid ? 'invalid' : !matrix.complete ? 'incomplete' : 'complete';
  return { cells, lines, matrix, matrixState, usageComplete };
}

async function main() {
  const cli = parseArgs(process.argv.slice(2), OPTIONS);
  const cells = cli.cells.map(cell => cell.split(':'));
  if (cli['assembly-evidence-tokens'] && !cli.assembly) throw new Error('--assembly-evidence-tokens requires --assembly');
  for (const [group, arm] of cells) if (!REGISTRATION.cells.some(([g, a]) => g === group && a === arm)) throw new Error(`unknown cell ${group}:${arm}`);
  const credentials = cli.run ? await resolveCredentials({ providerConfig: cli['provider-config'], provider: cli.provider }) : undefined;
  const outRoot = path.resolve(cli.out ?? `.kodo/v3-delegation-${cli.run ? 'paid' : 'dry'}-${stamp()}`);
  prepareOutput(outRoot);
  // Every cell copies the same frozen tree, taken once before the first cell.
  const frozenSrc = path.join(outRoot, 'frozen-src');
  cpSync(path.join(repoRoot, 'src'), frozenSrc, { recursive: true });
  const plan = delegationPlan(cli.models, cells, cli.repeats);
  const settings = { ...cli, mode: cli.run ? 'paid' : 'dry-run', providerHost: credentials?.host ?? null };
  writeRegistration(outRoot, { registration: REGISTRATION, plan, settings, fixtures: { frozenSrc: treeDigest(frozenSrc), verify: VERIFY_SOURCE, ...(cli['allow-unbuilt-ui'] ? { buildException: 'The last successful dist is used while unrelated src/tui and src/cli/tui-host.ts files are being edited concurrently.' } : {}) }, repoRoot, requireBuild: !cli['allow-unbuilt-ui'] });
  let interrupted = null;
  process.once('SIGINT', () => { interrupted = 'INTERRUPTED'; console.error('stopping after the current cell'); });
  const { results, stop, spent } = await runMatrix({
    outRoot, plan, secret: credentials?.key, fatal: fatalRules(), budget: cli.unrestricted ? {} : { requests: cli['matrix-calls'], tokens: cli['matrix-tokens'] }, shouldStop: () => interrupted,
    runCell: async (key, remaining) => {
      const result = await runCell({ cli, credentials, key, remaining, outRoot, frozenSrc });
      console.error(`${key}: ${result.status} delivery=${result.delivery.ok ? 'ok' : result.delivery.reasons.join('+')} correct=${result.correct ?? '-'} nudged=${result.nudged ?? false} delegated=${result.delegated} children=${result.children ?? 0} tokens=${result.usage?.totalTokens ?? '?'} unknown=${result.usage?.unknownCalls ?? '?'}${result.error ? ` error=${result.error}` : ''}`);
      return result;
    },
  });
  if (stop) console.error(`matrix stopped at ${stop.at}: ${stop.reason}`);
  const report = { registration: REGISTRATION, mode: settings.mode, providerHost: settings.providerHost, stop, spent, results, ...summarize(results, { plan }) };
  await writeJson(path.join(outRoot, 'summary.json'), report, credentials?.key);
  console.log(JSON.stringify({ out: outRoot, stop, matrixState: report.matrixState, usageComplete: report.usageComplete, cells: report.cells, lines: report.lines }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
