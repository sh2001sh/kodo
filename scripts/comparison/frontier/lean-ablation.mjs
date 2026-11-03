// FastAPI ablation of the lean tool views (plan section 11): P (Pi), R0 (compact-v2),
// L1 (lean-solo) and L3 (lean-team), three rotated blocks, serial, frozen build and scripts.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { verifyBuildManifest } from '../../write-build-manifest.mjs';
import { analyzeComparisonCell, usageTotals } from './efficiency-analysis.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const repository = path.resolve(import.meta.dirname, '../../..');
const scriptNames = ['run.mjs', 'launch.mjs', 'relay.mjs', 'recorder.mjs', 'execution-evidence.mjs', 'native.mjs', 'trace.mjs', 'delegation-metrics.mjs', 'efficiency-analysis.mjs', 'lean-ablation.mjs'];
const limits = { contextTokens: 1_048_576, outputTokens: 393_216 };
const factors = 'A,B,C,D,E';

/** Registered groups; P is the same-period gateway reference and carries no Kodo configuration. */
export const groups = {
  P: { harness: 'pi' },
  R0: { harness: 'kodo', toolProfile: 'compact-v2' },
  L1: { harness: 'kodo', toolProfile: 'lean-solo' },
  L3: { harness: 'kodo', toolProfile: 'lean-team' },
};
/** Incomplete rotation from plan 11.3; positions are reported because order effects do not cancel. */
export const blocks = [['P', 'R0', 'L1', 'L3'], ['R0', 'L1', 'L3', 'P'], ['L1', 'L3', 'P', 'R0']];

export function cellPlan(repeats = 1, selected = Object.keys(groups)) {
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > blocks.length) throw new Error(`repeats must be 1 to ${blocks.length}`);
  if (!selected.length || selected.some(group => !groups[group])) throw new Error(`groups must be a subset of ${Object.keys(groups).join(',')}`);
  // Positions stay those of the registered rotation, so a group run later keeps its recorded slot.
  return blocks.slice(0, repeats).flatMap((order, block) => order.map((group, position) => ({ name: `b${block + 1}-${group}`, group, block: block + 1, position: position + 1, ...groups[group] })).filter(cell => selected.includes(cell.group)));
}

export function runnerArgs(cell, root) {
  return [path.join(import.meta.dirname, 'run.mjs'), '--task', 'fastapi', '--harness', cell.harness,
    ...(cell.harness === 'kodo' ? ['--kodo-dist', path.join(root, 'build'), '--kodo-factors', factors, '--kodo-tool-profile', cell.toolProfile] : []),
    '--context-tokens', String(limits.contextTokens), '--output-tokens', String(limits.outputTokens), '--out', path.join(root, cell.name)];
}

/** Configuration persisted in the Kodo session must equal the registered treatment. */
export function configurationErrors(cell, saved) {
  if (cell.harness !== 'kodo') return [];
  if (!saved?.length) return ['no persisted session'];
  const expected = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map(name => [name, factors.split(',').includes(name)]));
  return saved.flatMap(config => [
    ...(config.toolProfile !== cell.toolProfile ? [`toolProfile ${config.toolProfile} != ${cell.toolProfile}`] : []),
    ...(config.taskProtocol !== 3 ? [`taskProtocol ${config.taskProtocol} != 3`] : []),
    ...Object.entries(expected).filter(([name, value]) => config.agentFactors?.[name] !== value).map(([name]) => `factor ${name}`),
  ]);
}

/** Reasons that end the experiment early; ordinary task failures do not stop it. */
export function stopReason(cell) {
  if (cell.configurationErrors?.length) return `persisted configuration mismatch: ${cell.configurationErrors.join('; ')}`;
  const statuses = cell.httpStatuses ?? {};
  if (statuses['401'] || statuses['402'] || statuses['403']) return 'provider authorization or billing failure';
  if (cell.scriptDrift?.length) return 'experiment scripts changed';
  if (cell.recording?.missingFiles?.length) return 'recording incomplete';
  return null;
}

async function scriptHashes() {
  return Object.fromEntries(await Promise.all(scriptNames.map(async name => [name, sha(await readFile(path.join(import.meta.dirname, name)))])));
}

