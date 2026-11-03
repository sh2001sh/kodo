/* global AbortController, clearTimeout, DOMException, ReadableStream, Request, Response, setTimeout, TextEncoder */
import assert from 'node:assert/strict';
import console from 'node:console';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const command = (program, args, cwd, timeout = 300_000) => {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', NO_COLOR: '1' } });
  return { exitCode: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const signalOf = (input, init) => input instanceof Request ? input.signal : init?.signal;
const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
const deadline = (promise, ms = 1500) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`oracle deadline ${ms}ms exceeded`); })]);
const errorName = async promise => {
  try { await promise; return null; } catch (error) { return error?.name ?? error?.constructor?.name ?? 'Error'; }
};

async function runtimeChecks(ky) {
  const checks = {};
  const record = async (id, run) => {
    const started = Date.now();
    try { await run(); checks[id] = { passed: true, durationMs: Date.now() - started }; }
    catch (error) { checks[id] = { passed: false, durationMs: Date.now() - started, error: error instanceof Error ? error.stack ?? error.message : String(error) }; }
  };

  await record('T01', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return new Response('ok'); };
    assert.equal(await ky('https://example.test', { fetch }).text(), 'ok');
    assert.equal(await ky('https://example.test', { fetch, totalTimeout: false }).text(), 'ok');
    assert.equal(calls, 2);
  });
  await record('T02', async () => {
    let calls = 0;
    const fetch = async (input, init) => {
      calls++;
      if (calls < 3) await abortableSleep(90, signalOf(input, init));
      return new Response('ok');
    };
    assert.equal(await deadline(ky('https://example.test', { fetch, timeout: 25, retry: { limit: 3, retryOnTimeout: true, delay: () => 0 } }).text()), 'ok');
    assert.equal(calls, 3);
  });
  await record('T03', async () => {
    let calls = 0;
    const fetch = async () => { calls++; await sleep(25); return new Response('', { status: 500 }); };
    assert.equal(await errorName(deadline(ky('https://example.test', { fetch, totalTimeout: 65, retry: { limit: 10, delay: () => 0 } }).text())), 'TimeoutError');
    assert.ok(calls >= 1 && calls <= 3, `calls=${calls}`);
  });
  await record('T04', async () => {
    const hanging = async (input, init) => { await abortableSleep(500, signalOf(input, init)); return new Response('late'); };
    assert.equal(await errorName(deadline(ky('https://example.test', { fetch: hanging, timeout: false, totalTimeout: 35 }).text())), 'TimeoutError');
    const finite = async () => { await sleep(20); return new Response('ok'); };
    assert.equal(await deadline(ky('https://example.test', { fetch: finite, timeout: false, totalTimeout: false }).text()), 'ok');
  });
  await record('T05', async () => {
    let calls = 0;
    const fetch = async (input, init) => {
      calls++;
      if (calls === 1) { await sleep(35); return new Response('', { status: 500 }); }
      await abortableSleep(500, signalOf(input, init));
      return new Response('late');
    };
    assert.equal(await errorName(deadline(ky('https://example.test', { fetch, timeout: 100, totalTimeout: 65, retry: { limit: 2, delay: () => 0 } }).text())), 'TimeoutError');
    assert.equal(calls, 2);
  });
  await record('T06', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return new Response('', { status: 500, headers: { 'retry-after': '1' } }); };
    const started = Date.now();
    assert.equal(await errorName(deadline(ky('https://example.test', { fetch, totalTimeout: 45, retry: { limit: 4 } }).text())), 'TimeoutError');
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 300, 'retry delay was not bounded by the total budget');
  });
  await record('T07', async () => {
    let calls = 0;
    const fetch = async (input, init) => { calls++; await abortableSleep(100, signalOf(input, init)); return new Response('late'); };
    assert.equal(await errorName(deadline(ky('https://example.test', { fetch, timeout: 25, totalTimeout: 70, retry: { limit: 10, retryOnTimeout: true, shouldRetry: () => true, delay: () => 0 } }).text())), 'TimeoutError');
    assert.ok(calls >= 2 && calls <= 4, `calls=${calls}`);
  });
  await record('T08', async () => {
    let bodyCalls = 0;
    const bodyFetch = async () => {
      bodyCalls++;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); } }), { status: 500, headers: { 'content-type': 'application/json' } });
    };
    let started = Date.now();
    assert.equal(await errorName(deadline(ky('https://example.test', { fetch: bodyFetch, timeout: 200, totalTimeout: 45, retry: { limit: 3, delay: () => 0 } }).text())), 'TimeoutError');
    assert.ok(Date.now() - started < 130, 'error response body outlived the total budget');
    assert.equal(bodyCalls, 1);
    let parseCalls = 0;
    const parseFetch = async () => { parseCalls++; return new Response('{"error":true}', { status: 500, headers: { 'content-type': 'application/json' } }); };
    started = Date.now();
    assert.equal(await errorName(deadline(ky('https://example.test', { fetch: parseFetch, timeout: 200, totalTimeout: 45, parseJson: async () => new Promise(() => {}), retry: { limit: 3, delay: () => 0 } }).text())), 'TimeoutError');
    assert.ok(Date.now() - started < 130, 'error response parsing outlived the total budget');
    assert.equal(parseCalls, 1);
  });
  await record('T09', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return new Response('ok'); };
    assert.equal(await errorName(deadline(ky('https://example.test', { fetch, totalTimeout: 0 }).text())), 'TimeoutError');
    assert.equal(calls, 0);
    assert.equal(await errorName(ky('https://example.test', { fetch, timeout: 2_147_483_648 }).text()), 'RangeError');
    assert.equal(await errorName(ky('https://example.test', { fetch, totalTimeout: 2_147_483_648 }).text()), 'RangeError');
  });
  await record('T10', async () => {
    let calls = 0;
    const fetch = async () => { calls++; if (calls % 2 === 1) { await sleep(45); return new Response('', { status: 500 }); } return new Response('ok'); };
    const parent = ky.create({ fetch, totalTimeout: 20, retry: { limit: 1, delay: () => 0 } });
    const disabled = parent.extend({ totalTimeout: false });
    assert.equal(await deadline(disabled('https://example.test').text()), 'ok');
    const parentError = await errorName(deadline(parent('https://example.test').text()));
    assert.equal(parentError, 'TimeoutError');
    const overridden = parent.extend({ totalTimeout: 200 });
    assert.equal(await deadline(overridden('https://example.test').text()), 'ok');
  });
  await record('T11', async () => {
    let calls = 0;
    const controller = new AbortController();
    const fetch = async (input, init) => { calls++; await abortableSleep(500, signalOf(input, init)); return new Response('late'); };
    setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 20);
    assert.ok(['AbortError', 'TimeoutError'].includes(await errorName(deadline(ky('https://example.test', { fetch, signal: controller.signal, retry: { limit: 5, retryOnTimeout: true, delay: () => 0 } }).text()))));
    await sleep(80);
    assert.equal(calls, 1);
  });
  await record('T12', async () => {
    let calls = 0;
    const fetch = async () => { calls++; return calls === 1 ? new Response('', { status: 500 }) : new Response('ok'); };
    assert.equal(await ky('https://example.test', { fetch, retry: { limit: 1, delay: () => 0 } }).text(), 'ok');
    assert.equal(calls, 2);
  });
  return checks;
}

