import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Permission, ToolRecoveryVerifier } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';
import { assertFileScope, normalizeFileScope } from '../runtime/scope.js';
import { prepareSandboxCommand } from '../sandbox/index.js';
import type { PreparedSandbox, SandboxOptions } from '../sandbox/index.js';
import { digest } from '../storage/index.js';
import type { ToolRegistration } from '../tools/registry.js';

export interface McpToolPolicy {
  permission: Permission; effect: 'read' | 'write'; description?: string; recover?: ToolRecoveryVerifier;
  /** Host semantic revision for server behavior changes without public schema changes. */
  version?: string;
}
interface McpBase {
  /** Trusted host alias; remote names become mcp.<id>.<remoteName>. */
  id: string;
  /** Only explicitly declared tools are exposed; server annotations never grant permission. */
  tools: Record<string, McpToolPolicy>;
  timeoutMs?: number;
  maxMessageBytes?: number;
}
export type McpConfig = McpBase & ({ transport: 'http'; url: string; headers?: Record<string, string | { env: string }> } |
  { transport: 'stdio'; command: string; args?: string[]; cwd?: string; env?: Record<string, { env: string }>; sandbox?: SandboxOptions });
export interface McpConnection { tools: ToolRegistration[]; close(): Promise<void> }
type RpcMessage = Record<string, unknown>;
interface Transport { request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>; notify(method: string, params?: unknown): Promise<void>; close(): Promise<void> }
const fail = (code: string, message: string): KodoError => new KodoError(`MCP_${code}`, message);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const protocolVersion = '2025-03-26';

