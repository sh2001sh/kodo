// Matrix execution for the v3 evaluations: registration snapshot, whole-matrix
// stop, per-cell persistence and completeness checks.
// - The output directory must be new or empty; there is no implicit resume, so
//   completed evidence is never overwritten or mixed with another registration.
// - registration.json is written before the first cell and holds the code and
//   build digests, fixtures, models, limits, order and stop rules.
// - progress.json is rewritten before and after every cell. A crash leaves the
//   running cell recorded, so readProgress reports it as interrupted.
// - A fatal result (relay rejection, provider stop, registered condition) or the
//   matrix budget stops the whole matrix: no later cell starts.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { verifyBuildManifest } from '../write-build-manifest.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
function writeText(file, value, secret) {
  let text = JSON.stringify(value, null, 2);
  if (secret) text = text.replaceAll(secret, '[REDACTED]');
  writeFileSync(file, `${text}\n`, 'utf8');
}

/** Create the output directory, refusing one that already holds anything. */
export function prepareOutput(outRoot) {
  if (existsSync(outRoot) && readdirSync(outRoot).length) throw new Error(`output directory is not empty: ${outRoot}; results are never overwritten or resumed implicitly`);
  mkdirSync(outRoot, { recursive: true });
}

/**
 * Freeze the registration. The build manifest must show that dist/ was built
 * from the current src/ unless `requireBuild` is false (unit tests only).
 */
export function writeRegistration(outRoot, { registration, plan, settings, fixtures = {}, repoRoot, requireBuild = true }) {
  let code = null;
  if (repoRoot) {
    const build = verifyBuildManifest(repoRoot);
    if (requireBuild && !build.ok) throw new Error(`dist does not match src: ${build.problems.join('; ')}; run npm run build`);
    code = { buildOk: build.ok, source: build.current.source.digest, dist: build.current.dist.digest };
  }
  const snapshot = { registration, plan, settings, fixtures, code, node: process.version, createdAt: new Date().toISOString() };
  const digest = sha256(JSON.stringify({ ...snapshot, createdAt: undefined }));
  writeText(path.join(outRoot, 'registration.json'), { ...snapshot, digest });
  return digest;
}

function progressRecord(plan, results, running, stop) {
  // Interrupted cells started, so they are neither completed nor not started.
  const done = new Set([...results.map(result => result.key), ...(stop?.interrupted ?? [])]);
  return {
    state: running ? 'running' : stop ? 'stopped' : 'finished', running: running ?? null, stop: stop ?? null,
    completed: results.map(result => result.key), notStarted: plan.filter(key => !done.has(key) && key !== running),
    results,
  };
}

/** Read progress.json; a cell still marked running after the process ended is interrupted. */
export function readProgress(outRoot) {
  const progress = JSON.parse(readFileSync(path.join(outRoot, 'progress.json'), 'utf8'));
  return { ...progress, interrupted: progress.state === 'running' ? [progress.running] : progress.stop?.interrupted ?? [] };
}

/**
 * Run `plan` (ordered cell keys) through `runCell(key, remaining)` until done or
 * stopped. `fatal(result)` returns a stop reason or null. `budget` caps the
 * matrix total of relay requests and tokens; `remaining` lets the cell cap its
 * own relay so the limit is enforced, not just checked between cells.
 */
export async function runMatrix({ outRoot, plan, runCell, fatal = () => null, budget = {}, shouldStop = () => null, secret }) {
  const results = [];
  const spent = { requests: 0, tokens: 0 };
  const persist = (running, stop) => writeText(path.join(outRoot, 'progress.json'), progressRecord(plan, results, running, stop), secret);
  let stop = null;
  for (const key of plan) {
    const remaining = { requests: (budget.requests ?? Infinity) - spent.requests, tokens: (budget.tokens ?? Infinity) - spent.tokens };
    const external = shouldStop();
    if (external) { stop = { reason: external, at: key, interrupted: [] }; break; }
    if (remaining.requests <= 0 || remaining.tokens <= 0) { stop = { reason: 'MATRIX_BUDGET', at: key, interrupted: [] }; break; }
    persist(key);
    let result;
    try { result = { ...(await runCell(key, remaining)), key }; }
    catch (error) {
      stop = { reason: `CELL_ERROR: ${error instanceof Error ? error.message : String(error)}`, at: key, interrupted: [key] };
      break;
    }
    results.push(result);
    spent.requests += result.relay?.requests ?? 0;
    spent.tokens += result.relay?.tokens ?? 0;
    const reason = result.relay?.rejected?.length ? `RELAY_REJECTED: ${result.relay.rejected.join(', ')}` : fatal(result);
    if (reason) { stop = { reason, at: key, interrupted: [] }; break; }
  }
  persist(undefined, stop);
  return { results, stop, spent };
}

