import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const run = promisify(execFile);
const root = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(path.join(root, 'manifest.json'))) throw new Error('Pass an evidence directory with manifest.json');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
for (const [index, cell] of manifest.cells.entries()) {
  const task = manifest.tasks.find(item => item.id === cell.task);
  if (task?.suite !== 'deep-swe') continue;
  const directory = path.join(root, manifest.order[index]);
  const artifacts = path.join(directory, 'artifacts');
  const patch = path.join(artifacts, 'model.patch');
  if (!existsSync(patch) || (await stat(patch)).size === 0) continue;
  const verifier = path.join(directory, 'verifier-corrected');
  await mkdir(verifier, { recursive: true });
  let output;
  let exitCode = 0;
  try {
    const result = await run('docker', ['run', '--rm', '--network', 'none', '--cpus', String(task.cpus), '--memory', `${task.memoryMb}m`, '-v', `${artifacts}:/logs/artifacts:ro`, '-v', `${verifier}:/logs/verifier`, '--entrypoint', 'bash', task.verifier, '-lc', 'tr -d "\\r" < /tests/test.sh | bash'], { timeout: 2_000_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    output = result.stdout + result.stderr;
  } catch (error) {
    exitCode = error.code ?? -1;
    output = String(error.stdout ?? '') + String(error.stderr ?? '') + String(error.message);
  }
  await writeFile(path.join(directory, 'verifier-corrected.log'), output);
  const rewardPath = path.join(verifier, 'reward.json');
  const reward = existsSync(rewardPath) ? JSON.parse(await readFile(rewardPath, 'utf8')) : null;
  const result = { exitCode, passed: reward?.reward === 1, reward, log: 'verifier-corrected.log' };
  await writeFile(path.join(directory, 'verification-corrected.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${manifest.order[index]} ${JSON.stringify(result)}\n`);
}