/** Real MCP client with no model-controlled endpoint, process, environment, or permission selection. */
export async function connectMcp(config: McpConfig, options: { signal?: AbortSignal } = {}): Promise<McpConnection> {
  options.signal?.throwIfAborted();
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(config.id) || !record(config.tools)) throw fail('CONFIG', 'invalid host server declaration');
  if (config.transport === 'stdio' && (typeof config.command !== 'string' || (config.args !== undefined && !Array.isArray(config.args)) || (config.env !== undefined && !record(config.env)))) throw fail('CONFIG', 'invalid host command');
  // Initialization crosses asynchronous I/O boundaries. Snapshot declarations
  // so the persisted identity describes the process that was actually started.
  config = { ...config, tools: Object.fromEntries(Object.entries(config.tools).map(([name, policy]) => [name, { ...policy }])), ...(config.transport === 'stdio' ? { args: [...(config.args ?? [])], env: structuredClone(config.env ?? {}), ...(config.sandbox ? { sandbox: structuredClone(config.sandbox) } : {}) } : { headers: structuredClone(config.headers ?? {}) }) };
  const timeout = config.timeoutMs ?? 30_000;
  const maximum = config.maxMessageBytes ?? 1024 * 1024;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600_000 || !Number.isInteger(maximum) || maximum < 1024 || maximum > 16 * 1024 * 1024) throw fail('CONFIG', 'invalid protocol resource limits');
  for (const [name, policy] of Object.entries(config.tools)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name) || `mcp.${config.id}.${name}`.length > 64 || !record(policy) || !['read', 'write', 'exec'].includes(policy.permission) || !['read', 'write'].includes(policy.effect) || (policy.effect === 'write' && policy.permission === 'read') || (policy.recover !== undefined && typeof policy.recover !== 'function') || (policy.version !== undefined && (typeof policy.version !== 'string' || !policy.version.trim() || policy.version.length > 200))) throw fail('CONFIG', 'invalid host tool policy');
  }
  const lifetime = new AbortController();
  const secrets: string[] = [];
  const secret = (name: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !process.env[name]) throw fail('CONFIG', 'a required credential environment reference is unavailable');
    const value = process.env[name]!;
    secrets.push(value);
    return value;
  };
  const redact = <T>(value: T): T => JSON.parse(secrets.reduce((json, value) => json.split(JSON.stringify(value).slice(1, -1)).join('[REDACTED]'), JSON.stringify(value))) as T;
  let transport: Transport;
  let bindingIdentity: Record<string, unknown>;
  let sandbox: SandboxOptions | undefined;
  if (config.transport === 'http') {
    let endpoint: URL;
    try { endpoint = new URL(config.url); } catch { throw fail('CONFIG', 'invalid host endpoint'); }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw fail('CONFIG', 'use HTTPS or loopback HTTP without embedded credentials, query or fragment');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.headers ?? {})) {
      if (/^(?:host|content-length|content-type|accept|mcp-session-id|mcp-protocol-version)$/i.test(name)) throw fail('CONFIG', 'reserved HTTP protocol header');
      headers[name] = typeof value === 'string' ? value : secret(value.env);
      if (typeof value === 'string' && value) secrets.push(value);
    }
    bindingIdentity = { url: endpoint.href, headers: Object.entries(config.headers ?? {}).map(([name, value]) => [name.toLowerCase(), typeof value === 'string' ? { literalHash: digest(value) } : { env: value.env }] as const).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0) };
    transport = new HttpTransport(endpoint, headers, maximum, timeout, lifetime.signal);
  } else if (config.transport === 'stdio') {
    if (!config.command || config.command.includes('\0') || config.args?.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw fail('CONFIG', 'invalid host command');
    const env: NodeJS.ProcessEnv = {};
    if (!config.sandbox) for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']) if (process.env[name]) env[name] = process.env[name];
    for (const [name, value] of Object.entries(config.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !record(value) || typeof value.env !== 'string' || (config.sandbox && /^(?:NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*)$/i.test(name))) throw fail('CONFIG', 'invalid process environment binding');
      env[name] = secret(value.env);
    }
    bindingIdentity = { command: config.command, args: config.args ?? [], cwd: config.cwd ?? process.cwd(), env: Object.entries(config.env ?? {}).map(([name, value]) => [name, value.env] as const).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0) };
    let prepared: PreparedSandbox | undefined;
    if (config.sandbox) {
      sandbox = structuredClone(config.sandbox);
      sandbox.workspace = await realpath(sandbox.workspace);
      sandbox.scope = normalizeFileScope(sandbox.scope ?? {});
      sandbox.readOnlyPaths = await Promise.all((sandbox.readOnlyPaths ?? []).map(value => realpath(value)));
      prepared = await prepareSandboxCommand(config.command, config.args ?? [], { ...sandbox, cwd: config.cwd, env });
      bindingIdentity.cwd = prepared.cwd;
      bindingIdentity.sandbox = {
        backend: process.platform, workspace: sandbox.workspace, scope: sandbox.scope, write: sandbox.write ?? false,
        network: sandbox.network ?? 'none',
        ...(sandbox.networkAllowlist === undefined ? {} : { networkAllowlist: [...sandbox.networkAllowlist].sort() }),
        ...(sandbox.resources === undefined ? {} : { resources: Object.fromEntries(Object.entries(sandbox.resources).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) }),
        readOnlyPaths: [...sandbox.readOnlyPaths].sort(), deny: [...(sandbox.deny ?? [])].sort(),
      };
    }
    try { options.signal?.throwIfAborted(); transport = new StdioTransport(prepared?.program ?? config.command, prepared?.args ?? config.args ?? [], prepared?.cwd ?? config.cwd, prepared?.env ?? env, maximum, prepared); }
    catch (error) { await prepared?.cleanup(); throw error; }
  } else throw fail('CONFIG', 'unsupported MCP transport');
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closed = true;
      lifetime.abort(fail('CLOSED', 'MCP connection closed'));
      options.signal?.removeEventListener('abort', onAbort);
      closePromise = transport.close();
    }
    return closePromise;
  };
  // Event callbacks cannot return cleanup promises; a rejected cleanup is retained
  // and reported to the host when it awaits close()/Application.shutdown().
  const onAbort = (): void => { void close().catch(() => {}); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const request = async (method: string, params: unknown, signal?: AbortSignal): Promise<unknown> => {
    const combined = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
    try { combined.throwIfAborted(); return redact(await transport.request(method, params, combined)); }
    catch (error) {
      if (error instanceof KodoError && ['MCP_CLEANUP', 'MCP_STOP', 'SANDBOX_CLEANUP'].includes(error.code)) throw error;
      if (combined.aborted) throw fail('CANCELLED', 'MCP request cancelled, timed out, or connection closed');
      if (error instanceof KodoError) throw error;
      throw fail('TRANSPORT', 'MCP transport operation failed');
    }
  };
  try {
    options.signal?.throwIfAborted();
    const initialized = await request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'kodo-local', version: '0.1.0' } }, options.signal);
    if (!record(initialized) || !['2024-11-05', protocolVersion, '2025-06-18'].includes(initialized.protocolVersion as string) || !record(initialized.capabilities) || !record(initialized.capabilities.tools)) throw fail('PROTOCOL', 'server did not negotiate a supported tools protocol');
    if (transport instanceof HttpTransport) transport.protocol = initialized.protocolVersion as string;
    await transport.notify('notifications/initialized');
    const definitions = new Map<string, { description: string; parameters: Record<string, unknown> }>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = await request('tools/list', cursor ? { cursor } : {}, options.signal);
      if (!record(page) || !Array.isArray(page.tools)) throw fail('PROTOCOL', 'invalid MCP tool list');
      for (const remote of page.tools) {
        if (++count > 1000) throw fail('LIMIT', 'MCP tool catalog exceeds 1000 entries');
        if (!record(remote) || typeof remote.name !== 'string' || !record(remote.inputSchema) || remote.inputSchema.type !== 'object') throw fail('PROTOCOL', 'invalid MCP tool definition');
        if (definitions.has(remote.name)) throw fail('PROTOCOL', 'duplicate MCP tool name');
        definitions.set(remote.name, { description: typeof remote.description === 'string' ? remote.description.slice(0, 4000) : remote.name, parameters: remote.inputSchema });
      }
      cursor = page.nextCursor as string | undefined;
      if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursors.has(cursor) || cursors.size >= 100)) throw fail('PROTOCOL', 'invalid or repeating MCP catalog cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const tools: ToolRegistration[] = Object.entries(config.tools).map(([name, policy]) => {
      const definition = definitions.get(name);
      if (!definition) throw fail('CONFIG', 'a host-declared tool is missing from the MCP server');
      const permission = policy.permission;
      const effect = policy.effect;
      const version = digest(JSON.stringify({ transport: config.transport, id: config.id, binding: bindingIdentity, protocol: initialized.protocolVersion, remoteName: name, revision: policy.version ?? null }));
      return { name: `mcp.${config.id}.${name}`, version, description: policy.description ?? definition.description, parameters: definition.parameters, permission, effect, ...(policy.recover ? { recover: policy.recover } : {}),
        execute: async ({ signal, markEffectStarted, run, session }, args) => {
          signal.throwIfAborted();
          if (closed) throw fail('CLOSED', 'MCP connection closed');
          if (sandbox) {
            const workspace = await realpath(session.workspace);
            const compare = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
            if (compare(workspace) !== compare(sandbox.workspace)) throw fail('SCOPE', 'sandboxed MCP server belongs to another workspace');
            const permissions = run.permissions ?? session.permissions;
            const readRoots = [...(sandbox.scope?.read ?? ['.']), ...(sandbox.write ? sandbox.scope?.write ?? ['.'] : [])];
            if (readRoots.length && !permissions.includes('read')) throw fail('SCOPE', 'sandboxed MCP server requires workspace read permission');
            if (sandbox.write && (sandbox.scope?.write ?? ['.']).length && !permissions.includes('write')) throw fail('SCOPE', 'sandboxed MCP server requires workspace write permission');
            // A persistent server already holds these grants. Do not allow a
            // narrowed child run to borrow its parent's broader process rights.
            try {
              for (const root of readRoots) assertFileScope(run.scope, 'read', workspace, path.resolve(workspace, root));
              if (sandbox.write) for (const root of sandbox.scope?.write ?? ['.']) assertFileScope(run.scope, 'write', workspace, path.resolve(workspace, root));
            } catch { throw fail('SCOPE', 'sandboxed MCP server grants exceed this run scope'); }
          }
          signal.throwIfAborted();
          if (closed) throw fail('CLOSED', 'MCP connection closed');
          if (Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER, method: 'tools/call', params: { name, arguments: args } })) + 1 > maximum) throw fail('LIMIT', 'MCP request exceeds message limit');
          // Persist uncertainty before sending any potentially mutating external request.
          if (effect === 'write') markEffectStarted();
          const result = await request('tools/call', { name, arguments: args }, signal);
          if (!record(result) || !Array.isArray(result.content)) throw fail('PROTOCOL', 'invalid MCP tool result');
          if (result.isError === true) {
            const evidence = result.content.filter(record).filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text as string).join('\n').slice(0, 2000);
            throw fail('TOOL', `MCP server reported a tool execution error${evidence ? `: ${evidence}` : ''}`);
          }
          return result;
        },
      };
    });
    return { tools, close };
  } catch (error) { await close(); if (error instanceof KodoError) throw error; throw fail('TRANSPORT', 'MCP connection initialization failed'); }
}