async function runCell(cell, root) {
  const log = createWriteStream(path.join(root, `${cell.name}.log`), { flags: 'a' });
  const child = spawn(process.execPath, runnerArgs(cell, root), { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await new Promise(resolve => log.end(resolve));
  const manifestFile = path.join(root, cell.name, 'manifest.json');
  const result = existsSync(manifestFile) ? (await read(manifestFile)).cells?.[0] ?? null : null;
  return { code, result };
}

/** A failure before the agent started (no relay request recorded) is not a result of the group. */
const preRunFailure = (cell, evidence) => cell.result?.status === 'infra_invalid' && !existsSync(path.join(evidence, 'relay', 'calls.json'));

async function analyze(cell, root) {
  const evidence = path.join(root, cell.name, `fastapi-${cell.harness}`);
  if (!existsSync(path.join(evidence, 'relay', 'calls.json'))) return;
  const calls = await read(path.join(evidence, 'relay', 'calls.json'));
  cell.recording = { requests: calls.length, missingFiles: calls.flatMap(call => [`request-${call.index}.json`, `response-${call.index}.txt`]).filter(file => !existsSync(path.join(evidence, 'relay', file))) };
  cell.httpStatuses = Object.fromEntries([...new Set(calls.map(call => String(call.httpStatus)))].map(code => [code, calls.filter(call => String(call.httpStatus) === code).length]));
  cell.usage = usageTotals(calls);
  if (cell.harness !== 'kodo') return;
  const analysis = await analyzeComparisonCell(evidence, cell.result ?? {});
  await writeFile(path.join(evidence, 'process', 'lean-ablation-analysis.json'), JSON.stringify(analysis, null, 2) + '\n');
  cell.configurationErrors = configurationErrors(cell, analysis.savedConfiguration);
  cell.delivery = analysis.delivery.checks;
  cell.completeObserved = analysis.delivery.completeObserved;
  cell.parallelism = { peakChildLifespans: analysis.parallelism.peakChildLifespans, childRuns: analysis.childRuns.length };
}

async function main(output, repeats, selected) {
  const root = path.resolve(output);
  if (existsSync(root)) throw new Error('Evidence directory must be new');
  const build = verifyBuildManifest(repository);
  if (!build.ok) throw new Error(`Build is not current: ${build.problems.join('; ')}`);
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await cp(path.join(repository, 'dist'), path.join(root, 'build'), { recursive: true });
  for (const name of scriptNames) await cp(path.join(import.meta.dirname, name), path.join(root, 'scripts', name));
  const scripts = await scriptHashes();
  const order = blocks.slice(0, repeats);
  const matrix = { task: 'fastapi', design: 'plan section 11, FastAPI only', repeats, groups: selected, blocks: order, factors, ...limits, build: build.recorded, scripts, runnerPid: process.pid, startedAt: new Date().toISOString(),
    limitation: repeats === blocks.length
      ? 'Three rotated sequential blocks; one P sample per block cannot estimate within-block variance. Direction only, no significance.'
      : `${repeats} of ${blocks.length} rotated blocks, one sample per group: no variance estimate, no order-effect cancellation and no median rule. Single observations only.`,
    cells: cellPlan(repeats, selected).map(cell => ({ ...cell, status: 'pending' })) };
  const save = () => writeFile(path.join(root, 'matrix.json'), JSON.stringify(matrix, null, 2) + '\n');
  await save();
  for (const cell of matrix.cells) {
    const now = await scriptHashes();
    cell.scriptDrift = Object.keys(scripts).filter(name => scripts[name] !== now[name]);
    if (cell.scriptDrift.length) { matrix.stopReason = stopReason(cell); cell.status = 'not_run'; break; }
    cell.command = [process.execPath, ...runnerArgs(cell, root)];
    for (let attempt = 1; attempt <= 2; attempt++) {
      cell.status = 'running'; cell.startedAt = new Date().toISOString(); cell.attempt = attempt; await save();
      process.stdout.write(`START ${cell.name} attempt=${attempt}\n`);
      const { code, result } = await runCell(cell, root);
      cell.runnerExitCode = code; cell.result = result;
      cell.status = code === 0 && result ? result.status : 'infra_invalid';
      const evidence = path.join(root, cell.name, `fastapi-${cell.harness}`);
      if (attempt === 1 && preRunFailure(cell, evidence)) {
        cell.preRunFailure = { status: cell.status, error: result?.error ?? null };
        await rename(path.join(root, cell.name), path.join(root, `${cell.name}-prerun-failed`));
        continue;
      }
      break;
    }
    await analyze(cell, root);
    cell.finishedAt = new Date().toISOString(); await save();
    process.stdout.write(`DONE ${cell.name} status=${cell.status} verified=${cell.result?.verification?.passed} complete=${cell.completeObserved} seconds=${cell.result?.elapsedSec} credit=${cell.usage?.credit?.knownSubtotal}\n`);
    const stop = stopReason(cell);
    if (stop) { matrix.stopReason = `${cell.name}: ${stop}`; break; }
  }
  matrix.finishedAt = new Date().toISOString(); await save();
  const files = [];
  for (const entry of await readdir(root, { recursive: true })) {
    const file = path.join(root, entry);
    if ((await stat(file)).isFile()) files.push({ path: entry.replaceAll('\\', '/'), sha256: sha(await readFile(file)) });
  }
  await writeFile(path.join(root, 'evidence-sha256.json'), JSON.stringify(files, null, 2) + '\n');
  process.stdout.write(`EVIDENCE ${root}${matrix.stopReason ? ` STOPPED ${matrix.stopReason}` : ''}\n`);
  if (matrix.stopReason) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const positional = args.filter((argument, index) => !argument.startsWith('--') && !['--blocks', '--groups'].includes(args[index - 1]));
  if (positional.length !== 1) throw new Error('Usage: node lean-ablation.mjs NEW_EVIDENCE_DIRECTORY [--blocks 1|2|3] [--groups P,R0,L1,L3]');
  const requested = process.argv.includes('--blocks') ? Number(process.argv[process.argv.indexOf('--blocks') + 1]) : 1;
  const selected = args.includes('--groups') ? args[args.indexOf('--groups') + 1].split(',') : Object.keys(groups);
  await main(positional[0], requested, selected);
}
