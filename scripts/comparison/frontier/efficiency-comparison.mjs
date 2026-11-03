// Executes two registered Kodo cells with frozen builds, relay and task fixture.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { verifyBuildManifest } from '../../write-build-manifest.mjs';
import { analyzeComparisonCell, comparisonVerdict } from './efficiency-analysis.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const scriptNames = ['run.mjs', 'launch.mjs', 'relay.mjs', 'recorder.mjs', 'execution-evidence.mjs', 'native.mjs', 'trace.mjs', 'delegation-metrics.mjs', 'efficiency-comparison.mjs', 'efficiency-analysis.mjs', 'check-audit.mjs'];
const flags = { A: true, B: true, C: true, D: true, E: true };

export function validateScope(scope) {
  if (scope.task !== 'fastapi' || scope.repeats !== 1 || scope.factors !== 'A,B,C,D,E' ||
    JSON.stringify(scope.groups) !== JSON.stringify(['baseline', 'optimized']) || scope.contextTokens !== 1_048_576 || scope.outputTokens !== 393_216) {
    throw new Error('Scope must be the approved two-cell FastAPI comparison with ABCDE and real limits');
  }
  if (scope.experiment !== undefined) {
    if (scope.experiment !== 'parallelism-v1') throw new Error('Unknown comparison experiment');
    for (const name of scope.groups) {
      const config = scope.concurrency?.[name];
      if (!config || !['maxConcurrentModels', 'maxActiveChildren'].every(key => Number.isSafeInteger(config[key]) && config[key] > 0)) throw new Error('Concurrency scope requires both positive limits per cell');
    }
  } else if (scope.concurrency !== undefined) throw new Error('Concurrency scope requires parallelism-v1');
}

export function stopReason(cell) {
  if (cell.runnerExitCode !== 0) return 'runner failed';
  if (!cell.result || cell.result.status === 'infra_invalid') return 'infrastructure invalid';
  if (cell.result.recordingErrors?.length || cell.result.executionEvidence?.status === 'failed') return 'execution evidence incomplete';
  if (cell.recording?.missingFiles.length || cell.recording?.duplicateIndexes || !cell.recording?.requests) return 'recording incomplete';
  if (!cell.analysis?.savedConfiguration.length || cell.analysis.savedConfiguration.some(config => Object.entries(flags).some(([name, enabled]) => config.agentFactors?.[name] !== enabled))) return 'persisted factors mismatch';
  if (cell.analysis.httpStatuses?.['401'] || cell.analysis.httpStatuses?.['403'] || cell.analysis.httpStatuses?.['402']) return 'provider authorization or billing failure';
  if (cell.conditionErrors?.length) return 'experiment conditions mismatch';
  if (cell.scriptDrift?.length) return 'experiment scripts changed';
  return null;
}

export async function frozenBuild(directory) {
  const manifest = await read(path.join(directory, '.kodo-build-manifest.json'));
  if (!manifest.dist?.files || !manifest.source?.files) throw new Error(`Invalid frozen build manifest: ${directory}`);
  for (const [name, expected] of Object.entries(manifest.dist.files)) {
    if (!name.startsWith('dist/') || name.includes('..')) throw new Error(`Invalid output path ${name}`);
    const actual = sha(await readFile(path.join(directory, name.slice(5))));
    if (actual !== expected) throw new Error(`Frozen build changed: ${name}`);
  }
  const files = (await readdir(directory, { recursive: true })).map(name => name.replaceAll('\\', '/'))
    .filter(name => /\.(?:js|d\.ts|map|node)$/u.test(name)).map(name => `dist/${name}`).sort();
  if (JSON.stringify(files) !== JSON.stringify(Object.keys(manifest.dist.files).sort())) throw new Error('Frozen build contains an unexpected output file');
  return { manifestSha256: sha(await readFile(path.join(directory, '.kodo-build-manifest.json'))), manifest };
}

export function sourceChanges(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter(name => before[name] !== after[name])
    .map(name => ({ path: name, before: before[name] ?? null, after: after[name] ?? null,
      kind: before[name] === undefined ? 'added' : after[name] === undefined ? 'removed' : 'changed' }));
}

async function hashes(directory, names) { return Object.fromEntries(await Promise.all(names.map(async name => [name, sha(await readFile(path.join(directory, name)))]))); }

