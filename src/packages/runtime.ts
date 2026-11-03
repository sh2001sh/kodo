import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { createSandbox } from '../sandbox/execute.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { validateSandboxNetworkAllowlist, validateSandboxResources } from '../sandbox/policy.js';
import { loadSkill } from '../extensions/skills.js';
import type { Skill } from '../extensions/skills.js';
import type { McpConfig } from '../extensions/mcp.js';
import { defaultBudget, KodoError } from '../runtime/types.js';
import type { Card, FileScope, Permission, Run, Session } from '../runtime/types.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolRegistration } from '../tools/registry.js';
import { digest } from '../storage/index.js';
import { inspectInstalledPackage } from './archive.js';
import type { InstalledPackage, PackageMcp } from './schema.js';
import { packageWorkerSource } from './worker.js';

export interface PackageHost {
  /** Effective host ceilings, independent of any package's requested stdio authorization. */
  readonly packageResources?: SandboxPolicy['resources'];
  registerTool(tool: ToolRegistration): void;
  registerSkills(skills: readonly Skill[]): void;
  connectMcp(config: McpConfig, signal?: AbortSignal): Promise<unknown>;
  registerCard(card: Card): void;
  /** Applications can stage all registrations before committing them atomically. */
  activatePackage?(installed: InstalledPackage, options: PackageActivationOptions): Promise<Card>;
  preflightPackage?(resources: { tools: readonly ToolRegistration[]; skills: readonly Skill[]; card: Card; mcp: readonly PackageMcp[] }): void;
}
/** These values belong to the local host; they are never written into distributable resources. */
export interface PackageBindings {
  mcp?: Record<string, { url?: string; headers?: Record<string, { env: string }>; env?: Record<string, { env: string }> }>;
}
export interface PackageVerification { passed: boolean; evidence: string }
export interface PackageActivationOptions {
  workspace: string;
  scope?: FileScope;
  /** Private host storage and other forbidden paths, independently of model file scopes. */
  deny?: string[];
  /** Absolute private host resources, resolved again for each run workspace. */
  privatePaths?: string[];
  /** Host-wide ceilings for all package child processes; stdio limits may only tighten them. */
  resources?: SandboxPolicy['resources'];
  /** Explicit host authorization for stdio servers, whose lifetime spans tool calls. */
  stdio?: { write?: boolean } & SandboxPolicy;
  bindings?: PackageBindings;
  signal?: AbortSignal;
  preparedRoot?: string;
  preparedDigest?: string;
  verifyExamples?: (input: { installed: InstalledPackage; card: Card; tools: readonly ToolRegistration[]; skills: readonly Skill[]; signal?: AbortSignal }) => PackageVerification | Promise<PackageVerification>;
}
interface ToolDescriptor {
  format: 'kodo-tool/v1'; name: string; description: string; parameters: Record<string, unknown>;
  permission: 'read' | 'write' | 'exec'; effect: 'read' | 'write'; version?: string;
}
const descriptorValidator = new Ajv({ allErrors: true }).compile({
  type: 'object', additionalProperties: false, required: ['format', 'name', 'description', 'parameters', 'permission', 'effect'],
  properties: { format: { const: 'kodo-tool/v1' }, name: { type: 'string' }, description: { type: 'string' }, parameters: { type: 'object' }, permission: { enum: ['read', 'write', 'exec'] }, effect: { enum: ['read', 'write'] }, version: { type: 'string' } },
});
const error = (message: string): KodoError => new KodoError('PACKAGE_ACTIVATION', message);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Supported requirement grammar is explicit and unknown forms fail closed. */
export function nodeRequirementMatches(requirement: string, version = process.versions.node): boolean {
  const actual = version.replace(/^v/, '').split('.').map(Number);
  return requirement.trim().split(/\s*\|\|\s*/).some(branch => branch.trim().split(/\s+/).every(term => {
    const match = /^(>=|<=|>|<|=|\^|~)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(term);
    if (!match) return false;
    const expected = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
    const compare = actual.reduce((result, value, index) => result || Math.sign(value - expected[index]!), 0);
    switch (match[1]) {
      case '>=': return compare >= 0;
      case '<=': return compare <= 0;
      case '>': return compare > 0;
      case '<': return compare < 0;
      case '^': return compare >= 0 && actual[0] === expected[0] && (expected[0] !== 0 || actual[1] === expected[1]) && (expected[0] !== 0 || expected[1] !== 0 || actual[2] === expected[2]);
      case '~': return compare >= 0 && actual[0] === expected[0] && (match[3] === undefined || actual[1] === expected[1]);
      default: return actual[0] === expected[0] && (match[3] === undefined || actual[1] === expected[1]) && (match[4] === undefined || actual[2] === expected[2]);
    }
  }));
}
export function packageCompatibility(installed: InstalledPackage): string[] {
  const requirements = installed.manifest.requirements;
  const reasons: string[] = [];
  if (requirements?.node && !nodeRequirementMatches(requirements.node)) reasons.push(`Node ${requirements.node} required`);
  if (requirements?.platforms && !requirements.platforms.includes(process.platform)) reasons.push(`platform ${process.platform} is unsupported`);
  if (requirements?.arch && !requirements.arch.includes(process.arch)) reasons.push(`architecture ${process.arch} is unsupported`);
  return reasons;
}

