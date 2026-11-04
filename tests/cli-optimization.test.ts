import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Application } from '../src/application/index.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
async function cli(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { windowsHide: true, env: { ...process.env, KODO_API_KEY: '', OPENAI_API_KEY: '', KODO_MODEL: '' } });
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += String(chunk); });
    child.stderr.on('data', chunk => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
}

describe('optimization CLI host commands', () => {
  it('advertises the new host commands and rejects an invalid rewind step before opening state', async () => {
    const help = await cli(['--help']);
    expect(help.code).toBe(0);
    for (const text of ['--context', 'kodo interrupt', 'kodo rewind', '--verification-config', '--lazy-tools']) expect(help.out).toContain(text);
    const invalid = await cli(['rewind', 'unused-run', '--to', '-2']);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain('rewind requires --to');
  });

  it('reads context through inspect and persistently interrupts a queued turn without a provider call', async () => {
    const workspace = temp(); const directory = path.join(workspace, '.state');
    const app = new Application(directory, scripted());
    const run = app.createRun({ objective: 'CLI local fixture', workspace, binding });
    await app.shutdown();
    const context = await cli(['inspect', run.id, '--context', '--json', '--data-dir', directory]);
    expect(context.code, context.err).toBe(0);
    expect(JSON.parse(context.out)).toMatchObject({ runId: run.id });
    const stopped = await cli(['interrupt', run.id, '--json', '--data-dir', directory]);
    expect(stopped.code, stopped.err).toBe(0);
    expect(JSON.parse(stopped.out)).toMatchObject({ id: run.id, status: 'interrupted', interruptRequested: true });
  });

  it('confirms an isolated synthetic unknown call without authorizing replay', async () => {
    const workspace = temp(); const directory = path.join(workspace, '.state');
    const app = new Application(directory, scripted());
    const run = app.createRun({ objective: 'Isolated synthetic settlement fixture', workspace, binding, permissions: ['read', 'write'] });
    const request = call('file.apply_patch', { path: 'never-created.txt', expectedHash: null, content: 'fixture' }, 'synthetic');
    app.store.putCall({ id: 'synthetic-unknown-call', runId: run.id, step: 0, kind: 'tool', name: request.name, status: 'unknown', effect: 'write', effectState: 'started', requestRef: app.store.blob(request), reservedTokens: 0 });
    app.store.updateRun(run.id, { status: 'interrupted' });
    await app.shutdown();
    const settled = await cli(['reconcile', 'synthetic-unknown-call', '--not-applied', '--evidence', 'Synthetic fixture confirms no file operation was dispatched.', '--json', '--data-dir', directory]);
    expect(settled.code, settled.err).toBe(0);
    const report = JSON.parse(settled.out);
    expect(report.blocked).toEqual([]);
    expect(report.resolutions.at(-1)).toMatchObject({ outcome: 'not_applied', retryAuthorized: false });
    expect(existsSync(path.join(workspace, 'never-created.txt'))).toBe(false);
  });

  it('rewinds a completed native creation to the initial file state', async () => {
    const workspace = temp(); const directory = path.join(workspace, '.state');
    const app = new Application(directory, scripted(calls(call('file.apply_patch', { path: 'created.txt', expectedHash: null, content: 'created by native tool' })), answer()));
    const run = app.createRun({ objective: 'Create a fixture file', workspace, binding, permissions: ['read', 'write'] });
    const finished = await app.run(run.id);
    expect(finished.status, finished.error).toBe('completed');
    await app.shutdown();
    expect(existsSync(path.join(workspace, 'created.txt'))).toBe(true);
    const rewound = await cli(['rewind', run.id, '--to', '-1', '--json', '--data-dir', directory]);
    expect(rewound.code, rewound.err).toBe(0);
    expect(JSON.parse(rewound.out)).toMatchObject({ runId: run.id, toStep: -1, rewound: 1 });
    expect(existsSync(path.join(workspace, 'created.txt'))).toBe(false);
  });
});
