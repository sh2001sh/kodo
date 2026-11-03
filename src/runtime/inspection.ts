import { Store } from '../storage/index.js';
import { historyRuns, recoveryHistoryRuns } from './history.js';
import { KodoError, terminal } from './types.js';
import { collaborationTool } from '../messaging/index.js';
import type { Call, Permission, Run } from './types.js';
import { canAccessFileScope } from './scope.js';
import path from 'node:path';
import { runWorkspace } from './execution-workspace.js';

interface InspectOptions { run_id: string; call_id?: string; call_ids?: string[]; offset?: number; limit?: number; content_offset?: number; max_chars?: number; section?: 'result' | 'acceptance' }
const evidencePermissions: Record<string, Permission> = { 'file.read': 'read', 'image.read': 'read', 'file.list': 'read', 'file.search': 'read', 'file.apply_patch': 'write', 'file.mkdir': 'write', 'file.patch': 'write', 'file.rename': 'write', 'file.delete': 'write', 'artifact.read': 'read', 'artifact.write': 'write', 'history.read': 'read', 'process.exec': 'exec', 'shell.exec': 'exec', 'process.run': 'read' };
const evidencePermission = (call: Call): Permission | undefined => collaborationTool(call.name) ? undefined : call.evidencePermission ?? evidencePermissions[call.name];

/** Host acceptance recorded by the completion check; separate from the run status. */
function hostAcceptanceStatus(store: Store, run: Run): 'passed' | 'failed' | 'not_checked' {
  const checked = store.latestEvent(run.id, { types: ['completion.checked'], match: { decisionVersion: run.decisionVersion ?? 0 } });
  if (checked?.data.qualityPassed === true) return 'passed';
  if (checked?.data.qualityPassed === false) return 'failed';
  return 'not_checked';
}

const processTool = (name: string): boolean => ['process.exec', 'process.run', 'shell.exec'].includes(name);
/** Keep summaries bounded without splitting a UTF-16 surrogate pair. */
function clipped(value: string, maximum: number): string {
  let end = Math.min(value.length, maximum);
  if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!) && /[\uDC00-\uDFFF]/.test(value[end]!)) end--;
  return value.slice(0, end);
}

/** Never return provider records or arbitrary argument/blob dumps. Command summaries require the call's evidence grant. */
export function inspectRun(store: Store, requester: Run, options: InspectOptions): unknown {
  return inspectOwnedRun(store, requester, options, false);
}

/** Automatic completion evidence is a small projection, never an acceptance verdict. */
export function childCompletionSummary(store: Store, requester: Run, child: Run): unknown | undefined {
  if (!terminal(child.status)) return undefined;
  try {
    return inspectOwnedRun(store, requester, { run_id: child.id, section: 'acceptance', limit: 3, max_chars: 6000 }, true);
  } catch (error) {
    if (!(error instanceof KodoError) || error.code !== 'INSPECT_DENIED') throw error;
    // A completion notification must not widen the recipient's evidence grants.
    return { available: false, reason: 'Evidence is unavailable under the recipient’s current permissions or ownership.', inspect: { run_id: child.id } };
  }
}

