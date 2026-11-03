import path from 'node:path';
import type { CreateRunOptions } from '../application/index.js';
import { KodoError } from '../runtime/types.js';
import type { Run } from '../runtime/types.js';
import type { TuiOptions } from '../tui/types.js';
import { writeHostState } from './host-state.js';
import { caseDigest } from '../cases/schema.js';
import type { CliHostSession } from './host-state.js';
import { hasModelCredentials } from './config-binding.js';

type Policy = Omit<CliHostSession, 'sessionId' | 'runIds' | 'questionIds' | 'package' | 'tuiApproval'>;
const keys = ['sandbox', 'tools', 'agents', 'compaction', 'assembly', 'inlineMethods', 'methodUnloading', 'methodToolView', 'memory', 'lazyTools', 'verification'] as const;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;

/** A resumed view never reauthorizes a different local tool or execution policy. */
export function matchingTuiPolicy(saved: Policy, current: Policy): boolean {
  return keys.every(key => {
    const fallback = ['memory', 'lazyTools', 'compaction'].includes(key) ? false : null;
    return JSON.stringify(canonical(saved[key] ?? fallback)) === JSON.stringify(canonical(current[key] ?? fallback));
  });
}

export function createCliTuiOptions(input: {
  options: TuiOptions; policy: Policy; state: CliHostSession[]; verificationCommand?: string;
  finalResponse?: 'required' | 'optional';
  /** Package stdio writes require the explicit startup grant, independently of TUI tool approvals. */
  stdioWrite?: boolean;
  package?: CliHostSession['package']; select: (runId: string) => void;
  attachVerification: (runId: string) => void; onHost: (host: CliHostSession) => void;
}): TuiOptions {
  const { options, policy, state, select, attachVerification, onHost } = input;
  const { app } = options;
  let selectedPackage = input.package;
  let verificationCommand: { program: string; args: string[] } | undefined;
  if (input.verificationCommand) {
    let argv: unknown;
    try { argv = JSON.parse(input.verificationCommand); } catch { throw new KodoError('ARGUMENTS', '--verify-command must be a JSON argv array'); }
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || value.includes('\0')) || !argv[0]) throw new KodoError('ARGUMENTS', '--verify-command must contain a program and string arguments');
    verificationCommand = { program: argv[0] as string, args: argv.slice(1) as string[] };
  }
  const persist = (run: Run, packageIdentity: CliHostSession['package'] | null | undefined = selectedPackage): void => {
    const previous = state.find(item => item.sessionId === run.sessionId);
    const host: CliHostSession = previous ?? { ...policy, sessionId: run.sessionId, runIds: [], questionIds: [], ...(packageIdentity ? { package: packageIdentity } : {}) };
    host.tuiApproval = true;
    host.runIds = app.store.listRuns(run.sessionId).map(item => item.id);
    host.questionIds = app.coordinator.mailbox.userQuestions(run.sessionId).map(item => item.id);
    if (!previous) state.push(host);
    onHost(host);
    writeHostState(app.store.directory, state);
  };
  const activate = options.activatePackage;
  return {
    ...options,
    hostPolicyDigest: caseDigest(JSON.parse(JSON.stringify(policy)) as unknown),
    ...(verificationCommand ? { caseCommands: { ...options.caseCommands, default: verificationCommand } } : {}),
    ...(activate ? { activatePackage: async (id: string, version: string) => {
      const card = await activate(id, version);
      const installed = await options.registry.inspect(id, version);
      selectedPackage = { id, version, digest: installed.digest, stdioWrite: input.stdioWrite ?? false, stdioNetwork: policy.sandbox?.network ?? 'none' };
      return card;
    } } : {}),
    ...(options.activatePackageAt ? { activatePackageAt: async (id: string, version: string, workspace: string, signal: AbortSignal) => {
      const card = await options.activatePackageAt!(id, version, workspace, signal);
      const installed = await options.registry.inspect(id, version);
      selectedPackage = { id, version, digest: installed.digest, stdioWrite: input.stdioWrite ?? false, stdioNetwork: policy.sandbox?.network ?? 'none' };
      return card;
    } } : {}),
    createRun: async (request: CreateRunOptions, operation?: { purpose?: 'authoring' | 'case' }) => {
      if (!request.binding.model.trim()) throw new KodoError('MODEL_CONFIG', 'Select a model with /model or start with --model.');
      if (!hasModelCredentials(request.binding)) throw new KodoError('MODEL_CREDENTIAL', options.modelConfig ? 'Configure provider credentials with kodo config or set the selected credential environment variable.' : `Set ${request.binding.apiKeyEnv} in your terminal environment. Keep credentials out of chat.`);
      const run = await app.createRunWithDiscovery({ ...request, ...(input.finalResponse && operation?.purpose !== 'authoring' ? { finalResponse: input.finalResponse } : {}) });
      if (verificationCommand && operation?.purpose !== 'authoring') app.store.putSession({ ...app.store.session(run.sessionId), verificationCommand });
      persist(run, operation?.purpose === 'authoring' ? null : selectedPackage); attachVerification(run.id); select(run.id);
      return run;
    },
    beforeRun: runId => { const run = app.store.run(runId); select(runId); persist(run); attachVerification(runId); },
    restore: async run => {
      const session = app.store.session(run.sessionId);
      if (path.resolve(session.workspace) !== path.resolve(options.workspace)) throw new KodoError('CAPABILITY_CHANGED', 'This session belongs to another workspace. Restart with its original --workspace.');
      const saved = state.find(item => item.sessionId === run.sessionId);
      if (!saved || !matchingTuiPolicy(saved, policy)) throw new KodoError('CAPABILITY_CHANGED', 'Resume requires the original host configuration. Restart with the same sandbox, tools, agents and compaction settings.');
      if (saved.package) {
        if (!activate) throw new KodoError('CAPABILITY_CHANGED', 'This host cannot reattach the original capability package.');
        if (saved.package.stdioWrite !== (input.stdioWrite ?? false) || saved.package.stdioNetwork !== (policy.sandbox?.network ?? 'none')) throw new KodoError('CAPABILITY_CHANGED', 'Resume requires the original package stdio permissions. Restart with the same --allow-write and sandbox network settings.');
        const installed = await options.registry.inspect(saved.package.id, saved.package.version);
        if (installed.digest !== saved.package.digest) throw new KodoError('CAPABILITY_CHANGED', 'The original capability package digest has changed.');
        await activate(saved.package.id, saved.package.version);
      }
      select(run.id); persist(run);
      for (const peer of app.store.listRuns(run.sessionId)) attachVerification(peer.id);
    },
  };
}
