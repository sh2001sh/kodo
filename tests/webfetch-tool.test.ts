import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestListener, Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebFetchTool, isPublicWebAddress } from '../src/tools/webfetch.js';
import type { WebFetchPolicy } from '../src/tools/webfetch.js';
import { Application } from '../src/application/index.js';
import { answer, binding, scripted } from './helpers.js';

vi.mock('node:dns/promises', async original => {
  const actual = await original<typeof import('node:dns/promises')>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

const servers: Server[] = [];
const apps: { app: Application; root: string }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const { app, root } of apps.splice(0)) {
    await app.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function fetcher(policy: WebFetchPolicy = { enabled: true, allowPrivate: true, allowedHosts: ['127.0.0.1'] }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'kodo-webfetch-'));
  const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { webFetch: policy, agentFactors: { D: false, E: false } });
  apps.push({ app, root });
  const card = app.parseCard('---\nschema_version: 1\nid: fixture/webfetch\nversion: 1.0.0\nname: Web fetch fixture\ndescription: Exercise the explicitly declared host web service.\ncapabilities: { tools: [web.fetch] }\n---\nRead a page only under the host network policy.');
  const runId = app.createRun({ objective: 'Read a page with host authorization.', workspace: root, binding, permissions: ['read'], card }).id;
  return { app, runId, fetch: (url: string, extra: Record<string, unknown> = {}, signal = new AbortController().signal) => app.coordinator.tools.execute(runId, 'web.fetch', { url, ...extra }, signal) };
}

