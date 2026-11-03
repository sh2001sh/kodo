// Container test-feedback preflight: the real AVA chain must pass on the base
// fixture and fail on a known-broken snapshot, while network, write and timeout
// boundaries still hold. No model request is made.

import { spawnSync } from 'node:child_process';
import console from 'node:console';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runInContainer, runPublicTests, TEST_IMAGE } from './run-tests.mjs';

const probe = async (workspace, command, timeoutMs = 60_000) => runInContainer({ workspace, command, timeoutMs });
const liveContainers = name => spawnSync('docker', ['ps', '-q', '--filter', `name=${name}`], { encoding: 'utf8', windowsHide: true }).stdout.trim();

/** Each boundary probe prints one JSON line; acceptance is decided here, not in the container. */
export async function containerPreflight({ baseWorkspace, brokenWorkspace, expectedFailure }) {
  const checks = {};
  const base = await runPublicTests({ workspace: baseWorkspace });
  checks.baseRegression = { passed: base.ok && base.summary.failed === 0 && base.summary.passed > 0, summary: base.summary, durationMs: base.durationMs };
  if (brokenWorkspace) {
    const broken = await runPublicTests({ workspace: brokenWorkspace });
    checks.brokenRegression = { passed: !broken.ok && broken.summary.failures.includes(expectedFailure), summary: broken.summary };
  }
  // Loopback must work (AVA's HTTP test servers); any route off the host must not.
  const network = await probe(baseWorkspace, `node -e "
const net=require('node:net');const out={};
const s=net.createServer(c=>c.end('ok')).listen(0,'127.0.0.1',()=>{const c=net.connect(s.address().port,'127.0.0.1');c.on('data',d=>{out.loopback=String(d);c.destroy();s.close();
const e=net.connect({host:'1.1.1.1',port:443,timeout:3000});e.on('connect',()=>{out.external='connected';e.destroy();done()});e.on('error',x=>{out.external=x.code;done()});e.on('timeout',()=>{out.external='timeout';e.destroy();done()})})});
function done(){require('node:dns').lookup('registry.npmjs.org',x=>{out.dns=x?x.code:'resolved';console.log(JSON.stringify(out))})}"`);
  const net = JSON.parse(network.stdout.trim().split('\n').at(-1) || '{}');
  checks.network = { passed: net.loopback === 'ok' && net.external !== 'connected' && net.dns !== 'resolved', ...net };
  // The mounted workspace is read-only; the working copy is a tmpfs discarded with the container.
  const writes = await probe(baseWorkspace, `touch /src/.probe 2>/dev/null && echo src-writable || echo src-readonly; touch /work/node_modules/.probe 2>/dev/null && echo deps-writable || echo deps-readonly; touch .probe && echo copy-writable`);
  checks.writes = { passed: /src-readonly/u.test(writes.stdout) && /deps-readonly/u.test(writes.stdout) && /copy-writable/u.test(writes.stdout), output: writes.stdout.trim().split('\n') };
  // A hung test tree is killed at the deadline and the container does not survive.
  const hung = await probe(baseWorkspace, `node -e "require('node:child_process').spawn('sleep',['600'],{stdio:'inherit'});setInterval(()=>{},1000)"`, 5_000);
  checks.timeout = { passed: hung.timedOut && hung.durationMs < 40_000 && !liveContainers(hung.container), durationMs: hung.durationMs };
  return { passed: Object.values(checks).every(check => check.passed), image: TEST_IMAGE, checks };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [baseWorkspace, brokenWorkspace, expectedFailure] = process.argv.slice(2);
  if (!expectedFailure) throw new Error('usage: preflight.mjs <base workspace> <broken workspace> <expected failing test title>');
  const result = await containerPreflight({ baseWorkspace, brokenWorkspace, expectedFailure });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}