function responseResult(message: unknown, id: number): unknown {
  if (!record(message) || message.jsonrpc !== '2.0' || message.id !== id || ('result' in message) === ('error' in message) || 'method' in message) throw fail('PROTOCOL', 'invalid JSON-RPC response');
  if ('error' in message) throw fail('REMOTE', 'MCP server rejected the protocol request');
  return message.result;
}

class HttpTransport implements Transport {
  protocol = protocolVersion;
  private session?: string;
  private sequence = 0;
  constructor(private endpoint: URL, private headers: Record<string, string>, private maximum: number, private timeout: number, private lifetime: AbortSignal) {}
  private async send(message: RpcMessage, signal: AbortSignal): Promise<Response> {
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > this.maximum) throw fail('LIMIT', 'MCP request exceeds message limit');
    const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', signal, headers: { ...this.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.protocol, ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) }, body });
    if (!response.ok) { await response.body?.cancel(); throw fail('HTTP', `MCP endpoint returned HTTP ${response.status}`); }
    const session = response.headers.get('mcp-session-id');
    if (session) {
      if (session.length > 1024 || /[^\x21-\x7e]/.test(session) || (this.session && this.session !== session)) { await response.body?.cancel(); throw fail('PROTOCOL', 'invalid MCP session identifier'); }
      this.session = session;
    }
    return response;
  }
  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const id = ++this.sequence;
    const onAbort = (): void => {
      if (!this.lifetime.aborted) void this.notify('notifications/cancelled', { requestId: id, reason: 'Request cancelled' }).catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try { return await this.response(id, method, params, signal); }
    finally { signal.removeEventListener('abort', onAbort); }
  }
  private async response(id: number, method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.send({ jsonrpc: '2.0', id, method, params }, signal);
    if (!response.body) throw fail('PROTOCOL', 'MCP response body missing');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const streaming = response.headers.get('content-type')?.split(';')[0]?.trim() === 'text/event-stream';
    if (!streaming && response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') { await reader.cancel(); throw fail('PROTOCOL', 'unsupported MCP response content type'); }
    let bytes = 0;
    let buffered = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          buffered += decoder.decode();
          if (!streaming) return responseResult(JSON.parse(buffered), id);
          throw fail('PROTOCOL', 'MCP event stream ended before its response');
        }
        bytes += chunk.value.byteLength;
        if (bytes > this.maximum) throw fail('LIMIT', 'MCP response exceeds message limit');
        buffered += decoder.decode(chunk.value, { stream: true });
        if (!streaming) continue;
        buffered = buffered.replaceAll('\r\n', '\n');
        let boundary: number;
        while ((boundary = buffered.indexOf('\n\n')) >= 0) {
          const event = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          const message: unknown = JSON.parse(data);
          if (record(message) && message.jsonrpc === '2.0' && typeof message.method === 'string' && (typeof message.id === 'number' || typeof message.id === 'string')) {
            const reply = await this.send({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Client method not supported' } }) }, signal);
            await reply.body?.cancel();
            continue;
          }
          if (record(message) && message.id === id) return responseResult(message, id);
          // Notifications are data; no server-driven client capabilities are enabled.
          if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.id !== undefined) throw fail('PROTOCOL', 'unexpected MCP stream message');
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }
  async notify(method: string, params?: unknown): Promise<void> {
    const signal = AbortSignal.any([this.lifetime, AbortSignal.timeout(this.timeout)]);
    const response = await this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }, signal);
    await response.body?.cancel();
  }
  async close(): Promise<void> {
    if (!this.session) return;
    try { const response = await fetch(this.endpoint, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(Math.min(this.timeout, 1000)), headers: { ...this.headers, 'MCP-Protocol-Version': this.protocol, 'Mcp-Session-Id': this.session } }); await response.body?.cancel(); }
    catch { /* Local cancellation still closes every in-flight request; DELETE is best effort. */ }
  }
}

