// Live process recording for one trial container: timestamped logs, workspace snapshots and resource samples.
// Reads only; git runs with optional locks disabled so it never contends with the agent's own git use.
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';

const sha = value => createHash('sha256').update(value).digest('hex');

function capture(args, timeoutMs = 60_000) {
  return new Promise(resolve => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0 ? Buffer.concat(out).toString('utf8') : null); });
  });
}

// Tracked changes against the task base plus untracked files as additions.
const diffScript = base => [
  'cd /app',
  `git -c safe.directory=/app --no-pager diff --no-ext-diff --binary ${base}`,
  "git -c safe.directory=/app ls-files --others --exclude-standard -z | xargs -0 -r -n1 sh -c 'git -c safe.directory=/app --no-pager diff --no-ext-diff --binary --no-index -- /dev/null \"$0\" || true'",
].join(' && ');

/** Starts recording; returns stop(), which flushes and resolves once the log follower has exited. */
export async function startRecorder({ container, directory, task, intervalSec }) {
  const processDir = path.join(directory, 'process');
  const diffsDir = path.join(processDir, 'workspace');
  await mkdir(diffsDir, { recursive: true });
  const started = Date.now();
  const log = createWriteStream(path.join(processDir, 'agent.timestamped.log'));
  const follower = spawn('docker', ['logs', '--follow', '--timestamps', container], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  follower.stdout.pipe(log, { end: false });
  follower.stderr.pipe(log, { end: false });
  const followerDone = new Promise(resolve => follower.on('close', resolve));
  let lastDigest = null, snapshots = 0, sampling = false;
  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      const at = new Date().toISOString(), offsetSec = (Date.now() - started) / 1000;
      const stats = await capture(['stats', '--no-stream', '--format', '{{json .}}', container], 20_000);
      if (stats) await appendFile(path.join(processDir, 'resources.jsonl'), `${JSON.stringify({ at, offsetSec, ...JSON.parse(stats) })}\n`);
      const diff = task.base ? await capture(['exec', '-e', 'GIT_OPTIONAL_LOCKS=0', container, 'sh', '-c', diffScript(task.base)], 60_000)
        : await capture(['exec', container, 'sh', '-c', 'cd /app && find . -maxdepth 3 -type f -newer /fh-config/trial.json -printf "%TY-%Tm-%TdT%TH:%TM:%TS %s %p\\n" | sort'], 30_000);
      if (diff === null) return;
      const digest = sha(diff);
      const entry = { at, offsetSec, digest, bytes: Buffer.byteLength(diff), changed: digest !== lastDigest };
      if (entry.changed) {
        entry.file = `workspace/${String(++snapshots).padStart(4, '0')}-${Math.round(offsetSec)}s.${task.base ? 'patch' : 'txt'}`;
        await writeFile(path.join(processDir, entry.file), diff);
        lastDigest = digest;
      }
      await appendFile(path.join(processDir, 'workspace.jsonl'), `${JSON.stringify(entry)}\n`);
    } catch (error) {
      await appendFile(path.join(processDir, 'recorder-errors.log'), `${new Date().toISOString()} ${error.message}\n`).catch(() => {});
    } finally { sampling = false; }
  }
  const timer = intervalSec > 0 ? setInterval(() => { void sample(); }, intervalSec * 1000) : null;
  return {
    /** Stops sampling and closes the log once the container has exited. The final workspace is the verifier's model.patch. */
    async stop() {
      if (timer) clearInterval(timer);
      while (sampling) await new Promise(resolve => setTimeout(resolve, 100));
      await followerDone;
      await new Promise(resolve => log.end(resolve));
      return snapshots;
    },
  };
}