function typeCheck(workspace) {
  const file = path.join(workspace, '.ky-hidden-types.ts');
  writeFileSync(file, "import ky from './distribution/index.js';\nky('https://example.test', {totalTimeout: 1});\nky('https://example.test', {totalTimeout: false});\n// @ts-expect-error boolean true is invalid\nky('https://example.test', {totalTimeout: true});\n", 'utf8');
  try {
    const result = command(process.execPath, [npxCli, '--no-install', 'tsc', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM,DOM.Iterable', '--strict', '--skipLibCheck', '.ky-hidden-types.ts'], workspace, 120_000);
    return { passed: result.exitCode === 0, ...result };
  } finally { rmSync(file, { force: true }); }
}

function deliveryCheck(workspace, finalText, build, regression) {
  const readme = readFileSync(path.join(workspace, 'readme.md'), 'utf8');
  const deliveryPath = path.join(workspace, 'DELIVERY.md');
  const delivery = (() => { try { return readFileSync(deliveryPath, 'utf8'); } catch { return ''; } })();
  const tests = ['retry.ts', 'http-error.ts', 'hooks.ts'].map(file => {
    try { return readFileSync(path.join(workspace, 'test', file), 'utf8'); } catch { return ''; }
  }).join('\n');
  const items = {
    documentation: /totalTimeout/u.test(readme) && /per-attempt|each retry|independent/u.test(readme) && /false/u.test(readme),
    regressionTests: /totalTimeout/u.test(tests),
    deliveryArtifact: delivery.trim().length > 0 && /npm|ava|build|test/u.test(delivery),
    finalReply: finalText.trim().length > 0,
    actualBuild: build.exitCode === 0,
    actualRegression: regression.exitCode === 0,
  };
  return { passed: Object.values(items).every(Boolean), items };
}

export async function auditWorkspace({ workspace, finalText = '', runRegression = true }) {
  const build = command(process.execPath, [npmCli, 'run', 'build'], workspace, 180_000);
  let runtime = {};
  if (build.exitCode === 0) {
    const module = await import(`${pathToFileURL(path.join(workspace, 'distribution', 'index.js')).href}?audit=${Date.now()}`);
    runtime = await runtimeChecks(module.default);
  } else {
    for (let index = 1; index <= 12; index++) runtime[`T${String(index).padStart(2, '0')}`] = { passed: false, error: 'build failed' };
  }
  const types = build.exitCode === 0 ? typeCheck(workspace) : { passed: false, exitCode: null, error: 'build failed' };
  const regression = runRegression ? command(process.execPath, [npxCli, '--no-install', 'ava', '--concurrency=1', 'test/retry.ts', 'test/http-error.ts', 'test/hooks.ts'], workspace, 300_000) : { exitCode: null, skipped: true, stdout: '', stderr: '' };
  const t12 = runtime.T12?.passed && (!runRegression || regression.exitCode === 0);
  runtime.T12 = { ...runtime.T12, passed: Boolean(t12), regressionExitCode: regression.exitCode };
  const delivery = deliveryCheck(workspace, finalText, build, regression);
  const checks = { ...runtime, T13: types, T14: delivery };
  return {
    passed: Object.values(checks).every(check => check.passed),
    functionalPassed: Object.entries(checks).filter(([id]) => id !== 'T14').every(([, check]) => check.passed),
    checks,
    build: { exitCode: build.exitCode, signal: build.signal, stdout: build.stdout.slice(-6000), stderr: build.stderr.slice(-6000), error: build.error },
    regression: { exitCode: regression.exitCode, signal: regression.signal, stdout: regression.stdout.slice(-8000), stderr: regression.stderr.slice(-8000), error: regression.error ?? null, skipped: regression.skipped ?? false },
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith('--') ? [value.slice(2), all[index + 1]] : []).filter(Boolean));
  if (!args.workspace) throw new Error('usage: oracle.mjs --workspace <dir> [--final-file <file>] [--out <file>]');
  const finalText = args['final-file'] ? readFileSync(args['final-file'], 'utf8') : '';
  const result = await auditWorkspace({ workspace: path.resolve(args.workspace), finalText });
  if (args.out) writeFileSync(path.resolve(args.out), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 2; });