export async function preparedTreeDigest(root: string): Promise<string> {
  const files: { path: string; hash?: string; link?: string }[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name); const info = await lstat(file); const relative = path.relative(root, file).replaceAll('\\', '/');
      if (info.isSymbolicLink()) {
        const target = await readlink(file); const resolved = path.resolve(directory, target); const within = path.relative(root, resolved);
        if (path.isAbsolute(target) || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw error('prepared dependency symlink escapes its immutable tree');
        files.push({ path: relative, link: target });
      } else if (info.isDirectory()) await visit(file);
      else if (info.isFile() && info.nlink === 1) files.push({ path: relative, hash: createHash('sha256').update(await readFile(file)).digest('hex') });
      else throw error('prepared dependencies contain a special file or hard link');
    }
  };
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw error('prepared dependency root must be a regular directory');
  await visit(root); return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
function canonicalResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalResult);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonicalResult(item)]));
  return value;
}
async function privateDeny(workspace: string, values: readonly string[] = []): Promise<string[]> {
  const root = await realpath(workspace); const denied: string[] = [];
  for (const value of values) {
    if (!path.isAbsolute(value)) throw error('private host resource paths must be absolute');
    const target = await realpath(value); const relative = path.relative(root, target); const parent = path.relative(target, root);
    if (!parent || (parent !== '..' && !parent.startsWith(`..${path.sep}`) && !path.isAbsolute(parent))) throw error('execution workspace is inside private host storage');
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) denied.push(relative);
  }
  return denied;
}
/** Deterministic offline fixtures for package custom tools; arbitrary prose requires a host verifier. */
export function verifyToolExamples(options: { workspace: string; scope?: FileScope; permissions?: Permission[]; signal?: AbortSignal }): NonNullable<PackageActivationOptions['verifyExamples']> {
  return async ({ installed, card, tools, signal: activationSignal }) => {
    const registry = new ToolRegistry(); for (const tool of tools) registry.register(tool);
    const permissions = options.permissions ?? ['read'];
    const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : []), ...(activationSignal ? [activationSignal] : [])]);
    let checked = 0;
    for (const example of installed.manifest.examples ?? []) {
      signal.throwIfAborted();
      let request: unknown; let expected: unknown;
      try { request = JSON.parse(example.input); expected = JSON.parse(example.expected ?? ''); }
      catch { throw error('offline examples require JSON input {tool,arguments} and JSON expected results'); }
      if (!record(request) || Object.keys(request).some(key => !['tool', 'arguments'].includes(key)) || typeof request.tool !== 'string' || !record(request.arguments)) throw error('offline example input must contain tool and arguments');
      const tool = registry.get(request.tool);
      if (!tool || !card.tools.includes(tool.name)) throw error('offline example references an unavailable or unauthorized package custom tool');
      if (!permissions.includes(tool.permission) || (tool.effect === 'write' && !permissions.includes('write'))) throw error('offline example needs additional explicit host permissions');
      if (!tool.validate(request.arguments)) throw error('offline example arguments do not match the tool schema');
      const id = `package-example-${randomUUID()}`; const createdAt = new Date().toISOString();
      const session: Session = { id, workspace: options.workspace, permissions, budget: { ...defaultBudget, maxContextTokens: 8192, maxOutputTokens: 1024 }, tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, createdAt };
      const run: Run = { id, sessionId: id, objective: example.input, status: 'running', card, binding: { model: 'offline-package-fixture', baseURL: '', apiKeyEnv: '' }, contextRef: '', step: 0, cancelRequested: false, createdAt, permissions, ...(options.scope ? { scope: options.scope } : {}) };
      const result = await tool.execute({ run, session, signal, markEffectStarted() {} }, request.arguments);
      if (JSON.stringify(canonicalResult(result)) !== JSON.stringify(canonicalResult(expected))) throw error(`offline example ${example.name} produced a different result`);
      checked++;
    }
    return { passed: true, evidence: `${checked} package custom-tool examples passed through the OS sandbox` };
  };
}

