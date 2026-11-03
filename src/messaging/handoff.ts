import type { ToolSpec } from '../runtime/types.js';

export const leadHandoffGuidance = 'Delegate once entry points, module boundaries, shared interfaces and acceptance checks are clear; do not design the entire implementation first. Pass confirmed facts, starting paths and symbols, unresolved questions and ownership boundaries using context/inputs. Each owner implements and checks its work. While a child works, handle independent work and dependencies instead of repeating its exploration. Reuse the same owner with followup_task for corrections or related work; use a fresh child for independent review or unrelated work. Children cannot inspect sibling runs: copy the relevant findings into context/inputs, or write a shared artifact and pass its ID. Handle simple reading, questions and small document edits directly; do not delegate solely to finish a report.';

/** Rendering only: preserves schemas, permissions and disabled-factor bytes. */
export function handoffSpec<T extends ToolSpec>(spec: T): T {
  if (!['spawn_agent', 'followup_task'].includes(spec.name)) return spec;
  const descriptions: Record<string, string> = {
    objective: 'Concrete behavior to deliver.',
    context: 'Confirmed interfaces, open questions and ownership boundaries.',
    inputs: 'Starting files/symbols, known facts or shared artifact IDs; copy sibling findings.',
    acceptance: 'Checks and reusable evidence IDs; include required branch/commit operations.',
  };
  const properties = Object.fromEntries(Object.entries(spec.parameters.properties as Record<string, Record<string, unknown>>).map(([name, schema]) => [name, descriptions[name] ? { ...schema, description: descriptions[name] } : schema]));
  const configured = spec.description.includes(' Active child limit:') ? spec.description.slice(spec.description.indexOf(' Active child limit:')) : '';
  return { ...spec, description: (spec.name === 'spawn_agent'
    ? 'Start a child without parent history; pass known entry points. Keep implementation and checks together; parallel writes need disjoint scopes. Returns a run ID: work independently, then wait_for_events and inspect_run. Reuse owners with followup_task; explore creates and waits for read-only work.'
    : 'Continue a finished owner in a new run, retaining identity/model/context. Supply goal, required slots and new checks. Busy: use send_message. Different model: create a child. Old reports are not new acceptance.') + configured,
  parameters: { ...spec.parameters, properties } };
}

export function childHandoffGuidance(readOnly: boolean, taskProtocol?: 1 | 2 | 3): string {
  if (taskProtocol === 3) return `Start from supplied files, symbols, confirmed facts and valid check commands; do not repeat excluded searches or the parent’s orientation. Read supplied artifact IDs with artifact.read. ${readOnly ? '' : 'Read current contents before editing and own the implementation with its focused checks. '}Expand investigation only for a concrete missing dependency or contradiction. Reuse prior results only when their code, inputs and environment still apply. Return actual evidence and unresolved requirements; do not create extra reports or rerun unchanged checks merely to summarize. Stop when the requested result is delivered. Wait for dependencies through coordination, not shell polling.`;
  if (taskProtocol === 2) return `Start from supplied files, symbols and facts. Read an artifact ID with artifact.read; use the supplied contract as the single source of behavior, not a second rewritten specification. ${readOnly ? '' : 'Read current contents before editing and own the implementation with its focused checks. '}Expand investigation only for a concrete missing dependency or contradiction. Keep a review to the requested change and risk questions; report unavailable evidence and uncovered cases. Stop when the task and required evidence are delivered. Use messages or task dependencies to wait for other owners, not shell polling.`;
  return `Start from the files and symbols supplied in Inputs, context and named slots; do not rediscover known entry points. ${readOnly ? '' : 'Read current file contents before editing. '}Expand investigation only when supplied facts conflict with code or required dependencies are missing; report the conflict or missing information. Reuse supplied evidence when it still applies.`;
}
