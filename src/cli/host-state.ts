import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { KodoError } from '../runtime/types.js';
import type { AgentFactors } from '../runtime/agent-factors.js';
import { validateAssemblyPolicy, validateCompactionPolicy } from '../runtime/context.js';
import type { AssemblyPolicy, CompactionPolicy } from '../runtime/context.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { validateSandboxNetworkAllowlist, validateSandboxResources } from '../sandbox/policy.js';
import { createWebFetchTool } from '../tools/webfetch.js';
import type { WebFetchPolicy } from '../tools/webfetch.js';
import { lspTools } from '../tools/lsp.js';
import type { LspOptions } from '../tools/lsp.js';
import { createVerificationTool } from '../tools/verify.js';
import type { VerificationPolicy } from '../tools/verify.js';

export interface CliToolPolicy { shellProgram?: string; webFetch?: WebFetchPolicy; lsp?: LspOptions }

export interface CliAgentPolicy {
  agentFactors?: AgentFactors;
}

export function validateAgentPolicy(policy: CliAgentPolicy | undefined): void {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['agentFactors'].includes(key))) throw new KodoError('CLI_HOST_STATE', 'invalid agent policy');
  if (policy.agentFactors !== undefined && (!policy.agentFactors || typeof policy.agentFactors !== 'object' || Array.isArray(policy.agentFactors) || Object.entries(policy.agentFactors).some(([key, value]) => !['A', 'B', 'C', 'D', 'E'].includes(key) || typeof value !== 'boolean'))) throw new KodoError('ARGUMENTS', 'agent factors must contain boolean A, B, C, D and E values');
}

export function cliAgentPolicy(values: Record<string, unknown>): CliAgentPolicy | undefined {
  const policy: CliAgentPolicy = {};
  if (values['agent-factors'] !== undefined) {
    const factors = values['agent-factors'];
    if (typeof factors !== 'string' || !/^(?:none|[ABCDE](?:,[ABCDE])*)$/.test(factors)) throw new KodoError('ARGUMENTS', '--agent-factors must be none or comma-separated A,B,C,D,E');
    policy.agentFactors = { A: factors.split(',').includes('A'), B: factors.split(',').includes('B'), C: factors.split(',').includes('C'), D: factors.split(',').includes('D'), E: factors.split(',').includes('E') };
  }
  validateAgentPolicy(policy);
  return Object.keys(policy).length ? policy : undefined;
}

export interface CliHostSession {
  sessionId: string;
  runIds: string[];
  questionIds: string[];
  /** Sessions with interactive tool approvals must execute through the TUI gate. */
  tuiApproval?: boolean;
  sandbox?: SandboxPolicy;
  tools?: CliToolPolicy;
  compaction?: CompactionPolicy | false;
  assembly?: AssemblyPolicy;
  memory?: boolean;
  lazyTools?: boolean;
  verification?: VerificationPolicy;
  agents?: CliAgentPolicy;
  package?: { id: string; version: string; digest: string; stdioWrite: boolean; stdioNetwork: 'none' | 'allow' };
}
const legacyMethodFields = ['inlineMethods', 'methodUnloading', 'methodToolView'];
/** Local host bindings are deliberately kept out of portable package contents. */
export function readHostState(directory: string): CliHostSession[] {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path.join(directory, 'cli-host.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new KodoError('CLI_HOST_STATE', 'cannot read local execution bindings'); }
  // Sessions saved with the deleted inline-method policy cannot resume under this build.
  if (Array.isArray(parsed) && parsed.some(item => item && typeof item === 'object' && legacyMethodFields.some(key => key in item))) throw new KodoError('CLI_HOST_STATE', 'saved inline-method policy (inlineMethods, methodUnloading, methodToolView) belongs to deleted method stages; start a new task');
  const fields = new Set(['sessionId', 'runIds', 'questionIds', 'tuiApproval', 'sandbox', 'tools', 'compaction', 'assembly', 'memory', 'lazyTools', 'verification', 'agents', 'package']);
  if (!Array.isArray(parsed) || parsed.some(item => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !fields.has(key)) || typeof item.sessionId !== 'string' || !Array.isArray(item.runIds) || item.runIds.some((id: unknown) => typeof id !== 'string') || !Array.isArray(item.questionIds) || item.questionIds.some((id: unknown) => typeof id !== 'string') || (item.sandbox && !['none', 'allow'].includes(item.sandbox.network)) || (item.package && (typeof item.package.id !== 'string' || typeof item.package.version !== 'string' || !/^[a-f0-9]{64}$/.test(item.package.digest) || typeof item.package.stdioWrite !== 'boolean' || !['none', 'allow'].includes(item.package.stdioNetwork))))) throw new KodoError('CLI_HOST_STATE', 'invalid local execution bindings');
  for (const item of parsed as CliHostSession[]) {
    if (item.tuiApproval !== undefined && typeof item.tuiApproval !== 'boolean') throw new KodoError('CLI_HOST_STATE', 'tuiApproval must be a boolean');
    if (item.sandbox) {
      if (Object.keys(item.sandbox).some(key => !['network', 'networkAllowlist', 'resources'].includes(key))) throw new KodoError('CLI_HOST_STATE', 'invalid persisted sandbox fields');
      validateSandboxResources(item.sandbox.resources); validateSandboxNetworkAllowlist(item.sandbox.networkAllowlist);
    }
    validateToolPolicy(item.tools);
    validateCompactionPolicy(item.compaction === false ? undefined : item.compaction);
    validateAssemblyPolicy(item.assembly);
    if ((item.memory !== undefined && typeof item.memory !== 'boolean') || (item.lazyTools !== undefined && typeof item.lazyTools !== 'boolean')) throw new KodoError('CLI_HOST_STATE', 'memory and lazyTools must be booleans');
    validateVerificationPolicy(item.verification);
    // Older host-state files may still carry the deleted agentRetention and
    // projectRoots policy fields. They are read-only history: drop them silently
    // instead of rejecting an otherwise resumable session.
    if (item.agents !== undefined) {
      const { agentRetention: _retention, projectRoots: _roots, ...remaining } = item.agents as CliAgentPolicy & Record<string, unknown>;
      void _retention; void _roots;
      validateAgentPolicy(remaining);
      item.agents = remaining;
    } else validateAgentPolicy(item.agents);
  }
  return parsed as CliHostSession[];
}
export function writeHostState(directory: string, sessions: CliHostSession[]): void {
  mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, 'cli-host.json');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sessions)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  renameSync(temporary, destination);
}

