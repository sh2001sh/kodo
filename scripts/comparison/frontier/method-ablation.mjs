import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { pathToFileURL } from 'node:url';
import { arms, methods } from './method-worker.mjs';
import { verifyBuildManifest } from '../../write-build-manifest.mjs';
import { usageTotals } from './efficiency-analysis.mjs';

const repository = path.resolve(import.meta.dirname, '../../..');
const scripts = ['run.mjs', 'launch.mjs', 'method-worker.mjs', 'method-ablation.mjs', 'relay.mjs', 'recorder.mjs', 'execution-evidence.mjs', 'native.mjs', 'trace.mjs', 'efficiency-analysis.mjs'];
const sha = value => createHash('sha256').update(value).digest('hex');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
export const limits = { contextTokens: 1048576, outputTokens: 393216, timeoutSec: 5400 };
export function plan(tasks = ['statemachine', 'fastapi']) {
  if (!tasks.length || new Set(tasks).size !== tasks.length || tasks.some(task => !['statemachine', 'fastapi'].includes(task))) throw new Error('Select distinct historical statemachine/fastapi tasks');
  return tasks.flatMap((task, index) => [...arms.slice(index), ...arms.slice(0, index)].map(arm => ({ key: `${task}-${arm}`, task, arm })));
}
export function runnerArgs(cell, root) {
  return [path.join(import.meta.dirname, 'run.mjs'), '--task', cell.task, '--harness', 'kodo', '--kodo-dist', path.join(root, 'build'),
    '--kodo-method-arm', cell.arm, '--kodo-tool-profile', 'compact-v2', '--kodo-factors', 'A,B,C,D,E',
    '--context-tokens', String(limits.contextTokens), '--output-tokens', String(limits.outputTokens), '--out', path.join(root, cell.key)];
}
const hashes = async () => Object.fromEntries(await Promise.all(scripts.map(async name => [name, sha(await readFile(path.join(import.meta.dirname, name)))])));

export async function main(argv = process.argv.slice(2)) {
  const option = name => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
  const execute = argv.includes('--run');
  const output = option('--out');
  if (!output) throw new Error('Usage: method-ablation.mjs --out NEW_DIRECTORY [--tasks statemachine,fastapi] [--run]');
  const cells = plan(option('--tasks')?.split(','));
  const root = path.resolve(output);
  if (existsSync(root)) throw new Error('Evidence directory must be new');
  const build = verifyBuildManifest(repository);
  if (!build.ok) throw new Error(`Build is not current: ${build.problems.join('; ')}`);
  const frozen = await hashes();
  const taskFolders = { statemachine: 'python-statemachine-state-data-scoping', fastapi: 'fastapi-deprecation-response-headers' };
  const fixtures = Object.fromEntries(await Promise.all([...new Set(cells.map(cell => cell.task))].map(async task => [task, sha(await readFile(path.join(repository, '.kodo/frontier-eval-source/tasks', taskFolders[task], 'instruction.md')))])));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  for (const name of scripts) await cp(path.join(import.meta.dirname, name), path.join(root, 'scripts', name));
  const matrix = { model: 'deepseek-v4.1-flash', provider: 'codego1', limits, methods, fixtures,
    toolProfile: 'compact-v2', taskProtocol: 3, factors: 'A,B,C,D,E', build: build.current, scripts: frozen,
    interpretation: 'Same historical tasks/model/limits and independent verifiers; new within-build comparison. One run per cell is exploratory. No prompt requires loading methods. The baseline comparison includes the full feature bundle; only marking/checkpoint and checkpoint/active are single-factor contrasts. No forced compaction: zero checkpoint events means unloading benefit was not tested.',
    status: execute ? 'running' : 'planned', cells: cells.map(cell => ({ ...cell, status: 'pending' })),
  };
  const save = () => writeFile(path.join(root, 'matrix.json'), JSON.stringify(matrix, null, 2));
  await save();
  if (!execute) { console.log(JSON.stringify({ output: root, status: 'planned', cells: cells.length, credentialsRead: false })); return; }
  await cp(path.join(repository, 'dist'), path.join(root, 'build'), { recursive: true });
  for (const cell of matrix.cells) {
    if (JSON.stringify(await hashes()) !== JSON.stringify(frozen)) { matrix.stopReason = 'Experiment scripts changed'; break; }
    cell.status = 'running'; cell.startedAt = new Date().toISOString(); await save();
    console.log(`START ${cell.key}`);
    const log = createWriteStream(path.join(root, `${cell.key}.log`), { flags: 'wx' });
    const child = spawn(process.execPath, runnerArgs(cell, root), { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    await new Promise(resolve => log.end(resolve));
    const manifestFile = path.join(root, cell.key, 'manifest.json');
    cell.runnerExitCode = code;
    cell.result = existsSync(manifestFile) ? (await read(manifestFile)).cells?.[0] ?? null : null;
    cell.status = cell.result?.status ?? 'infra_invalid';
    const evidence = path.join(root, cell.key, `${cell.task}-kodo`);
    const methodFile = path.join(evidence, 'state/method-results.json');
    cell.methods = existsSync(methodFile) ? await read(methodFile) : null;
    const callFile = path.join(evidence, 'relay/calls.json');
    const calls = existsSync(callFile) ? await read(callFile) : [];
    cell.usage = usageTotals(calls);
    cell.finishedAt = new Date().toISOString();
    const reported = cell.methods?.session;
    if (!reported || reported.inlineMethods !== ['marking', 'checkpoint', 'active'].includes(cell.arm) || reported.methodUnloading !== (['checkpoint', 'active'].includes(cell.arm)) || reported.toolProfile !== 'compact-v2' || reported.methodToolView !== (['marking', 'checkpoint', 'active'].includes(cell.arm) ? cell.arm === 'active' ? 'active' : 'stable' : null)) matrix.stopReason = 'Persisted method policy missing or mismatched';
    if (calls.some(call => [401, 402, 403].includes(call.httpStatus))) matrix.stopReason = 'Provider authorization or billing failure';
    if (cell.result?.recordingErrors?.length || cell.result?.traceError) matrix.stopReason = 'Incomplete evidence recording';
    await save();
    console.log(JSON.stringify({ key: cell.key, status: cell.status, verification: cell.result?.verification, adoption: cell.methods?.adoption, unloads: cell.methods?.events?.filter(event => event.type === 'context.methods.unloaded').length, stop: matrix.stopReason ?? null }));
    if (matrix.stopReason) break;
  }
  matrix.status = matrix.stopReason ? 'stopped' : 'finished'; matrix.finishedAt = new Date().toISOString(); await save();
  if (matrix.stopReason) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