describe('host-governed text webfetch', () => {
  it('extracts readable HTML and JSON with status and source metadata', async () => {
    const url = await serve((req, res) => {
      if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>A &amp; B</title><script>secret()</script><style>.bad{}</style></head><body><h1>标题</h1><p>Hello&nbsp;world &#x1f600;</p></body></html>');
    });
    const { fetch } = fetcher();
    const html = await fetch(`${url}/page`);
    expect(html).toMatchObject({ status: 200, ok: true, format: 'html', title: 'A & B', truncated: false, source: { url: `${url}/page`, finalUrl: `${url}/page`, redirects: [] } });
    expect((html as { content: string }).content).toContain('Hello world 😀');
    expect((html as { content: string }).content).not.toContain('secret');
    expect(await fetch(`${url}/json`)).toMatchObject({ content: '{\n  "ok": true\n}', format: 'json' });
  });

  it('follows bounded redirects and enforces the host allowlist at each destination', async () => {
    let targetRequests = 0;
    const url = await serve((req, res) => {
      if (req.url === '/good') { res.writeHead(302, { Location: '/target' }); res.end(); return; }
      if (req.url === '/bad') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); res.end(); return; }
      if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); return; }
      targetRequests++;
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
    });
    const { fetch } = fetcher();
    expect(await fetch(`${url}/good`)).toMatchObject({ status: 404, ok: false, content: 'not found', source: { finalUrl: `${url}/target`, redirects: [{ status: 302 }] } });
    await expect(fetch(`${url}/bad`)).rejects.toMatchObject({ code: 'WEBFETCH_DENIED' });
    await expect(fetch(`${url}/loop`)).rejects.toMatchObject({ code: 'WEBFETCH_REDIRECT' });
    expect(targetRequests).toBe(1);
  });

  it('connects a DNS hostname through the verified address list and rechecks redirect DNS targets', async () => {
    const url = await serve((req, res) => {
      if (req.url === '/redirect') { res.writeHead(302, { Location: url.replace('127.0.0.1', 'localhost') + '/target' }); res.end(); }
      else { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(req.headers.host); }
    });
    const local = url.replace('127.0.0.1', 'localhost');
    const { fetch } = fetcher({ enabled: true, allowPrivate: true, allowedHosts: ['127.0.0.1', 'localhost'] });
    expect(await fetch(`${local}/direct`)).toMatchObject({ status: 200, content: new URL(local).host });
    expect(await fetch(`${url}/redirect`)).toMatchObject({ status: 200, content: new URL(local).host, source: { finalUrl: `${local}/target` } });
  });

  it('pins checked DNS results in the actual connection instead of resolving again', async () => {
    const url = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('pinned address'); });
    const resolver = vi.mocked(lookup);
    const before = resolver.mock.calls.length;
    resolver.mockImplementationOnce((async () => [{ address: '127.0.0.1', family: 4 }]) as unknown as typeof lookup);
    const target = url.replace('127.0.0.1', 'rebind.invalid');
    expect(await fetcher({ enabled: true, allowPrivate: true }).fetch(target)).toMatchObject({ status: 200, content: 'pinned address' });
    expect(resolver.mock.calls.length - before).toBe(1);
    resolver.mockImplementationOnce((async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]) as unknown as typeof lookup);
    await expect(fetcher({ enabled: true }).fetch(target)).rejects.toMatchObject({ code: 'WEBFETCH_DENIED' });
  });

  it('denies networking without host opt-in, all private DNS targets by default and invalid/auth URLs', async () => {
    let requests = 0;
    const url = await serve((_req, res) => { requests++; res.end('must not fetch'); });
    await expect(fetcher({ enabled: false }).fetch(url)).rejects.toMatchObject({ code: 'WEBFETCH_DENIED' });
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      await expect(fetcher({ enabled: true }).fetch(`http://${host}:1/`)).rejects.toMatchObject({ code: 'WEBFETCH_DENIED' });
    }
    const { fetch } = fetcher();
    for (const value of ['file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com', 'broken']) await expect(fetch(value)).rejects.toMatchObject({ code: 'WEBFETCH_URL' });
    expect(requests).toBe(0);
  });

  it('bounds actual bytes even without Content-Length and marks character truncation', async () => {
    const url = await serve((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('x'.repeat(1024)); res.end('y'.repeat(1024)); });
    expect(await fetcher({ enabled: true, allowPrivate: true, maxBytes: 256 }).fetch(url)).toMatchObject({ truncated: true, bytesRead: 256, content: 'x'.repeat(256) });
    expect(await fetcher().fetch(url, { maxChars: 25 })).toMatchObject({ truncated: true, content: 'x'.repeat(25) });
  });

  it('handles unclosed script blocks and truncated UTF-8 without exposing script bodies or replacement characters', async () => {
    const url = await serve((req, res) => {
      if (req.url === '/utf8') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('中'.repeat(500)); }
      else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<p>visible</p><script>'.repeat(20_000) + 'hidden script body'); }
    });
    expect(await fetcher().fetch(url)).toMatchObject({ content: 'visible', truncated: false });
    expect(await fetcher({ enabled: true, allowPrivate: true, maxBytes: 256 }).fetch(`${url}/utf8`)).toMatchObject({ content: '中'.repeat(85), truncated: true, bytesRead: 256 });
  });

  it('rejects binary, invalid JSON, unsupported encoding and malformed UTF-8', async () => {
    const url = await serve((req, res) => {
      if (req.url === '/binary') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end('binary'); }
      else if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{oops'); }
      else if (req.url === '/gzip') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' }); res.end('compressed'); }
      else { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(Buffer.from([0xff])); }
    });
    const { fetch } = fetcher();
    for (const pathname of ['/binary', '/json', '/gzip', '/utf8']) await expect(fetch(`${url}${pathname}`)).rejects.toMatchObject({ code: 'WEBFETCH_CONTENT' });
  });

  it('aborts hanging headers and body using total timeout and caller cancellation', async () => {
    const url = await serve((req, res) => { if (req.url === '/body') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('partial'); } });
    for (const pathname of ['/headers', '/body']) await expect(fetcher({ enabled: true, allowPrivate: true, timeoutMs: 50 }).fetch(`${url}${pathname}`)).rejects.toMatchObject({ code: 'WEBFETCH_TIMEOUT' });
    const controller = new AbortController();
    const pending = fetcher().fetch(`${url}/headers`, {}, controller.signal);
    setTimeout(() => controller.abort(new Error('caller cancelled')), 30);
    await expect(pending).rejects.toThrow('caller cancelled');
  });

  it('requires card authorization and detects host policy changes in tool binding', async () => {
    const { app, runId, fetch } = fetcher();
    const original = app.store.run(runId);
    app.store.updateRun(runId, { card: { ...original.card, tools: [] } });
    await expect(fetch('https://example.com')).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    app.store.updateRun(runId, { card: original.card });
    const session = app.store.session(original.sessionId);
    app.store.putSession({ ...session, permissions: [] });
    await expect(fetch('https://example.com')).rejects.toMatchObject({ code: 'TOOL_DENIED' });
    const publicHost = fetcher({ enabled: true });
    const privateHost = fetcher({ enabled: true, allowPrivate: true });
    expect(publicHost.app.coordinator.tools.bindingSnapshot(['web.fetch'])).not.toEqual(privateHost.app.coordinator.tools.bindingSnapshot(['web.fetch']));
    expect(() => createWebFetchTool({ enabled: true, allowedHosts: ['example.com/path'] })).toThrow();
  });

  it.each(['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '198.19.1.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::1'])('rejects non-public network address %s', address => {
    expect(isPublicWebAddress(address)).toBe(false);
  });
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('recognizes public address %s without network calls', address => {
    expect(isPublicWebAddress(address)).toBe(true);
  });
});
