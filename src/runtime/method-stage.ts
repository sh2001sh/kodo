import { recoveryHistoryRuns } from './history.js';
import { runWorkspace } from './execution-workspace.js';
import { workspacesOverlap } from './paths.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { digest } from '../storage/index.js';
import type { Store } from '../storage/index.js';
import { KodoError } from './types.js';
import type { Message, Provider, Run, ToolSpec } from './types.js';
import { declareTasks } from './task-declare.js';
import type { TaskDeclaration } from './task-declare.js';
import { currentDependencies, dependenciesCurrent, descendants, moveTaskNode, predecessorsSatisfied, readTaskGraph, requireTaskNode, writeTaskNode } from './task-graph.js';
import { activeMethod, methodContract, methodSkillId } from '../extensions/methods.js';
import { reportCompleteness, validateReport, validateSlots } from '../agents/contracts.js';
import { assertFileScope, intersectFileScopes } from './scope.js';
import { ProjectKnowledge } from '../knowledge/index.js';
import { createInputTokenEstimator, estimateTextTokens } from './context-tokens.js';

const text = { type: 'string', minLength: 1, maxLength: 4000 };
const strings = { type: 'array', maxItems: 30, items: text };
export const methodTaskSpec: ToolSpec = { name: 'task', description: 'Optional stages in the existing task graph. declare records goals, dependencies and capability needs; activate binds a selected card and existing project knowledge; extend supplies referenced Skills; done requires a saved artifact (resultRef), or result:{name,content} to save a report, and recorded check calls; inspect/resume/redo/drop preserve generation checks. skill.load remains available without declaring a stage. Activation changes the executable tool contract; visible stable tool schemas are only the authorized candidate pool.',
  parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { enum: ['declare', 'activate', 'extend', 'done', 'inspect', 'resume', 'redo', 'drop', 'wait'] },
    node_id: text, expectedGeneration: { type: 'integer', minimum: 1 }, card: { type: 'string', minLength: 1, maxLength: 256 }, execution: { enum: ['auto', 'inline', 'child'] },
    result: { type: 'object', additionalProperties: false, required: ['name', 'content'], properties: { name: text, content: { type: 'string', minLength: 1, maxLength: 16000 } } },
    inputs: { type: 'object' }, resultRef: text, checkCallIds: strings, fields: { type: 'object' }, reason: text, skill: text,
    tasks: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['id', 'goal'], properties: {
      id: text, goal: text, after: strings, acceptance: text, owner: { const: 'self' }, needs: { type: 'object', additionalProperties: false, properties: {
        capabilities: strings, knowledgeQueries: strings, execution: { enum: ['auto', 'inline', 'child'] },
        requiredRefs: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['id', 'revision'], properties: { id: text, revision: { type: 'integer', minimum: 1 } } } },
      } },
    } } },
  } },
};

