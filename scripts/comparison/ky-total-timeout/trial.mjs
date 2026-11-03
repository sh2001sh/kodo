// One Ky trial: seed a fresh workspace, run Kodo through the metering relay,
// audit the result and compare the protected file set. Shared by the matrix
// runner (eval.mjs) and the recovery diagnosis (recovery.mjs).

import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { auditWorkspace } from './oracle.mjs';
import { protectedSnapshot, taskTreeDigest } from './fixture.mjs';
import { errorText, eventCounts, finalText, relayBinding, sessionUsage, sha256, writeJson } from '../v3-eval-common.mjs';

const delegationTools = new Set(['explore', 'spawn_agent']);

function toolArgument(store, call) {
  try { return JSON.parse(store.readBlob(call.requestRef)?.arguments ?? '{}'); } catch { return {}; }
}

function delegationEvidence(app, sessionId, mainId) {
  const runs = app.store.listRuns(sessionId);
  const mainTools = app.store.calls(mainId).filter(call => call.kind === 'tool');
  const observations = new Set(mainTools.filter(call => call.name === 'inspect_run' && call.status === 'succeeded').map(call => toolArgument(app.store, call).run_id));
  const exploreSucceeded = mainTools.some(call => call.name === 'explore' && call.status === 'succeeded');
  const children = runs.filter(run => run.parentId).map(run => {
    const result = finalText(app.store, run);
    return { id: run.id, status: run.status, objective: run.objective, resultChars: result.length, resultSha256: result ? sha256(result) : null, observedByMain: exploreSucceeded || observations.has(run.id) };
  });
  const first = mainTools.find(call => delegationTools.has(call.name));
  return {
    created: children.length,
    firstDelegationStep: first?.step ?? null,
    exploreCalls: mainTools.filter(call => call.name === 'explore').length,
    spawnCalls: mainTools.filter(call => call.name === 'spawn_agent').length,
    waitCalls: mainTools.filter(call => call.name === 'wait_for_events').length,
    inspectCalls: mainTools.filter(call => call.name === 'inspect_run').length,
    messageCalls: mainTools.filter(call => call.name === 'send_message').length,
    children,
    resultObservedCount: children.filter(child => child.observedByMain).length,
  };
}

function compactionEvidence(app, sessionId) {
  const events = app.store.listRuns(sessionId).flatMap(run => app.store.events(run.id));
  const select = type => events.filter(event => event.type === type).map(event => ({ runId: event.runId, time: event.time, data: event.data }));
  return {
    counts: Object.fromEntries(['context.summary.started', 'context.summary.installed', 'context.summary.failed', 'context.summary.skipped', 'context.summary.disabled'].map(type => [type, events.filter(event => event.type === type).length])),
    started: select('context.summary.started'), installed: select('context.summary.installed'), failed: select('context.summary.failed'),
  };
}

/** Tool calls of every run in the session, by name, so host-tool use is visible per trial. */
function toolUse(app, sessionId) {
  const counts = {};
  for (const run of app.store.listRuns(sessionId)) for (const call of app.store.calls(run.id)) if (call.kind === 'tool') counts[call.name] = (counts[call.name] ?? 0) + 1;
  return counts;
}

function deliveryVerdict(result, before, after) {
  const added = Object.keys(after.files).filter(file => !(file in before.files));
  const removed = Object.keys(before.files).filter(file => !(file in after.files));
  const modified = Object.keys(before.files).filter(file => file in after.files && before.files[file] !== after.files[file]);
  result.protected = { added, removed, modified };
  result.delivery = {
    ok: result.status === 'completed' && Boolean(result.finalText?.trim()) && result.audit.passed && !added.length && !removed.length && !modified.length,
    reasons: [
      ...(result.status === 'completed' ? [] : ['RUN_NOT_COMPLETED']),
      ...(result.finalText?.trim() ? [] : ['EMPTY_REPLY']),
      ...(result.audit.passed ? [] : ['ACCEPTANCE_FAILED']),
      ...((added.length || removed.length) ? ['PROTECTED_SET_CHANGED'] : []),
      ...(modified.length ? ['PROTECTED_MODIFIED'] : []),
    ],
  };
}

