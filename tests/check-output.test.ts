import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { fixture } from './helpers.js';
import { backgroundNotice } from '../src/runtime/background-notice.js';

interface Result {
  stdout: string; stderr: string; exitCode: number; truncated: boolean; preview?: string;
  outputFiltered?: boolean; note?: string;
  outputArtifact: { id: string; capturedComplete: boolean };
}

function setup(exitCode = 0, stdout = Array.from({ length: 150 }, (_, i) => `line ${i}: 中文😀`).join('\n') + '\nFINAL SUMMARY\n') {
  const f = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-solo', taskProtocol: 3 });
  const stderr = 'diagnostic\n';
  writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
  writeFileSync(path.join(f.root, 'check.cjs'), `require('node:fs').writeFileSync('executed', 'yes'); process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = ${exitCode};`);
  const execute = (command: string, background = false) => f.app.coordinator.tools.execute(f.runId, 'shell.exec', { command, background }, new AbortController().signal);
  return { ...f, execute, stdout, stderr };
}

async function stored(f: ReturnType<typeof setup>, result: Result): Promise<Result> {
  let content = '', contentOffset = 0;
  for (;;) {
    const page = await f.app.coordinator.tools.execute(f.runId, 'artifact.read', { id: result.outputArtifact.id, contentOffset, maxChars: 512 }, new AbortController().signal) as { content: string; next: { contentOffset: number } | null };
    content += page.content;
    if (!page.next) break;
    contentOffset = page.next.contentOffset;
  }
  return JSON.parse(content) as Result;
}

it.each([0, 3])('returns a check tail and lossless paginated evidence with the actual exit code %s', async exitCode => {
  const f = setup(exitCode);
  const result = await f.execute('npm test') as Result;
  expect(result).toMatchObject({ exitCode, preview: 'tail', truncated: true, outputArtifact: { capturedComplete: true } });
  expect(result.stdout.trimEnd().split('\n')).toHaveLength(80);
  expect(result.stdout).toContain('FINAL SUMMARY');
  expect(result.stdout).not.toContain('line 0:');
  expect(result.stderr).toBe(f.stderr);
  const full = await stored(f, result);
  expect(full.stdout).toContain(f.stdout);
  expect(full).toMatchObject({ stderr: f.stderr, exitCode, outputLimitExceeded: false });
}, 20_000);

it.each(['npm test | tail -3', 'npm test>out.txt; v=$?; tail -3 out.txt; exit $v'])('executes filtered checks unchanged and describes capture limits: %s', async command => {
  const f = setup(3);
  const result = await f.execute(command) as Result;
  expect(result).toMatchObject({ exitCode: 3, outputFiltered: true, outputArtifact: { capturedComplete: true } });
  expect(result.note).toContain('not output removed by the command');
  expect(existsSync(path.join(f.root, 'executed'))).toBe(true);
  expect(existsSync(path.join(f.root, 'out.txt'))).toBe(command.includes('>out.txt'));
  expect(result.stdout).toContain('FINAL SUMMARY');
  expect(result.stdout).not.toContain('line 0:');
  expect((await stored(f, result)).stdout).toBe(result.stdout);
  expect(await f.execute("printf 'first\\nlast\\n' | tail -1")).toMatchObject({ stdout: 'last\n', exitCode: 0 });
  expect(await f.execute('npm test')).toMatchObject({ exitCode: 3, preview: 'tail' });
}, 20_000);

it('allows a redirected test-runner version query without treating it as a full suite', async () => {
  const f = setup();
  expect(await f.execute('npm test -- --version > version.txt')).toMatchObject({ exitCode: 0, stdout: '', outputFiltered: true });
  expect(existsSync(path.join(f.root, 'version.txt'))).toBe(true);
  expect(f.app.store.events(f.runId, { types: ['check.suite_passed'] })).toHaveLength(0);
}, 20_000);

it('stores the same check receipt when a command finishes in the background', async () => {
  const f = setup();
  expect(await f.execute('npm test', true)).toMatchObject({ background: { state: 'running' } });
  await f.app.coordinator.tools.backgroundSettled();
  const event = f.app.store.latestEvent(f.runId, { types: ['process.background.finished'] })!;
  const result = f.app.store.readBlob<Result>(event.data.resultRef as string);
  expect(result).toMatchObject({ exitCode: 0, preview: 'tail', outputArtifact: { capturedComplete: true } });
  expect(result.stdout).toContain('FINAL SUMMARY');
  expect((await stored(f, result)).stdout).toContain(f.stdout);
  expect(backgroundNotice(f.app.store, f.runId).message?.content).toContain(result.outputArtifact.id);
}, 20_000);

it('preserves filtered-output metadata and failure in background receipts', async () => {
  const f = setup(3);
  await f.execute('npm test | tail -3', true);
  await f.app.coordinator.tools.backgroundSettled();
  const event = f.app.store.latestEvent(f.runId, { types: ['process.background.finished'] })!;
  const result = f.app.store.readBlob<Result>(event.data.resultRef as string);
  expect(result).toMatchObject({ exitCode: 3, outputFiltered: true, outputArtifact: { capturedComplete: true } });
  expect((await stored(f, result)).stdout).toBe(result.stdout);
}, 20_000);

it('keeps a character-bounded tail on long lines without splitting a Unicode character', async () => {
  const f = setup(0, 'x' + '😀'.repeat(7000) + '\nSUMMARY\n');
  const result = await f.execute('npm test') as Result;
  expect(result.stdout.length).toBeLessThanOrEqual(12_000);
  expect(result.stdout).toMatch(/^😀/u);
  expect(result.stdout).toContain('SUMMARY');
  expect((await stored(f, result)).stdout).toContain(f.stdout);
}, 20_000);