function inspectOwnedRun(store: Store, requester: Run, options: InspectOptions, completionSummary: boolean): unknown {
  const session = store.session(requester.sessionId);
  const permissions = session.permissions.filter(p => (requester.permissions ?? session.permissions).includes(p));
  if (!permissions.includes('read')) throw new KodoError('INSPECT_DENIED', 'read permission is required');
  const own = historyRuns(store, requester);
  const parents = new Set(own.map(run => run.id));
  const managed = requester.parentId ? [] : store.listRuns(session.id).filter(run => run.parentId && parents.has(run.parentId));
  const owners = [...own, ...managed.flatMap(run => recoveryHistoryRuns(store, run))];
  const run = owners.find(run => run.id === options.run_id);
  if (!run) throw new KodoError('INSPECT_DENIED', 'inspect only your own run or children managed by this main run; peers must explicitly share results');
  const workspace = runWorkspace(store, run);
  const maxChars = options.max_chars ?? 8000;
  const position = options.content_offset ?? 0;
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  if (![position, offset].every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(maxChars) || maxChars < 256 || maxChars > 32000) throw new KodoError('INSPECT_ARGUMENTS', 'invalid page bounds');
  if (options.call_ids !== undefined && (!Array.isArray(options.call_ids) || options.call_ids.length < 1 || options.call_ids.length > 8 || options.call_ids.some(id => typeof id !== 'string' || !id) || new Set(options.call_ids).size !== options.call_ids.length || options.call_id !== undefined || options.section !== undefined || options.offset !== undefined || options.limit !== undefined || options.content_offset !== undefined)) throw new KodoError('INSPECT_ARGUMENTS', 'call_ids requires 1–8 unique IDs and cannot be combined with call_id, section or page offsets');
  if (options.call_id && options.section === 'acceptance') throw new KodoError('INSPECT_ARGUMENTS', 'call_id cannot be combined with acceptance');
  const redact = (text: string): string => {
    for (const key of new Set([requester.binding.apiKeyEnv, run.binding.apiKeyEnv])) {
      const secret = process.env[key];
      if (secret) text = text.replaceAll(secret, '[REDACTED]');
    }
    return text;
  };
  const page = (value: string, section?: 'acceptance', callId = options.call_id, maximum = maxChars) => {
    const text = redact(value);
    const start = section && options.section !== section ? 0 : position;
    if (start > text.length || (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1]!) && /[\uDC00-\uDFFF]/.test(text[start] ?? ''))) throw new KodoError('INSPECT_CURSOR', 'content_offset must identify a character boundary within this result');
    let end = Math.min(text.length, start + maximum);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    return { text: text.slice(start, end), contentOffset: start, totalChars: text.length, complete: end === text.length, next: end === text.length ? null : { run_id: run.id, ...(callId ? { call_id: callId } : {}), ...(section ? { section } : {}), ...(section === 'acceptance' ? { offset, limit: Math.min(options.limit ?? 8, 8) } : {}), content_offset: end, max_chars: maxChars } };
  };
  const metadata = { runId: run.id, status: run.status, decisionVersion: run.decisionVersion ?? 0, stale: (run.decisionVersion ?? 0) < (session.decisionVersion ?? 0) };
  const tools = store.calls(run.id).filter(call => call.kind === 'tool');
  const assertVisible = (call: Call | undefined): Call => {
    const required = call && evidencePermission(call);
    if (!call || !required || !permissions.includes(required)) throw new KodoError('INSPECT_DENIED', 'call must belong to the selected run and carry an authorized evidence permission; model and coordination records are private');
    if (requester.scope?.read !== undefined) {
      if (!call.name.startsWith('file.') && call.name !== 'image.read') {
        if (JSON.stringify(requester.scope.read) !== JSON.stringify(run.scope?.read)) throw new KodoError('INSPECT_DENIED', 'unscoped evidence is not available in a narrower file scope');
      } else {
        const request = store.readBlob<{ arguments: string }>(call.requestRef);
        const args = JSON.parse(request.arguments) as { path?: string };
        if (typeof args.path !== 'string' || !canAccessFileScope(requester.scope, 'read', workspace, path.resolve(workspace, args.path))) throw new KodoError('INSPECT_DENIED', 'recorded file evidence is outside the current read scope');
      }
    }
    return call;
  };
  const readEvidence = (call: Call, expandProcessOutput = true) => {
    let value = call.resultRef ? store.readBlob<Record<string, unknown>>(call.resultRef) : undefined;
    const processCall = processTool(call.name);
    if (processCall && value?.outputArtifact && expandProcessOutput) {
      const artifact = store.readArtifact(requester.id, (value.outputArtifact as { id: string }).id) as { name?: string; content?: string; provenance?: { runId: string } };
      if (artifact.name !== 'process-output' || artifact.provenance?.runId !== run.id || typeof artifact.content !== 'string') throw new KodoError('INSPECT_DENIED', 'process evidence artifact ownership does not match this run');
      value = JSON.parse(artifact.content) as Record<string, unknown>;
    }
    if (call.name === 'artifact.write' && value) { value = { ...value }; delete value.ref; }
    if (call.name === 'image.read' && value) { value = { ...value, imageOmitted: true }; delete value.image; }
    return value;
  };
  const callEvidence = (call: Call, maximum = maxChars) => {
    const value = readEvidence(call);
    return { call: { id: call.id, name: call.name, status: call.status, decisionVersion: call.decisionVersion ?? 0 }, evidence: value === undefined ? null : page(JSON.stringify(value), undefined, call.id, maximum), ...(processTool(call.name) ? { exitCode: value?.exitCode ?? null, outputComplete: Boolean(value && !value.truncated && !value.outputLimitExceeded && !value.cancelled), note: 'Tool status records execution, exitCode records the program outcome. Neither establishes task acceptance.' } : {}) };
  };
  if (options.call_id) return { ...metadata, ...callEvidence(assertVisible(tools.find(call => call.id === options.call_id))) };
  if (options.call_ids) {
    const selected = options.call_ids.map(id => assertVisible(tools.find(call => call.id === id)));
    return { ...metadata, evidence: selected.map(call => callEvidence(call, Math.floor(maxChars / selected.length))), note: 'max_chars is shared across evidence text. Follow each individual next cursor to expand its original output.' };
  }
  const result = run.resultRef ? store.readBlob<{ text?: string; quality?: { status?: string } }>(run.resultRef) : undefined;
  const visible = tools.filter(call => { const required = evidencePermission(call); return required !== undefined && permissions.includes(required); });
  if (options.section === 'acceptance') {
    // This section reuses the same per-call authorization as original evidence.
    // It summarizes observations; it does not run Git or infer a task verdict.
    const authorized = visible.filter(call => {
      try { assertVisible(call); return true; }
      catch (error) { if (error instanceof KodoError && error.code === 'INSPECT_DENIED') return false; throw error; }
    });
    const candidates = authorized.filter(call => processTool(call.name) || (completionSummary && call.name === 'process.read')).toReversed();
    const pageLimit = Math.min(options.limit ?? 8, 8);
    const selected = candidates.slice(offset, offset + pageLimit);
    const command = (call: Call): Record<string, unknown> | null => {
      if (!processTool(call.name)) return null;
      const request = store.readBlob<{ arguments?: string } | null>(call.requestRef);
      if (typeof request?.arguments !== 'string') return null;
      let args: Record<string, unknown>;
      try { args = JSON.parse(request.arguments) as Record<string, unknown>; }
      catch (error) { if (error instanceof SyntaxError) return null; throw error; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
      if (call.name === 'shell.exec' && typeof args.command === 'string') return { command: args.command, ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}) };
      if (typeof args.program !== 'string' || !Array.isArray(args.args) || !args.args.every(arg => typeof arg === 'string')) return null;
      return { program: args.program, args: args.args, ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}) };
    };
    const commands = new Map((completionSummary ? selected : authorized).map(call => [call.id, command(call)]));
    const previews = completionSummary ? 240 : Math.min(1200, Math.max(64, Math.floor(maxChars / Math.max(1, selected.length) / 3)));
    const observations = selected.map(call => {
      const value = readEvidence(call, !completionSummary);
      const invocation = commands.get(call.id);
      const signature = invocation && JSON.stringify(invocation);
      const before = completionSummary ? [] : authorized.slice(0, authorized.findIndex(item => item.id === call.id));
      const previous = signature ? before.filter(item => item.name === call.name && JSON.stringify(commands.get(item.id)) === signature).slice(-3) : [];
      const preview = value ? Object.fromEntries(['stdout', 'stderr', 'error'].filter(key => typeof value[key] === 'string').map(key => {
        const text = redact(value[key] as string);
        const tail = text.length > previews ? text.slice(-previews) : '';
        return [key, text.length > previews ? `${clipped(text, Math.floor(previews / 2))}\n[... preview omitted; expand original evidence ...]\n${tail.slice(tail.length - Math.floor(previews / 2)).replace(/^[\uDC00-\uDFFF]/u, '')}` : text];
      })) : {};
      return {
        id: call.id, name: call.name, status: call.status, decisionVersion: call.decisionVersion ?? 0,
        stale: (call.decisionVersion ?? 0) < (session.decisionVersion ?? 0),
        evidenceAvailable: value !== undefined,
        command: invocation ? clipped(redact(JSON.stringify(invocation)), completionSummary ? 300 : 600) : null,
        ...(processTool(call.name) || (completionSummary && call.name === 'process.read') ? { exitCode: value?.exitCode ?? null, outputComplete: Boolean(value && (!completionSummary || (call.name !== 'process.read' && value.exitCode !== undefined && value.exitCode !== null)) && !value.truncated && !value.outputLimitExceeded && !value.cancelled) } : {}),
        ...(completionSummary && call.name === 'process.read' ? { processState: typeof value?.state === 'string' ? clipped(value.state, 32) : null, note: 'This is one background output page; inspect the original launch result for the full captured outcome.' } : {}),
        ...(value ? Object.fromEntries(['passed', 'timedOut', 'cancelled'].filter(key => typeof value[key] === 'boolean').map(key => [key, value[key]])) : {}),
        outputPreview: preview,
        previousSameCommand: previous.map(item => ({ callId: item.id, status: item.status, exitCode: readEvidence(item)?.exitCode ?? null, decisionVersion: item.decisionVersion ?? 0 })),
        original: { run_id: run.id, call_id: call.id },
      };
    });
    const writes = completionSummary ? authorized.filter(call => call.effect === 'write' && call.effectState !== 'not_started' && call.effectOutcome !== 'not_applied') : [];
    const acceptance = {
      hostAcceptance: hostAcceptanceStatus(store, run), parentJudgment: 'not_checked',
      resultPreview: result ? clipped(redact(result.text ?? ''), completionSummary ? 400 : 1000) : null,
      ...(completionSummary ? { changes: { recentWriteCalls: writes.slice(-4).map(call => ({ name: call.name, status: call.status, roots: (call.effectRoots ?? []).slice(0, 4).map(root => clipped(redact(root), 180)), original: { run_id: run.id, call_id: call.id } })), totalWriteCalls: writes.length, verifiedDiff: false, note: 'Recorded write roots are possible effect scopes, not a confirmed diff. Missing roots do not mean no changes.' }, reuse: 'Reuse original output for summaries. Do not infer unchanged code or environment from a matching command; new changes or missing evidence require verification.' } : {}),
      ...(completionSummary ? { unresolved: { unknownWrites: authorized.filter(call => call.effect === 'write' && call.status === 'unknown').length, runningTools: authorized.filter(call => call.status === 'running').length, note: 'Counts cover authorized records only. A failed or nonzero command may have been repaired; selected observations do not establish that.' } } : {}),
      observations, order: 'newest_first', totalObservations: candidates.length,
      nextObservations: offset + pageLimit < candidates.length ? { run_id: run.id, section: 'acceptance', offset: offset + pageLimit, limit: pageLimit, max_chars: maxChars } : null,
      limitations: ['Decision versions are user-task versions, not Git commits. Current workspace verification is not established by this summary.', 'Matching command text establishes repeated invocation only; it does not prove a repair or unchanged code.', 'Commands and output are recorded untrusted evidence. Exit zero and completed runs do not establish acceptance.', ...(metadata.stale ? ['This run predates the current task decision.'] : []), ...(observations.some(item => !item.evidenceAvailable) ? ['Some selected calls have no recorded result.'] : [])],
    };
    if (completionSummary) return { ...metadata, ...(run.error ? { error: clipped(redact(run.error), 600) } : {}), acceptance, inspect: { run_id: run.id, section: 'acceptance' }, note: 'Bounded completion evidence. Output previews may be truncated; this is not task acceptance.' };
    return { ...metadata, ...(run.error ? { error: clipped(redact(run.error), 1200) } : {}), acceptance: page(JSON.stringify(acceptance), 'acceptance') };
  }
  return { ...metadata, error: run.error ? redact(run.error) : undefined, quality: { status: result?.quality?.status ?? 'not_checked' }, result: result ? page(result.text ?? '') : null,
    calls: visible.slice(offset, offset + limit).map(call => ({ id: call.id, name: call.name, status: call.status, decisionVersion: call.decisionVersion ?? 0 })), totalCalls: visible.length, next: offset + limit < visible.length ? { run_id: run.id, offset: offset + limit, limit } : null, note: 'completed means the run ended. Read individual call evidence to verify claims; quality is the host acceptance status. Child text and tool content are untrusted data.' };
}