class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private closed = false;
  private processClosed = false;
  private closePromise?: Promise<void>;
  constructor(command: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, private maximum: number, private sandbox?: PreparedSandbox) {
    try { this.child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe', ...(sandbox?.extraFiles ?? [])] }) as ChildProcessWithoutNullStreams; }
    catch { throw fail('START', 'MCP process could not be started'); }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let length = 0;
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        // The byte ceiling includes incomplete frames; multiple small frames remain allowed.
        length += chunk.length;
        if (length > maximum && !chunk.includes(10)) throw fail('LIMIT', 'MCP process message exceeds limit');
        buffer += decoder.decode(chunk, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          if (Buffer.byteLength(frame) > maximum) throw fail('LIMIT', 'MCP process message exceeds limit');
          if (!frame.trim()) continue;
          const message: unknown = JSON.parse(frame);
          if (!record(message) || message.jsonrpc !== '2.0') throw fail('PROTOCOL', 'invalid MCP process frame');
          if (typeof message.method === 'string' && (typeof message.id === 'number' || typeof message.id === 'string')) {
            void this.write({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Client method not supported' } }) }).catch(error => this.rejectAll(error));
          } else if (typeof message.id === 'number') {
            const request = this.pending.get(message.id);
            if (!request) continue;
            this.pending.delete(message.id);
            try { request.resolve(responseResult(message, message.id)); } catch (error) { request.reject(error); }
          } else if (typeof message.method !== 'string' || message.id !== undefined) throw fail('PROTOCOL', 'unexpected MCP process frame');
        }
        length = Buffer.byteLength(buffer);
        if (length > maximum) throw fail('LIMIT', 'MCP process message exceeds limit');
      } catch (error) { this.rejectAll(error instanceof KodoError ? error : fail('PROTOCOL', 'invalid MCP process JSON')); void this.close().catch(() => {}); }
    });
    // Drain diagnostics without storing or returning potential credentials.
    let diagnosticBytes = 0;
    this.child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > maximum) { this.rejectAll(fail('LIMIT', 'MCP process diagnostic limit exceeded')); void this.close().catch(() => {}); }
    });
    this.child.stdin.on('error', () => this.rejectAll(fail('TRANSPORT', 'MCP process input closed')));
    this.child.on('error', () => { this.closed = true; this.rejectAll(fail('START', 'MCP process could not be started')); });
    this.child.on('close', () => { this.processClosed = true; this.closed = true; this.rejectAll(fail('CLOSED', 'MCP process exited')); void this.close().catch(() => {}); });
  }
  private rejectAll(error: unknown): void { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
  private write(message: RpcMessage): Promise<void> {
    if (this.closed) return Promise.reject(fail('CLOSED', 'MCP connection closed'));
    const text = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(text) > this.maximum) return Promise.reject(fail('LIMIT', 'MCP request exceeds message limit'));
    return new Promise((resolve, reject) => this.child.stdin.write(text, error => error ? reject(fail('TRANSPORT', 'MCP process input failed')) : resolve()));
  }
  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const id = ++this.sequence;
    let onAbort!: () => void;
    try {
      return await new Promise((resolve, reject) => {
        onAbort = (): void => { this.pending.delete(id); reject(fail('CANCELLED', 'MCP request cancelled')); void this.notify('notifications/cancelled', { requestId: id, reason: 'Request cancelled' }).catch(() => {}); };
        this.pending.set(id, { resolve, reject });
        signal.addEventListener('abort', onAbort, { once: true });
        void this.write({ jsonrpc: '2.0', id, method, params }).catch(error => { this.pending.delete(id); reject(error); });
      });
    } catch (error) {
      // A sandboxed server must not continue a cancelled mutation in the
      // background. Its whole lifetime ends before cancellation is reported.
      if (signal.aborted && this.sandbox) await this.close();
      throw error;
    } finally { signal.removeEventListener('abort', onAbort); }
  }
  async notify(method: string, params?: unknown): Promise<void> { await this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); }
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.rejectAll(fail('CLOSED', 'MCP connection closed'));
    this.child.stdin.destroy();
    this.closePromise = new Promise<void>((resolve, reject) => {
      // The detached POSIX process group may still contain descendants after
      // its leader exits. Kill the group even when its close event was seen.
      if (process.platform !== 'win32' && this.child.pid) {
        try { process.kill(-this.child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { reject(fail('STOP', 'MCP process tree termination failed')); return; } }
      }
      if (this.processClosed) { resolve(); return; }
      const timer = setTimeout(() => { this.child.kill('SIGKILL'); reject(fail('STOP', 'MCP process termination could not be confirmed')); }, 2000);
      this.child.once('close', () => { clearTimeout(timer); resolve(); });
      if (!this.child.pid) { clearTimeout(timer); resolve(); return; }
      if (process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => { this.child.kill('SIGKILL'); clearTimeout(timer); reject(fail('STOP', 'MCP process tree termination failed')); });
          killer.on('exit', code => { if (code && this.child.exitCode === null) { this.child.kill('SIGKILL'); clearTimeout(timer); reject(fail('STOP', 'MCP process tree termination could not be confirmed')); } });
        } catch { this.child.kill('SIGKILL'); clearTimeout(timer); reject(fail('STOP', 'MCP process tree termination failed')); }
      }
    }).then(async () => {
      try { await this.sandbox?.cleanup(); }
      catch (error) { if (error instanceof KodoError) throw error; throw fail('CLEANUP', 'MCP sandbox cleanup failed'); }
    });
    return this.closePromise;
  }
}