async function runCell(args, repository, logFile) {
  const log = createWriteStream(logFile, { flags: 'wx' });
  const child = spawn(process.execPath, args, { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  try { return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { await new Promise((resolve, reject) => { log.once('error', reject); log.end(resolve); }); }
}

async function recordFiles(root) {
  const files = [];
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    if (name === 'evidence-sha256.json') continue;
    const file = path.join(root, name);
    if ((await stat(file)).isFile()) files.push({ path: name.replaceAll('\\', '/'), sha256: sha(await readFile(file)) });
  }
  await writeFile(path.join(root, 'evidence-sha256.json'), JSON.stringify(files, null, 2) + '\n');
}

export async function runComparison(root, { repository = path.resolve(import.meta.dirname, '../../..'), execute = runCell } = {}) {
  const scope = await read(path.join(root, 'scope.json')); validateScope(scope);
  for (const name of ['matrix.json', 'baseline', 'optimized', 'optimized-build', 'scripts']) {
    if (existsSync(path.join(root, name))) throw new Error(`Comparison cannot overwrite existing ${name}`);
  }
  const current = verifyBuildManifest(repository);
  if (!current.ok) throw new Error(`Build is not current: ${current.problems.join('; ')}`);
  const baseline = await frozenBuild(path.join(root, 'baseline-build'));
  const scripts = path.join(repository, 'scripts', 'comparison', 'frontier');
  const scriptHashes = await hashes(scripts, scriptNames);
  await cp(path.join(repository, 'dist'), path.join(root, 'optimized-build'), { recursive: true });
  const optimized = await frozenBuild(path.join(root, 'optimized-build'));
  const parallelism = scope.experiment === 'parallelism-v1';
  if (parallelism && (baseline.manifest.source.digest !== optimized.manifest.source.digest || baseline.manifest.dist.digest !== optimized.manifest.dist.digest)) {
    throw new Error('Concurrency comparison requires the same source and build in both cells');
  }
  await mkdir(path.join(root, 'scripts'));
  for (const name of scriptNames) await cp(path.join(scripts, name), path.join(root, 'scripts', name));
  // Preserve build inputs, not host configuration files containing credentials.
  for (const name of Object.keys(current.recorded.source.files)) {
    const target = path.join(root, 'optimized-source', name);
    await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(repository, name), target);
  }
  await writeFile(path.join(root, 'source-changes.json'), JSON.stringify(sourceChanges(baseline.manifest.source.files, optimized.manifest.source.files), null, 2) + '\n');
  const matrix = { ...scope, runnerPid: process.pid, startedAt: new Date().toISOString(), scriptHashes,
    builds: { baseline, optimized }, conditions: { model: 'deepseek-v4.1-flash', cpus: 2, memoryMb: 8192, timeoutSec: 5400,
      initialBranch: 'main', initialCommit: '11614be9021aa4ac078d4d0693a8b5250a1010d8', ordering: 'baseline then optimized',
      sessionProfiles: parallelism ? { baseline: { taskProtocol: 3, toolProfile: 'compact-v2' }, optimized: { taskProtocol: 3, toolProfile: 'compact-v2' } }
        : { baseline: { taskProtocol: null, toolProfile: null }, optimized: { taskProtocol: 2, toolProfile: 'compact-v1' } },
      ...(parallelism ? { concurrency: scope.concurrency, labels: { baseline: 'current default concurrency', optimized: 'expanded concurrency' } } : {}),
      workspacePolicy: 'Both arms may use host-managed isolated task checkouts and must integrate final delivery into /app. This differs from the older /app-only experiments.',
      failurePolicy: 'No replacement cells or retries; stop remaining cells on infrastructure, recording, configuration, authorization/billing or script-integrity failure.' },
    limitation: parallelism ? 'One sequential sample per concurrency setting on the same build. Both model and active-child limits change together; strategy and upstream latency remain confounders. Expanded is finite, not unlimited.'
      : 'One sequential sample per build; task strategy and upstream latency remain confounders. This measures the whole optimization, not individual changes.',
    cells: scope.groups.map(name => ({ name, factors: scope.factors, status: 'pending' })) };
  const save = () => writeFile(path.join(root, 'matrix.json'), JSON.stringify(matrix, null, 2) + '\n');
  await save();
  let stopped = null;
  try {
    for (const cell of matrix.cells) {
      if (stopped) { cell.status = 'not_started'; cell.reason = stopped; continue; }
      const latestHashes = await hashes(scripts, scriptNames);
      if (JSON.stringify(latestHashes) !== JSON.stringify(scriptHashes)) throw new Error('Experiment scripts changed before next cell');
      await frozenBuild(path.join(root, `${cell.name}-build`));
      const args = [path.join(scripts, 'run.mjs'), '--task', 'fastapi', '--harness', 'kodo', '--kodo-dist', path.join(root, `${cell.name}-build`),
        '--kodo-factors', scope.factors, '--context-tokens', String(scope.contextTokens), '--output-tokens', String(scope.outputTokens), '--out', path.join(root, cell.name)];
      if (parallelism) args.push('--kodo-max-concurrent-models', String(scope.concurrency[cell.name].maxConcurrentModels), '--kodo-max-active-children', String(scope.concurrency[cell.name].maxActiveChildren));
      cell.status = 'running'; cell.startedAt = new Date().toISOString(); cell.command = [process.execPath, ...args]; await save();
      process.stdout.write(`START ${cell.name}\n`);
      cell.runnerExitCode = await execute(args, repository, path.join(root, `${cell.name}.log`));
      const manifestFile = path.join(root, cell.name, 'manifest.json');
      const manifest = existsSync(manifestFile) ? await read(manifestFile) : null;
      cell.result = manifest?.cells?.[0] ?? null;
      cell.status = cell.result?.status ?? 'infra_invalid';
      cell.finishedAt = new Date().toISOString();
      cell.conditionErrors = [];
      if (manifest) {
        if (manifest.model !== matrix.conditions.model || manifest.contextTokens !== scope.contextTokens || manifest.outputTokens !== scope.outputTokens || manifest.kodoFactors !== scope.factors) cell.conditionErrors.push('model/limits/factors');
        if (manifest.kodoBuild?.buildManifestSha256 !== matrix.builds[cell.name].manifestSha256) cell.conditionErrors.push('build hash');
        if (parallelism && ['maxConcurrentModels', 'maxActiveChildren'].some(key => manifest.kodoConcurrency?.[key] !== scope.concurrency[cell.name][key])) cell.conditionErrors.push('declared concurrency');
        if (cell.result?.initialRepository?.branch !== 'main' || cell.result?.initialRepository?.commit !== matrix.conditions.initialCommit) cell.conditionErrors.push('initial repository');
        const previous = matrix.cells.find(item => item.name !== cell.name && item.result?.instructionSha256);
        if (!cell.result?.instructionSha256 || (previous && previous.result.instructionSha256 !== cell.result.instructionSha256)) cell.conditionErrors.push('task instruction');
      }
      const directory = path.join(root, cell.name, 'fastapi-kodo');
      const relayIndex = path.join(directory, 'relay', 'calls.json');
      if (existsSync(relayIndex)) {
        const calls = await read(relayIndex);
        const required = ['process/steps.jsonl', 'process/transcript.md', 'process/tools.jsonl', 'process/summary.json', 'process/execution-archive.json', 'state/kodo/kodo.sqlite'];
        required.push(...calls.flatMap(call => [`relay/request-incoming-${call.index}.json`, `relay/request-${call.index}.json`, `relay/response-${call.index}.txt`]));
        cell.recording = { requests: calls.length, duplicateIndexes: calls.length - new Set(calls.map(call => call.index)).size,
          missingFiles: required.filter(name => !existsSync(path.join(directory, name))) };
        cell.analysis = await analyzeComparisonCell(directory, cell.result ?? {});
        const expected = matrix.conditions.sessionProfiles[cell.name];
        if (cell.analysis.savedConfiguration.some(config => config.taskProtocol !== expected.taskProtocol || config.toolProfile !== expected.toolProfile)) {
          cell.conditionErrors.push('persisted task protocol/tool profile');
        }
        if (parallelism && cell.analysis.savedConfiguration.some(config => ['maxConcurrentModels', 'maxActiveChildren'].some(key => config.budget?.[key] !== scope.concurrency[cell.name][key]))) {
          cell.conditionErrors.push('persisted concurrency');
        }
      }
      const afterHashes = await hashes(scripts, scriptNames);
      cell.scriptDrift = scriptNames.filter(name => scriptHashes[name] !== afterHashes[name]);
      stopped = stopReason(cell); if (stopped) matrix.stopReason = stopped;
      await save();
      process.stdout.write(`DONE ${cell.name} status=${cell.status} verified=${cell.result?.verification?.passed} seconds=${cell.result?.elapsedSec} creditKnown=${cell.analysis?.usage.credit.knownSubtotal} creditMissing=${cell.analysis?.usage.credit.missingRequests}\n`);
    }
  } catch (error) {
    matrix.stopReason = error.message;
    for (const cell of matrix.cells) {
      if (cell.status === 'pending') { cell.status = 'not_started'; cell.reason = error.message; }
      if (cell.status === 'running') { cell.status = 'infra_invalid'; cell.error = error.message; }
    }
    throw error;
  } finally {
    matrix.finishedAt = new Date().toISOString(); matrix.comparison = comparisonVerdict(matrix.stopReason ? [] : matrix.cells);
    await save();
    await writeFile(path.join(root, 'analysis.json'), JSON.stringify({ cells: matrix.cells.map(cell => ({ name: cell.name, status: cell.status, analysis: cell.analysis })), comparison: matrix.comparison }, null, 2) + '\n');
    await recordFiles(root);
  }
  process.stdout.write(`EVIDENCE ${root}\n`);
  return matrix;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node efficiency-comparison.mjs PREPARED_DIRECTORY');
  const result = await runComparison(path.resolve(process.argv[2]));
  if (result.stopReason) process.exitCode = 1;
}
