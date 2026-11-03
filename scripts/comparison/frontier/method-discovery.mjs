// A discovery diagnostic, not a rerun of the full FastAPI feature benchmark.
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

export const definition = {
  id: 'diagnostic/fastapi-release',
  description: 'Project-specific release-note.json delivery convention for the isolated FastAPI release rehearsal. Contains the required project fields and compatibility wording.',
  content: 'This is an isolated synthetic release rehearsal, not a real release. Read the current __version__ in fastapi/__init__.py. Write release-note.json as a JSON object with exactly these fields: project = "FastAPI", version = the observed __version__, rehearsal_protocol = "kodo-release-r7", compatibility = "No API behavior changes; metadata rehearsal only.". Do not modify source files or claim that a real release was made. Verify the saved JSON before delivery.',
};
export const objective = 'This is an isolated synthetic FastAPI release rehearsal, not a production release. Read fastapi/__init__.py and prepare release-note.json containing the current version and compatibility statement, following the project-specific release convention. Work in /app, leave source files unchanged, and report what you delivered.';
export function assess(text, version) {
  try {
    const value = JSON.parse(text);
    const checks = { fields: Object.keys(value).sort().join(',') === 'compatibility,project,rehearsal_protocol,version',
      project: value.project === 'FastAPI', version: value.version === version,
      convention: value.rehearsal_protocol === 'kodo-release-r7' && value.compatibility === 'No API behavior changes; metadata rehearsal only.' };
    return { passed: Object.values(checks).every(Boolean), checks };
  } catch { return { passed: false, checks: { validJson: false } }; }
}
const sha = value => createHash('sha256').update(value).digest('hex');

async function worker() {
  const config = JSON.parse(await readFile('/fh-config/trial.json', 'utf8'));
  const { createLocalRelay } = await import('/fh-launch.mjs');
  const localRelay = createLocalRelay();
  await new Promise(resolve => localRelay.listen(4011, '127.0.0.1', resolve));
  const [{ Application }, { serializeCard }, { methodSkillId }, { roleAllows }] = await Promise.all([
    import('/opt/fh/kodo/dist/application/index.js'), import('/opt/fh/kodo/dist/agents/card.js'),
    import('/opt/fh/kodo/dist/extensions/methods.js'), import('/opt/fh/kodo/dist/runtime/role-view.js'),
  ]);
  const app = new Application('/fh-state/kodo', undefined, undefined, {
    toolProfile: 'compact-v2', taskProtocol: 3, shellProgram: '/bin/bash', globalInstructions: false, projectMemory: false,
    agentFactors: { A: true, B: true, C: true, D: true, E: true }, inlineMethods: true, methodUnloading: false, methodToolView: 'stable',
  });
  let run;
  const stop = () => { if (run) app.coordinator.cancel(run.id); };
  process.on('SIGTERM', stop);
  try {
    const tools = [...new Set([...app.defaultCard.tools, 'skill.list', 'skill.load', 'artifact.write'])].filter(name => roleAllows({ card: app.defaultCard },
      { inlineMethods: true, toolProfile: 'compact-v2', permissions: ['read', 'write', 'exec'], agentFactors: { A: true, B: true, C: true, D: true, E: true } }, name));
    const card = app.parseCard(serializeCard({ ...app.defaultCard, tools }));
    const method = app.parseCard(serializeCard({ id: definition.id, name: 'FastAPI release convention', version: '1.0.0', schemaVersion: 2,
      description: definition.description, digest: '', catalog: { path: 'engineering/release' }, routing: { use_when: [definition.description], mode: 'write' },
      execution: { modes: ['inline'] }, tools, prompt: definition.content }));
    app.registerCard(method);
    const id = methodSkillId(method);
    const prompt = objective + (config.cell === 'positive-control' ? ` First load the method using skill.load with id ${JSON.stringify(id)}, then complete the task.` : '');
    await writeFile('/fh-state/prompt.json', JSON.stringify({ prompt, id, positiveControl: config.cell === 'positive-control' }, null, 2));
    run = app.createRun({ workspace: '/app', objective: prompt, card, permissions: ['read', 'write', 'exec'],
      binding: { provider: 'codego1', model: config.model, protocol: 'chat-completions', baseURL: 'http://127.0.0.1:4011/v1', apiKeyEnv: 'FH_RELAY_KEY', limits: { context: config.contextTokens, output: config.outputTokens } },
      budget: { maxModelCalls: 16, maxToolCalls: 30, maxContextTokens: config.contextTokens, maxOutputTokens: config.outputTokens, maxDurationMs: 300000, toolTimeoutMs: 30000 },
    });
    const start = Date.now();
    const result = await app.run(run.id);
    const owners = app.store.listRuns(run.sessionId);
    const events = owners.flatMap(owner => app.store.events(owner.id, { types: ['method.loaded', 'method.ended', 'context.methods.unloaded'] }));
    const calls = owners.flatMap(owner => app.store.calls(owner.id)).filter(call => call.kind === 'tool');
    const report = { cell: config.cell, status: result.status, error: result.error ?? null, elapsedMs: Date.now() - start, runId: run.id, id,
      loaded: events.some(event => event.runId === run.id && event.type === 'method.loaded' && event.data.id === id), events,
      tools: calls.map(call => ({ name: call.name, status: call.status, runId: call.runId })),
      finalText: result.resultRef ? app.store.readBlob(result.resultRef) : null };
    await writeFile('/fh-state/result.json', JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ cell: config.cell, status: result.status, loaded: report.loaded }) + '\n');
  } finally { process.off('SIGTERM', stop); await app.shutdown(); localRelay.closeAllConnections(); await new Promise(resolve => localRelay.close(resolve)); }
}

