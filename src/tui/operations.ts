import type { CreateRunOptions } from '../application/index.js';
import { parseCard } from '../agents/card.js';
import { caseDigest } from '../cases/schema.js';
import { KodoError } from '../runtime/types.js';
import type { ModelBinding, Provider, Run } from '../runtime/types.js';
import type { AgentAuthoringHost } from './agent-authoring.js';
import type { AgentCaseHost } from './agent-cases.js';
import type { TuiOptions } from './types.js';

interface Hooks {
  binding: ModelBinding;
  signal?: AbortSignal;
  executeRun(request: CreateRunOptions, signal: AbortSignal, purpose?: 'authoring' | 'case', onCreated?: (run: Run) => void): Promise<Run>;
}

/** Authoring and cases use the same recorded, budgeted runtime as ordinary tasks. */
export function createAgentOperations(options: TuiOptions, hooks: Hooks): { authoringHost: AgentAuthoringHost; caseHost?: AgentCaseHost } {
  const { app } = options;
  // CLI options include absent optional fields as undefined; frozen case records are JSON.
  const binding = JSON.parse(JSON.stringify(hooks.binding)) as ModelBinding;
  const bounded = (value: number | null | undefined, ceiling: number): number => Math.min(value ?? ceiling, ceiling);
  const model: Provider = { async complete(request, signal) {
    if (request.tools.length) throw new KodoError('TUI_AUTHORING', 'Authoring requests do not allow tool execution.');
    const combined = AbortSignal.any([signal, ...(hooks.signal ? [hooks.signal] : [])]);
    combined.throwIfAborted();
    const instructions = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const objective = request.messages.filter(message => message.role !== 'system').map(message => message.content ?? '').join('\n\n');
    const card = parseCard(`---\n${JSON.stringify({ schema_version: 1, id: 'builtin/tui-authoring', version: '1.0.0', name: 'Agent method author', description: 'Generate reviewable local method drafts without executing tools.', capabilities: { tools: [] } })}\n---\n${instructions}`, { toolNames: [] });
    const run = await hooks.executeRun({ objective, card, workspace: options.workspace, binding,
      permissions: [], scope: { read: [], write: [] }, finalResponse: 'required', toolChoice: 'none',
      budget: { ...options.budget, maxModelCalls: bounded(options.budget?.maxModelCalls, 1), maxToolCalls: 1, maxChildren: 1,
        maxOutputTokens: bounded(options.budget?.maxOutputTokens, request.maxOutputTokens), maxDurationMs: bounded(options.budget?.maxDurationMs, 120_000) },
    }, combined, 'authoring');
    combined.throwIfAborted();
    if (run.status !== 'completed' || !run.resultRef) throw new KodoError('TUI_AUTHORING', `Authoring run ${run.status}: ${run.error ?? 'No complete method was generated; no draft was written.'}`);
    const result = app.store.readBlob<{ text: string }>(run.resultRef);
    return { message: { role: 'assistant', content: result.text }, finishReason: 'stop' };
  } };
  const allowedTools = app.coordinator.tools.availableNames().filter(name => !name.startsWith('mcp.') && !name.startsWith('package.'));
  const authoringHost: AgentAuthoringHost = { binding, allowedTools, model, signal: hooks.signal };
  if (!options.activatePackageAt) return { authoringHost };
  const activate = options.activatePackageAt;
  const caseHost: AgentCaseHost = {
    binding, permissions: options.permissions, commands: options.caseCommands, signal: hooks.signal,
    hostPolicyDigest: async installed => caseDigest(JSON.parse(JSON.stringify({
      host: options.hostPolicyDigest ?? null, budget: options.budget ?? null,
      bindings: await options.registry.bindings(installed.card.id, installed.card.version), commands: options.caseCommands ?? {},
    })) as unknown),
    execute: async (input, installed) => {
      const signal = AbortSignal.any([input.signal, ...(hooks.signal ? [hooks.signal] : [])]);
      signal.throwIfAborted();
      const card = await activate(installed.card.id, installed.card.version, input.workspace, signal);
      signal.throwIfAborted();
      const objective = input.data === undefined ? input.objective : `${input.objective}\n\nFrozen case input data:\n${JSON.stringify(input.data)}`;
      const run = await hooks.executeRun({ objective, card, workspace: input.workspace, binding,
        permissions: input.permissions, scope: input.scope,
        budget: { ...options.budget, maxDurationMs: bounded(options.budget?.maxDurationMs, 120_000), maxModelCalls: bounded(options.budget?.maxModelCalls, 30), maxToolCalls: bounded(options.budget?.maxToolCalls, 100) },
      }, signal, 'case', run => input.recordExecution?.(run.id));
      return { runId: run.id, status: run.status, output: run.resultRef ? app.store.readBlob<{ text: string }>(run.resultRef).text : '' };
    },
  };
  return { authoringHost, caseHost };
}
