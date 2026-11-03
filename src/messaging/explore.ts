import type { Run, ToolSpec } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';
import type { delegationState } from './spawn-spec.js';
import { todoIdSchema } from './spawn-spec.js';

export type Thoroughness = 'quick' | 'medium' | 'thorough';
export interface ExploreTask { prompt: string; scope?: string[]; thoroughness?: Thoroughness; todoId?: string }
export const maxExploreTasks = 4;
/** Each explore report is delivered whole up to this size; the rest stays readable through inspect_run. */
export const exploreReportChars = 8000;

const depth: Record<Thoroughness, string> = {
  quick: 'quick (fact lookup): locate the answer with a few targeted searches and reads.',
  medium: 'medium (call chain): follow the main code paths and confirm conclusions in the source.',
  thorough: 'thorough (cross-module conflict): check several locations, naming conventions and edge cases before concluding.',
};

/** Mechanics live here; when to explore is stated once in the main-agent system prompt. */
export const exploreSpec: ToolSpec & { main: true; control: true } = {
  name: 'explore',
  main: true,
  control: true,
  description: [
    'Run 1-4 read-only investigations in parallel child agents and wait for all of them.',
    'Each child has scoped file read/list/search tools (or the read-only configuration you select) and none of your history, so write a self-contained prompt: the question, what you already found (files, search hits), the read scope, and what evidence is enough to stop.',
    'Use quick for fact lookups, medium for call chains, thorough only for cross-module conflicts.',
    'Every report (conclusion, key files with line numbers, open questions) arrives in your next input; wait_for_events and inspect_run are not needed unless a report is truncated or the wait times out.',
    'Must be the last tool and the only control call.',
    'Example: {"tasks":[{"prompt":"Find where HTTP retries are configured and how backoff is computed","scope":["src"]}]}',
  ].join(' '),
  parameters: {
    type: 'object', additionalProperties: false, required: ['tasks'],
    properties: {
      tasks: { type: 'array', minItems: 1, maxItems: maxExploreTasks, items: {
        type: 'object', additionalProperties: false, required: ['prompt'],
        properties: {
          prompt: { type: 'string', minLength: 1, maxLength: 16_000, description: 'Self-contained question with known leads, the facts to report, and when the evidence is enough to stop.' },
          scope: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, maxItems: 256, description: 'Relative read roots, e.g. "src"; omit to use your read scope.' },
          thoroughness: { enum: ['quick', 'medium', 'thorough'], description: 'Search depth; default medium.' },
          todoId: todoIdSchema,
        },
      } },
    },
  },
};

/** Report instructions appended to each child's task packet. */
export function exploreInstructions(thoroughness: Thoroughness): string {
  return `Read-only investigation. Depth ${depth[thoroughness]} Do not change files. Stop as soon as the evidence answers the question or meets the stated end condition; widen the search only when sources contradict each other, and report what stays unresolved instead of searching on for completeness. Your final response is the report delivered to the main agent: lead with the conclusion, then key files with line numbers and the observed facts, then anything unresolved or uncertain. Keep it under about 1,500 tokens and plain text; no JSON contract is required.`;
}

export interface ExploreDeps {
  state: () => ReturnType<typeof delegationState>;
  prepare: (args: Record<string, unknown>, explore: NonNullable<Run['explore']>) => Run;
  commit: (child: Run) => Record<string, unknown>;
  register: (runIds: string[]) => Record<string, unknown>;
}

/**
 * Create one read-only child per task and register an all-wait in the caller's transaction.
 * Every child is prepared before any is committed, so a rejected task creates nothing.
 */
export function commitExplore(callId: string, args: Record<string, unknown>, deps: ExploreDeps): Record<string, unknown> {
  const tasks = args.tasks as ExploreTask[];
  if (tasks.some(task => !task.prompt.trim())) throw new KodoError('TOOL_ARGUMENTS', 'every explore task needs a nonblank prompt');
  const state = deps.state();
  if (state.children.remaining !== null && state.children.remaining < tasks.length) throw new KodoError('CHILD_BUDGET', `explore needs ${tasks.length} children but only ${state.children.remaining} child slots remain under the active or cumulative limit; wait for active work to finish or use fewer tasks`);
  if (!state.canSpawn) throw new KodoError('CHILD_BUDGET', 'explore cannot start children: shared model call or token budget is exhausted or this run cannot delegate; investigate directly');
  const prepared = tasks.map(task => deps.prepare(
    { objective: task.prompt, permissions: ['read'], scope: { ...(task.scope ? { read: task.scope } : {}), write: [] }, ...(task.todoId ? { todoId: task.todoId } : {}) },
    { callId, thoroughness: task.thoroughness ?? 'medium' },
  ));
  const runs = prepared.map(child => deps.commit(child));
  const wait = deps.register(prepared.map(child => child.id));
  return { ...wait, runs: runs.map(run => ({ id: run.id, status: run.status, scope: run.scope })), note: 'Reports arrive in your next input when every child has finished.' };
}
