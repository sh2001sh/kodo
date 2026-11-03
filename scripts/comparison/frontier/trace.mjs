// Builds a harness-neutral step trace from relay evidence: per model request, its timing, full reasoning,
// visible text and tool calls, then the tool results the harness sent back in the next request.
// Usage: node trace.mjs EVIDENCE_DIR [EVIDENCE_DIR ...]  (writes <cell>/process/steps.jsonl, transcript.md, summary.json)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Reassembles one response (SSE stream or JSON body) into reasoning, content and tool calls. */
export function parseResponse(text) {
  const out = { reasoning: '', content: '', toolCalls: [], malformedEvents: 0, protocol: { doneSeen: false, finishReasons: [], errorSeen: false } };
  const tools = new Map();
  const apply = message => {
    out.reasoning += String(message.reasoning_content ?? message.reasoning ?? '');
    out.content += String(message.content ?? '');
    for (const [position, call] of (message.tool_calls ?? []).entries()) {
      const slot = call.index ?? position;
      const entry = tools.get(slot) ?? { id: '', name: '', arguments: '' };
      entry.id += call.id ?? '';
      entry.name += call.function?.name ?? '';
      entry.arguments += call.function?.arguments ?? '';
      tools.set(slot, entry);
    }
  };
  const record = (value, streamed) => {
    if (value.error || ['error', 'new_api_error', 'get_channel_failed'].includes(value.type) || value.code === 'get_channel_failed') out.protocol.errorSeen = true;
    for (const choice of value.choices ?? []) {
      if (choice.finish_reason) out.protocol.finishReasons.push(choice.finish_reason);
      apply((streamed ? choice.delta : choice.message) ?? {});
    }
  };
  if (text.trimStart().startsWith('{')) {
    try { record(JSON.parse(text), false); } catch { out.malformedEvents++; }
  } else {
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { out.protocol.doneSeen = true; continue; }
      try { record(JSON.parse(data), true); } catch { out.malformedEvents++; }
    }
  }
  out.toolCalls = [...tools.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  return out;
}

/** Protocol/transport evidence is not a native model-success or tool-execution record. */
export function responseStatus(call, response) {
  const transportStatus = call.status ?? (call.error ? 'failed' : 'completed');
  const reasons = response.protocol.finishReasons;
  const normalFinish = reasons.length > 0 && reasons.every(reason => ['stop', 'tool_calls'].includes(reason));
  const protocolStatus = call.httpStatus >= 400 || response.protocol.errorSeen || response.malformedEvents ? 'error'
    : response.protocol.doneSeen ? normalFinish ? 'completed' : 'incomplete'
      : reasons.some(reason => !['stop', 'tool_calls'].includes(reason)) ? 'incomplete' : 'unknown';
  const status = protocolStatus === 'error' || protocolStatus === 'incomplete' ? 'failed'
    : protocolStatus === 'completed' ? 'completed' : transportStatus;
  return { status, transportStatus, protocolStatus, nativeStatus: null };
}

/** Messages the harness appended after the model's previous turn: tool results and runtime notices. */
export function followUps(messages) {
  const last = messages.findLastIndex(message => message.role === 'assistant');
  return last < 0 ? [] : messages.slice(last + 1).map(message => ({ role: message.role, toolCallId: message.tool_call_id, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }));
}

const read = file => existsSync(file) ? readFileSync(file, 'utf8') : null;

/** Label of a message for cache diagnostics: role plus a runtime marker kind when the harness tagged one. */
function messageKind(message) {
  const text = typeof message?.content === 'string' ? message.content : '';
  const tag = /^<kodo-[a-z]+ kind="([a-z-]+)"/u.exec(text)?.[1];
  if (tag) return `${message.role}:${tag}`;
  if (text.startsWith('Current run task list')) return `${message.role}:todo`;
  if (text.startsWith('Task progress')) return `${message.role}:progress`;
  return message?.role ?? 'missing';
}

/**
 * How much of the previous request this request resends unchanged. A provider prefix
 * cache can reuse at most the shared leading messages, and nothing when tools changed.
 */
