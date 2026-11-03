import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { exportNative } from './native.mjs';
import { startRecorder } from './recorder.mjs';
import { writeTrace } from './trace.mjs';
import { captureExecutionEvidence } from './execution-evidence.mjs';
import { selectKodoSandbox } from './launch.mjs';
import { validateArm } from './method-worker.mjs';

const repository = path.resolve(import.meta.dirname, '../../..');
const source = path.join(repository, '.kodo/frontier-eval-source');
const tasks = {
  statemachine: { id: 'datacurve/python-statemachine-state-data-scoping', folder: 'python-statemachine-state-data-scoping', suite: 'deep-swe', image: 'kodo-frontier-trial-statemachine:20261031', verifier: 'kodo-frontier-verify-statemachine:20261031', base: '8d17ba9f6ba8420cf05fddb94013bc221ed9a222', timeoutSec: 5400, cpus: 2, memoryMb: 8192 },
  merger: { id: 'terminal-bench/multi-source-data-merger', folder: 'multi-source-data-merger', suite: 'terminal', image: 'kodo-frontier-trial-merger:20261028', verifier: 'alexgshaw/multi-source-data-merger:20251031', timeoutSec: 900, cpus: 1, memoryMb: 2048 },
  fastapi: { id: 'datacurve/fastapi-deprecation-response-headers', folder: 'fastapi-deprecation-response-headers', suite: 'deep-swe', image: 'kodo-frontier-trial-fastapi:20261028', verifier: 'kodo-frontier-verify-fastapi:20261028', base: '11614be9021aa4ac078d4d0693a8b5250a1010d8', timeoutSec: 5400, cpus: 2, memoryMb: 8192 },
  arktype: { id: 'datacurve/arktype-json-schema-refs-dependencies', folder: 'arktype-json-schema-refs-dependencies', suite: 'deep-swe', image: 'kodo-frontier-trial-arktype:20261028', verifier: 'kodo-frontier-verify-arktype:20261028', base: '04355e8b26d1ad5264ef62314a2bc46c4de58ed8', timeoutSec: 5400, cpus: 2, memoryMb: 8192 },
};
const harnesses = ['kodo', 'pi', 'opencode', 'dsh'];
const selectedTasks = process.argv.includes('--task') ? [process.argv[process.argv.indexOf('--task') + 1]] : ['merger', 'fastapi', 'arktype'];
const selectedHarnesses = process.argv.includes('--harness') ? process.argv[process.argv.indexOf('--harness') + 1].split(',') : harnesses;
if (selectedTasks.some(task => !tasks[task]) || selectedHarnesses.some(harness => !harnesses.includes(harness))) throw new Error('Unknown task or harness');
const limitArg = process.argv.includes('--limit-sec') ? Number(process.argv[process.argv.indexOf('--limit-sec') + 1]) : null;
if (limitArg !== null && (!Number.isInteger(limitArg) || limitArg < 1)) throw new Error('--limit-sec must be a positive integer');
if (limitArg !== null) for (const task of Object.values(tasks)) task.timeoutSec = Math.min(task.timeoutSec, limitArg);
// Mount the local Kodo build over the image copy so kernel changes are measured without rebuilding images.
const distArg = process.argv.includes('--kodo-dist') ? process.argv[process.argv.indexOf('--kodo-dist') + 1] : undefined;
const localKodo = process.argv.includes('--kodo-local') || distArg !== undefined;
const kodoDist = distArg ? path.resolve(distArg) : path.join(repository, 'dist');
const kodoMethodArm = process.argv.includes('--kodo-method-arm') ? validateArm(process.argv[process.argv.indexOf('--kodo-method-arm') + 1]) : undefined;
if (kodoMethodArm && (selectedHarnesses.some(name => name !== 'kodo') || !localKodo)) throw new Error('Method experiments require Kodo only and a frozen local build');
if (localKodo && !existsSync(path.join(kodoDist, 'cli/index.js'))) throw new Error('--kodo-local requires a local build: run npm run build');
const out = process.argv.includes('--out') ? path.resolve(process.argv[process.argv.indexOf('--out') + 1]) : path.join(repository, '.kodo', `frontier-fourway-${Date.now()}`);
if (existsSync(out)) throw new Error(`Evidence directory already exists: ${out}`);
await mkdir(out, { recursive: true });
const network = `fh-${process.pid}`;
const model = 'deepseek-v4.1-flash';
// Defaults keep earlier capped experiments reproducible; pass the model's published limits to remove the caps.
const tokenArg = (name, fallback) => {
  if (!process.argv.includes(name)) return fallback;
  const value = Number(process.argv[process.argv.indexOf(name) + 1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};
const contextTokens = tokenArg('--context-tokens', 65_536);
const outputTokens = tokenArg('--output-tokens', 8192);
const kodoConcurrency = {};
for (const [flag, field] of [['--kodo-max-concurrent-models', 'maxConcurrentModels'], ['--kodo-max-active-children', 'maxActiveChildren']]) {
  if (process.argv.includes(flag)) kodoConcurrency[field] = tokenArg(flag);
}
if (Object.keys(kodoConcurrency).length && selectedHarnesses.some(name => name !== 'kodo')) throw new Error('Kodo concurrency overrides require a Kodo-only run');
if (outputTokens >= contextTokens) throw new Error('--output-tokens must be smaller than --context-tokens');
const kodoAblation = process.argv.includes('--kodo-ablation') ? process.argv[process.argv.indexOf('--kodo-ablation') + 1] : undefined;
if (kodoAblation && !['no-state', 'small-tools'].includes(kodoAblation)) throw new Error('--kodo-ablation must be no-state or small-tools');
const kodoFactors = process.argv.includes('--kodo-factors') ? process.argv[process.argv.indexOf('--kodo-factors') + 1] : undefined;
if (process.argv.includes('--kodo-factors') && (typeof kodoFactors !== 'string' || !/^(?:none|[ABCDE](?:,[ABCDE])*)$/u.test(kodoFactors))) throw new Error('--kodo-factors requires none or comma-separated A,B,C,D,E');
// A frozen per-session tool view; absent keeps the CLI default (compact-v2) and earlier evidence reproducible.
const kodoToolProfile = process.argv.includes('--kodo-tool-profile') ? process.argv[process.argv.indexOf('--kodo-tool-profile') + 1] : undefined;
if (process.argv.includes('--kodo-tool-profile') && !['compact-v1', 'compact-v2', 'full', 'lean-solo', 'lean-team'].includes(kodoToolProfile)) throw new Error('--kodo-tool-profile must be compact-v1, compact-v2, full, lean-solo or lean-team');
if (kodoToolProfile !== undefined && selectedHarnesses.some(name => name !== 'kodo')) throw new Error('--kodo-tool-profile requires a Kodo-only run');
const kodoSandbox = selectKodoSandbox(kodoToolProfile, process.argv.includes('--kodo-sandbox'), process.argv.includes('--kodo-no-sandbox'));
if ((kodoSandbox || process.argv.includes('--kodo-no-sandbox')) && selectedHarnesses.some(name => name !== 'kodo')) throw new Error('Kodo sandbox overrides require a Kodo-only run');
// Seconds between workspace diff and resource samples during a trial; 0 disables sampling.
const recordIntervalSec = process.argv.includes('--record-interval-sec') ? Number(process.argv[process.argv.indexOf('--record-interval-sec') + 1]) : 60;
if (!Number.isInteger(recordIntervalSec) || recordIntervalSec < 0) throw new Error('--record-interval-sec must be a nonnegative integer');
const opencode = JSON.parse(await readFile(path.join(os.homedir(), '.config/opencode/opencode.json'), 'utf8'));
const provider = opencode.provider?.codego1;
const key = provider?.options?.apiKey;
const upstream = provider?.options?.baseURL;
if (typeof key !== 'string' || !key || typeof upstream !== 'string') throw new Error('Configured codego1 credential unavailable');
const sha = value => createHash('sha256').update(value).digest('hex');
const suffixArg = process.argv.includes('--instruction-suffix') ? process.argv[process.argv.indexOf('--instruction-suffix') + 1] : undefined;
if (process.argv.includes('--instruction-suffix') && (!suffixArg || suffixArg.startsWith('--'))) throw new Error('--instruction-suffix requires a file');
const instructionSuffix = suffixArg ? await readFile(path.resolve(suffixArg), 'utf8') : '';
const launcher = path.join(repository, 'scripts/comparison/frontier/launch.mjs');
const kodoBuild = localKodo ? { source: 'local dist mount', buildManifestSha256: existsSync(path.join(kodoDist, '.kodo-build-manifest.json')) ? sha(await readFile(path.join(kodoDist, '.kodo-build-manifest.json'))) : null } : { source: 'image' };
const manifest = { benchmark: 'frontierharness-eval-v1 representative subset', sourceCommit: 'e837a70bd6beb4e72eeeda62dd06e3bd34f6cb63', launcherSha256: sha(await readFile(launcher)), kodoBuild, model, provider: 'codego1', endpointHost: new URL(upstream).host, contextTokens, outputTokens, ...(kodoAblation ? { kodoAblation } : {}), recordIntervalSec, tasks: selectedTasks.map(name => tasks[name]), harnesses: selectedHarnesses, order: [], conditions: { trialNetwork: 'Docker internal network, relay only; verifier no network', approval: 'Noninteractive writes and commands allowed within disposable container; defaults reviewed separately', wallTime: 'Docker launch to process exit; external verifier excluded', budget: limitArg === null ? 'Task original timeout; model usage from upstream relay' : `All tasks capped at ${limitArg}s; model usage from upstream relay` }, cells: [] };
if (kodoFactors !== undefined) manifest.kodoFactors = kodoFactors;
if (suffixArg) manifest.instructionSuffix = { text: instructionSuffix, sha256: sha(instructionSuffix), interpretation: 'Modified instruction; directed test, not an official benchmark score' };
if (kodoToolProfile !== undefined) manifest.kodoToolProfile = kodoToolProfile;
if (Object.keys(kodoConcurrency).length) manifest.kodoConcurrency = kodoConcurrency;
manifest.kodoSandbox = kodoSandbox;
if (kodoMethodArm) manifest.kodoMethodArm = kodoMethodArm;
const saveManifest = () => writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
await saveManifest();

async function command(program, args, { cwd = repository, input, timeoutMs = 120_000, raw = false, combine = false } = {}) {
  const child = spawn(program, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const exit = await new Promise(resolve => { child.on('error', error => resolve({ code: -1, error: String(error) })); child.on('close', code => resolve({ code })); });
  clearTimeout(timer);
  const result = { ...exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  if (result.code !== 0) throw new Error(`${program} ${args.slice(0, 4).join(' ')} failed (${result.code}): ${result.stderr.toString('utf8').slice(-1800)}`);
  const output = combine ? Buffer.concat([result.stdout, result.stderr]) : result.stdout;
  return raw ? output : output.toString('utf8').trim();
}
async function optional(program, args, options) { try { return await command(program, args, options); } catch { return null; } }

async function startRelay(directory) {
  const script = path.join(repository, 'scripts/comparison/frontier/relay.mjs');
  const child = spawn('docker', ['run', '--rm', '-i', '--name', `fh-relay-${process.pid}`, '--network', 'bridge', '-v', `${script}:/fh/relay.mjs:ro`, '-v', `${directory}:/evidence`, 'node:24-bookworm-slim', 'node', '/fh/relay.mjs'], { cwd: repository, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay startup timed out')), 30_000);
    child.stdout.on('data', chunk => { if (String(chunk).includes('relay ready')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { process.stderr.write(String(chunk).replaceAll(key, '[REDACTED]')); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`relay exited ${code}`)); });
  });
  child.stdin.end(JSON.stringify({ upstream, key, model, outputTokens, contextTokens }));
  await ready;
  await command('docker', ['network', 'connect', '--alias', 'fh-relay', network, `fh-relay-${process.pid}`]);
  return child;
}

async function verifyTerminal(container, directory, task) {
  const artifacts = path.join(directory, 'artifacts');
  await mkdir(artifacts);
  for (const file of ['merged_users.parquet', 'conflicts.json']) await optional('docker', ['cp', `${container}:/app/${file}`, path.join(artifacts, file)]);
  const verifier = path.join(repository, '.kodo/frontier-terminal-bench', task.folder, 'tests');
  const code = "import runpy; d=runpy.run_path('/tests/test_outputs.py'); names=sorted(x for x in d if x.startswith('test_')); [(d[n](),print('PASS',n)) for n in names]; print('PASS_COUNT',len(names))";
  try {
    const stdout = await command('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'python3', '-v', `${artifacts}:/app:ro`, '-v', `${verifier}:/tests:ro`, task.verifier, '-c', code], { timeoutMs: 120_000 });
    await writeFile(path.join(directory, 'verifier.log'), stdout);
    return { passed: true, output: stdout };
  } catch (error) { await writeFile(path.join(directory, 'verifier.log'), String(error)); return { passed: false, error: String(error) }; }
}

async function verifyDeepSwe(container, directory, task) {
  const snapshot = `fh-snapshot-${process.pid}-${path.basename(directory)}`;
  const artifacts = path.join(directory, 'artifacts');
  const verifierDir = path.join(directory, 'verifier');
  await mkdir(artifacts); await mkdir(verifierDir);
  try {
    await command('docker', ['commit', container, snapshot], { timeoutMs: 180_000 });
    const gitStateScript = 'import json,subprocess; cmds={"branch":["branch","--show-current"],"head":["rev-parse","HEAD"],"status":["status","--porcelain=v1"],"commits":["log","--format=%H %s","' + task.base + '..HEAD"]}; print(json.dumps({k:subprocess.run(["git","-c","safe.directory=/app",*v],cwd="/app",text=True,capture_output=True,check=True).stdout for k,v in cmds.items()}))';
    const gitState = await command('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'python', snapshot, '-c', gitStateScript]);
    await writeFile(path.join(directory, 'git-state.json'), gitState);
    const patch = await command('docker', ['run', '--rm', '--network', 'none', '--entrypoint', 'sh', snapshot, '-lc', `cd /app && git config --global --add safe.directory /app && git add -N . && git diff --binary ${task.base}`], { timeoutMs: 120_000, raw: true });
    await writeFile(path.join(artifacts, 'model.patch'), patch);
    const result = await command('docker', ['run', '--rm', '--network', 'none', '--cpus', String(task.cpus), '--memory', `${task.memoryMb}m`, '-v', `${artifacts}:/logs/artifacts:ro`, '-v', `${verifierDir}:/logs/verifier`, '--entrypoint', 'bash', task.verifier, '-lc', 'tr -d "\\r" < /tests/test.sh | bash'], { timeoutMs: 2_000_000 });
    await writeFile(path.join(directory, 'verifier.log'), result);
    const score = JSON.parse(await readFile(path.join(verifierDir, 'reward.json'), 'utf8'));
    return { passed: score.reward === 1, score, patchBytes: patch.length };
  } catch (error) {
    await writeFile(path.join(directory, 'verifier-error.log'), String(error));
    const score = existsSync(path.join(verifierDir, 'reward.json')) ? JSON.parse(await readFile(path.join(verifierDir, 'reward.json'), 'utf8')) : null;
    return { passed: false, score, error: String(error) };
  } finally { await optional('docker', ['image', 'rm', snapshot], { timeoutMs: 30_000 }); }
}

await command('docker', ['network', 'create', '--internal', network]);
try {
  for (const taskName of selectedTasks) {
    const task = tasks[taskName];
    const order = taskName === 'fastapi' ? [...selectedHarnesses].reverse() : taskName === 'arktype' ? ['pi', 'kodo', 'dsh', 'opencode'].filter(name => selectedHarnesses.includes(name)) : selectedHarnesses;
    for (const harness of order) {
      const cellName = `${taskName}-${harness}`;
      const directory = path.join(out, cellName);
      const configDir = path.join(directory, 'config');
      const stateDir = path.join(directory, 'state');
      const relayDir = path.join(directory, 'relay');
      await mkdir(configDir, { recursive: true }); await mkdir(stateDir); await mkdir(relayDir);
      const instruction = await readFile(path.join(source, 'tasks', task.folder, 'instruction.md'), 'utf8');
      const originalObjective = task.suite === 'terminal' ? instruction : `${instruction}\n\nThe task repository is /app. Work in this repository or in isolated task checkouts created and managed by the host. Integrate the final delivery back into /app. The verifier is separate and unavailable during this run.\n`;
      const objective = instructionSuffix ? `${originalObjective}\n\n${instructionSuffix}\n` : originalObjective;
      await writeFile(path.join(configDir, 'instruction.md'), objective);
      await writeFile(path.join(configDir, 'trial.json'), JSON.stringify({ task: task.id, harness, model, contextTokens, outputTokens, timeoutSec: task.timeoutSec, ...(kodoAblation ? { kodoAblation } : {}), ...(kodoToolProfile !== undefined ? { kodoToolProfile } : {}), ...(kodoFactors !== undefined ? { kodoFactors } : {}), ...(Object.keys(kodoConcurrency).length ? { kodoConcurrency } : {}), kodoSandbox, ...(kodoMethodArm ? { kodoMethodArm } : {}) }));
      if (kodoMethodArm) await writeFile(path.join(configDir, 'method-worker.mjs'), await readFile(path.join(import.meta.dirname, 'method-worker.mjs')));
      const cell = { task: task.id, harness, originalInstructionSha256: sha(instruction), instructionSha256: sha(objective), startedAt: new Date().toISOString(), status: 'starting', ...(kodoAblation ? { kodoAblation } : {}) };
      manifest.cells.push(cell); manifest.order.push(cellName); await saveManifest();
      process.stdout.write(`START ${cellName}\n`);
      const relay = await startRelay(relayDir);
      const container = `fh-trial-${process.pid}-${cellName}`;
      let recorder;
      try {
        const started = Date.now();
        // Only this newly created, disposable fixture is normalized. Refuse an unexpected
        // HEAD or dirty image rather than discarding changes. Every treatment gets the same main.
        const start = task.base ? ['--entrypoint', '/bin/sh', task.image, '-ec',
          'test "$(git -C /app rev-parse HEAD)" = "$1"; test -z "$(git -C /app status --porcelain)"; git -C /app switch -C main "$1"; exec /opt/fh/bin/node /opt/fh/launch.mjs', 'fixture-init', task.base]
          : ['--entrypoint', '/opt/fh/bin/node', task.image, '/opt/fh/launch.mjs'];
        if (task.base) cell.initialRepository = { branch: 'main', commit: task.base, requiresClean: true };
        await command('docker', ['run', '-d', '--name', container, '--network', network, '--cpus', String(task.cpus), '--memory', `${task.memoryMb}m`, '-v', `${configDir}:/fh-config:ro`, '-v', `${stateDir}:/fh-state`, '-v', `${launcher}:/opt/fh/launch.mjs:ro`, ...(localKodo && harness === 'kodo' ? ['-v', `${kodoDist}:/opt/fh/kodo/dist:ro`] : []), ...start], { timeoutMs: 120_000 });
        recorder = await startRecorder({ container, directory, task, intervalSec: recordIntervalSec });
        let timedOut = false;
        const stop = setTimeout(() => { timedOut = true; optional('docker', ['stop', '--time', '5', container]); }, task.timeoutSec * 1000);
        const exitCode = Number((await command('docker', ['wait', container], { timeoutMs: (task.timeoutSec + 60) * 1000 })).trim());
        clearTimeout(stop);
        cell.workspaceSnapshots = await recorder.stop();
        recorder = undefined;
        cell.elapsedSec = (Date.now() - started) / 1000;
        cell.exitCode = exitCode;
        cell.timedOut = timedOut;
        cell.status = timedOut ? 'timeout' : exitCode === 0 ? 'completed' : 'failed';
        const logs = await command('docker', ['logs', container], { timeoutMs: 30_000, raw: true, combine: true });
        await writeFile(path.join(directory, 'agent.log'), logs);
        cell.verification = task.suite === 'terminal' ? await verifyTerminal(container, directory, task) : await verifyDeepSwe(container, directory, task);
        process.stdout.write(`DONE ${cellName} status=${cell.status} elapsed=${cell.elapsedSec}s verified=${cell.verification.passed}\n`);
      } catch (error) { cell.status = 'infra_invalid'; cell.error = String(error); process.stdout.write(`INFRA ${cellName} ${cell.error.slice(0, 250)}\n`); }
      finally {
        // Read the delivered Git state before deleting the disposable trial container.
        // Passing an external verifier alone does not establish the requested branch/commit delivery.
        if (task.base) {
          const archive = await optional('docker', ['cp', `${container}:/app/.git`, path.join(directory, 'git')], { timeoutMs: 120_000 });
          if (archive === null) cell.gitEvidenceError = 'Could not preserve the trial Git repository';
        }
        if (!existsSync(path.join(directory, 'agent.log'))) {
          const partialLogs = await optional('docker', ['logs', '--timestamps', container], { timeoutMs: 30_000, raw: true, combine: true });
          if (partialLogs !== null) await writeFile(path.join(directory, 'agent.log'), partialLogs);
        }
        // These clones live outside /app. Neither its diff snapshots nor its .git archive
        // includes unintegrated work, so retain all clone trees before removing the container.
        cell.executionEvidence = await captureExecutionEvidence({ container, directory, command });
        if (cell.executionEvidence.status === 'failed') {
          cell.recordingErrors ??= [];
          cell.recordingErrors.push(`execution archive: ${cell.executionEvidence.error}`);
          process.stderr.write(`RECORDING ${cellName} execution archive failed: ${cell.executionEvidence.error.slice(0, 250)}\n`);
        }
        // Keep the stopped container recoverable if evidence export fails.
        if (cell.executionEvidence.status !== 'failed') await optional('docker', ['rm', '-f', container]);
        else cell.retainedContainer = container;
        if (recorder) { cell.workspaceSnapshots = await recorder.stop(); recorder = undefined; }
        await optional('docker', ['stop', '--time', '2', `fh-relay-${process.pid}`]);
        relay.kill();
        if (existsSync(path.join(relayDir, 'calls.json'))) {
          const calls = JSON.parse(await readFile(path.join(relayDir, 'calls.json'), 'utf8'));
          // Totals are known subtotals; missing fields have explicit counts, never
          // silently become measured zero when a disconnected stream lacks final usage.
          const usage = { requests: calls.length, unknown: 0, input: 0, inputUnknown: 0, cachedInput: 0, cachedInputUnknown: 0, output: 0, outputUnknown: 0, credit: 0, creditUnknown: 0 };
          for (const call of calls) {
            if (!call.usage) usage.unknown++;
            const values = {
              input: call.usage?.prompt_tokens ?? call.usage?.input_tokens,
              output: call.usage?.completion_tokens ?? call.usage?.output_tokens,
              cachedInput: call.usage?.prompt_tokens_details?.cached_tokens ?? call.usage?.input_tokens_details?.cached_tokens ?? call.usage?.cache_read_input_tokens,
              credit: call.usage?.credit,
            };
            for (const [field, value] of Object.entries(values)) {
              if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[field] += value;
              else usage[`${field}Unknown`]++;
            }
          }
          cell.usage = usage;
        }
        // Step trace and native harness records; a failure here is recorded rather than aborting the run.
        try {
          const tools = await exportNative(directory, harness);
          cell.trace = await writeTrace(directory, cellName, tools);
        } catch (error) { cell.traceError = String(error); process.stderr.write(`TRACE ${cellName} ${cell.traceError.slice(0, 250)}\n`); }
        cell.finishedAt = new Date().toISOString(); await saveManifest();
      }
    }
  }
} finally { await optional('docker', ['network', 'rm', network]); }
process.stdout.write(`EVIDENCE ${out}\n`);
