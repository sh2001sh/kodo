// Preserve every host-managed clone, including failed or cancelled deliveries, before container removal.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const executionArchiveRoot = '/.kodo-executions';

/** Keep Docker's tar stream intact: extracting Linux symlinks requires extra Windows privileges. */
export function executionArchiveCommand(container) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(container)) throw new Error('Invalid trial container identity');
  return ['cp', `${container}:${executionArchiveRoot}`, '-'];
}

export async function captureExecutionEvidence({ container, directory, command }) {
  const destination = path.join(directory, 'executions.tar');
  const record = { source: executionArchiveRoot, destination: 'executions.tar', format: 'tar', capturedAt: new Date().toISOString(),
    note: 'Final preserved clone trees and Git histories. Periodic /app snapshots remain separate; this archive includes failed and cancelled tasks.' };
  try {
    const archive = await command('docker', executionArchiveCommand(container), { timeoutMs: 300_000, raw: true });
    if (!(archive instanceof Uint8Array) || archive.length === 0) throw new Error('Docker copy did not produce a binary execution archive');
    await writeFile(destination, archive);
    const listing = await command('tar', ['-tf', destination], { timeoutMs: 120_000 });
    record.bytes = archive.length;
    record.sha256 = createHash('sha256').update(archive).digest('hex');
    record.status = 'captured';
    const clones = new Map();
    for (const entry of listing.split(/\r?\n/u)) {
      const parts = entry.replace(/^\.\//u, '').split('/');
      if (parts[0] !== '.kodo-executions' || !parts[1] || !parts[2]) continue;
      const key = `${parts[1]}/${parts[2]}`;
      const clone = clones.get(key) ?? { path: key, gitDirectory: false };
      if (parts[3] === '.git' && parts.length > 4) clone.gitDirectory = true;
      clones.set(key, clone);
    }
    record.clones = [...clones.values()];
  } catch (error) {
    // Only Docker's explicit missing archive-path result is expected for shared-only runs.
    // A missing container, permission failure, timeout or partial copy is a recording error.
    if (String(error.message).includes(`Could not find the file ${executionArchiveRoot} in container`)) record.status = 'absent';
    else { record.status = 'failed'; record.error = String(error.message); }
  }
  await mkdir(path.join(directory, 'process'), { recursive: true });
  await writeFile(path.join(directory, 'process', 'execution-archive.json'), JSON.stringify(record, null, 2) + '\n');
  return record;
}