/**
 * Compare results with the registered plan. Missing cells make the matrix
 * incomplete; duplicates, unknown cells or a policy other than the registered
 * one make it invalid. Neither may yield a passing verdict.
 */
export function completeness(plan, results, policyOf = () => undefined) {
  const expected = new Set(plan);
  const seen = new Map();
  for (const result of results) seen.set(result.key, (seen.get(result.key) ?? 0) + 1);
  const missing = plan.filter(key => !seen.has(key));
  const duplicated = [...seen].filter(([, count]) => count > 1).map(([key]) => key);
  const unexpected = [...seen.keys()].filter(key => !expected.has(key));
  const mixedPolicy = results.filter(result => policyOf(result) !== undefined && JSON.stringify(result.policy ?? null) !== JSON.stringify(policyOf(result))).map(result => result.key);
  return { complete: missing.length === 0, valid: !duplicated.length && !unexpected.length && !mixedPolicy.length, missing, duplicated, unexpected, mixedPolicy };
}

/**
 * Unmeasured relay calls are excused only when every one is a client abort, every
 * unknown Kodo call belongs to a run its main agent cancelled, and their count is
 * within the pre-registered tolerance. The cost stays a lower bound; it is not zero.
 */
export function excusedAgentCancels(result, tolerance) {
  const relay = result.relay ?? {};
  const usage = result.usage ?? {};
  const unmeasured = relay.unmeasured ?? 0;
  if (!unmeasured || unmeasured > tolerance || relay.clientAborted !== unmeasured) return false;
  return usage.unknownCalls === usage.agentCancelledUnknown && unmeasured <= usage.agentCancelledUnknown;
}

/**
 * Registered fatal conditions shared by the v3 runners: a write outside the
 * allowed set, a relay that could not settle usage, or two consecutive cells
 * that ended on provider failures. Ordinary task failures are results, not stops.
 */
export function fatalRules({ agentCancelTolerance = 0 } = {}) {
  let providerStreak = 0;
  return result => {
    if (result.delivery?.reasons?.some(reason => reason.startsWith('PROTECTED_'))) return 'PROTECTED_VIOLATION';
    if (result.relay?.estimated && !excusedAgentCancels(result, agentCancelTolerance)) return 'USAGE_UNRECONCILED';
    providerStreak = result.status !== 'completed' && (result.usage?.providerFailures ?? 0) > 0 ? providerStreak + 1 : 0;
    return providerStreak >= 2 ? 'PROVIDER_FAILURES' : null;
  };
}

/** Parse `--prices input,cacheRead,output[,cacheWrite]` (per million tokens). */
export function parsePrices(text) {
  if (!text) return null;
  const values = text.split(',').map(Number);
  if (values.length < 3 || values.length > 4 || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('--prices requires input,cacheRead,output[,cacheWrite] per million tokens');
  const [input, cacheRead, output, cacheWrite] = values;
  return { input, cacheRead, output, ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
}

/** Price per million tokens, applied to a ledger; unknown usage makes the cost uncertain. */
export function priceLedger(ledger, prices) {
  if (!prices) return { basis: 'tokens', value: ledger.totalTokens, certain: ledger.complete };
  const uncached = ledger.inputTokens - ledger.cacheRead - ledger.cacheWrite;
  const value = (uncached * prices.input + ledger.cacheRead * prices.cacheRead + ledger.cacheWrite * (prices.cacheWrite ?? prices.input) + ledger.outputTokens * prices.output) / 1e6;
  return { basis: 'price', value, certain: ledger.complete };
}
