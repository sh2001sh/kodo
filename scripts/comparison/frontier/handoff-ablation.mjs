// Four Kodo cells, one repeat each. Frozen build and explicit factors make the comparisons auditable.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { readEvidence } from './delegation-metrics.mjs';
import { verifyBuildManifest } from '../../write-build-manifest.mjs';

const repository = path.resolve(import.meta.dirname, '../../..');
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error('Usage: node handoff-ablation.mjs NEW_EVIDENCE_DIRECTORY');
const root = path.resolve(output);
if (existsSync(root)) throw new Error('Evidence directory must be new');
const build = verifyBuildManifest(repository);
if (!build.ok) throw new Error(`Build is not current: ${build.problems.join('; ')}`);
await mkdir(root, { recursive: true });
await cp(path.join(repository, 'dist'), path.join(root, 'build'), { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Sequential order is recorded; one repeat cannot disentangle time-of-day/provider drift.
const groups = [
  { name: 'R0', factors: 'A,B,C' }, { name: 'RDE', factors: 'A,B,C,D,E' },
  { name: 'RD', factors: 'A,B,C,D' }, { name: 'RE', factors: 'A,B,C,E' },
];
const matrix = { task: 'fastapi', harness: 'kodo', repeats: 1, runnerPid: process.pid, startedAt: new Date().toISOString(),
  contextTokens: 1_048_576, outputTokens: 393_216, build: build.recorded,
  limitation: 'Exploratory single sample per group, sequential: model variability and gateway drift remain confounders.',
  cells: groups.map(group => ({ ...group, status: 'pending' })) };
const save = () => writeFile(path.join(root, 'matrix.json'), JSON.stringify(matrix, null, 2) + '\n');
await mkdir(path.join(root, 'scripts'));
for (const name of ['run.mjs', 'launch.mjs', 'relay.mjs', 'recorder.mjs', 'native.mjs', 'trace.mjs', 'delegation-metrics.mjs', 'handoff-ablation.mjs']) await cp(path.join(import.meta.dirname, name), path.join(root, 'scripts', name));
await save();

for (const cell of matrix.cells) {
  const directory = path.join(root, cell.name);
  const log = createWriteStream(path.join(root, `${cell.name}.log`));
  const args = [path.join(import.meta.dirname, 'run.mjs'), '--task', 'fastapi', '--harness', 'kodo', '--kodo-dist', path.join(root, 'build'),
    '--kodo-factors', cell.factors, '--context-tokens', String(matrix.contextTokens), '--output-tokens', String(matrix.outputTokens), '--out', directory];
  cell.status = 'running'; cell.startedAt = new Date().toISOString(); cell.command = [process.execPath, ...args]; await save();
  process.stdout.write(`START ${cell.name} factors=${cell.factors}\n`);
  const child = spawn(process.execPath, args, { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  cell.runnerPid = child.pid; await save();
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  await new Promise(resolve => log.end(resolve));
  cell.runnerExitCode = code;
  const manifestFile = path.join(directory, 'manifest.json');
  const manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, 'utf8')) : null;
  const result = manifest?.cells?.[0];
  cell.result = result ?? null;
  cell.status = code === 0 && result ? result.status : 'infra_invalid';
  const evidence = path.join(directory, 'fastapi-kodo');
  if (existsSync(path.join(evidence, 'relay', 'calls.json'))) {
    const metrics = await readEvidence(evidence, { sourceRoots: ['fastapi'] });
    await writeFile(path.join(evidence, 'process', 'delegation-metrics.json'), JSON.stringify(metrics, null, 2) + '\n');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(evidence, 'state', 'kodo', 'kodo.sqlite'), { readOnly: true });
    try { cell.savedFactors = db.prepare('select data from sessions').all().map(row => JSON.parse(row.data).agentFactors); }
    finally { db.close(); }
    const expected = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map(name => [name, cell.factors.split(',').includes(name)]));
    if (!cell.savedFactors.length || cell.savedFactors.some(flags => Object.keys(expected).some(key => flags?.[key] !== expected[key]))) {
      cell.status = 'configuration_invalid'; await save(); throw new Error(`${cell.name}: persisted factors do not match treatment`);
    }
    const calls = JSON.parse(await readFile(path.join(evidence, 'relay', 'calls.json'), 'utf8'));
    cell.recording = { requests: calls.length, missingFiles: calls.flatMap(call => [`request-${call.index}.json`, `response-${call.index}.txt`]).filter(file => !existsSync(path.join(evidence, 'relay', file))) };
  }
  cell.finishedAt = new Date().toISOString(); await save();
  process.stdout.write(`DONE ${cell.name} status=${cell.status} verified=${result?.verification?.passed} seconds=${result?.elapsedSec} credit=${result?.usage?.credit}\n`);
}
// Preserve hashes of original evidence for future analysis without rewriting those originals.
matrix.finishedAt = new Date().toISOString(); await save();
const files = [];
for (const entry of await readdir(root, { recursive: true })) {
  const file = path.join(root, entry);
  if ((await stat(file)).isFile()) files.push({ path: entry.replaceAll('\\', '/'), sha256: sha(await readFile(file)) });
}
await writeFile(path.join(root, 'evidence-sha256.json'), JSON.stringify(files, null, 2) + '\n');
process.stdout.write(`EVIDENCE ${root}\n`);
