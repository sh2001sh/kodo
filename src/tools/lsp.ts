import { spawn } from 'node:child_process';
import { open, realpath } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest } from '../storage/index.js';
import { assertFileScope } from '../runtime/scope.js';
import { KodoError } from '../runtime/types.js';
import { prepareSandboxCommand, sandboxEnvironment } from '../sandbox/index.js';
import type { PreparedSandbox, SandboxPolicy } from '../sandbox/index.js';
import type { ToolExecutionContext, ToolRegistration } from './registry.js';

export interface LspServerConfig {
  id: string;
  /** Trusted host command, never supplied or changed by a model. */
  program: string;
  args: string[];
  /** Extension including the dot -> language ID, for example { '.ts': 'typescript' }. */
  languages: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  readOnlyPaths?: string[];
}
export interface LspOptions {
  servers: LspServerConfig[];
  timeoutMs?: number;
  maxMessageBytes?: number;
  sandbox?: SandboxPolicy;
  /** Workspace-relative private resources denied to sandboxed servers. */
  deny?: string[];
  /** Absolute private host directories: protected by the API and denied to sandbox processes. */
  privatePaths?: string[];
  /** Runtime-owned data follows a restored backup; its protection role, not location, is pinned. */
  runtimeDirectory?: string;
}
type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
const protectedPart = (part: string): boolean => /^(?:\.git|\.kodo|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i.test(part);
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** One short-lived language server per operation avoids shared documents or cross-run cache disclosure. */
class StdioLsp {
  private readonly child: ReturnType<typeof spawn>;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(message: Rpc) => void>();
  private readonly closed: Promise<void>;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 0;
  private messages = 0;
  private outputBytes = 0;
  private failure?: Error;
  private exited = false;

  constructor(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, private readonly maximum: number, extraFiles: number[] = []) {
    try { this.child = spawn(program, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe', ...extraFiles] }); }
    catch { throw new KodoError('LSP_START', 'the host-configured language server could not start'); }
    this.closed = new Promise(resolve => this.child.once('close', () => { this.exited = true; this.fail(new KodoError('LSP_CLOSED', 'language server exited')); resolve(); }));
    this.child.once('error', () => this.fail(new KodoError('LSP_START', 'the host-configured language server could not start')));
    this.child.stdin!.on('error', () => this.fail(new KodoError('LSP_CLOSED', 'language server input closed')));
    // Always drain stderr, retaining none of its potentially sensitive contents.
    let stderrBytes = 0;
    this.child.stderr!.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > maximum) this.fail(new KodoError('LSP_LIMIT', 'language server stderr exceeded the output limit')); });
    this.child.stdout!.on('data', (chunk: Buffer) => this.consume(chunk));
  }
  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }
  private consume(chunk: Buffer): void {
    if (this.failure) return;
    try {
      this.outputBytes += chunk.length;
      if (this.outputBytes > 8 * this.maximum) throw new KodoError('LSP_LIMIT', 'language server exceeded the total output limit');
      // A chunk may hold multiple valid messages; parse before applying the residual buffer bound.
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const boundary = this.buffer.indexOf('\r\n\r\n');
        if (boundary < 0) { if (this.buffer.length > 8192) throw new KodoError('LSP_PROTOCOL', 'language server header exceeded 8192 bytes'); return; }
        if (boundary > 8192) throw new KodoError('LSP_PROTOCOL', 'language server header exceeded 8192 bytes');
        const headers = this.buffer.subarray(0, boundary).toString('ascii').split('\r\n');
        const lengths = headers.filter(header => /^Content-Length:/i.test(header));
        if (lengths.length !== 1 || !/^Content-Length:\s*[0-9]+\s*$/i.test(lengths[0]!)) throw new KodoError('LSP_PROTOCOL', 'language server Content-Length is invalid');
        const length = Number(lengths[0]!.split(':')[1]!.trim());
        if (!Number.isSafeInteger(length) || length < 1 || length > this.maximum) throw new KodoError('LSP_LIMIT', 'language server message exceeded the configured limit');
        const end = boundary + 4 + length;
        if (this.buffer.length < end) return;
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(boundary + 4, end)));
        this.buffer = this.buffer.subarray(end);
        if (!plain(value) || value.jsonrpc !== '2.0') throw new KodoError('LSP_PROTOCOL', 'language server emitted invalid JSON-RPC');
        if (++this.messages > 1000) throw new KodoError('LSP_LIMIT', 'language server exceeded 1000 messages per operation');
        this.dispatch(value as Rpc);
        if (!this.buffer.length) return;
      }
    } catch (error) { this.fail(error instanceof KodoError ? error : new KodoError('LSP_PROTOCOL', 'language server emitted invalid JSON or UTF-8')); }
  }
  private dispatch(message: Rpc): void {
    if (message.method && message.id !== undefined) {
      if (message.method === 'workspace/configuration') {
        const items = plain(message.params) && Array.isArray(message.params.items) ? message.params.items : [];
        this.send({ jsonrpc: '2.0', id: message.id, result: items.slice(0, 100).map(() => null) });
      } else this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client method is not supported' } });
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new KodoError('LSP_SERVER_ERROR', `language server rejected the request (${message.error.code}): ${String(message.error.message).slice(0, 300)}`));
      else if ('result' in message) pending.resolve(message.result);
      else pending.reject(new KodoError('LSP_PROTOCOL', 'language server response has neither result nor error'));
      return;
    }
    for (const listener of this.listeners) listener(message);
  }
  private send(message: Rpc): void {
    if (this.failure) throw this.failure;
    const body = JSON.stringify(message);
    const length = Buffer.byteLength(body);
    if (length > this.maximum) throw new KodoError('LSP_LIMIT', 'language server request exceeded the message limit');
    this.child.stdin!.write(`Content-Length: ${length}\r\n\r\n${body}`);
  }
  notify(method: string, params?: unknown): void { this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }); }
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const clear = (): void => signal.removeEventListener('abort', abort);
      const abort = (): void => {
        this.pending.delete(id);
        clear();
        if (!this.failure) this.notify('$/cancelRequest', { id });
        reject(new KodoError('LSP_CANCELLED', 'language server request was cancelled or reached its deadline'));
      };
      this.pending.set(id, { resolve: value => { clear(); resolve(value); }, reject: error => { clear(); reject(error); } });
      signal.addEventListener('abort', abort, { once: true });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clear(); this.pending.delete(id); reject(error); }
    });
  }
  onNotification(listener: (message: Rpc) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(): Promise<'graceful' | 'terminated'> {
    let graceful = false;
    if (!this.failure) {
      try { await this.request('shutdown', null, AbortSignal.timeout(300)); this.notify('exit'); graceful = true; }
      catch { graceful = false; } // Report forced shutdown explicitly in the tool result.
    }
    if (!this.exited && graceful && await this.waitForClose(300)) return 'graceful';
    if (!this.exited && this.child.pid) {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await new Promise<void>(resolve => {
          const deadline = setTimeout(() => { killer.kill(); this.child.kill(); resolve(); }, 2000);
          killer.once('close', () => { clearTimeout(deadline); resolve(); });
          killer.once('error', () => { clearTimeout(deadline); this.child.kill(); resolve(); });
        });
      } else {
        try { process.kill(-this.child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new KodoError('LSP_STOP', 'could not terminate language server process group'); }
      }
    }
    if (!this.exited && !await this.waitForClose(2000)) throw new KodoError('LSP_STOP', 'language server did not finish within the cleanup deadline');
    return graceful && !this.failure ? 'graceful' : 'terminated';
  }
  private async waitForClose(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([this.closed.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  }
}

const inside = (root: string, target: string): boolean => { const relative = path.relative(root, target); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
function assertPrivatePaths(target: string, privatePaths: string[]): void {
  let canonical = target;
  try { canonical = realpathSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (privatePaths.some(root => inside(root, canonical))) throw new KodoError('LSP_PATH', 'language server cannot access private host storage');
}

async function document(context: ToolExecutionContext, input: string, privatePaths: string[]): Promise<{ file: string; uri: string; text: string }> {
  if (path.isAbsolute(input) || input.includes('\0') || input.replaceAll('\\', '/').split('/').some(part => part === '..' || protectedPart(part))) throw new KodoError('LSP_PATH', 'document path must be an unprotected workspace-relative file');
  const file = await realpath(path.resolve(context.session.workspace, input));
  assertPrivatePaths(file, privatePaths);
  if (path.relative(context.session.workspace, file).split(path.sep).some(protectedPart)) throw new KodoError('LSP_PATH', 'document resolves to a protected path');
  assertFileScope(context.run.scope, 'read', context.session.workspace, file);
  const handle = await open(file, 'r');
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new KodoError('LSP_FILE', 'language server documents must be regular UTF-8 files up to 1 MiB');
    const buffer = Buffer.alloc(Math.min(info.size + 1, 1024 * 1024 + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      context.signal.throwIfAborted();
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > info.size) throw new KodoError('LSP_FILE', 'document changed while being read; retry');
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead)); }
    catch { throw new KodoError('LSP_FILE', 'language server document must use UTF-8'); }
    if (text.includes('\0')) throw new KodoError('LSP_FILE', 'binary documents are unsupported');
  } finally { await handle.close(); }
  context.signal.throwIfAborted();
  return { file, uri: pathToFileURL(file).href, text };
}

function checkResultPaths(value: unknown, context: ToolExecutionContext, privatePaths: string[], depth = 0): void {
  if (depth > 100) throw new KodoError('LSP_LIMIT', 'language server result is nested too deeply');
  if (Array.isArray(value)) { for (const item of value) checkResultPaths(item, context, privatePaths, depth + 1); return; }
  if (!plain(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (['uri', 'targetUri'].includes(key) && typeof item === 'string') {
      let file: string;
      try { file = fileURLToPath(item); }
      catch { throw new KodoError('LSP_PATH', 'language server returned a non-file location'); }
      assertPrivatePaths(file, privatePaths);
      if (path.relative(context.session.workspace, file).split(path.sep).some(protectedPart)) throw new KodoError('LSP_PATH', 'language server returned a protected location');
      assertFileScope(context.run.scope, 'read', context.session.workspace, file);
    }
    checkResultPaths(item, context, privatePaths, depth + 1);
  }
}

/** Register only servers explicitly approved by the host. There is no model-selected executable. */
export function lspTools(options: LspOptions): ToolRegistration[] {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maximum = options.maxMessageBytes ?? 2 * 1024 * 1024;
  if (!Array.isArray(options.servers) || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000 || !Number.isInteger(maximum) || maximum < 1024 || maximum > 8 * 1024 * 1024) throw new KodoError('LSP_CONFIG', 'provide a language server configuration and bounded timeout/message limits');
  const servers = structuredClone(options.servers);
  const privatePaths = (options.privatePaths ?? []).map(directory => realpathSync(directory));
  const runtimeDirectory = options.runtimeDirectory === undefined ? undefined : realpathSync(options.runtimeDirectory);
  const protectedPaths = [...privatePaths, ...(runtimeDirectory ? [runtimeDirectory] : [])];
  const sandbox = options.sandbox ? { ...structuredClone(options.sandbox), network: options.sandbox.network ?? 'none' } : undefined;
  const deny = options.deny ? [...options.deny] : [];
  const extensions = new Set<string>();
  const ids = new Set<string>();
  for (const server of servers) {
    if (!server || !/^[A-Za-z0-9_-]{1,64}$/.test(server.id) || ids.has(server.id) || typeof server.program !== 'string' || !server.program || server.program.includes('\0') || !Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !plain(server.languages) || !Object.keys(server.languages).length) throw new KodoError('LSP_CONFIG', 'language servers need unique IDs, trusted commands and language extension mappings');
    ids.add(server.id);
    for (const [extension, language] of Object.entries(server.languages)) {
      if (!/^\.[A-Za-z0-9_-]{1,32}$/.test(extension) || extensions.has(extension.toLowerCase()) || typeof language !== 'string' || !language || language.length > 100) throw new KodoError('LSP_CONFIG', 'language extensions must be unique and map to nonempty language IDs');
      extensions.add(extension.toLowerCase());
    }
  }
  const version = digest(JSON.stringify({ protocol: 1, servers, timeoutMs, maximum, sandbox, deny, privatePaths, protectsRuntimeDirectory: runtimeDirectory !== undefined }));
  const methods = { hover: 'textDocument/hover', definition: 'textDocument/definition', references: 'textDocument/references', symbols: 'textDocument/documentSymbol', diagnostics: 'textDocument/diagnostic' };
  return Object.entries(methods).map(([operation, method]) => {
    const positioned = ['hover', 'definition', 'references'].includes(operation);
    return {
      name: `lsp.${operation}`, version, permission: 'read', effect: 'read', available: servers.length > 0,
      description: `Read ${operation} from a host-approved language server for a workspace file. Positions use zero-based UTF-16 line/character. Files are loaded fresh per call; each server is initialized, then shut down. Never edits files or runs model-provided commands. ${sandbox ? 'OS sandbox enforces read scope and disables writes.' : 'The host-approved server is a trusted local process; API path checks do not isolate its filesystem or network access.'} Registered languages: ${JSON.stringify(servers.map(server => ({ id: server.id, languages: server.languages })))}`,
      parameters: { type: 'object', additionalProperties: false, required: positioned ? ['path', 'line', 'character'] : ['path'], properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        ...(positioned ? { line: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, character: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } } : {}),
      } },
      async execute(context, args) {
        if (!servers.length) throw new KodoError('LSP_UNAVAILABLE', 'no host-approved language servers are configured');
        const source = await document(context, args.path as string, protectedPaths);
        const extension = path.extname(source.file).toLowerCase();
        const server = servers.find(item => Object.keys(item.languages).some(key => key.toLowerCase() === extension));
        if (!server) throw new KodoError('LSP_LANGUAGE', 'no host-approved language server is configured for this file extension');
        if (positioned) {
          const lines = source.text.split('\n');
          const line = args.line as number;
          const character = args.character as number;
          const text = lines[line]?.replace(/\r$/, '');
          if (text === undefined || character > text.length || (character > 0 && /[\uD800-\uDBFF]/.test(text[character - 1]!) && /[\uDC00-\uDFFF]/.test(text[character] ?? ''))) throw new KodoError('LSP_POSITION', 'position must identify a UTF-16 character boundary within the document');
        }
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
        const env = sandboxEnvironment();
        if (protectedPaths.some(directory => inside(directory, context.session.workspace))) throw new KodoError('LSP_PATH', 'workspace cannot be private host storage');
        const privateDeny = protectedPaths.filter(directory => inside(context.session.workspace, directory)).map(directory => path.relative(context.session.workspace, directory));
        const prepared: PreparedSandbox | undefined = sandbox ? await prepareSandboxCommand(server.program, server.args, { ...sandbox, workspace: context.session.workspace, scope: context.run.scope, write: false, readOnlyPaths: server.readOnlyPaths, deny: [...deny, ...privateDeny] }) : undefined;
        let client: StdioLsp | undefined;
        try {
          signal.throwIfAborted();
          client = new StdioLsp(prepared?.program ?? server.program, prepared?.args ?? server.args, prepared?.cwd ?? context.session.workspace, prepared?.env ?? env, maximum, prepared?.extraFiles);
          const initialized = await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(context.session.workspace).href, workspaceFolders: [{ uri: pathToFileURL(context.session.workspace).href, name: path.basename(context.session.workspace) }], capabilities: { textDocument: { synchronization: { didSave: false }, diagnostic: {} }, workspace: { configuration: false } }, ...(server.initializationOptions ? { initializationOptions: server.initializationOptions } : {}) }, signal);
          client.notify('initialized', {});
          let diagnostics: unknown;
          const unsubscribe = client.onNotification(message => { if (message.method === 'textDocument/publishDiagnostics' && plain(message.params) && message.params.uri === source.uri) diagnostics = message.params.diagnostics; });
          const languageId = Object.entries(server.languages).find(([key]) => key.toLowerCase() === extension)![1];
          client.notify('textDocument/didOpen', { textDocument: { uri: source.uri, languageId, version: 1, text: source.text } });
          let result: unknown;
          try {
            const capabilities = plain(initialized) && plain(initialized.capabilities) ? initialized.capabilities : {};
            if (operation === 'diagnostics' && !capabilities.diagnosticProvider) {
              if (diagnostics === undefined) diagnostics = await new Promise<unknown>((resolve, reject) => {
                const cancel = (): void => { stop(); reject(new KodoError('LSP_DIAGNOSTICS', 'server did not publish diagnostics before cancellation or the deadline')); };
                const stop = (): void => { signal.removeEventListener('abort', cancel); remove(); };
                const remove = client!.onNotification(message => { if (message.method === 'textDocument/publishDiagnostics' && plain(message.params) && message.params.uri === source.uri) { stop(); resolve(message.params.diagnostics); } });
                signal.addEventListener('abort', cancel, { once: true });
                if (signal.aborted) cancel();
              });
              result = { kind: 'full', items: diagnostics };
            } else result = await client.request(method, { textDocument: { uri: source.uri }, ...(positioned ? { position: { line: args.line, character: args.character } } : {}), ...(operation === 'references' ? { context: { includeDeclaration: true } } : {}) }, signal);
          } finally { unsubscribe(); }
          checkResultPaths(result, context, protectedPaths);
          client.notify('textDocument/didClose', { textDocument: { uri: source.uri } });
          const shutdown = await client.close();
          client = undefined;
          return { serverId: server.id, path: args.path, operation, result, shutdown };
        } finally {
          try { await client?.close(); }
          finally { await prepared?.cleanup(); }
        }
      },
    } satisfies ToolRegistration;
  });
}
