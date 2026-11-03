import { statSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../storage/index.js';
import { assertFileScope, normalizeFileScope } from '../runtime/scope.js';
import { KodoError } from '../runtime/types.js';
import type { Card, FileScope, Run, ToolSpec } from '../runtime/types.js';

/** Validate task data before a child, its context or a queued event is committed. */
export function validateSlots(store: Store, parent: Run, card: Card, scope: FileScope, value: unknown): Record<string, unknown> {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new KodoError('INPUT_SLOTS', 'slots must be a named object');
  const slots = (value ?? {}) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(slots)) > 64_000) throw new KodoError('INPUT_SLOTS', 'input slots exceed 64000 bytes');
  const definitions = card.inputs ?? [];
  const errors: string[] = [];
  for (const name of Object.keys(slots)) if (!definitions.some(field => field.name === name)) errors.push(`${name}: undeclared slot`);
  for (const field of definitions) {
    const supplied = Object.hasOwn(slots, field.name);
    const item = slots[field.name];
    if (!supplied) { if (field.required) errors.push(`${field.name}: required`); continue; }
    if (field.kind === 'text') {
      if (typeof item !== 'string' || !item.trim()) errors.push(`${field.name}: expected nonempty text`);
    } else if (field.kind === 'artifact') {
      if (typeof item !== 'string' || !item.trim()) errors.push(`${field.name}: expected artifact id`);
      else {
        try { store.readArtifact(parent.id, item); }
        catch (error) { if (!(error instanceof KodoError)) throw error; errors.push(`${field.name}: artifact must resolve in this session`); }
      }
    } else if (field.kind === 'paths') {
      if (!Array.isArray(item) || item.length > 256 || (field.required && !item.length) || item.some(entry => typeof entry !== 'string')) { errors.push(`${field.name}: expected ${field.required ? 'nonempty ' : ''}path list`); continue; }
      const workspace = store.session(parent.sessionId).workspace;
      try {
        const roots = normalizeFileScope({ read: item as string[] }).read!;
        for (const root of roots) {
          const target = path.resolve(workspace, root);
          assertFileScope(scope, 'read', workspace, target);
          statSync(target);
        }
      } catch (error) {
        if (!(error instanceof KodoError) && !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        errors.push(`${field.name}: each path must exist within the child read scope`);
      }
    }
  }
  if (errors.length) throw new KodoError('INPUT_SLOTS', errors.join('; '));
  return structuredClone(slots);
}

export const reportSubmissionSpec: ToolSpec = {
  name: 'report.submit',
  description: 'Submit the structured fields declared by your agent card. Required fields must be present. calls fields reference settled tool calls from this run. A complete report proves neither successful checks nor parent acceptance; raw call status remains visible.',
  parameters: { type: 'object', additionalProperties: false, required: ['fields'], properties: { fields: { type: 'object', maxProperties: 32, additionalProperties: true } } },
};

/** Card fields are stable for the run; live call IDs stay out of the tool schema. */
export function reportSpecForCard(card: Card): ToolSpec {
  const fields = card.report ?? [];
  return { ...reportSubmissionSpec,
    description: 'Submit your declared report fields once checks are settled. For calls fields use an exact call_id from inspect_run or an unambiguous tool_call_id from your own tool messages; stored references are canonical. Reuse existing evidence instead of rerunning checks to produce a report. Completeness does not prove successful checks or parent acceptance.',
    parameters: { ...reportSubmissionSpec.parameters, properties: { fields: {
      type: 'object', additionalProperties: false,
      required: fields.filter(field => field.required).map(field => field.name),
      properties: Object.fromEntries(fields.map(field => [field.name, {
        ...(field.kind === 'text' ? { type: 'string', minLength: 1 } : { type: 'array', maxItems: 256, items: { type: 'string', minLength: 1 } }),
        description: [field.description, field.kind === 'calls' ? 'Settled tool-call IDs from this run; [] when no checks ran. Disclose unrun checks in your report.' : field.kind === 'paths' ? 'Workspace-relative paths.' : undefined].filter(Boolean).join(' '),
      }])),
    } } },
  };
}