export function prefixShare(previous, current) {
  if (!previous || !current) return null;
  const before = previous.messages ?? [];
  const after = current.messages ?? [];
  let shared = 0;
  while (shared < before.length && shared < after.length && JSON.stringify(before[shared]) === JSON.stringify(after[shared])) shared++;
  const toolsChanged = JSON.stringify(previous.tools ?? null) !== JSON.stringify(current.tools ?? null);
  // The last previous message is usually the per-request state frame; diverging there is expected.
  const expected = !toolsChanged && shared >= before.length - 1;
  return {
    sharedMessages: shared, previousMessages: before.length, toolsChanged, expected,
    ...(expected ? {} : { divergedAt: { index: shared, before: messageKind(before[shared]), after: messageKind(after[shared]) } }),
  };
}
const reasoningTokens = usage => usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens ?? null;

/** Only host system messages identify a run; quoted user/tool text must not group requests. */
export function requestRunId(request) {
  const ids = new Set();
  for (const message of request?.messages ?? []) {
    if (message.role !== 'system' || typeof message.content !== 'string') continue;
    for (const match of message.content.matchAll(/(?:^|[.!?]\s+|\n)Run ID:\s*([\w-]+)(?=\.|\s|$)/gu)) ids.add(match[1]);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

const parseRequest = text => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

export function buildSteps(relay) {
  const calls = JSON.parse(readFileSync(path.join(relay, 'calls.json'), 'utf8')).sort((a, b) => a.startedMs - b.startedMs);
  const entries = calls.map(call => {
    const request = parseRequest(read(path.join(relay, `request-${call.index}.json`)));
    return { call, request, runId: requestRunId(request), response: parseResponse(read(path.join(relay, `response-${call.index}.txt`)) ?? '') };
  });
  const idCounts = new Map();
  for (const entry of entries) for (const tool of entry.response.toolCalls) {
    const key = `${entry.runId ?? 'unknown'}:${tool.id}`;
    idCounts.set(key, (idCounts.get(key) ?? 0) + 1);
  }
  const previousByRun = new Map();
  return entries.map(({ call, request, runId, response }, position) => {
    const previous = runId ? previousByRun.get(runId) : null;
    if (runId) previousByRun.set(runId, request);
    const prefix = previous ? prefixShare(previous, request) : null;
    // Never equate unidentified, potentially interleaved harness requests to one run.
    const nextEntry = runId ? entries.slice(position + 1).find(entry => entry.runId === runId) : entries[position + 1];
    const ids = new Set(response.toolCalls.filter(tool => idCounts.get(`${runId ?? 'unknown'}:${tool.id}`) === 1).map(tool => tool.id));
    const results = [];
    const seen = new Set();
    // Match results by call id, even when compaction or additional assistant turns move them.
    for (const entry of entries.slice(position + 1)) {
      if (runId && entry.runId !== runId) continue;
      for (const message of entry.request?.messages ?? []) {
        if (message.role !== 'tool' || !ids.has(message.tool_call_id) || seen.has(message.tool_call_id)) continue;
        seen.add(message.tool_call_id);
        results.push({ role: 'tool', toolCallId: message.tool_call_id, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) });
      }
      if (seen.size === ids.size) break;
    }
    // Runtime notices may only be attributed when the next request's run is known.
    if (runId && nextEntry) results.push(...followUps(nextEntry.request?.messages ?? []).filter(message => message.role !== 'tool'));
    const endMs = call.startedMs + (call.timing?.streamEndMs ?? call.elapsedMs ?? 0);
    const next = nextEntry?.call;
    const httpFailed = call.httpStatus >= 400;
    const statuses = responseStatus(call, response);
    return {
      step: position + 1, index: call.index, runId, prefixStatus: runId ? previous ? 'compared' : 'first' : 'unknown',
      startedAt: call.startedAt, startedMs: call.startedMs, endedMs: endMs,
      ...statuses, httpStatus: call.httpStatus ?? null,
      transportError: call.error ?? null,
      error: statuses.status === 'completed' ? null : call.error ?? (httpFailed ? `HTTP ${call.httpStatus}` : statuses.protocolStatus === 'incomplete' ? 'MODEL_INCOMPLETE' : null),
      modelSec: (endMs - call.startedMs) / 1000, gapAfterSec: next ? Math.max(0, next.startedMs - endMs) / 1000 : null,
      gapScope: runId ? 'run' : 'adjacent-unidentified',
      timing: call.timing ?? null, finishReasons: call.finishReasons ?? [],
      inputTokens: call.usage?.prompt_tokens ?? null, cachedTokens: call.usage?.prompt_tokens_details?.cached_tokens ?? null,
      outputTokens: call.usage?.completion_tokens ?? null, reasoningTokens: reasoningTokens(call.usage), credit: call.usage?.credit ?? null,
      messages: call.messageCount ?? null, prefix, requestToolNames: (request?.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? 'unknown'),
      ambiguousResultIds: response.toolCalls.filter(tool => !ids.has(tool.id)).map(tool => tool.id), ...response, results,
    };
  });
}

const clip = (text, limit) => text.length > limit ? `${text.slice(0, limit)}\n… [${text.length - limit} more characters in steps.jsonl]` : text;
const fence = text => `~~~~\n${text.replaceAll('~~~~', '~ ~ ~ ~')}\n~~~~`;

export function transcript(cell, steps) {
  const lines = [`# ${cell} step transcript`, '', 'Times are relay-measured. Long sections are clipped here; steps.jsonl has full text.', ''];
  for (const step of steps) {
    const t = step.timing;
    const phases = t ? ` · headers ${t.headersMs ?? '-'} ms · reasoning ${t.firstReasoningMs ?? '-'}–${t.lastReasoningMs ?? '-'} ms · tools ${t.firstToolMs ?? '-'}–${t.lastToolMs ?? '-'} ms` : '';
    const after = step.toolSec !== null && step.toolSec !== undefined ? ` · then tools ${step.toolSec.toFixed(1)} s + harness ${step.harnessSec?.toFixed(1) ?? '-'} s` : ` · then ${step.gapAfterSec?.toFixed(1) ?? '-'} s`;
    lines.push(`## Step ${step.step} · ${step.status}${step.error ? ` (${step.error})` : ''} · model ${step.modelSec.toFixed(1)} s${phases}${after}`);
    lines.push('', `input ${step.inputTokens ?? '?'} (cached ${step.cachedTokens ?? '?'}) · output ${step.outputTokens ?? '?'} (reasoning ${step.reasoningTokens ?? '?'}) · finish ${step.finishReasons.join(',') || '-'}`, '');
    if (step.reasoning) lines.push(`### Reasoning (${step.reasoning.length} chars)`, '', fence(clip(step.reasoning, 6000)), '');
    if (step.content) lines.push('### Text', '', fence(clip(step.content, 4000)), '');
    for (const call of step.toolCalls) lines.push(`### Tool call \`${call.name}\``, '', fence(clip(call.arguments, 3000)), '');
    for (const result of step.results) lines.push(`### ${result.role === 'tool' ? 'Tool result' : `Harness ${result.role} message`}`, '', fence(clip(result.content, 3000)), '');
  }
  return lines.join('\n');
}

export function summarize(steps, includeRuns = true) {
  const sum = key => steps.reduce((total, step) => total + (step[key] ?? 0), 0);
  const toolNames = {};
  for (const step of steps) for (const call of step.toolCalls) toolNames[call.name] = (toolNames[call.name] ?? 0) + 1;
  return {
    ...(includeRuns ? { byRun: Object.fromEntries([...new Set(steps.map(step => step.runId).filter(Boolean))].map(id => [id, summarize(steps.filter(step => step.runId === id), false)])), unidentifiedRequests: steps.filter(step => !step.runId).length } : {}),
    requests: steps.length, failedRequests: steps.filter(step => step.status !== 'completed').length,
    transportTerminations: Object.fromEntries([...new Set(steps.map(step => step.transportStatus ?? step.status))].map(status => [status, steps.filter(step => (step.transportStatus ?? step.status) === status).length])),
    protocolOutcomes: Object.fromEntries([...new Set(steps.map(step => step.protocolStatus ?? 'unknown'))].map(status => [status, steps.filter(step => (step.protocolStatus ?? 'unknown') === status).length])),
    nativeOutcomeNote: 'Relay protocol completion does not establish native model acceptance or actual tool execution; reconcile native records separately.',
    modelSec: Math.round(sum('modelSec')), gapSec: Math.round(sum('gapAfterSec')),
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), reasoningTokens: sum('reasoningTokens'),
    reasoningChars: steps.reduce((total, step) => total + step.reasoning.length, 0), toolCalls: steps.reduce((total, step) => total + step.toolCalls.length, 0), toolNames,
    slowestSteps: [...steps].sort((a, b) => b.modelSec - a.modelSec).slice(0, 5).map(step => ({ step: step.step, modelSec: step.modelSec, reasoningTokens: step.reasoningTokens })),
    longestGaps: [...steps].sort((a, b) => (b.gapAfterSec ?? 0) - (a.gapAfterSec ?? 0)).slice(0, 5).map(step => ({ afterStep: step.step, gapSec: step.gapAfterSec, tools: step.toolCalls.map(call => call.name) })),
    // Structural clues only: relay text cannot establish provider caching or causal attribution.
    cacheDrops: steps.filter(step => step.inputTokens && step.cachedTokens !== null && step.cachedTokens / step.inputTokens < 0.5 && step.prefixStatus !== 'first' && step.step > 1).map(step => ({
      step: step.step, cachedShare: Math.round(step.cachedTokens / step.inputTokens * 100) / 100, credit: step.credit,
      cause: !step.prefix ? 'unknown' : step.prefix.expected ? 'intact-prefix' : step.prefix.toolsChanged ? 'tools-changed' : `prefix-changed:${step.prefix.divergedAt.before}`,
    })),
  };
}