/**
 * Run one trial in `directory`. `seed(workspace)` creates the workspace,
 * `wrapProvider(base)` adapts the model provider (Solo arms), `card(app)` returns
 * the agent card, `tools` are extra host registrations and `postChecks(workspace)`
 * collects host evidence after the agent stops. `budget` adds registered session
 * limits; the relay itself only meters usage and keeps the credential out of the run.
 */
export async function executeTrial({ directory, key, arm, block, policy, registration, credentials, model, seed, objective, card, wrapProvider = provider => provider, tools = [], deliverables = registration.deliverables, budget = {}, postChecks }) {
  const workspace = path.join(directory, 'workspace');
  const wire = path.join(directory, 'wire');
  mkdirSync(wire, { recursive: true });
  const seededAt = Date.now();
  seed(workspace);
  const seedMs = Date.now() - seededAt;
  if (existsSync(path.join(workspace, '.git'))) throw new Error('trial workspace unexpectedly contains .git');
  const before = protectedSnapshot(workspace);
  const { relay, binding } = await relayBinding({ directory: wire, credentials, model, unrestricted: true, maxOutputTokens: registration.outputTokens, contextTokens: registration.contextTokens, cacheReadCostPercent: registration.cacheReadCostPercent });
  const { Application, ModelProvider } = await import('../../../dist/application/index.js');
  const app = new Application(path.join(directory, 'state'), wrapProvider(new ModelProvider()), undefined, {
    exploration: false, structuredExploration: false, exploreNudge: false, sandbox: registration.sandbox, tools,
    ...(policy.compaction ? { compaction: policy.compaction } : {}),
  });
  const result = { key, arm, block, repeat: block, policy, seedMs, status: null, error: null };
  const agentStarted = Date.now();
  try {
    const run = app.createRun({
      objective, workspace, binding, card: card(app), permissions: ['read', 'write', 'exec'], finalResponse: 'required',
      deliverables: globalThis.structuredClone(deliverables),
      scope: { read: [...registration.scope.read], write: [...registration.scope.write] },
      budget: {
        maxContextTokens: registration.contextTokens, maxOutputTokens: registration.outputTokens,
        toolTimeoutMs: registration.toolTimeoutMs, maxChildren: registration.maxChildren,
        maxConcurrentModels: registration.maxConcurrentModels, cacheReadCostPercent: registration.cacheReadCostPercent,
        ...budget,
      },
    });
    const completed = await app.run(run.id).catch(error => ({ ...app.store.run(run.id), error: errorText(error) }));
    Object.assign(result, {
      status: completed.status, error: completed.error ?? null, finalText: finalText(app.store, app.store.run(run.id)),
      usage: sessionUsage(app.store, run.sessionId),
      delegation: delegationEvidence(app, run.sessionId, run.id),
      compaction: compactionEvidence(app, run.sessionId),
      toolUse: toolUse(app, run.sessionId),
      mainContextEvents: eventCounts(app.store, run.id, 'context.'),
      deliveryIncomplete: app.store.run(run.id).deliveryIncomplete ?? null,
      runtimeEvents: { ...eventCounts(app.store, run.id, 'delivery.'), ...eventCounts(app.store, run.id, 'run.handoff'), ...eventCounts(app.store, run.id, 'tool.repetition') },
    });
  } catch (error) { result.error = errorText(error); }
  finally {
    result.agentMs = Date.now() - agentStarted;
    await app.shutdown().catch(error => { result.shutdownError = errorText(error); });
    await relay.close();
    const { requests, tokens, rejected, estimated, unmeasured, clientAborted } = relay.stats;
    result.relay = { requests, tokens, rejected, estimated, unmeasured, clientAborted };
  }
  const auditStarted = Date.now();
  result.audit = await auditWorkspace({ workspace, finalText: result.finalText ?? '' });
  result.auditMs = Date.now() - auditStarted;
  if (postChecks) result.postChecks = await postChecks(workspace).catch(error => ({ error: errorText(error) }));
  deliveryVerdict(result, before, protectedSnapshot(workspace));
  result.workspaceDigest = taskTreeDigest(workspace);
  await writeFile(path.join(directory, 'final.txt'), result.finalText ?? '', 'utf8');
  await writeJson(path.join(directory, 'report.json'), result, credentials.key);
  return result;
}
