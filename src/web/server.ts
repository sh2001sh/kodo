import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Application, CreateRunOptions } from '../application/index.js';
import { PackageRegistry } from '../packages/registry.js';
import { normalizeFileScope } from '../runtime/scope.js';
import { KodoError } from '../runtime/types.js';
import type { Run, RuntimeEvent } from '../runtime/types.js';
import { methodCatalogDigest } from '../extensions/methods.js';
import { collaborationView } from './collaboration.js';
import { PackagePanel } from './packages.js';
import type { PackageOverview, PackagePanelOptions } from './packages.js';
import { createServerIdentity, recoveryView } from './recovery.js';
import { workbenchHtml, workbenchScript, workbenchStyle } from './workbench.js';

export interface LocalServerOptions extends Omit<CreateRunOptions, 'objective'> {
  port?: number;
  /** Limit the workspace view to these existing sessions, plus sessions created here. */
  sessionIds?: readonly string[];
  /** Persist/validate non-portable host bindings before commands are accepted. Runs inside the command transaction. */
  onSession?: (sessionId: string) => void;
  /** Capability-package panel; omitting it keeps GET /api/packages at enabled:false and package commands at 404. */
  packages?: PackagePanelOptions;
}
export interface LocalServerHandle { origin: string; startupSecret: string; close(): Promise<void> }
interface BrowserSession { csrf: string; expires: number }
class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
const token = (): string => randomBytes(32).toString('base64url');
const equal = (a: string, b: string): boolean => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex');
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}
function number(value: string | null, fallback = 0): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HttpError(400, 'PAGE', 'Invalid pagination cursor');
  return Number(value);
}
function textField(body: Record<string, unknown>, key: string, maximum = 16_000): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new HttpError(400, 'INPUT', `${key} must contain 1 to ${maximum} characters`);
  return value;
}
function fields(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, 'FIELDS', 'Unsupported request fields');
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415, 'CONTENT_TYPE', 'Use application/json');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string); size += bytes.length;
    if (size > 65_536) throw new HttpError(413, 'BODY_SIZE', 'Request exceeds 64 KiB');
    chunks.push(bytes);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON', 'Invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON', 'Expected a JSON object');
  return body as Record<string, unknown>;
}
/** Loopback-only workbench. The host supplies all execution capabilities. */
export async function createLocalServer(app: Application, options: LocalServerOptions): Promise<LocalServerHandle> {
  const { onSession, packages: packageOptions, ...settings } = options;
  // Survives only for this local server instance: a restart issues new values so the UI can tell it apart.
  const identity = createServerIdentity();
  const policy = structuredClone(settings);
  policy.workspace = realpathSync(policy.workspace);
  if (policy.scope) policy.scope = normalizeFileScope(policy.scope);
  if (policy.port !== undefined && (!Number.isInteger(policy.port) || policy.port < 0 || policy.port > 65_535)) throw new KodoError('WEB_PORT', 'port must be an integer from 0 to 65535');
  // The panel is opt-in: only a host that explicitly enables it gets package data or actions.
  const packagePanel = packageOptions !== undefined && packageOptions.enabled === true ? new PackagePanel(packagePanelSettings(app, packageOptions)) : undefined;
  const packagePrepareEnabled = packagePanel !== undefined && packageOptions?.prepare === true;
  const packageAdoptEnabled = packagePanel !== undefined && packageOptions?.adopt === true;
  const startupSecret = token(); let secretUsed = false; let origin = '';
  const cookies = new Map<string, BrowserSession>();
  const streams = new Set<ServerResponse>(); const jobs = new Set<Promise<unknown>>();
  const explicitSessions = policy.sessionIds ? new Set(policy.sessionIds) : undefined;
  // This table belongs to the HTTP adapter, rather than the runtime's schema version.
  app.store.webRequests.ensure();
  if (explicitSessions) for (const row of app.store.webRequests.byActions(['run'])) {
    try { const previous = app.store.run(row.run_id); if (app.store.session(previous.sessionId).workspace === policy.workspace) explicitSessions.add(previous.sessionId); } catch { /* A pruned session carries no access grant. */ }
  }
  const allowedSession = (id: string): boolean => {
    try { return (!explicitSessions || explicitSessions.has(id)) && app.store.session(id).workspace === policy.workspace; }
    catch { return false; }
  };
  const run = (id: string, mutate = false): Run => {
    let value: Run;
    try { value = app.store.run(id); } catch { throw new HttpError(404, 'NOT_FOUND', 'Run not found'); }
    if (!allowedSession(value.sessionId)) throw new HttpError(404, 'NOT_FOUND', 'Run not found');
    if (mutate) {
      const session = app.store.session(value.sessionId);
      const granted = policy.permissions ?? ['read'];
      if (session.permissions.some(permission => !granted.includes(permission)) ||
        fingerprint(JSON.stringify(value.binding)) !== fingerprint(JSON.stringify(policy.binding)) ||
        JSON.stringify(value.scope ?? null) !== JSON.stringify(policy.scope ?? null) ||
        (policy.card ?? app.defaultCard).digest !== value.card.digest ||
        Object.entries(policy.budget ?? {}).some(([key, ceiling]) => ceiling !== null && (session.budget[key as keyof typeof session.budget] === null || session.budget[key as keyof typeof session.budget]! > ceiling))) throw new HttpError(403, 'HOST_POLICY', 'This run requires a different host configuration; restart with its approved configuration');
      if (value.parentId) throw new HttpError(400, 'MAIN_RUN', 'Send user actions to the main run');
    }
    return value;
  };
  const launch = (id: string, action: string): void => {
    const task = Promise.resolve().then(async () => {
      const current = run(id, true);
      onSession?.(current.sessionId);
      if (action === 'resume' && (current.status === 'interrupted' || current.error?.startsWith('UNKNOWN_WRITE:'))) {
        const continued = app.store.events(id, { types: ['recovery.continued'] })[0];
        if (continued && typeof continued.data.runId === 'string') await app.run(continued.data.runId);
        else await app.recover(id);
      } else if (['queued', 'waiting'].includes(current.status)) await app.run(id);
    }).catch(error => {
      // Async failures are durable and visible in the evidence panel, never silently ignored.
      app.store.event(id, 'web.command_failed', { action, code: error instanceof KodoError ? error.code : 'WEB_EXECUTION', message: error instanceof KodoError ? error.message : 'Execution failed; inspect local runtime evidence' });
    }).finally(() => { jobs.delete(task); });
    jobs.add(task);
  };
  /** Directed child input anchors on a main run, so it cannot reuse launch(): mutating policy checks reject children. */
  const launchAgent = (agentRunId: string, anchorRunId?: string): void => {
    const task = Promise.resolve().then(async () => {
      const current = run(agentRunId);
      onSession?.(current.sessionId);
      // Drive the non-terminal anchor so a waiting main resumes when the child settles; the
      // session driver also wakes the queued child. If the anchor cannot drive (terminal,
      // interrupted), fall back to driving the child directly.
      const anchor = anchorRunId === undefined ? undefined : run(anchorRunId);
      if (anchor && !['completed', 'failed', 'cancelled', 'interrupted'].includes(anchor.status)) { await app.run(anchor.id); return; }
      if (current.status === 'queued' || current.status === 'waiting') await app.run(agentRunId);
    }).catch(error => {
      const data = { action: 'agent_input', code: error instanceof KodoError ? error.code : 'WEB_EXECUTION', message: error instanceof KodoError ? error.message : 'Execution failed; inspect local runtime evidence' };
      try { app.store.event(agentRunId, 'web.command_failed', data); } catch { /* The target became unreadable; the HTTP receipt remains the durable record. */ }
    }).finally(() => { jobs.delete(task); });
    jobs.add(task);
  };
  const authenticate = (req: IncomingMessage): BrowserSession => {
    const cookie = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('kodo_session='))?.slice(13);
    const auth = cookie ? cookies.get(cookie) : undefined;
    if (!auth || auth.expires <= Date.now()) { if (cookie) cookies.delete(cookie); throw new HttpError(401, 'AUTH', 'Connect using the startup secret printed in your terminal'); }
    return auth;
  };
  const server = createServer((req, res) => { void handle(req, res); });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
      if (req.headers.host !== new URL(origin).host) throw new HttpError(403, 'HOST', 'Host does not match this local server');
      if (req.headers.origin !== undefined && req.headers.origin !== origin) throw new HttpError(403, 'ORIGIN', 'Cross-origin requests are forbidden');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'ORIGIN', 'Cross-site requests are forbidden');
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, 'URL', 'Invalid request target');
      const url = new URL(req.url, origin); const route = url.pathname;
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(route)) {
        const asset = route === '/' ? workbenchHtml : route === '/app.js' ? workbenchScript : workbenchStyle;
        res.setHeader('Content-Type', route === '/' ? 'text/html; charset=utf-8' : route === '/app.js' ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'); res.end(asset); return;
      }
      if (req.method === 'POST' && req.headers.origin !== origin) throw new HttpError(403, 'ORIGIN', 'Writes require the exact local Origin');
      if (route === '/api/auth' && req.method === 'POST') {
        const body = await readBody(req); fields(body, ['secret']);
        if (secretUsed || typeof body.secret !== 'string' || !equal(body.secret, startupSecret)) throw new HttpError(401, 'AUTH', 'Invalid or already used startup secret; restart the local server to connect again');
        secretUsed = true; const cookie = token(); const auth = { csrf: token(), expires: Date.now() + 43_200_000 }; cookies.set(cookie, auth);
        res.setHeader('Set-Cookie', `kodo_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`); json(res, 200, { csrf: auth.csrf }); return;
      }
      const auth = authenticate(req);
      if (route === '/api/state' && req.method === 'GET') { json(res, 200, { csrf: auth.csrf, workspace: policy.workspace, permissions: policy.permissions ?? ['read'], ...identity }); return; }
      if (route === '/api/recovery' && req.method === 'GET') { json(res, 200, recoveryView(app, allowedSession, { limit: number(url.searchParams.get('limit'), 100), ...identity })); return; }
      if (route === '/api/packages' && req.method === 'GET') {
        json(res, 200, packagePanel ? await packagePanel.overview(app, allowedSession) : disabledPackageOverview());
        return;
      }
      const packageJobRoute = /^\/api\/packages\/jobs\/([^/]+)$/.exec(route);
      if (packageJobRoute && req.method === 'GET') {
        if (!packagePanel) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
        const job = packagePanel.job(packageJobRoute[1]!);
        if (!job) throw new HttpError(404, 'NOT_FOUND', 'Prepare job not found');
        json(res, 200, job); return;
      }
      if (req.method === 'GET') {
        const after = number(url.searchParams.get('after')); const limit = Math.min(1000, Math.max(1, number(url.searchParams.get('limit'), 100)));
        if (route === '/api/sessions') {
          // Advance the persisted cursor even across inaccessible rows.
          const page = app.sessions({ after, limit }); json(res, 200, { ...page, items: page.items.filter(session => allowedSession(session.id)) }); return;
        }
        if (route === '/api/runs') {
          const sessionId = url.searchParams.get('sessionId') ?? undefined;
          if (sessionId && !allowedSession(sessionId)) throw new HttpError(404, 'NOT_FOUND', 'Session not found');
          const page = app.runs({ after, limit, sessionId }); json(res, 200, { ...page, items: page.items.filter(item => allowedSession(item.sessionId)).map(publicRun) }); return;
        }
        const collaborationRoute = /^\/api\/runs\/([^/]+)\/collaboration$/.exec(route);
        if (collaborationRoute) { const value = run(collaborationRoute[1]!); json(res, 200, collaborationView(app, value.id)); return; }
        const methodsRoute = /^\/api\/runs\/([^/]+)\/methods$/.exec(route);
        if (methodsRoute) { const value = run(methodsRoute[1]!, true); const session = app.store.session(value.sessionId); json(res, 200, { methods: session.methodCards ?? [], digest: methodCatalogDigest(session.methodCards) }); return; }
        const contextRoute = /^\/api\/runs\/([^/]+)\/context$/.exec(route);
        if (contextRoute) { const value = run(contextRoute[1]!, true); json(res, 200, app.context(value.id)); return; }
        const knowledgeRoute = /^\/api\/runs\/([^/]+)\/knowledge(?:\/(search|read|versions))?$/.exec(route);
        if (knowledgeRoute) {
          const value = run(knowledgeRoute[1]!, true);
          const knowledge = app.coordinator.knowledge;
          if (!knowledge) throw new HttpError(409, 'KNOWLEDGE_DISABLED', 'Project knowledge is disabled');
          const param = (name: string) => url.searchParams.get(name) ?? undefined;
          if (knowledgeRoute[2] === 'search') {
            const scope = param('in');
            if (scope !== undefined && !['summary', 'evidence'].includes(scope)) throw new HttpError(400, 'INPUT', 'in must be summary or evidence');
            json(res, 200, knowledge.search(value.id, { query: param('query'), in: scope as 'summary' | 'evidence' | undefined, after, limit: Math.min(5, limit) }));
          } else if (knowledgeRoute[2] === 'read') {
            json(res, 200, knowledge.read(value.id, { id: param('id') ?? '', revision: number(url.searchParams.get('revision')), offset: number(url.searchParams.get('offset')), evidenceId: param('evidenceId') }));
          } else if (knowledgeRoute[2] === 'versions') {
            json(res, 200, knowledge.versions(value.id, param('id') ?? '', after));
          } else {
            json(res, 200, knowledge.browse(value.id, { parentId: param('parentId'), after: param('cursor'), limit: Math.min(20, limit) }, true));
          }
          return;
        }
        const matched = /^\/api\/runs\/([^/]+)\/(snapshot|events|artifacts|evidence)(?:\/([^/]+))?$/.exec(route);
        if (matched) {
          const value = run(matched[1]!); const kind = matched[2];
          if (kind === 'snapshot') {
            const snapshot = app.snapshot(value.id);
            json(res, 200, { ...snapshot, run: publicRun(snapshot.run), runs: snapshot.runs.map(item => ({ ...publicRun(item), stale: item.stale })), result: value.resultRef ? app.store.readBlob(value.resultRef) : null }); return;
          }
          if (kind === 'artifacts' && matched[3]) { json(res, 200, app.store.readArtifact(value.id, matched[3])); return; }
          if (kind === 'artifacts') {
            const artifacts = app.store.artifactIds(value.sessionId);
            json(res, 200, artifacts); return;
          }
          if (kind === 'evidence' && matched[3]) {
            const call = app.store.calls(value.id).find(item => item.id === decodeURIComponent(matched[3]!));
            if (!call) throw new HttpError(404, 'NOT_FOUND', 'Call not found');
            json(res, 200, { call, request: app.store.readBlob(call.requestRef), result: call.resultRef ? app.store.readBlob(call.resultRef) : null }); return;
          }
          if (kind === 'events') {
            let cursor = Math.max(after, number(typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : null));
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); streams.add(res);
            let disposed = false;
            const send = (event: RuntimeEvent): void => {
              if (disposed || event.sessionId !== value.sessionId || event.seq <= cursor) return;
              cursor = event.seq;
              if (res.writableLength > 1_048_576) { cleanup(); res.destroy(); return; }
              res.write(`id: ${event.seq}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`);
            };
            // Subscribe before replay; synchronous durable reads avoid a replay/live gap.
            const unsubscribe = app.store.subscribe(send);
            const heartbeat = setInterval(() => { if (auth.expires <= Date.now()) res.end(); else res.write(': heartbeat\n\n'); }, 15_000); heartbeat.unref();
            const cleanup = (): void => { if (disposed) return; disposed = true; unsubscribe(); clearInterval(heartbeat); streams.delete(res); };
            res.on('close', cleanup); res.on('error', cleanup);
            let page;
            do { page = app.events({ sessionId: value.sessionId, after: cursor, limit: 1000 }); for (const event of page.items) send(event); } while (page.next !== null && !disposed);
            if (disposed) return;
            res.write(': connected\n\n');
            return;
          }
        }
      }
      if (req.method === 'POST') {
        if (typeof req.headers['x-kodo-csrf'] !== 'string' || !equal(req.headers['x-kodo-csrf'], auth.csrf)) throw new HttpError(403, 'CSRF', 'Invalid request token; reload the workbench');
        // Package management actions are host-gated, same-origin and CSRF-checked, but deliberately do
        // not use web_requests receipts: adopt/rollback are idempotent and prepare reuses a live job.
        const packagePrepareRoute = /^\/api\/packages\/(.+?)\/([^/]+)\/prepare$/.exec(route);
        const packagePointerRoute = /^\/api\/packages\/(.+?)\/(adopt|rollback)$/.exec(route);
        if (packagePrepareRoute || packagePointerRoute) {
          if (!packagePanel) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
          if (packagePrepareRoute) {
            if (!packagePrepareEnabled) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
            const body = await readBody(req); fields(body, []);
            const id = decodeSegment(packagePrepareRoute[1]!);
            const version = decodeSegment(packagePrepareRoute[2]!);
            try {
              if (!(await packagePanel.has(id, version))) throw new KodoError('PACKAGE_NOT_FOUND', 'package version is not installed');
              json(res, 202, packagePanel.prepare(id, version));
            } catch (error) { throw packageHttpError(error); }
            return;
          }
          if (!packageAdoptEnabled) throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
          const id = decodeSegment(packagePointerRoute![1]!);
          const body = await readBody(req);
          try {
            if (packagePointerRoute![2] === 'adopt') {
              fields(body, ['version']);
              json(res, 200, { pointer: await packagePanel.adopt(id, textField(body, 'version', 32)) });
            } else {
              fields(body, []);
              json(res, 200, { pointer: await packagePanel.rollback(id) });
            }
          } catch (error) { throw packageHttpError(error); }
          return;
        }
        const requestId = req.headers['idempotency-key'];
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new HttpError(400, 'REQUEST_ID', 'Provide an Idempotency-Key of 8 to 128 letters, digits, dashes or underscores');
        const body = await readBody(req);
        const signature = fingerprint(JSON.stringify({ route, body }));
        const previous = app.store.webRequests.get(requestId);
        if (previous) {
          if (previous.fingerprint !== signature) throw new HttpError(409, 'REQUEST_CONFLICT', 'Request ID was already used with different input');
          run(previous.run_id, true); json(res, 200, JSON.parse(previous.response)); return;
        }
        let action = 'run'; let target: Run; let agent: Run | undefined; let agentRunId: string | undefined;
        const command = /^\/api\/runs\/([^/]+)\/(input|answer|cancel|resume)$/.exec(route);
        const agentCommand = /^\/api\/runs\/([^/]+)\/agents\/([^/]+)\/(input|cancel)$/.exec(route);
        const spawnCommand = /^\/api\/runs\/([^/]+)\/agents\/spawn$/.exec(route);
        const methodsCommand = /^\/api\/runs\/([^/]+)\/methods$/.exec(route);
        const knowledgeCommand = /^\/api\/runs\/([^/]+)\/knowledge\/(folder|organize|remove-folder)$/.exec(route);
        const response = app.store.transaction(() => {
          let node;
          let methodRevision;
          if (route === '/api/runs') {
            fields(body, ['objective']);
            target = app.createRun({ workspace: policy.workspace, binding: policy.binding, permissions: policy.permissions, scope: policy.scope, budget: policy.budget, card: policy.card, finalResponse: policy.finalResponse, objective: textField(body, 'objective', 32_000) });
            onSession?.(target.sessionId); explicitSessions?.add(target.sessionId);
          } else if (methodsCommand) {
            target = run(methodsCommand[1]!, true); onSession?.(target.sessionId); action = 'methods';
            fields(body, ['expectedDigest', 'card', 'disable']);
            if (body.disable !== undefined && (!Array.isArray(body.disable) || body.disable.length > 32 || body.disable.some(value => typeof value !== 'string'))) throw new HttpError(400, 'ARGUMENTS', 'disable must be a list of method IDs');
            methodRevision = app.updateSessionMethods(target.id, { expectedDigest: textField(body, 'expectedDigest', 64), ...(body.card !== undefined ? { install: [app.parseCard(textField(body, 'card', 128000))] } : {}), disable: body.disable as string[] | undefined });
          } else if (spawnCommand) {
            target = run(spawnCommand[1]!, true); onSession?.(target.sessionId); action = 'agent_input';
            fields(body, ['objective', 'context', 'inputs', 'acceptance', 'permissions', 'model_binding', 'scope', 'continuation_of', 'todoId']);
            textField(body, 'objective', 32_000);
            agent = app.spawnAgent(target.sessionId, body as unknown as Parameters<typeof app.spawnAgent>[1]);
            agentRunId = agent.id;
          } else if (knowledgeCommand) {
            target = run(knowledgeCommand[1]!, true); action = 'knowledge';
            const knowledge = app.coordinator.knowledge;
            if (!knowledge) throw new HttpError(409, 'KNOWLEDGE_DISABLED', 'Project knowledge is disabled');
            if (knowledgeCommand[2] === 'folder') {
              fields(body, ['title', 'parentId']);
              if (body.parentId !== undefined && body.parentId !== null && typeof body.parentId !== 'string') throw new HttpError(400, 'INPUT', 'parentId must be text or null');
              node = knowledge.createFolder(target.id, textField(body, 'title', 160), body.parentId as string | null | undefined);
            } else if (knowledgeCommand[2] === 'organize') {
              fields(body, ['nodeId', 'knowledgeId', 'title', 'parentId']);
              if (typeof body.nodeId !== 'string' && typeof body.knowledgeId !== 'string') throw new HttpError(400, 'INPUT', 'Provide nodeId or knowledgeId');
              for (const key of ['nodeId', 'knowledgeId', 'title']) if (body[key] !== undefined) textField(body, key, key === 'title' ? 160 : 256);
              if (body.parentId !== undefined && body.parentId !== null && typeof body.parentId !== 'string') throw new HttpError(400, 'INPUT', 'parentId must be text or null');
              node = knowledge.organize(target.id, body);
            } else { fields(body, ['nodeId']); knowledge.removeFolder(target.id, textField(body, 'nodeId', 256)); }
          } else if (command) {
            target = run(command[1]!, true); onSession?.(target.sessionId); action = command[2]!;
            if (action === 'input') { fields(body, ['content', 'mode', 'decision']); if (body.mode !== undefined && !['steer', 'follow_up'].includes(String(body.mode))) throw new HttpError(400, 'INPUT', 'Unknown input mode'); if (body.decision !== undefined && typeof body.decision !== 'boolean') throw new HttpError(400, 'INPUT', 'decision must be boolean'); target = app.submitInput(target.id, textField(body, 'content'), { mode: body.mode as 'steer' | 'follow_up' | undefined, decision: body.decision as boolean | undefined }); }
            else if (action === 'answer') {
              fields(body, ['questionId', 'content']); const questionId = textField(body, 'questionId', 128); const question = app.store.message(questionId);
              if (!question || question.sessionId !== target.sessionId || question.to !== 'user' || question.kind !== 'question') throw new HttpError(404, 'QUESTION', 'Question not found in this session');
              app.answer(questionId, textField(body, 'content'));
            } else if (action === 'cancel') { fields(body, []); app.coordinator.cancel(target.id); target = app.store.run(target.id); }
            else { fields(body, []); if (target.status !== 'interrupted' && !target.error?.startsWith('UNKNOWN_WRITE:')) throw new HttpError(409, 'NOT_INTERRUPTED', 'Only interrupted runs can be resumed; send a follow-up for completed or cancelled tasks'); }
          } else if (agentCommand) {
            // Host policy is validated on the anchor main run; the Application then requires a same-session direct child.
            target = run(agentCommand[1]!, true); onSession?.(target.sessionId);
            action = agentCommand[3] === 'input' ? 'agent_input' : 'agent_cancel';
            const childId = decodeURIComponent(agentCommand[2]!);
            if (action === 'agent_input') { fields(body, ['content']); agent = app.submitAgentInput(target.id, childId, textField(body, 'content')).agent; }
            else { fields(body, []); agent = app.cancelAgent(target.id, childId); }
            agentRunId = agent.id;
          } else throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
          const receipt = { requestId, runId: target.id, sessionId: target.sessionId, status: action === 'resume' || action === 'agent_input' ? 'accepted' : action === 'agent_cancel' ? agent?.status ?? target.status : target.status, ...(agent ? { agentRunId: agent.id } : {}), ...(node ? { node } : {}), ...(methodRevision ? { methodRevision } : {}) };
          app.store.webRequests.insert({ request_id: requestId, fingerprint: signature, response: JSON.stringify(receipt), action, run_id: target.id });
          return receipt;
        });
        json(res, 202, response);
        if (['run', 'input', 'answer', 'resume'].includes(action)) launch(response.runId, action);
        else if (action === 'agent_input' && agentRunId) launchAgent(agentRunId, response.runId);
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', 'Endpoint not found');
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof KodoError ? ['NOT_FOUND', 'ARTIFACT_DENIED'].includes(error.code) ? 404 : 400 : 500;
      json(res, status, { error: { code: error instanceof HttpError || error instanceof KodoError ? error.code : 'INTERNAL', message: error instanceof HttpError || error instanceof KodoError ? error.message : 'Operation failed; inspect the local runtime' } });
    }
  }
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(policy.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const row of app.store.webRequests.byActions(['run', 'input', 'answer', 'resume'], true)) {
    try { const current = run(row.run_id, true); if (current.status === 'queued' || (row.action === 'resume' && current.status === 'interrupted')) launch(current.id, row.action); } catch { /* Prior workspace or policy is intentionally inaccessible to this server. */ }
  }
  // Directed child input is anchored on the main run; re-drive queued/waiting children after a restart. Cancellation is never replayed.
  const resumedAgents = new Set<string>();
  for (const row of app.store.webRequests.byActions(['agent_input'])) {
    try {
      const current = run(row.run_id, true);
      const receipt = JSON.parse(row.response) as { agentRunId?: unknown };
      if (typeof receipt.agentRunId !== 'string' || resumedAgents.has(receipt.agentRunId)) continue;
      resumedAgents.add(receipt.agentRunId);
      const agent = app.store.run(receipt.agentRunId);
      if (agent.sessionId === current.sessionId && agent.parentId === current.id) launchAgent(agent.id, current.id);
    } catch { /* Prior workspace, policy or receipt is intentionally inaccessible to this server. */ }
  }
  return { origin, startupSecret, async close() { for (const stream of streams) stream.end(); await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }); cookies.clear(); await packagePanel?.close(); } };
}
const PACKAGE_IDENTITY = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+$/;
const PACKAGE_DIGEST = /^[a-f0-9]{64}$/;
/** The panel is disabled unless the host opts in; the browser can never widen this on its own. */
function disabledPackageOverview(): PackageOverview {
  return { enabled: false, actions: { prepare: false, adopt: false }, runtime: null, packages: [], running: [], prepareJobs: [], errors: [] };
}
function packagePanelSettings(app: Application, options: PackagePanelOptions): ConstructorParameters<typeof PackagePanel>[0] {
  const runtime = options.runtime;
  if (runtime !== undefined && (typeof runtime.id !== 'string' || !PACKAGE_IDENTITY.test(runtime.id) || typeof runtime.version !== 'string' || !PACKAGE_VERSION.test(runtime.version) || typeof runtime.digest !== 'string' || !PACKAGE_DIGEST.test(runtime.digest))) throw new KodoError('PACKAGE_RUNTIME', 'packages.runtime requires a package id, semantic version and sha256 digest');
  const npmCli = options.npmCli;
  if (npmCli !== undefined && !path.isAbsolute(npmCli)) throw new KodoError('PACKAGE_NPM_CLI', 'packages.npmCli must be an absolute path');
  return {
    registry: packageRegistry(app, options.registry),
    ...(runtime === undefined ? {} : { runtime: { id: runtime.id, version: runtime.version, digest: runtime.digest } }),
    prepare: options.prepare === true,
    adopt: options.adopt === true,
    ...(npmCli === undefined ? {} : { npmCli }),
  };
}
function packageRegistry(app: Application, registry: PackagePanelOptions['registry']): PackageRegistry {
  if (registry === undefined) return new PackageRegistry(path.join(app.store.directory, 'capabilities'));
  if (typeof registry === 'string') {
    if (!path.isAbsolute(registry)) throw new KodoError('PACKAGE_REGISTRY', 'packages.registry must be an absolute path');
    return new PackageRegistry(path.resolve(registry));
  }
  if (!(registry instanceof PackageRegistry)) throw new KodoError('PACKAGE_REGISTRY', 'packages.registry must be an absolute path or a PackageRegistry instance');
  return registry;
}
/** Package business errors keep their existing 400 mapping; a missing version is an HTTP 404. */
function packageHttpError(error: unknown): unknown {
  return error instanceof KodoError && (error.code === 'PACKAGE_NOT_FOUND' || error.code === 'NOT_FOUND') ? new HttpError(404, error.code, error.message) : error;
}
/** `author/name` may arrive as two raw path segments or one encoded segment; both select the same package. */
function decodeSegment(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new HttpError(400, 'URL', 'Invalid request target'); }
}
/** Never send the host's credential environment variable name or endpoint binding to the UI. */
function publicRun(value: Run): Omit<Run, 'binding'> { const { binding: _binding, ...visible } = value; void _binding; return visible; }