/** Tool configuration is trusted local host data; it is never read from model output. */
export function validateToolPolicy(policy: CliToolPolicy | undefined): void {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['shellProgram', 'webFetch', 'lsp'].includes(key))) throw new KodoError('CLI_HOST_STATE', 'invalid trusted tool policy');
  if (policy.shellProgram !== undefined && (typeof policy.shellProgram !== 'string' || !path.isAbsolute(policy.shellProgram) || policy.shellProgram.includes('\0'))) throw new KodoError('CLI_HOST_STATE', 'shell requires an absolute trusted executable path');
  if (policy.webFetch !== undefined) createWebFetchTool(policy.webFetch);
  if (policy.lsp !== undefined) {
    if (!policy.lsp || typeof policy.lsp !== 'object' || Array.isArray(policy.lsp) || Object.keys(policy.lsp).some(key => !['servers', 'timeoutMs', 'maxMessageBytes'].includes(key))) throw new KodoError('LSP_CONFIG', 'CLI LSP config permits only servers, timeoutMs and maxMessageBytes; sandbox and private paths are host-controlled');
    if (!Array.isArray(policy.lsp.servers) || policy.lsp.servers.some(server => !server || typeof server !== 'object' || Array.isArray(server) || Object.keys(server).some(key => !['id', 'program', 'args', 'languages', 'initializationOptions', 'readOnlyPaths'].includes(key)) || (server.initializationOptions !== undefined && (!server.initializationOptions || typeof server.initializationOptions !== 'object' || Array.isArray(server.initializationOptions))) || (server.readOnlyPaths !== undefined && (!Array.isArray(server.readOnlyPaths) || server.readOnlyPaths.some(value => typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')))))) throw new KodoError('LSP_CONFIG', 'invalid CLI language server fields or read-only runtime paths');
    lspTools(policy.lsp);
  }
}

export function readCliJson(file: string): unknown {
  try {
    const content = readFileSync(path.resolve(file));
    if (content.length > 1_048_576) throw new Error();
    return JSON.parse(content.toString('utf8')) as unknown;
  } catch { throw new KodoError('ARGUMENTS', 'trusted configuration must be a readable JSON file up to 1 MiB'); }
}

/** Validate the detached host command without executing or probing its backend. */
export function validateVerificationPolicy(policy: VerificationPolicy | undefined): void {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['enabled', 'approved', 'backend', 'program', 'args', 'timeoutMs', 'repeatLimit', 'parser'].includes(key)) || typeof policy.program !== 'string') throw new KodoError('VERIFY_CONFIG', 'invalid host verification configuration');
  createVerificationTool(policy);
}

export function cliVerificationPolicy(values: Record<string, unknown>): VerificationPolicy | undefined {
  if (values['verification-config'] === undefined) return;
  if (typeof values['verification-config'] !== 'string') throw new KodoError('ARGUMENTS', '--verification-config requires a JSON file');
  const policy = readCliJson(values['verification-config']) as VerificationPolicy;
  validateVerificationPolicy(policy);
  return policy;
}

export function cliToolPolicy(values: Record<string, unknown>): CliToolPolicy | undefined {
  if (values['web-hosts'] !== undefined && !values.webfetch) throw new KodoError('ARGUMENTS', '--web-hosts requires --webfetch');
  if (typeof values['shell-program'] === 'string' && !path.isAbsolute(values['shell-program'])) throw new KodoError('ARGUMENTS', '--shell-program requires an absolute Bash path');
  const policy: CliToolPolicy = {
    ...(typeof values['shell-program'] === 'string' ? { shellProgram: path.resolve(values['shell-program']) } : {}),
    ...(values.webfetch ? { webFetch: { enabled: true, ...(typeof values['web-hosts'] === 'string' ? { allowedHosts: values['web-hosts'].split(',').map(host => host.trim()) } : {}) } } : {}),
    ...(typeof values['lsp-config'] === 'string' ? { lsp: readCliJson(values['lsp-config']) as LspOptions } : {}),
  };
  validateToolPolicy(policy);
  return Object.keys(policy).length ? policy : undefined;
}

export function cliSandboxPolicy(values: Record<string, unknown>): SandboxPolicy | undefined {
  if ((values['allow-network'] || values['sandbox-resources'] !== undefined) && !values.sandbox) throw new KodoError('ARGUMENTS', '--allow-network and --sandbox-resources require --sandbox');
  if (!values.sandbox) return undefined;
  const resources = typeof values['sandbox-resources'] === 'string' ? readCliJson(values['sandbox-resources']) : undefined;
  validateSandboxResources(resources);
  return { network: values['allow-network'] ? 'allow' : 'none', ...(resources ? { resources } : {}) };
}

export { validateCompactionPolicy } from '../runtime/context.js';
export { defaultCompactionPolicy } from '../runtime/context.js';

/** The default policy is supplied by the host; `off` is the explicit opt-out. */
export function cliCompactionPolicy(values: Record<string, unknown>): CompactionPolicy | false | undefined {
  const strategy = values.compaction;
  const rawWork = values['compaction-work-tokens'];
  const rawRatio = values['compaction-trigger-ratio'];
  if ((rawWork !== undefined || rawRatio !== undefined) && strategy === undefined) throw new KodoError('ARGUMENTS', '--compaction-work-tokens and --compaction-trigger-ratio require --compaction');
  if (strategy === undefined) return undefined;
  if (strategy === 'off') return false;
  if (typeof strategy !== 'string' || !['mask', 'summary', 'hybrid'].includes(strategy)) throw new KodoError('ARGUMENTS', '--compaction must be off, mask, summary or hybrid');
  let workInputTokens: number | undefined;
  if (rawWork !== undefined) {
    if (typeof rawWork !== 'string' || !/^\d+$/.test(rawWork)) throw new KodoError('ARGUMENTS', '--compaction-work-tokens must be a positive integer');
    workInputTokens = Number(rawWork);
  }
  let triggerRatio: number | undefined;
  if (rawRatio !== undefined) {
    if (typeof rawRatio !== 'string' || !/^0?\.\d+$/.test(rawRatio)) throw new KodoError('ARGUMENTS', '--compaction-trigger-ratio must be a decimal from 0.5 to 0.95');
    triggerRatio = Number(rawRatio);
  }
  const policy: CompactionPolicy = { strategy: strategy as CompactionPolicy['strategy'], ...(workInputTokens === undefined ? {} : { workInputTokens }), ...(triggerRatio === undefined ? {} : { triggerRatio }) };
  validateCompactionPolicy(policy);
  return policy;
}

/** Experimental deterministic evidence assembly; it never adds a model request. */
export function cliAssemblyPolicy(values: Record<string, unknown>): AssemblyPolicy | undefined {
  const strategy = values.assembly;
  const rawWork = values['assembly-work-tokens'];
  const rawEvidence = values['assembly-evidence-tokens'];
  if ((rawWork !== undefined || rawEvidence !== undefined) && strategy === undefined) throw new KodoError('ARGUMENTS', '--assembly-work-tokens and --assembly-evidence-tokens require --assembly');
  if (strategy === undefined) return undefined;
  if (strategy !== 'deterministic') throw new KodoError('ARGUMENTS', '--assembly must be deterministic');
  const parse = (value: unknown, flag: string): number | undefined => {
    if (value === undefined) return;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new KodoError('ARGUMENTS', `${flag} must be a positive integer`);
    return Number(value);
  };
  const workInputTokens = parse(rawWork, '--assembly-work-tokens');
  const evidenceInputTokens = parse(rawEvidence, '--assembly-evidence-tokens');
  const policy: AssemblyPolicy = { strategy: 'deterministic', ...(workInputTokens === undefined ? {} : { workInputTokens }), ...(evidenceInputTokens === undefined ? {} : { evidenceInputTokens }) };
  validateAssemblyPolicy(policy);
  return policy;
}
