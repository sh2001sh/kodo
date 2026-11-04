import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/storage/index.js';
import { delta, mockServer, sendStream } from './http-server.js';
import { temp } from './helpers.js';

const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) if (child.exitCode === null) child.kill(); });
async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { windowsHide: true, env: { ...process.env, KODO_MODEL: '', KODO_API_KEY: '', OPENAI_API_KEY: '', ...env } }); children.push(child);
    let out = ''; let err = '';
    child.stdout.on('data', chunk => { out += String(chunk); }); child.stderr.on('data', chunk => { err += String(chunk); }); child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
  });
}

describe('built CLI authoring, cases and workbench', () => {
  it('dispatches case/serve help without requiring credentials and reads the installed version', async () => {
    for (const command of ['case', 'serve']) {
      const result = await cli([command, '--help']); expect(result.code, result.err).toBe(0); expect(result.out).toContain(`kodo ${command}`);
    }
    const result = await cli(['--version']);
    expect(result.code, result.err).toBe(0);
    expect(result.out.trim()).toBe((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version);
    const root = temp();
    const listed = await cli(['case', 'list', '--data-dir', path.join(root, 'state'), '--json']);
    expect(listed.code, listed.err).toBe(0); expect(JSON.parse(listed.out)).toMatchObject({ items: [] });
  }, 15_000);

  it('serves HTTP/SSE, persists host trust configuration and closes cleanly on a signal', async () => {
    const root = temp(); const data = path.join(root, 'state');
    const modelUrl = await mockServer((_body, response) => sendStream(response, [delta({ content: 'The task is complete.' }), delta({}, 'stop')]));
    const moduleUrl = new URL('../dist/cli/serve.js', import.meta.url).href;
    // IPC emits the same Node signal event on Windows, where child.kill terminates
    // the process without delivering an interceptable POSIX signal.
    const script = `import { serveCommand } from ${JSON.stringify(moduleUrl)}; process.on('message', () => process.emit('SIGTERM')); await serveCommand(process.argv.slice(1)); process.disconnect();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, '--', '--workspace', root, '--data-dir', data, '--model', 'test-model', '--base-url', modelUrl, '--max-context-tokens', '8192', '--max-output-tokens', '1024', '--webfetch', '--web-hosts', 'example.org', '--json'], { windowsHide: true, env: { ...process.env, KODO_API_KEY: 'fixture' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); children.push(child);
    let out = ''; let err = '';
    child.stderr!.on('data', chunk => { err += String(chunk); });
    const listening = new Promise<{ origin: string; startupSecret: string }>((resolve, reject) => {
      child.on('error', reject);
      child.stdout!.on('data', chunk => { out += String(chunk); if (out.includes('\n')) { try { resolve(JSON.parse(out.trim().split(/\r?\n/)[0]!) as { origin: string; startupSecret: string }); } catch { reject(new Error(out)); } } });
      child.on('close', code => reject(new Error(`serve exited ${code}: ${err}`)));
    });
    const closed = new Promise<number | null>(resolve => child.on('close', resolve));
    const { origin, startupSecret } = await listening;
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(origin)).status).toBe(200);
    expect((await fetch(`${origin}/api/sessions`)).status).toBe(401);
    const auth = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: startupSecret }) });
    expect(auth.status).toBe(200);
    const cookie = auth.headers.get('set-cookie')!.split(';')[0]!; const { csrf } = await auth.json() as { csrf: string };
    const created = await fetch(`${origin}/api/runs`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Kodo-CSRF': csrf, 'Idempotency-Key': 'cli-workbench-task' }, body: JSON.stringify({ objective: 'Inspect the workspace.' }) });
    expect(created.status, await created.clone().text()).toBe(202);
    const { runId, sessionId } = await created.json() as { runId: string; sessionId: string };
    const stream = await fetch(`${origin}/api/runs/${runId}/events`, { headers: { Cookie: cookie } });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader(); const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain('event: runtime');
    await reader.cancel();
    const persisted = JSON.parse(readFileSync(path.join(data, 'cli-host.json'), 'utf8')) as { sessionId: string; tools: unknown }[];
    expect(persisted.find(item => item.sessionId === sessionId)?.tools).toEqual({ webFetch: { enabled: true, allowedHosts: ['example.org'] } });
    child.send('shutdown'); expect(await closed, err).toBe(0);
    const store = new Store(data); try { expect(store.run(runId).sessionId).toBe(sessionId); } finally { store.close(); }
    await expect(fetch(origin)).rejects.toThrow();
  }, 15_000);

  it('reattaches trusted tool settings on follow-up after restart and refuses policy changes', async () => {
    const root = temp(); const data = path.join(root, 'state'); const config = path.join(root, 'lsp.json');
    writeFileSync(config, JSON.stringify({ servers: [{ id: 'typescript', program: process.execPath, args: ['server.js'], languages: { '.ts': 'typescript' } }] }), 'utf8');
    let requests = 0;
    const url = await mockServer((body, response) => {
      requests++; expect(JSON.stringify(body.tools)).toContain('web_fetch'); expect(JSON.stringify(body.tools)).toContain('lsp_hover');
      expect(JSON.stringify(body.tools)).not.toContain('knowledge_read');
      sendStream(response, [delta({ content: 'Inspected the task.' }), delta({}, 'stop')]);
    });
    // Explicit host capabilities remain directly available to the main run of the default card.
    const run = await cli(['run', 'Inspect the project.', '--data-dir', data, '--workspace', root, '--model', 'test-model', '--base-url', url, '--max-context-tokens', '256000', '--max-output-tokens', '8192', '--webfetch', '--web-hosts', 'example.org', '--lsp-config', config, '--json'], { KODO_API_KEY: 'fixture' });
    expect(run.code, `${run.err}\n${run.out}`).toBe(0);
    const events = run.out.trim().split(/\r?\n/).map(line => JSON.parse(line) as { runId: string; type: string });
    const runId = events.find(event => event.type === 'run.completed')!.runId;
    const saved = new Store(data);
    try {
      const source = saved.run(runId);
      expect(saved.session(source.sessionId)).not.toHaveProperty('toolProfile');
      expect(source.card.id).toMatch(/^builtin\/general-simple-web(?:-lsp)+$/u);
      expect(source.card.tools).toEqual(expect.arrayContaining(['web.fetch', 'lsp.hover']));
    } finally { saved.close(); }
    // The source config can change; persisted approved configuration remains pinned.
    writeFileSync(config, JSON.stringify({ servers: [] }), 'utf8');
    const followUp = await cli(['input', runId, '--text', 'Inspect once more.', '--follow-up', '--data-dir', data, '--json'], { KODO_API_KEY: 'fixture' });
    expect(followUp.code, followUp.err).toBe(0); expect(requests).toBe(2);
    const changed = await cli(['input', runId, '--text', 'Inspect once more.', '--follow-up', '--data-dir', data, '--webfetch', '--web-hosts', 'other.example.org', '--json'], { KODO_API_KEY: 'fixture' });
    expect(changed.code).toBe(1); expect(changed.err).toContain('CAPABILITY_CHANGED'); expect(requests).toBe(2);
  }, 15_000);

  it('rejects invalid serve trust configuration before starting HTTP', async () => {
    const result = await cli(['serve', '--port', '70000', '--model', 'fixture'], { KODO_API_KEY: 'fixture' });
    expect(result.code).toBe(1); expect(result.err).toContain('WEB_PORT');
    const publicHost = await cli(['serve', '--host', '0.0.0.0']);
    expect(publicHost.code).toBe(1); expect(publicHost.err).toContain('ARGUMENTS');
    const policy = await cli(['run', 'task', '--web-hosts', 'example.org']);
    expect(policy.code).toBe(1); expect(policy.err).toContain('--web-hosts requires --webfetch');
  });
});
