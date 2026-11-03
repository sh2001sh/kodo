import type { ToolSpec } from '../runtime/types.js';
import { defaultMaxTaskNodes } from '../runtime/task-declare.js';
import type { TaskNodeSpec } from '../runtime/task-graph.js';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required });
const id = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const ids = { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 64, pattern: id.source } };
const stringList = { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 1024 } };
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const taskCheck = object({ program: { type: 'string', minLength: 1, maxLength: 1024 }, args: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 4096 } }, timeoutMs: { type: 'integer', minimum: 1, maximum: 86400000 } }, ['program', 'args']);

export const builtinRoles: readonly string[] = ['explorer', 'implementer', 'tester', 'reviewer'];

export const delegateSpec: ToolSpec = {
  name: 'delegate',
  description: 'Delegate independent tasks with clear interfaces/ownership; keep tightly coupled work together. Children get snapshots after dependencies integrate. Missing parent behavior: owner:"self" plus after. Roles: explorer, implementer, tester, reviewer. start: relative files/symbols and confirmed environment/facts, distinguishing implemented behavior from plans. scope: literal write paths. acceptance: behavior, interfaces, compatibility, open questions. Executable snapshot children need targeted check:{program,args,timeoutMs?}; failure blocks integration. Shared tasks use acceptance. Children own focused checks; main does independent work and integrated project checks. Redeclare/remove only unstarted nodes.',
  parameters: object({ tasks: { type: 'array', minItems: 0, maxItems: defaultMaxTaskNodes, items: object({ id: { type: 'string', minLength: 1, maxLength: 64, pattern: id.source }, goal: text, owner: { enum: ['self'] }, role: { type: 'string', minLength: 1, maxLength: 256 }, after: ids, start: stringList, scope: stringList, acceptance: text, check: taskCheck }, ['id', 'goal']) }, remove: ids }, ['tasks']),
};

export const taskToolSpec: ToolSpec = {
  name: 'task',
  description: 'Operate on graph nodes. done finishes a self node after dependencies; drop settles with reason; inspect reads evidence; wait durably waits for node_ids (mode any/all; no waitMs). send supplies input; cancel/interrupt stop a node. accept confirms stale results only. recheck retries host verification on a completed child, optionally replacing check, without a model. resume keeps checkout/context/generation; needs_input/failed may replace scope/check and always rechecks. File moves need both paths in scope; explain in input. redo uses a fresh snapshot/generation. release discards a settled checkout. Pass node_id and reason/input as needed.',
  parameters: object({ action: { enum: ['done', 'drop', 'inspect', 'wait', 'send', 'cancel', 'interrupt', 'accept', 'resume', 'recheck', 'redo', 'release'] }, node_id: { type: 'string', minLength: 1, maxLength: 64, pattern: id.source }, node_ids: ids, mode: { enum: ['any', 'all'] }, reason: text, input: text, note: text, scope: stringList, check: taskCheck,
    call_id: { type: 'string', minLength: 1, maxLength: 256 }, section: { enum: ['result', 'report', 'acceptance'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, content_offset: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 256, maximum: 32000 },
  }, ['action']),
};

export const findAgentsSpec: ToolSpec = {
  name: 'find_agents',
  description: 'Find up to 5 custom specialists in the frozen roster by task/capability. Returns card IDs, versions, use-cases and input requirements. Built-in roles are listed in delegate.',
  parameters: object({ query: { type: 'string', minLength: 10, maxLength: 500 } }),
};

export function isTaskNodeSpec(value: unknown): value is TaskNodeSpec {
  return Boolean(value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' && typeof (value as { goal?: unknown }).goal === 'string');
}