export function validatePackageBindings(value: unknown): asserts value is PackageBindings {
  if (!record(value) || Object.keys(value).some(key => key !== 'mcp') || (value.mcp !== undefined && !record(value.mcp))) throw error('invalid local package bindings');
  for (const [id, entry] of Object.entries(value.mcp ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,19}$/.test(id) || !record(entry) || Object.keys(entry).some(key => !['url', 'headers', 'env'].includes(key))) throw error('invalid local MCP binding');
    if (entry.url !== undefined) {
      try { const endpoint = new URL(entry.url as string); if (typeof entry.url !== 'string' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) throw new Error(); }
      catch { throw error('local endpoint requires HTTPS or loopback HTTP without embedded credentials'); }
    }
    for (const field of ['headers', 'env']) {
      const references = entry[field];
      if (references === undefined) continue;
      if (!record(references)) throw error('credential bindings must use environment references');
      for (const [name, reference] of Object.entries(references)) if (!(field === 'headers' ? /^[A-Za-z0-9-]+$/ : /^[A-Za-z_][A-Za-z0-9_]*$/).test(name) || !record(reference) || Object.keys(reference).length !== 1 || typeof reference.env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.env)) throw error('credential bindings must use environment references');
    }
  }
}

export async function packageToolDescriptors(installed: InstalledPackage): Promise<ToolDescriptor[]> {
  const result: ToolDescriptor[] = [];
  const registry = new ToolRegistry();
  for (const resource of installed.manifest.resources?.tools ?? []) {
    let value: unknown;
    try { value = JSON.parse(await readFile(path.join(installed.root, resource.descriptor), 'utf8')); }
    catch { throw error('tool descriptor must contain valid JSON'); }
    if (!descriptorValidator(value) || (value as ToolDescriptor).name !== resource.name) throw error('invalid kodo-tool/v1 descriptor or resource name mismatch');
    const descriptor = value as ToolDescriptor;
    registry.register({ ...descriptor, execute: () => null });
    result.push(descriptor);
  }
  return result;
}

