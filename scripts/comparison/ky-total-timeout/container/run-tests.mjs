// Public regression feedback for the Ky fixture, executed in a disposable Linux
// container. The workspace is mounted read-only and copied into a tmpfs, so test
// code can never write back; the container has no network interface besides
// loopback, no capabilities, bounded memory/processes, and is killed on timeout.

import { spawn, spawnSync } from 'node:child_process';
import console from 'node:console';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

export const TEST_IMAGE = 'kodo-ky-test:e55482f55be2';
export const PUBLIC_TESTS = Object.freeze(['test/retry.ts', 'test/http-error.ts', 'test/hooks.ts']);
const outputChars = 16_000;
// Summaries are parsed from up to this much output; only the tail is returned.
const parseChars = 4_000_000;

// Copy the snapshot without dependencies, build output or protected files, then
// overlay node_modules as symlinks so AVA can still write its own cache.
const prepare = [
  'set -eu',
  'mkdir -p /work/ws/node_modules/.cache',
  'cd /src',
  'for entry in * .[!.]*; do case "$entry" in node_modules|distribution|.git|.kodo|.npmrc|.env*|".[!.]*") ;; *) [ -e "$entry" ] && cp -R "$entry" /work/ws/ ;; esac; done',
  'for entry in /work/node_modules/* /work/node_modules/.bin; do ln -s "$entry" "/work/ws/node_modules/$(basename "$entry")"; done',
  'cd /work/ws',
].join('\n');

/** Validate model-supplied test paths: only existing public test files under test/. */
export function selectTests(files) {
  if (files === undefined) return [...PUBLIC_TESTS];
  if (!Array.isArray(files) || !files.length || files.length > 16) throw new Error('files must list 1-16 test files');
  return files.map(file => {
    const normalized = String(file).replaceAll('\\', '/').replace(/^\.\//u, '');
    if (!/^test\/[A-Za-z0-9_./-]+\.ts$/u.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.') || normalized.startsWith('test/helpers/')) throw new Error(`${JSON.stringify(file)} is not a test file under test/`);
    return normalized;
  });
}

/** Extract counts and failing titles from the default AVA reporter. */
export function summarizeAva(output) {
  const count = pattern => Number(pattern.exec(output)?.[1] ?? 0);
  // A failure appears as a ✘ line and as a detail block: title, blank line, file:line.
  const marked = [...output.matchAll(/✘ \[fail\]: (.+)/gu)].map(match => match[1].trim());
  const detailed = [...output.matchAll(/^ {2}(\S[^\n]*)\n\n {2}test\/[\w./-]+\.ts:\d+\n/gmu)].map(match => match[1].trim());
  const failures = [...new Set([...marked, ...detailed])];
  // AVA omits the passed total when anything fails, so count the ✔ lines instead.
  const passedLines = [...output.matchAll(/^\s*✔ /gmu)].length;
  return {
    passed: count(/(\d+) tests? passed/u) || passedLines, failed: count(/(\d+) tests? failed/u),
    knownFailures: count(/(\d+) known failures?/u), skipped: count(/(\d+) tests? skipped/u),
    uncaught: count(/(\d+) uncaught exceptions?/u), timedOutTests: /Timed out while running tests/u.test(output),
    failures,
  };
}

const tail = text => text.length <= outputChars ? text : `[${text.length - outputChars} earlier characters omitted]\n${text.slice(-outputChars)}`;

/**
 * Run `command` (a shell line executed in the prepared copy) inside the container.
 * Resolves with the exit code, a bounded output tail and whether the deadline killed it.
 */
export function runInContainer({ workspace, command, timeoutMs = 240_000, image = TEST_IMAGE, cpus = 4, signal }) {
  const name = `kodo-ky-${randomUUID()}`;
  const args = [
    'run', '--rm', '--name', name, '--network', 'none', '--read-only',
    '--tmpfs', '/work/ws:rw,exec,size=512m,uid=1000,gid=1000', '--tmpfs', '/tmp:rw,exec,size=256m,uid=1000,gid=1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '4g', '--pids-limit', '256', '--cpus', String(cpus),
    '-e', 'CI=1', '-e', 'NO_COLOR=1', '-e', 'FORCE_COLOR=0',
    '-v', `${path.resolve(workspace)}:/src:ro`, image, 'sh', '-c', `${prepare}\n${command}`,
  ];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    // Killing the docker CLI does not stop the container; kill it by name.
    const kill = () => spawnSync('docker', ['kill', name], { windowsHide: true, timeout: 30_000 });
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const abort = () => { cancelled = true; kill(); };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > parseChars) stdout = stdout.slice(-parseChars); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > parseChars) stderr = stderr.slice(-parseChars); });
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', exitCode => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ exitCode, timedOut, cancelled, durationMs: Date.now() - started, container: name, output: `${stdout}\n${stderr}`, stdout: tail(stdout), stderr: tail(stderr) });
    });
  });
}

/** Run AVA on public test files; returns counts, failing titles and the reporter tail. */
export async function runPublicTests({ workspace, files, match, timeoutMs = 240_000, image, signal }) {
  const selected = selectTests(files);
  if (match !== undefined && (typeof match !== 'string' || !match.trim() || match.length > 200 || /['\n\r\0]/u.test(match))) throw new Error('match must be a short single-line title pattern without quotes');
  const command = `exec node node_modules/ava/entrypoints/cli.mjs --concurrency=1 --timeout=60s ${match ? `--match '${match}' ` : ''}${selected.join(' ')}`;
  const { output, ...result } = await runInContainer({ workspace, command, timeoutMs, image, signal });
  const summary = summarizeAva(output);
  return { ok: result.exitCode === 0 && !result.timedOut, files: selected, ...(match ? { match } : {}), ...result, summary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const workspace = process.argv[2];
  if (!workspace) throw new Error('usage: run-tests.mjs <workspace> [test files...]');
  const result = await runPublicTests({ workspace, files: process.argv.length > 3 ? process.argv.slice(3) : undefined });
  console.log(JSON.stringify({ ...result, stdout: result.stdout.slice(-3000), stderr: result.stderr.slice(-2000) }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
