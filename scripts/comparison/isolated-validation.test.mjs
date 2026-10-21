import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const runner = fileURLToPath(new URL('../verify-in-copy.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodo-copy-test-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/candidate.cjs'), 'module.exports = 42;\n');
  return root;
}
function start(root, code) {
  const child = spawn(process.execPath, [runner, '--', process.execPath, '-e', code], { cwd: root, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let ready;
  const mutated = new Promise(resolve => { ready = resolve; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes; if (output.includes('MUTATED')) ready(); });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, output })); });
  return { child, done, mutated };
}
test('a deliberately broken copy fails without changing delivery bytes', async () => {
  const root = await fixture();
  try {
    const before = hash(await readFile(path.join(root, 'src/candidate.cjs')));
    const run = start(root, "require('node:fs').writeFileSync('src/candidate.cjs','module.exports = ;'); process.exit(7)");
    const result = await run.done;
    assert.equal(result.code, 7);
    assert.equal(hash(await readFile(path.join(root, 'src/candidate.cjs'))), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('forcibly terminating mutation validation leaves the delivery directory intact', async () => {
  const root = await fixture();
  let temporary;
  let run;
  try {
    const before = hash(await readFile(path.join(root, 'src/candidate.cjs')));
    run = start(root, "require('node:fs').writeFileSync('src/candidate.cjs','module.exports = ;'); console.log('MUTATED'); setTimeout(()=>process.exit(0),10000)");
    const first = await Promise.race([run.mutated.then(() => 'mutated'), run.done.then(() => 'ended')]);
    assert.equal(first, 'mutated');
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => {
        const kill = spawn('taskkill', ['/PID', String(run.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        kill.once('error', reject); kill.once('close', code => code === 0 ? resolve() : reject(new Error(`taskkill exited ${code}`)));
      });
    } else process.kill(-run.child.pid, 'SIGKILL');
    const result = await run.done;
    const entry = result.output.split(/\r?\n/).find(line => line.startsWith('{"type":"validation.copy"'));
    assert.ok(entry, result.output);
    temporary = path.dirname(JSON.parse(entry).workspace);
    assert.equal(hash(await readFile(path.join(root, 'src/candidate.cjs'))), before);
    assert.equal((await readFile(path.join(temporary, 'workspace/src/candidate.cjs'), 'utf8')), 'module.exports = ;');
  } finally {
    if (run?.child.exitCode === null) run.child.kill();
    if (temporary) await rm(temporary, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