export function missingPackageBindings(installed: InstalledPackage, bindings: PackageBindings = {}): string[] {
  const missing: string[] = [];
  for (const server of installed.manifest.resources?.mcp ?? []) {
    const local = bindings.mcp?.[server.id];
    if (server.transport === 'http' && !local?.url) missing.push(`mcp.${server.id}.url`);
    const references = server.transport === 'stdio' ? local?.env : local?.headers;
    const template = server.transport === 'stdio' ? server.env : server.headers;
    for (const name of Object.keys(template ?? {})) if (!references?.[name]) missing.push(`mcp.${server.id}.${server.transport === 'stdio' ? 'env' : 'headers'}.${name}`);
    for (const reference of Object.values(references ?? {})) if (!process.env[reference.env]) missing.push(`env:${reference.env}`);
  }
  return [...new Set(missing)];
}

/** Import and inspection never call this function: activation is a separate explicit host action. */
export async function activatePackage(host: PackageHost, original: InstalledPackage, options: PackageActivationOptions): Promise<Card> {
  options.signal?.throwIfAborted();
  const hostResources = host.packageResources;
  validateSandboxResources(hostResources);
  validateSandboxResources(options.resources);
  validateSandboxResources(options.stdio?.resources);
  validateSandboxNetworkAllowlist(options.stdio?.networkAllowlist);
  const ceilings: NonNullable<SandboxPolicy['resources']> = {};
  for (const key of ['memoryBytes', 'maxProcesses'] as const) {
    const limits = [hostResources?.[key], options.resources?.[key], options.stdio?.resources?.[key]].filter((limit): limit is number => limit !== undefined);
    if (limits.length) ceilings[key] = Math.min(...limits);
  }
  const resources = Object.keys(ceilings).length ? ceilings : undefined;
  options = { ...options, resources, ...(options.stdio ? { stdio: structuredClone(options.stdio) } : {}) };
  const installed = await inspectInstalledPackage(original.root);
  if (installed.digest !== original.digest) throw error('installed package identity changed');
  const incompatible = packageCompatibility(installed);
  if (incompatible.length) throw error(incompatible.join('; '));
  validatePackageBindings(options.bindings ?? {});
  const missing = missingPackageBindings(installed, options.bindings);
  if (missing.length) throw error(`missing local configuration: ${missing.join(', ')}`);
  if (!path.isAbsolute(options.workspace)) throw error('activation workspace must be absolute');
  const activationDeny = [...(options.deny ?? []), ...await privateDeny(options.workspace, options.privatePaths)];
  if ((installed.manifest.resources?.mcp ?? []).some(server => server.transport === 'stdio') && !options.stdio) throw error('stdio MCP requires explicit host sandbox authorization');
  const descriptors = await packageToolDescriptors(installed);
  const executionRoot = options.preparedRoot ?? installed.root;
  if (Object.keys(installed.manifest.requirements?.dependencies ?? {}).length && !options.preparedRoot) throw error('dependencies must be explicitly prepared before activation');
  // Derived dependency trees may not replace the verified source files.
  if (executionRoot !== installed.root) for (const file of installed.manifest.files) {
    const bytes = await readFile(path.join(executionRoot, file.path));
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw error('prepared dependency tree has changed package source files');
  }
  const dependencyDigest = executionRoot === installed.root ? undefined : await preparedTreeDigest(executionRoot);
  if (options.preparedDigest && options.preparedDigest !== dependencyDigest) throw error('prepared dependency content changed before activation');
  const skills = await Promise.all((installed.manifest.resources?.skills ?? []).map(async resource => {
    const skill = await loadSkill(path.join(installed.root, resource.entry));
    if (skill.id !== resource.id) throw error('skill ID differs from the resource declaration');
    return skill;
  }));
  const tools: ToolRegistration[] = descriptors.map((descriptor, index) => {
    const entry = path.join(executionRoot, installed.manifest.resources!.tools![index]!.entry);
    const resourceIdentity = resources ? { memoryBytes: resources.memoryBytes ?? null, maxProcesses: resources.maxProcesses ?? null } : null;
    return { ...descriptor, version: digest(`${installed.digest}:${descriptor.version ?? ''}:${dependencyDigest ?? ''}${resourceIdentity ? `:${JSON.stringify(resourceIdentity)}` : ''}`), execute: async ({ run, session, signal }, args) => {
      signal.throwIfAborted();
      if ((await inspectInstalledPackage(installed.root)).digest !== installed.digest) throw error('installed package identity changed before execution');
      if (dependencyDigest && await preparedTreeDigest(executionRoot) !== dependencyDigest) throw error('prepared dependency content changed before execution');
      if (descriptor.effect === 'write' && (!session.permissions.includes('write') || !(run.permissions ?? session.permissions).includes('write'))) throw error('sandboxed write tools require an explicit write grant');
      const deny = [...(options.deny ?? []), ...await privateDeny(session.workspace, options.privatePaths)];
      const sandbox = createSandbox({ workspace: session.workspace, ...(run.scope ? { scope: run.scope } : {}), ...(deny.length ? { deny } : {}), write: descriptor.effect === 'write', network: 'none', ...(resources ? { resources } : {}), readOnlyPaths: [executionRoot] });
      const request = JSON.stringify({ arguments: args, context: { workspace: session.workspace, runId: run.id, sessionId: session.id } });
      if (Buffer.byteLength(request) > 1024 * 1024) throw error('sandboxed tool request exceeds 1 MiB');
      const output = await sandbox.run(process.execPath, ['--input-type=module', '-e', packageWorkerSource, entry], { cwd: session.workspace, stdin: request, signal });
      if (output.cancelled || signal.aborted) throw error('sandboxed tool execution was cancelled');
      if (output.exitCode !== 0 || output.truncated || output.outputLimitExceeded || output.signal) throw error('sandboxed tool execution failed or exceeded its output limit');
      try {
        const result = JSON.parse(output.stdout) as { protocol?: string; result?: unknown; error?: unknown };
        if (result.protocol !== 'kodo-tool-result/v1' || result.error || !Object.hasOwn(result, 'result')) throw new Error();
        return result.result;
      } catch { throw error('sandboxed tool returned an invalid JSON response'); }
    } };
  });
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  host.preflightPackage?.({ card: installed.card, tools, skills, mcp: installed.manifest.resources?.mcp ?? [] });
  if (installed.manifest.examples?.length) {
    if (!options.verifyExamples) throw error('package examples require an explicit host verifier before activation');
    const verification = await options.verifyExamples({ installed, card: installed.card, tools, skills, ...(options.signal ? { signal: options.signal } : {}) });
    if (!verification || verification.passed !== true || typeof verification.evidence !== 'string' || !verification.evidence.trim()) throw error('package examples did not pass host verification');
  }
  // Validate every local resource and example before changing host registrations.
  // Host implementations should preflight capability collisions before this call.
  for (const server of installed.manifest.resources?.mcp ?? []) {
    const local = options.bindings?.mcp?.[server.id];
    const config: McpConfig = server.transport === 'http'
      ? { id: server.id, transport: 'http', url: local!.url!, tools: server.tools, ...(local?.headers ? { headers: local.headers } : {}) }
      : { id: server.id, transport: 'stdio', command: process.execPath, args: [path.join(executionRoot, server.entry), ...(server.args ?? [])], cwd: options.workspace, tools: server.tools, ...(local?.env ? { env: local.env } : {}), sandbox: { workspace: options.workspace, ...(options.scope ? { scope: options.scope } : {}), ...(activationDeny.length ? { deny: activationDeny } : {}), write: options.stdio!.write ?? false, network: options.stdio!.network ?? 'none', ...(resources ? { resources } : {}), readOnlyPaths: [executionRoot] } };
    await host.connectMcp(config, options.signal);
  }
  for (const tool of tools) host.registerTool(tool);
  if (skills.length) host.registerSkills(skills);
  host.registerCard(installed.card);
  return installed.card;
}