/** Runs inside the existing collaboration tool/result transaction. */
export function executeMethodStage(store: Store, run: Run, callId: string, args: Record<string, unknown>, invoke: (name: string, args: Record<string, unknown>) => unknown, knowledge = new ProjectKnowledge(store)): unknown {
  const session = store.session(run.sessionId);
  if (!session.inlineMethods || run.parentId) throw new KodoError('ROLE_DENIED', 'method stages require an enabled main run');
  const action = args.action as string;
  if (action === 'declare') {
    const declaration = { tasks: (args.tasks as TaskDeclaration['tasks'] ?? []).map(task => ({ ...task, needs: task.needs ?? {}, owner: 'self' as const })) };
    return declareTasks(store, run.id, declaration, {});
  }
  const graph = readTaskGraph(store, run.id);
  const node = requireTaskNode(graph, args.node_id as string);
  if (action === 'inspect') return { ...node, ...(node.runId ? { child: { id: node.runId, status: store.run(node.runId).status } } : {}) };
  if (args.expectedGeneration !== node.generation) throw new KodoError('TASK_GENERATION', 'pass the current expectedGeneration from task inspect');
  const active = activeMethod(store, run.id);
  const end = (reason: string): void => { if (active?.nodeId === node.id) store.event(run.id, 'method.ended', { ...active, reason }); };
  if (action === 'wait') {
    if (!node.runId) throw new KodoError('TASK_NODE_STATE', 'this stage has no independent child');
    return invoke('wait_for_events', { run_ids: [node.runId] });
  }
  if (action === 'drop') {
    if (typeof args.reason !== 'string' || !args.reason.trim()) throw new KodoError('TASK_REASON_REQUIRED', 'drop requires a reason');
    if (node.runId && !['completed', 'failed', 'cancelled'].includes(store.run(node.runId).status)) invoke('cancel_agent', { run_id: node.runId });
    end('dropped'); return moveTaskNode(store, run.id, node, 'dropped', { reason: args.reason });
  }
  if (action === 'redo' || action === 'resume') {
    if (!['done', 'stale', 'failed', 'needs_input', 'running'].includes(node.state)) throw new KodoError('TASK_NODE_STATE', 'resume/redo requires a settled stage');
    if (node.runId && !['completed', 'failed', 'cancelled'].includes(store.run(node.runId).status)) throw new KodoError('TASK_NODE_STATE', 'wait for or cancel the current child before resuming');
    end(action);
    for (const successor of descendants(graph, node.id)) if (successor.state === 'done') moveTaskNode(store, run.id, successor, 'stale', { reason: 'predecessor stage revised' });
    if (action === 'resume' && node.runId) {
      const result = invoke('followup_task', { target: node.runId, objective: args.reason ?? node.goal }) as { id: string };
      return writeTaskNode(store, run.id, { ...node, state: 'running', runId: result.id, resultRef: undefined, artifactId: undefined, completionKey: undefined, activationCallId: callId, dependencies: currentDependencies(graph, node), resultDecisionVersion: session.decisionVersion ?? 0 });
    }
    return writeTaskNode(store, run.id, { ...node, state: 'pending', generation: action === 'redo' ? node.generation + 1 : node.generation, continuation: action === 'resume' ? { mode: 'resume', fromRunId: run.id } : undefined, resultRef: undefined, artifactId: undefined, completionKey: undefined, activationCallId: undefined, resultDecisionVersion: undefined, methodInstance: undefined, runId: undefined });
  }
  if (action === 'extend') {
    if (active?.nodeId !== node.id || node.state !== 'running') throw new KodoError('TASK_NODE_STATE', 'extend requires this active stage');
    if (!active.contract?.skills.includes(args.skill as string)) throw new KodoError('SKILL_DENIED', 'resource is not declared by this method');
    return { next: { tool: 'skill.load', args: { id: args.skill } }, note: 'Load the resource through the existing paginated Skill tool; this does not replace the method.' };
  }
  if (action === 'done') {
    if (node.state === 'done' && node.completionKey === digest(JSON.stringify(args)) && dependenciesCurrent(graph, node) && node.resultDecisionVersion === (session.decisionVersion ?? 0)) return node;
    if (node.state !== 'running' || !dependenciesCurrent(graph, node) || node.resultDecisionVersion !== (session.decisionVersion ?? 0)) throw new KodoError('TASK_NODE_STATE', 'stage or its dependencies/decisions changed; inspect and resume or redo');
    if (node.runId && store.run(node.runId).status !== 'completed') throw new KodoError('TASK_NODE_STATE', 'child must complete before stage acceptance');
    if (!node.runId && (active?.nodeId !== node.id || active.generation !== node.generation)) throw new KodoError('TASK_NODE_STATE', 'stage method is no longer active');
    if (typeof args.resultRef !== 'string' && !args.result) throw new KodoError('TASK_RESULT', 'done requires an artifact ID or a report to save');
    if (args.resultRef && args.result) throw new KodoError('TASK_RESULT', 'choose resultRef or result');
    const artifactId = typeof args.resultRef === 'string' ? args.resultRef : store.artifact(run.id, store.blob(args.result));
    const artifact = store.readArtifact(run.id, artifactId);
    const checkIds = args.checkCallIds as string[] ?? [];
    if (!checkIds.length) throw new KodoError('TASK_CHECK', 'done requires at least one recorded check; model review alone is not verified completion');
    const activation = node.activationCallId ? store.call(node.activationCallId) : undefined;
    const activated = activation && store.latestEvent(activation.runId, { types: ['tool.started'], match: { callId: activation.id } });
    const owners = store.listRuns(session.id).filter(owner => workspacesOverlap(runWorkspace(store, owner), runWorkspace(store, run)));
    const sourceRuns = new Set([...recoveryHistoryRuns(store, run), ...(node.runId ? recoveryHistoryRuns(store, store.run(node.runId)) : [])].map(owner => owner.id));
    const finished = owners.flatMap(owner => store.events(owner.id, { types: ['tool.finished'] }));
    const checks = checkIds.map(id => {
      const call = store.call(id);
      if (!sourceRuns.has(call.runId) || call.status !== 'succeeded' || !['verify.run', 'shell.exec', 'process.exec', 'process.run', 'file.read', 'artifact.read'].includes(call.name) || !call.resultRef || (call.decisionVersion ?? 0) !== (session.decisionVersion ?? 0)) throw new KodoError('TASK_CHECK', 'check evidence must be a successful current-decision check from this stage run');
      const checked = finished.find(event => event.data.callId === id && event.data.status === 'succeeded');
      if (!activated || !checked || checked.seq <= activated.seq) throw new KodoError('TASK_CHECK', 'checks must be recorded after this activation');
      if (finished.some(event => event.seq > checked.seq && event.data.callId !== callId && !checkIds.includes(event.data.callId as string) && event.data.name !== 'artifact.write' && store.call(event.data.callId as string).effect === 'write')) throw new KodoError('TASK_CHECK', 'workspace changed after the check; rerun it before acceptance');
      const result = store.readBlob<Record<string, unknown>>(call.resultRef);
      const reading = call.name === 'file.read' || call.name === 'artifact.read';
      if (result.error || result.cancelled || result.timedOut || result.passed === false || !reading && result.exitCode !== 0 && result.passed !== true) throw new KodoError('TASK_CHECK', 'a failed or unverified check cannot satisfy acceptance');
      return { callId: id, resultRef: call.resultRef, kind: reading ? 'source-inspection' : 'command-check' };
    });
    const childRun = node.runId ? store.run(node.runId) : undefined;
    if (childRun && !reportCompleteness(store, childRun).passed) throw new KodoError('TASK_REPORT', 'the child report contract is incomplete');
    const method = !childRun && active ? store.card(active.card.id, active.card.version) : undefined;
    const report = method?.report?.length ? validateReport(store, { ...run, card: method }, args.fields) : undefined;
    const resultRef = store.blob({ artifactId, artifact, checks, report, acceptance: { kind: 'model-review', criteria: node.acceptance ?? null, note: args.reason ?? null } });
    end('stage_done');
    return moveTaskNode(store, run.id, node, 'done', { resultRef, artifactId, completionKey: digest(JSON.stringify(args)), resultDecisionVersion: session.decisionVersion ?? 0, reason: 'Stage accepted; its method is no longer active. Preserve project facts and work evidence.' }, { evidenceRef: resultRef });
  }
  if (action !== 'activate') throw new KodoError('TASK_ARGUMENTS', 'unsupported stage action');
  if (node.state === 'running' && (active?.nodeId === node.id || node.runId)) return { ...node, note: 'Already activated; current binding is unchanged.' };
  if (node.state !== 'pending' || !predecessorsSatisfied(graph, node)) throw new KodoError('TASK_NODE_BLOCKED', 'stage must be pending with completed prerequisites');
  if (active?.nodeId && active.nodeId !== node.id) throw new KodoError('METHOD_ACTIVE', 'finish or drop the current explicit stage before activating another');
  let member = store.cards.rosterSnapshot(session.id)?.members.find(item => item.card.id === args.card || methodSkillId(item.card) === args.card);
  if (node.continuation?.mode === 'resume' && node.boundCard) {
    const pinned = store.card(node.boundCard.id, node.boundCard.version);
    if (pinned.digest !== node.boundCard.digest) throw new KodoError('METHOD_IDENTITY', 'the original stage card is unavailable');
    if (args.card !== pinned.id && args.card !== methodSkillId(pinned)) throw new KodoError('METHOD_IDENTITY', 'resume keeps the original card; use redo to select another method');
    member = { card: pinned, availability: 'available', reasons: [], source: 'user', catalogPath: pinned.catalog?.path ?? 'methods/general', resolvedScope: node.boundScope };
  }
  if (!member || member.availability !== 'available') throw new KodoError('METHOD_UNAVAILABLE', 'select an available exact card from the current roster');
  const card = member.card;
  const requested = args.execution ?? node.needs?.execution ?? 'auto';
  const child = Boolean(requested === 'child' || requested === 'auto' && (card.model || card.members?.length || !card.execution?.modes.includes('inline')));
  const contract = child ? { tools: [], skills: [], permissions: run.permissions ?? session.permissions, scope: intersectFileScopes(run.scope, member.resolvedScope ?? card.constraints?.scope) } : methodContract(run, session, member);
  if (!child && (!card.execution?.modes.includes('inline') || card.model || card.members?.length)) throw new KodoError('METHOD_INCOMPATIBLE', 'this card requires independent execution');
  if (active) store.event(run.id, 'method.ended', { ...active, reason: 'replaced', replacedBy: methodSkillId(card) });
  if (!child) store.event(run.id, 'method.loaded', { id: methodSkillId(card), card: { id: card.id, version: card.version, digest: card.digest }, callId, contract, nodeId: node.id, generation: node.generation });
  const refs = (node.needs?.requiredRefs ?? []).map(ref => {
    const value = knowledge.read(run.id, ref);
    // The existing reuse gate checks source and decision freshness.
    knowledge.validateFor({ ...run, scope: contract.scope }, ref);
    return value;
  });
  const found = (node.needs?.knowledgeQueries ?? []).map(query => {
    const page = knowledge.search(run.id, { query });
    return { ...page, items: page.items.filter(item => {
      try { knowledge.validateFor({ ...run, scope: contract.scope }, item); return true; }
      catch (error) { if (error instanceof KodoError) return false; throw error; }
    }) };
  });
  if (child) {
    if (card.execution && !card.execution.modes.includes('child')) throw new KodoError('METHOD_INCOMPATIBLE', 'this card does not support independent execution');
    const result = invoke('spawn_agent', { agent: card.id, objective: node.goal, slots: args.inputs, context: JSON.stringify({ refs, found }) }) as { id: string };
    return moveTaskNode(store, run.id, node, 'running', { runId: result.id, activationCallId: callId, boundScope: contract.scope, boundCard: { id: card.id, version: card.version, digest: card.digest }, dependencies: currentDependencies(graph, node), resultDecisionVersion: session.decisionVersion ?? 0 });
  }
  if (!card.execution?.modes.includes('inline') || card.model || card.members?.length) throw new KodoError('METHOD_INCOMPATIBLE', 'this card requires independent execution');
  const inputs = validateSlots(store, run, card, contract.scope, args.inputs);
  const rules = (card.constraints?.rules ?? []).map(file => {
    const target = path.resolve(session.workspace, file); assertFileScope(contract.scope, 'read', session.workspace, target);
    const content = readFileSync(target, 'utf8'); if (content.length > 128000) throw new KodoError('METHOD_SIZE', 'rule file exceeds 128000 characters');
    return { file, content };
  });
  const result = { method: { id: methodSkillId(card), card: { id: card.id, version: card.version, digest: card.digest } }, methodInstance: callId, content: card.prompt, inputs, rules, knowledge: { refs, found }, requiredSkills: card.skills ?? [], contract, report: card.report ?? [],
    note: 'Use this method under the displayed execution contract. Previously active method instructions are no longer applicable; project facts and work history remain valid. Task completion requires an artifact and check evidence.' };
  if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024) throw new KodoError('METHOD_CAPACITY', 'stage method and required inputs exceed the tool result budget; split the stage or use paginated skill.load');
  const modelCall = store.recentModelCalls(run.id)[0];
  const request = modelCall ? store.readBlob<Parameters<Provider['complete']>[0]>(modelCall.requestRef) : undefined;
  const messages = request?.messages ?? store.readBlob<Message[]>(run.contextRef);
  const estimate = createInputTokenEstimator(store, run, request?.tools ?? []).estimate(messages) + estimateTextTokens(JSON.stringify(result));
  if (estimate > Math.min(run.modelLimits?.input ?? session.modelLimits?.input ?? Infinity, session.budget.maxContextTokens - session.budget.maxOutputTokens)) throw new KodoError('METHOD_CAPACITY', 'method and required inputs do not fit beside the current context and output reserve');
  moveTaskNode(store, run.id, node, 'running', { methodInstance: callId, activationCallId: callId, boundScope: contract.scope, boundCard: { id: card.id, version: card.version, digest: card.digest }, dependencies: currentDependencies(graph, node), resultDecisionVersion: session.decisionVersion ?? 0 });
  return result;
}
