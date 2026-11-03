import type { Store } from '../storage/index.js';
import { normalizeFileScope } from './scope.js';
import { KodoError } from './types.js';
import type { Card, Run, ToolRequest, ToolSpec } from './types.js';

/**
 * The report tool stays available in this batch (1d narrows the collaboration
 * tools); the schema lives here because it is driven by the card report fields
 * that the runtime validates, not by any roster or card-selection subsystem.
 */
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

export interface ReportView {
  fields: Record<string, unknown>;
  calls: { id: string; name: string; status: string; resultRef?: string; exitCode?: unknown; passed?: unknown; timedOut?: unknown; cancelled?: unknown; error?: unknown }[];
}
export interface ReportCompleteness { status: 'not_required' | 'missing' | 'complete'; passed: boolean; feedback?: string; reportRef?: string; report?: ReportView }

/** Validate a structured member report against the host card fields and settled tool calls. */
export function validateReport(store: Store, run: Run, value: unknown): ReportView {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 64_000) throw new KodoError('REPORT_FIELDS', 'report fields must be an object of at most 64000 bytes');
  const fields = structuredClone(value) as Record<string, unknown>;
  const definitions = run.card.report ?? [];
  if (!definitions.length) throw new KodoError('REPORT_FIELDS', 'this card declares no report fields');
  const errors: string[] = [];
  const callViews = new Map<string, ReportView['calls'][number]>();
  const ownCalls = new Map(store.calls(run.id).filter(call => call.kind === 'tool').map(call => [call.id, call]));
  const aliases = new Map<string, string[]>();
  for (const call of ownCalls.values()) {
    const request = store.readBlob<Partial<ToolRequest> | null>(call.requestRef);
    if (typeof request?.id === 'string') aliases.set(request.id, [...aliases.get(request.id) ?? [], call.id]);
  }
  for (const name of Object.keys(fields)) if (!definitions.some(field => field.name === name)) errors.push(`${name}: undeclared field`);
  for (const field of definitions) {
    if (!Object.hasOwn(fields, field.name)) { if (field.required) errors.push(`${field.name}: required`); continue; }
    const item = fields[field.name];
    if (field.kind === 'text') {
      if (typeof item !== 'string' || !item.trim()) errors.push(`${field.name}: expected nonempty string`);
    } else {
      if (!Array.isArray(item) || item.length > 256 || item.some(entry => typeof entry !== 'string' || !entry.trim())) { errors.push(`${field.name}: expected string list`); continue; }
      if (field.kind === 'paths') {
        try { normalizeFileScope({ read: item as string[] }); }
        catch (error) { if (!(error instanceof KodoError)) throw error; errors.push(`${field.name}: expected workspace-relative paths`); }
      }
      if (field.kind === 'calls') for (const [index, id] of (item as string[]).entries()) {
        const matches = aliases.get(id) ?? [];
        if (!ownCalls.has(id) && matches.length > 1) { errors.push(`${field.name}: ${id} is ambiguous; use an exact call_id from inspect_run`); continue; }
        const call = ownCalls.get(id) ?? (matches.length === 1 ? ownCalls.get(matches[0]!) : undefined);
        if (!call || !['succeeded', 'failed', 'cancelled'].includes(call.status)) { errors.push(`${field.name}: ${id} must reference a settled tool call from this run`); continue; }
        (item as string[])[index] = call.id;
        const result = call.resultRef ? store.readBlob<unknown>(call.resultRef) : undefined;
        const evidence = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
        callViews.set(call.id, { id: call.id, name: call.name, status: call.status, ...(call.resultRef ? { resultRef: call.resultRef } : {}), ...Object.fromEntries(['exitCode', 'passed', 'timedOut', 'cancelled', 'error'].filter(key => Object.hasOwn(evidence, key)).map(key => [key, evidence[key]])) });
      }
    }
  }
  if (errors.length) throw new KodoError('REPORT_FIELDS', errors.join('; '));
  return { fields: structuredClone(fields), calls: [...callViews.values()] };
}

export function submitReport(store: Store, run: Run, fields: unknown): { status: 'complete'; reportRef: string; report: ReportView } {
  if (!run.parentId) throw new KodoError('ROLE_DENIED', 'report.submit is a member-agent operation');
  const report = validateReport(store, run, fields);
  const reportRef = store.blob(report);
  store.event(run.id, 'report.submitted', { reportRef, decisionVersion: run.decisionVersion ?? 0, cardDigest: run.card.digest });
  return { status: 'complete', reportRef, report };
}

export function reportCompleteness(store: Store, run: Run): ReportCompleteness {
  if (!run.parentId || !run.card.report?.length) return { status: 'not_required', passed: true };
  const event = store.latestEvent(run.id, { types: ['report.submitted'], match: { decisionVersion: run.decisionVersion ?? 0, cardDigest: run.card.digest } });
  if (typeof event?.data.reportRef !== 'string') return { status: 'missing', passed: false, feedback: `Use report.submit with the card report fields before finishing: ${JSON.stringify(run.card.report)}.` };
  const report = store.readBlob<ReportView>(event.data.reportRef);
  try { return { status: 'complete', passed: true, reportRef: event.data.reportRef, report: validateReport(store, run, report.fields) }; }
  catch (error) {
    if (!(error instanceof KodoError)) throw error;
    return { status: 'missing', passed: false, feedback: error.message };
  }
}

/** Host checks keep their own outcome even when no final result was committed. */
export function hostAcceptanceStatus(store: Store, run: Run): 'passed' | 'failed' | 'not_checked' {
  const checked = store.latestEvent(run.id, { types: ['completion.checked'], match: { decisionVersion: run.decisionVersion ?? 0 } });
  if (checked?.data.qualityPassed === true) return 'passed';
  if (checked?.data.qualityPassed === false) return 'failed';
  return 'not_checked';
}