async function treeHashes(directory, prefix = '') {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name, target = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await treeHashes(target, name + '/'));
    else if (entry.isFile()) result[name] = sha(await readFile(target));
  }
  return result;
}

export async function main(argv) {
  const repository = path.resolve(import.meta.dirname, '../../..');
  const output = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : `.kodo/method-discovery-${Date.now()}`);
  await mkdir(output, { recursive: false });
  const plan = { diagnostic: 'inline-method-discovery', synthetic: true, provider: 'codego1', model: 'deepseek-v4.1-flash',
    image: 'kodo-frontier-trial-fastapi:20261028', base: '11614be9021aa4ac078d4d0693a8b5250a1010d8',
    cells: ['positive-control', 'autonomous-1', 'autonomous-2'], objective, definition,
    marking: { inlineMethods: true, methodUnloading: false, methodToolView: 'stable' },
    contextTokens: 1048576, outputTokens: 8192, maxModelCalls: 16, maxToolCalls: 30, maxDurationMs: 300000,
    totalCreditAdmissionBudget: 10, creditReserve: 1,
    interpretation: ['Positive control is excluded from autonomous adoption.', 'Positive control failure stops the diagnostic for investigation.',
      'Autonomous loading demonstrates discovery for this fixture, not general performance benefit or causation versus the old display.',
      'Two valid autonomous nonloads after a passing control justify stopping expansion for this tested combination, not a universal claim about the model.',
      'Timeout, unknown billing, budget rejection or missing evidence are inconclusive, not nonadoption.',
      'Admission stops at 9 known credits or unknown billing; final in-flight billing is controlled by the supplier and can exceed the reserved 1 credit.',
      'This task is a small release rehearsal on the historical snapshot; it does not rerun the original feature task.'] };
  const save = (file, value) => writeFile(path.join(output, file), JSON.stringify(value, null, 2) + '\n');
  await save('plan.json', plan);
  if (!argv.includes('--run')) { process.stdout.write(JSON.stringify({ output, noModelCalls: true }) + '\n'); return; }
  const configuration = JSON.parse(await readFile(path.join(os.homedir(), '.config/opencode/opencode.json'), 'utf8')).provider?.codego1?.options;
  if (!configuration?.apiKey || !configuration?.baseURL) throw new Error('codego1 configuration unavailable');
  const key = configuration.apiKey;
  const command = (args, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
    const timer = setTimeout(() => { child.kill(); reject(new Error('Docker command timed out')); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code) reject(new Error(Buffer.concat(stderr).toString().replaceAll(key, '[REDACTED]'))); else resolve(Buffer.concat(stdout).toString()); });
  });
  const dist = path.join(output, 'dist');
  const baselineInit = await command(['run', '--rm', '--network', 'none', '--entrypoint', 'cat', plan.image, '/app/fastapi/__init__.py']);
  const baselineVersion = /__version__\s*=\s*['"]([^'"]+)/u.exec(baselineInit)?.[1];
  if (!baselineVersion) throw new Error('Fixture version missing');
  await writeFile(path.join(output, 'baseline-init.py'), baselineInit);
  await cp(path.join(repository, 'dist'), dist, { recursive: true });
  await cp(path.join(import.meta.dirname, 'method-discovery.mjs'), path.join(output, 'worker.mjs'));
  await cp(path.join(import.meta.dirname, 'relay.mjs'), path.join(output, 'relay.mjs'));
  await cp(path.join(import.meta.dirname, 'launch.mjs'), path.join(output, 'launch.mjs'));
  await save('build.json', { dist: await treeHashes(dist), worker: sha(await readFile(path.join(output, 'worker.mjs'))), relay: sha(await readFile(path.join(output, 'relay.mjs'))),
    launch: sha(await readFile(path.join(output, 'launch.mjs'))), image: (await command(['image', 'inspect', plan.image, '--format', '{{.Id}}'])).trim() });
  const network = `method-discovery-${process.pid}`, relayName = `${network}-relay`, results = [];
  const relayDir = path.join(output, 'relay');
  await mkdir(relayDir);
  await command(['network', 'create', '--internal', network]);
  let relay;
  try {
    relay = spawn('docker', ['run', '--rm', '-i', '--name', relayName, '--network', 'bridge', '-v', `${path.join(output, 'relay.mjs')}:/fh/relay.mjs:ro`, '-v', `${relayDir}:/evidence`, 'node:24-bookworm-slim', 'node', '/fh/relay.mjs'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Relay startup timed out')), 30000);
      relay.stdout.on('data', chunk => { if (String(chunk).includes('relay ready')) { clearTimeout(timer); resolve(); } });
      relay.stderr.on('data', chunk => process.stderr.write(String(chunk).replaceAll(key, '[REDACTED]')));
      relay.on('error', reject); relay.on('exit', code => { clearTimeout(timer); reject(new Error(`Relay exited ${code}`)); });
    });
    relay.stdin.end(JSON.stringify({ upstream: configuration.baseURL, key, model: plan.model, outputTokens: plan.outputTokens, contextTokens: plan.contextTokens,
      maxCredit: plan.totalCreditAdmissionBudget, creditReserve: plan.creditReserve, maxRequests: 48 }));
    await ready;
    await command(['network', 'connect', '--alias', 'fh-relay', network, relayName]);
    let offset = 0;
    for (const cell of plan.cells) {
      const directory = path.join(output, cell), configDir = path.join(directory, 'config'), stateDir = path.join(directory, 'state');
      await mkdir(configDir, { recursive: true }); await mkdir(stateDir);
      await writeFile(path.join(configDir, 'trial.json'), JSON.stringify({ ...plan, cell }));
      const container = `${network}-${cell}`;
      process.stdout.write(`START ${cell}\n`);
      try {
        await command(['run', '-d', '--name', container, '--network', network, '--cpus', '2', '--memory', '8192m', '-e', 'FH_RELAY_KEY=diagnostic-relay-placeholder',
          '-v', `${dist}:/opt/fh/kodo/dist:ro`, '-v', `${path.join(output, 'worker.mjs')}:/fh-worker.mjs:ro`, '-v', `${path.join(output, 'launch.mjs')}:/fh-launch.mjs:ro`, '-v', `${configDir}:/fh-config:ro`, '-v', `${stateDir}:/fh-state`,
          '--entrypoint', '/bin/sh', plan.image, '-ec', 'test "$(git -C /app rev-parse HEAD)" = "$1"; test -z "$(git -C /app status --porcelain)"; exec /opt/fh/bin/node /fh-worker.mjs --worker', 'fixture-init', plan.base]);
        const exitCode = Number((await command(['wait', container], 360000)).trim());
        await writeFile(path.join(directory, 'agent.log'), await command(['logs', container]));
        await command(['cp', `${container}:/app/fastapi/__init__.py`, path.join(directory, 'init.py')]);
        let artifact = '';
        try { await command(['cp', `${container}:/app/release-note.json`, path.join(directory, 'release-note.json')]); artifact = await readFile(path.join(directory, 'release-note.json'), 'utf8'); }
        catch (error) { await writeFile(path.join(directory, 'artifact-error.txt'), error.message); }
        const initUnchanged = sha(await readFile(path.join(directory, 'init.py'))) === sha(baselineInit);
        await writeFile(path.join(directory, 'container-diff.txt'), await command(['diff', container]));
        const report = JSON.parse(await readFile(path.join(stateDir, 'result.json'), 'utf8'));
        const allCalls = JSON.parse(await readFile(path.join(relayDir, 'calls.json'), 'utf8'));
        const calls = allCalls.slice(offset); offset = allCalls.length;
        const creditUnknown = calls.filter(call => !Number.isFinite(call.usage?.credit)).length;
        const first = calls[0] ? JSON.parse(await readFile(path.join(relayDir, `request-${calls[0].index}.json`), 'utf8')) : {};
        const initialText = JSON.stringify(first.messages ?? []);
        const evaluation = assess(artifact, baselineVersion);
        evaluation.checks.initUnchanged = initUnchanged;
        evaluation.passed &&= initUnchanged;
        const result = { ...report, exitCode, evaluation, requests: calls.map(call => call.index), creditUnknown,
          knownCredit: calls.reduce((sum, call) => sum + (call.usage?.credit ?? 0), 0),
          discovery: { handleVisible: initialText.includes(report.id), inlineVisible: initialText.includes('inline'), rulePreloaded: initialText.includes('kodo-release-r7') },
          valid: exitCode === 0 && report.status === 'completed' && creditUnknown === 0 && calls.length > 0 && initialText.includes(report.id) && !initialText.includes('kodo-release-r7') };
        results.push(result); await save('results.json', { plan, results });
        process.stdout.write(JSON.stringify({ cell, valid: result.valid, loaded: result.loaded, passed: evaluation.passed, credit: result.knownCredit }) + '\n');
        if (!result.valid || cell === 'positive-control' && (!result.loaded || !evaluation.passed)) break;
      } finally {
        // Keep any failed trial recoverable; successful evidence has already been copied.
        if (results.at(-1)?.cell === cell) await command(['rm', '-f', container]);
        else { await command(['stop', '--time', '5', container]); await save('retained-container.json', { container }); }
      }
    }
  } finally {
    await command(['stop', '--time', '5', relayName]);
    relay?.kill();
    // A retained trial may still reference the network. Report cleanup failure explicitly.
    try { await command(['network', 'rm', network]); } catch (error) { await save('cleanup-error.json', { network, error: error.message }); }
  }
  process.stdout.write(JSON.stringify({ output, completed: results.length }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--worker')) await worker();
  else await main(process.argv.slice(2));
}
