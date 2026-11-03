// Native-sandbox preflight for the Ky evaluation: every command the objective
// advertises must run inside the same OS sandbox policy the trials use.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const timeout = () => globalThis.AbortSignal.timeout(180_000);

function boundedOutput(value, limit = 1_000) {
  if (value.length <= limit) return value;
  const half = Math.floor(limit / 2);
  return `${value.slice(0, half)}\n...[${value.length - limit} characters omitted]...\n${value.slice(-half)}`;
}

function countFiles(root) {
  let count = 0;
  const visit = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) { if (entry.isDirectory()) visit(path.join(directory, entry.name)); else count++; } };
  visit(root);
  return count;
}

/** Each probe is a separate sandboxed process, exactly like a model's process.exec call. */
const PROBES = [
  {
    name: 'node',
    args: ['-e', "const f=require('node:fs');let denied=false,deniedCode=null;try{f.readFileSync('.npmrc')}catch(e){denied=true;deniedCode=e.code}f.writeFileSync('source/.sandbox-probe','ok');f.unlinkSync('source/.sandbox-probe');console.log(JSON.stringify({package:JSON.parse(f.readFileSync('package.json')).name,denied,deniedCode}))"],
    accept: result => { const value = JSON.parse(result.stdout.trim()); return value.package === 'ky' && value.denied === true; },
  },
  {
    // The current Windows sandbox brokers anonymous pipes outside the restricted
    // token. Exercise the same synchronous child transport used by test runners.
    name: 'pipedChild',
    args: ['-e', "const out=require('node:child_process').execFileSync(process.execPath,['-e','process.stdout.write(\"pipe-ok\")'],{encoding:'utf8'});console.log(JSON.stringify({out}))"],
    accept: result => JSON.parse(result.stdout.trim()).out === 'pipe-ok',
  },
  { name: 'typecheck', args: ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.json'], accept: () => true },
  { name: 'build', args: ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.dist.json'], accept: () => true },
  { name: 'import', args: ['-e', "import('./distribution/index.js').then(m=>console.log(typeof m.default))"], accept: result => result.stdout.trim() === 'function' },
  { name: 'lint', args: ['node_modules/xo/dist/cli.js', 'source'], accept: () => true },
];

/** Runs every advertised command in a disposable seeded workspace under the trial sandbox policy. */
export async function sandboxPreflight({ outRoot, seed, scope, sandbox }) {
  const root = mkdtempSync(path.join(outRoot, '.sandbox-preflight-'));
  if (!path.resolve(root).startsWith(`${path.resolve(outRoot)}${path.sep}`)) throw new Error('sandbox preflight escaped the experiment output directory');
  const workspace = path.join(root, 'workspace');
  seed(workspace);
  try {
    const { createSandbox } = await import('../../../dist/application/index.js');
    const options = { workspace, scope, write: true, ...sandbox };
    const started = Date.now();
    const probes = {};
    for (const probe of PROBES) {
      const probeStarted = Date.now();
      const result = await createSandbox(options).run(process.execPath, probe.args, { signal: timeout() });
      const durationMs = Date.now() - probeStarted;
      let accepted = false;
      try { accepted = result.exitCode === 0 && probe.accept(result); } catch { accepted = false; }
      if (!accepted) throw new Error(`native sandbox preflight ${probe.name} failed: exit=${result.exitCode} stdout=${boundedOutput(result.stdout)} stderr=${boundedOutput(result.stderr)}`);
      probes[probe.name] = { exitCode: result.exitCode, durationMs, stdout: result.stdout.trim().slice(0, 200) };
    }
    return { passed: true, platform: process.platform, durationMs: Date.now() - started, dependencyFiles: countFiles(path.join(workspace, 'node_modules')), probes };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