/** Attributes each inter-request gap to tool execution (from the harness's own records) and the remainder to the harness. */
export function attributeGaps(steps, tools) {
  const occurrences = new Map();
  for (const step of steps) for (const call of step.toolCalls) occurrences.set(call.id, (occurrences.get(call.id) ?? 0) + 1);
  const byId = new Map(tools.filter(tool => tool.runId || occurrences.get(tool.callId) === 1).map(tool => [tool.runId ? `${tool.runId}:${tool.callId}` : tool.callId, tool]));
  for (const step of steps) {
    const timed = step.toolCalls.map(call => byId.get(`${step.runId}:${call.id}`) ?? byId.get(call.id)).filter(tool => tool?.startMs && tool?.endMs);
    // Parallel calls overlap; the span from first start to last end is the wall time spent in tools.
    step.toolSec = timed.length ? (Math.max(...timed.map(tool => tool.endMs)) - Math.min(...timed.map(tool => tool.startMs))) / 1000 : null;
    step.harnessSec = step.gapAfterSec !== null && step.toolSec !== null ? Math.max(0, step.gapAfterSec - step.toolSec) : null;
  }
  return steps;
}

/** Writes process/steps.jsonl, transcript.md and summary.json for one cell. */
export async function writeTrace(cellDir, cell, tools = []) {
  const relay = path.join(cellDir, 'relay');
  if (!existsSync(path.join(relay, 'calls.json'))) return null;
  const steps = attributeGaps(buildSteps(relay), tools);
  const out = path.join(cellDir, 'process');
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'steps.jsonl'), steps.map(step => JSON.stringify(step)).join('\n') + '\n');
  await writeFile(path.join(out, 'transcript.md'), transcript(cell, steps));
  const summary = { ...summarize(steps), toolSec: Math.round(steps.reduce((total, step) => total + (step.toolSec ?? 0), 0)), harnessSec: Math.round(steps.reduce((total, step) => total + (step.harnessSec ?? 0), 0)), toolTimingsKnown: tools.length > 0 };
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { exportNative } = await import('./native.mjs');
  for (const evidence of process.argv.slice(2)) {
    for (const cell of readdirSync(evidence, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
      const cellDir = path.join(evidence, cell);
      const harness = cell.slice(cell.lastIndexOf('-') + 1);
      const tools = await exportNative(cellDir, harness).catch(error => { process.stderr.write(`${cell}: native export failed: ${error.message}\n`); return []; });
      const summary = await writeTrace(cellDir, cell, tools);
      if (summary) process.stdout.write(`${cell}: ${summary.requests} steps, model ${summary.modelSec}s, tools ${summary.toolSec}s, harness ${summary.harnessSec}s, reasoning ${summary.reasoningTokens}\n`);
    }
  }
}
