import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertFileScope, normalizeFileScope } from '../runtime/scope.js';
import { KodoError } from '../runtime/types.js';
import type { FileScope, ModelBinding, Permission } from '../runtime/types.js';
import { createSandbox } from '../sandbox/execute.js';
import { caseDigest, canonicalJson, freezeCase } from './schema.js';
import type { CaseAssertion } from './schema.js';
import { CaseRunStore } from './store.js';
import type { AssertionEvidence, CaseConditions, CaseRun, CaseTarget } from './store.js';

/** Only trusted host configuration supplies executables; cases reference a name and cannot add arguments. */
export interface CaseCommand { program: string; args: string[]; write?: boolean }
export interface CaseExecutionInput { objective: string; data?: unknown; workspace: string; signal: AbortSignal; target: CaseTarget; permissions: Permission[]; scope?: FileScope; recordExecution?(runId: string): void }
export interface CaseExecutionResult { status: string; output: string; runId?: string }
export interface RunCaseOptions {
  store: CaseRunStore; definition: unknown; target: CaseTarget; workspace: string;
  binding: ModelBinding; permissions: Permission[]; scope?: FileScope;
  /** Identifies host configuration/tool bindings not represented by the model and permission fields. */
  hostPolicyDigest: string;
  commands?: Record<string, CaseCommand>; environmentLabel?: string; signal?: AbortSignal;
  execute(input: CaseExecutionInput): Promise<CaseExecutionResult>;
}
const message = (error: unknown): string => error instanceof KodoError ? `${error.code}: ${error.message}` : error instanceof Error ? error.name : 'case execution failed';
function deadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function boundedRead(file: string, signal: AbortSignal, limit = 1_000_000): Promise<Buffer> {
  signal.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    signal.throwIfAborted();
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new KodoError('CASE_BOUNDS', 'assertion input must be a regular file of at most 1 MB');
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    for (;;) { signal.throwIfAborted(); const result = await handle.read(bytes, length, bytes.length - length); length += result.bytesRead; if (length > limit) throw new KodoError('CASE_BOUNDS', 'assertion input exceeds 1 MB'); if (!result.bytesRead) return bytes.subarray(0, length); }
  } finally { await handle.close(); }
}
function pointerValue(input: unknown, pointer: string): unknown {
  let value = input;
  for (const token of pointer ? pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')) : []) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, token)) throw new KodoError('CASE_ASSERTION', 'JSON pointer does not exist');
    value = (value as Record<string, unknown>)[token];
  }
  return value;
}
async function assertCase(check: CaseAssertion, index: number, output: string, workspace: string, options: RunCaseOptions, commands: Record<string, CaseCommand>, signal: AbortSignal): Promise<AssertionEvidence> {
  const read = async (relative: string): Promise<Buffer> => { if (!options.permissions.includes('read')) throw new KodoError('CASE_PERMISSION', 'file assertions require host read permission'); const file = path.join(workspace, relative); assertFileScope(options.scope, 'read', workspace, file); return await boundedRead(file, signal); };
  let passed = false; let actual: unknown;
  if (check.type === 'output') { actual = output; passed = output === check.equals; }
  if (check.type === 'file') {
    const file = path.join(workspace, check.path);
    if (!options.permissions.includes('read')) throw new KodoError('CASE_PERMISSION', 'file assertions require host read permission');
    assertFileScope(options.scope, 'read', workspace, file);
    try {
      const info = await stat(file); actual = { exists: true, file: info.isFile() };
      passed = info.isFile() && check.exists !== false;
      if (passed && (check.equals !== undefined || check.sha256 !== undefined)) { const contents = await read(check.path); const digest = createHash('sha256').update(contents).digest('hex'); actual = { exists: true, digest }; passed = (check.equals === undefined || contents.toString('utf8') === check.equals) && (check.sha256 === undefined || digest === check.sha256); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; actual = { exists: false }; passed = check.exists === false; }
  }
  if (check.type === 'json') { actual = pointerValue(JSON.parse(check.source === 'file' ? (await read(check.path!)).toString('utf8') : output) as unknown, check.pointer); passed = canonicalJson(actual) === canonicalJson(check.equals); }
  if (check.type === 'command') {
    const command = commands[check.command];
    if (!command || !options.permissions.includes('exec') || (command.write && !options.permissions.includes('write'))) throw new KodoError('CASE_PERMISSION', 'command assertion requires a trusted host command and granted permissions');
    // Commands always get the OS sandbox and no network. Package code never supplies this policy.
    const sandbox = createSandbox({ workspace, write: Boolean(command.write), network: 'none', ...(options.scope ? { scope: options.scope } : {}) });
    const result = await sandbox.run(command.program, command.args, { cwd: workspace, signal });
    actual = { exitCode: result.exitCode, stdoutDigest: caseDigest(result.stdout), stderrDigest: caseDigest(result.stderr) };
    passed = !result.cancelled && !result.signal && !result.outputLimitExceeded && !result.truncated && result.exitCode === check.exitCode && (check.stdout === undefined || result.stdout === check.stdout);
  }
  return { index, passed, detail: `${check.type} assertion ${passed ? 'passed' : 'failed'}`, actualDigest: caseDigest(actual) };
}
/** Workspace must be empty: both versions are always run from identical frozen fixtures. */
export async function runCase(input: RunCaseOptions): Promise<CaseRun> {
  const frozen = freezeCase(input.definition);
  const commands = structuredClone(input.commands ?? {});
  for (const command of Object.values(commands)) if (!path.isAbsolute(command.program) || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string') || command.args.join('').length > 32000) throw new KodoError('CASE_POLICY', 'host commands require an absolute executable path and bounded literal arguments');
  if (!/^[a-f0-9]{64}$/.test(input.hostPolicyDigest)) throw new KodoError('CASE_POLICY', 'host policy digest must identify the execution configuration');
  const workspace = await realpath(input.workspace);
  const scope = input.scope ? normalizeFileScope(input.scope) : undefined;
  const permissions = [...new Set(input.permissions)].sort();
  if (permissions.some(value => !['read', 'write', 'exec'].includes(value))) throw new KodoError('CASE_PERMISSION', 'unknown case host permission');
  const model = Object.fromEntries(Object.entries(structuredClone(input.binding)).filter(([key]) => key !== 'apiKeyEnv')) as Omit<ModelBinding, 'apiKeyEnv'>;
  const conditions: CaseConditions = {
    model, environment: { platform: process.platform, arch: process.arch, node: process.versions.node, ...(input.environmentLabel ? { label: input.environmentLabel } : {}) },
    permissions, ...(scope ? { scope } : {}), policyDigest: caseDigest({ host: input.hostPolicyDigest, commands }),
  };
  const options = { ...input, permissions, ...(scope ? { scope } : {}) };
  const run: CaseRun = { id: randomUUID(), case: frozen.definition, caseDigest: frozen.digest, inputDigest: frozen.inputDigest, target: structuredClone(input.target), conditions, conditionsDigest: caseDigest(conditions), workspace, status: 'running', startedAt: new Date().toISOString(), assertions: [] };
  input.store.start(run);
  const signal = AbortSignal.any([AbortSignal.timeout(frozen.definition.timeoutMs ?? 120000), ...(input.signal ? [input.signal] : [])]);
  try {
    signal.throwIfAborted();
    if ((await readdir(workspace)).length) throw new KodoError('CASE_WORKSPACE', 'case workspace must be empty to establish frozen inputs');
    for (const file of frozen.definition.inputs.files) {
      signal.throwIfAborted();
      if (!permissions.includes('write')) throw new KodoError('CASE_PERMISSION', 'fixture creation requires host write permission');
      const target = path.join(workspace, file.path); assertFileScope(scope, 'write', workspace, target);
      await mkdir(path.dirname(target), { recursive: true });
      const handle = await open(target, 'wx', 0o600); try { await handle.writeFile(file.content, 'utf8'); } finally { await handle.close(); }
    }
    const execution = await deadline(input.execute({ objective: frozen.definition.objective, ...(frozen.definition.inputs.data !== undefined ? { data: frozen.definition.inputs.data } : {}), workspace, signal, target: structuredClone(run.target), permissions, ...(scope ? { scope } : {}), recordExecution: runId => { signal.throwIfAborted(); run.execution = input.store.attachExecution(run.id, runId).execution; } }), signal);
    if (run.execution?.runId && execution.runId !== run.execution.runId) throw new KodoError('CASE_EVIDENCE', 'execution result differs from the run identity recorded before driving');
    if (typeof execution.output !== 'string' || Buffer.byteLength(execution.output) > 1_000_000) throw new KodoError('CASE_BOUNDS', 'execution output exceeds 1 MB or is not text');
    run.execution = { ...(execution.runId ? { runId: execution.runId } : {}), status: execution.status, outputDigest: caseDigest(execution.output) };
    for (const [index, check] of frozen.definition.assertions.entries()) {
      signal.throwIfAborted();
      try { run.assertions.push(await deadline(assertCase(check, index, execution.output, workspace, options, commands, signal), signal)); }
      catch (error) { run.assertions.push({ index, passed: false, detail: message(error) }); }
    }
    run.status = execution.status === 'completed' && run.assertions.every(check => check.passed) ? 'passed' : 'failed';
    if (execution.status !== 'completed') run.error = 'execution did not complete';
  } catch (error) { run.status = 'failed'; run.error = message(error); }
  run.completedAt = new Date().toISOString(); input.store.finish(run); return structuredClone(run);
}
export interface CaseComparison { comparable: boolean; passed: boolean; baseline: string; candidate: string; regressions: number[]; reason?: string }
export function compareCaseRuns(baseline: CaseRun, candidate: CaseRun): CaseComparison {
  const identity = (run: CaseRun): string => caseDigest({ case: run.caseDigest, input: run.inputDigest, conditions: run.conditionsDigest, target: run.target.id });
  if (identity(baseline) !== identity(candidate)) return { comparable: false, passed: false, baseline: baseline.id, candidate: candidate.id, regressions: [], reason: 'case, frozen input, target or execution conditions differ' };
  const regressions = baseline.assertions.filter(check => check.passed && !candidate.assertions.some(item => item.index === check.index && item.passed)).map(check => check.index);
  return { comparable: true, passed: candidate.status === 'passed' && regressions.length === 0, baseline: baseline.id, candidate: candidate.id, regressions };
}
