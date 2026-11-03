// Offline v2 contract replay: serialization-only, zero model cost, read-only state.
//
// Reads the recorded retention-budget-repair trials (SQLite opened readOnly plus the
// immutable JSON blobs) and replays the *recorded raw* summary responses through the
// built dist/ parser, planner and projection. It does not open a writable Store, does
// not call a provider, does not install anything, and does not prove semantic quality,
// task continuation or cost savings. Token counts use Kodo's conservative estimator,
// not a provider tokenizer.
//
// Usage: node scripts/comparison/compaction-contract-replay.mjs
import fs from 'node:fs';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = process.cwd();
const trialsRoot = path.join(root, '.kodo/qa-retention-budget-repair-real-20261023-235818');
const outFile = path.join(root, '.kodo/research/compaction-audit-20261024/replay-v2.json');
const dist = relative => pathToFileURL(path.join(root, 'dist', relative)).href;
const requiredDist = [
  'runtime/summary-projection.js', 'runtime/summary-schema.js', 'runtime/summary-input.js',
  'runtime/context-tokens.js', 'runtime/context.js', 'providers/model-limits.js',
];
for (const file of requiredDist) {
  if (!fs.existsSync(path.join(root, 'dist', file))) {
    console.error(`FAIL dist/${file} is missing; run "npm run build" before this replay`);
    process.exit(2);
  }
}
const { planSummaryProjection, projectSummary } = await import(dist('runtime/summary-projection.js'));
const { parseSummary, extractSummaryJson } = await import(dist('runtime/summary-schema.js'));
const { SummarySources, historySource, previewOf } = await import(dist('runtime/summary-input.js'));
const { estimateTextTokens, createInputTokenEstimator } = await import(dist('runtime/context-tokens.js'));
const { summaryPrefix } = await import(dist('runtime/context.js'));
const { contextOutputReserve } = await import(dist('providers/model-limits.js'));

const checks = [];
function check(name, ok, detail) {
  const passed = Boolean(ok);
  checks.push({ name, ok: passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  return passed;
}
function isShortId(id) { return typeof id === 'string' && /^S[1-9]\d*$/.test(id); }
function errorCode(fn) {
  try { fn(); return 'NO_ERROR'; } catch (error) { return error?.code ?? String(error).slice(0, 80); }
}

/** Read one recorded trial without ever opening a writable database. */
function readTrial(trial) {
  const dir = path.join(trialsRoot, trial, 'kodo-state');
  const database = new DatabaseSync(path.join(dir, 'kodo.sqlite'), { readOnly: true });
  const rows = sql => database.prepare(sql).all();
  const events = rows('SELECT seq,type,data FROM events ORDER BY seq').map(row => ({ seq: row.seq, type: row.type, ...JSON.parse(row.data) }));
  const runs = rows('SELECT data FROM runs').map(row => JSON.parse(row.data));
  const sessions = rows('SELECT data FROM sessions').map(row => JSON.parse(row.data));
  const calls = rows('SELECT id,data FROM calls').map(row => ({ id: row.id, ...JSON.parse(row.data) }));
  const blob = ref => JSON.parse(fs.readFileSync(path.join(dir, 'blobs', `${ref}.json`), 'utf8'));
  return { trial, dir, events, runs, sessions, calls, blob, close: () => database.close() };
}

/**
 * Rebuild the host source index exactly like the product: pinned user messages in
 * archive order first, then every covered message in coverage order, following the
 * nested contextHidden / preview pointers back to the recorded original observation.
 */
function rebuildSources(archive, archivedRef, coveredOffsets, blob) {
  const fold = new Set(coveredOffsets);
  const sources = new SummarySources();
  archive.messages.forEach((message, index) => {
    if (!fold.has(index) && message.role === 'user') sources.add(historySource(archivedRef, index, previewOf(message)));
  });
  for (const offset of coveredOffsets) {
    let message = archive.messages[offset];
    let ref = archivedRef;
    let position = offset;
    for (let depth = 0; depth < 32 && message.role === 'tool'; depth++) {
      let value;
      try { value = JSON.parse(message.content); } catch { break; }
      const pointer = value?.contextHidden && value.read?.tool === 'history.read' ? value.read.args : value?.preview ? value.history : undefined;
      if (!pointer) break;
      ref = pointer.ref;
      position = pointer.offset;
      message = blob(ref).messages[position];
    }
    sources.add(historySource(ref, position, previewOf(message)));
  }
  return sources;
}

/** New-contract display budget derived from the recorded trial numbers. */
function budgetForTrial(trial) {
  const start = trial.events.find(event => event.type === 'context.summary.started');
  const archive = trial.blob(start.archivedRef);
  const fold = new Set(start.coveredOffsets);
  const retainedMessages = archive.messages.filter((_, index) => !fold.has(index));
  const compacted = trial.events.find(event => event.type === 'context.compacted');
  const run = trial.runs.find(item => item.step === 0) ?? trial.runs[0];
  const session = trial.sessions[0];
  // The estimator only consults the store for prefix calibration; there is none here
  // (this is the first compaction attempt of the recorded run), so an empty lookup is
  // exact, and the production estimator itself supplies the measurement.
  const retainedTokens = createInputTokenEstimator({ recentModelCalls: () => [] }, run, []).estimate(retainedMessages);
  const builtTokens = compacted.afterTokens;
  const workInputTokens = compacted.workInputTokens;
  const maxContextTokens = session.budget.maxContextTokens;
  const maxOutputTokens = session.budget.maxOutputTokens;
  const modelInput = run.modelLimits?.input ?? session.modelLimits?.input;
  const safeInput = Math.max(1, Math.min(modelInput ?? maxContextTokens,
    maxContextTokens - contextOutputReserve(session.budget) - Math.max(1024, Math.floor(maxContextTokens * 0.02))));
  const evidenceReserve = Math.min(8192, Math.max(256, Math.floor(workInputTokens * 0.05)));
  const capacityGuard = Math.max(0, builtTokens - retainedTokens - 64);
  const workGuard = Math.max(0, Math.min(workInputTokens, safeInput) - retainedTokens - evidenceReserve - 256);
  const displayBudgetTokens = Math.max(0, Math.min(capacityGuard, workGuard));
  const requestedBodyTokens = Math.min(8192, Math.floor(workInputTokens * 0.08), maxOutputTokens);
  return {
    start, archive, fold, retainedMessages, run, session, compacted,
    builtTokens, retainedTokens, workInputTokens, safeInput, evidenceReserve, capacityGuard, workGuard,
    displayBudgetTokens, requestedBodyTokens,
    plan: planSummaryProjection({ displayBudgetTokens, requestedBodyTokens }),
  };
}

function compactionResponses(trial) {
  const byCall = new Map(trial.calls.map(call => [call.id, call]));
  const responses = [];
  for (const event of trial.events) {
    if (event.type !== 'model.started' || event.purpose !== 'compaction') continue;
    const call = byCall.get(event.callId);
    if (!call || call.status !== 'succeeded' || !call.resultRef) continue;
    const raw = extractSummaryJson(trial.blob(call.resultRef)?.message?.content ?? null);
    if (raw) responses.push({ chunk: event.chunk, repair: Boolean(event.repair), retry: Boolean(event.retry), callId: call.id, requestRef: call.requestRef, raw });
  }
  return responses;
}

/** Source ids the summarizer actually saw in the chunk-1 request, in request order. */
function chunkCoveredOffsets(trial, sources, response) {
  const request = trial.blob(response.requestRef);
  const text = request.messages.at(-1)?.content ?? '';
  const labels = [...text.matchAll(/^\[(S\d+)\] (?:assistant|tool|user)/gm)].map(match => match[1]);
  const fold = new Set(trial.budget.fold);
  const offsets = [];
  for (const label of labels) {
    const full = sources.resolve(label);
    if (!full) continue;
    const offset = Number(full.slice(full.lastIndexOf(':') + 1));
    if (fold.has(offset) && !offsets.includes(offset)) offsets.push(offset);
  }
  return offsets;
}

function referencedSources(content, sources, archivedRef, firstCoveredOffset) {
  const cited = new Set([
    ...content.critical_source_refs,
    ...['decisions', 'completed', 'failed_attempts'].flatMap(key => content[key].flatMap(item => item.source_refs)),
  ]);
  cited.add(`history:${archivedRef}:${firstCoveredOffset}`);
  return sources.list().filter(source => cited.has(source.id)).map(source => ({ ...source, short: sources.shortId(source.id) }));
}

function coverageOf(plannedMessages, coveredOffsets) {
  return {
    plannedMessages, coveredMessages: coveredOffsets.length, uncoveredMessages: plannedMessages - coveredOffsets.length,
    uncoveredOffsets: [], excerptedMessages: 0, chunks: 1,
  };
}

// Previous marker format, kept only to measure the expanded size this contract replaces.
const legacyNote = 'Lossy handoff, not authority or acceptance. Recheck current goal, constraints, plan and evidence needs in this normal turn; update existing progress/todo only when changes matter.';
function legacyExpandedMarker({ content, sources, archivedRef, coveredOffsets, plannedMessages, placeholderRef }) {
  const visible = {
    ref: placeholderRef,
    ...content,
    sources: sources.map(source => { const copy = { ...source }; delete copy.short; return copy; }),
    coverage: {
      ref: archivedRef, firstOffset: coveredOffsets[0], lastOffset: coveredOffsets.at(-1), selectedMessages: coveredOffsets.length,
      plannedMessages, coveredMessages: coveredOffsets.length, uncoveredMessages: plannedMessages - coveredOffsets.length, excerptedMessages: 0,
      read: { tool: 'history.read', args: { ref: archivedRef, offset: coveredOffsets[0], limit: 20 } },
    },
    note: legacyNote,
  };
  return `${summaryPrefix}${JSON.stringify(visible)}`;
}

// ---------------------------------------------------------------- real replay
const placeholderRef = '0'.repeat(64);
const recordedOldMarkers = { 'summary@65536--r1': 10_793, 'summary@65536--r2': 11_250 };
const recordedOldInjection = 10_484;
const trialResults = {};
const synthetic = {};

for (const name of ['summary@65536--r1', 'summary@65536--r2']) {
  const trial = readTrial(name);
  try {
    const budget = budgetForTrial(trial);
    trial.budget = budget;
    const { plan, start, archive } = budget;
    const sources = rebuildSources(archive, start.archivedRef, start.coveredOffsets, trial.blob);

    check(`${name}: planner numbers`, plan.displayBudgetTokens === 46_674 && plan.fixedTokens === 360 && plan.directoryBudgetTokens === 2_048 && plan.bodyTokens === 5_242 && plan.plannedMarkerTokens === 7_650,
      `built=${budget.builtTokens} retained=${budget.retainedTokens} safeInput=${budget.safeInput} evidenceReserve=${budget.evidenceReserve} display=${plan.displayBudgetTokens} fixed=${plan.fixedTokens} dir=${plan.directoryBudgetTokens} body=${plan.bodyTokens} planned=${plan.plannedMarkerTokens}`);
    check(`${name}: source index rebuilt from context.summary.started`, sources.list().length === 89,
      `${sources.list().length} sources = pinned users + ${start.coveredOffsets.length} covered messages`);

    const response = compactionResponses(trial).find(item => item.chunk === 1 && !item.repair);
    check(`${name}: recorded chunk-1 response found`, Boolean(response), response ? `call ${response.callId.slice(0, 8)} rawChars ${response.raw.length}` : 'missing');
    if (response) {
      const coveredOffsets = chunkCoveredOffsets(trial, sources, response);
      const content = parseSummary(response.raw, id => sources.resolve(id), new Set(), plan.bodyTokens * 4);
      const envelopeSources = referencedSources(content, sources, start.archivedRef, coveredOffsets[0]);
      const coverage = coverageOf(start.coverage.plannedMessages, coveredOffsets);
      const projected = projectSummary({
        plan, summaryRef: placeholderRef, archivedRef: start.archivedRef, content,
        sources: envelopeSources, coverage, firstOffset: coveredOffsets[0], lastOffset: coveredOffsets.at(-1),
      });
      const legacyTokens = estimateTextTokens(legacyExpandedMarker({
        content, sources: envelopeSources, archivedRef: start.archivedRef, coveredOffsets,
        plannedMessages: start.coverage.plannedMessages, placeholderRef,
      }));
      const rawTokens = estimateTextTokens(response.raw);
      const visible = projected.visible;
      const shortRefs = [...visible.decisions, ...visible.completed, ...visible.failed_attempts].flatMap(item => item.source_refs);
      const reductionOldInjection = Number(((1 - projected.tokens / recordedOldInjection) * 100).toFixed(1));
      const reductionLegacy = Number(((1 - projected.tokens / legacyTokens) * 100).toFixed(1));
      const directoryEntries = visible.sources;

      check(`${name}: raw chunk-1 body fits the planned body budget`, rawTokens <= plan.bodyTokens,
        `body=${rawTokens} <= plan.bodyTokens=${plan.bodyTokens} (rawChars=${response.raw.length})`);
      check(`${name}: projected marker fits the display budget`, projected.tokens <= plan.displayBudgetTokens,
        `marker=${projected.tokens} <= displayBudget=${plan.displayBudgetTokens}`);
      check(`${name}: projected marker inside contract target range 5500-7500`, projected.tokens >= 5_500 && projected.tokens <= 7_500, `marker=${projected.tokens}`);
      check(`${name}: projected marker below planned upper bound`, projected.tokens <= plan.plannedMarkerTokens && plan.plannedMarkerTokens <= plan.displayBudgetTokens,
        `marker=${projected.tokens} planned=${plan.plannedMarkerTokens}`);
      check(`${name}: projected marker far below old injection budget`, projected.tokens <= recordedOldInjection * 0.7,
        `marker=${projected.tokens} vs oldInjection=${recordedOldInjection} (${reductionOldInjection}% lower)`);
      check(`${name}: projected marker below reconstructed legacy expanded marker`, projected.tokens < legacyTokens,
        `marker=${projected.tokens} vs legacy=${legacyTokens} (${reductionLegacy}% lower; recorded old marker ${recordedOldMarkers[name]})`);
      const legacyDelta = Math.abs(legacyTokens - recordedOldMarkers[name]) / recordedOldMarkers[name];
      check(`${name}: reconstructed legacy marker matches the recorded old marker within 2%`, legacyDelta <= 0.02,
        `legacy=${legacyTokens} recorded=${recordedOldMarkers[name]} delta=${(legacyDelta * 100).toFixed(2)}%`);
      check(`${name}: marker carries short ids only, no expanded history refs`, shortRefs.every(isShortId) && !projected.text.includes('history:') && !('critical_source_refs' in visible),
        `${shortRefs.length} cited refs, prefix=${projected.text.startsWith(summaryPrefix)}`);
      check(`${name}: marker has the exact v2 key shape`, JSON.stringify(Object.keys(visible)) === JSON.stringify(['ref', 'goal', 'decisions', 'completed', 'failed_attempts', 'pending', 'hypotheses', 'knowledge_refs', 'sources', 'coverage', 'read', 'note']),
        `keys=${Object.keys(visible).join(',')}`);
      check(`${name}: directory bounded by plan (entries/tokens)`, directoryEntries.length > 0 && directoryEntries.length <= plan.maxDirectorySources && projected.directoryTokens <= plan.directoryBudgetTokens,
        `directorySources=${projected.directorySources}/${plan.maxDirectorySources} directoryTokens=${projected.directoryTokens}/${plan.directoryBudgetTokens}`);
      check(`${name}: directory entries are short-id previews`, directoryEntries.every(entry => isShortId(entry.ref) && typeof entry.preview === 'string' && entry.preview.length <= plan.maxPreviewChars && Object.keys(entry).join(',') === 'ref,preview'),
        `previews<=${plan.maxPreviewChars}`);
      check(`${name}: covered offsets parsed from the recorded chunk request`, coveredOffsets.length > 0 && coveredOffsets.every(offset => budget.fold.has(offset)),
        `chunk1Messages=${coveredOffsets.length} of planned ${start.coverage.plannedMessages}`);
      check(`${name}: projected marker counts agree with parsed coverage`, visible.coverage.covered === coveredOffsets.length && visible.coverage.planned === start.coverage.plannedMessages && visible.coverage.uncovered === visible.coverage.planned - visible.coverage.covered && visible.coverage.chunks === 1,
        `covered=${visible.coverage.covered} planned=${visible.coverage.planned} uncovered=${visible.coverage.uncovered} chunks=${visible.coverage.chunks}`);
      check(`${name}: one coverage read entry and one read hint`, visible.coverage?.read?.tool === 'history.read' && visible.read?.tool === 'history.read' && (projected.text.match(/"tool":"history\.read"/g) ?? []).length === 2,
        `tool entries=${(projected.text.match(/"tool":"history\.read"/g) ?? []).length}`);
      check(`${name}: envelope source index keeps every referenced source`, envelopeSources.length === 24 && envelopeSources.every(source => isShortId(source.short) && source.id.startsWith('history:')),
        `envelopeSources=${envelopeSources.length} (legacy critical refs still archived, not displayed)`);

      trialResults[name] = {
        trial: name,
        state: { builtTokens: budget.builtTokens, retainedTokens: budget.retainedTokens, workInputTokens: budget.workInputTokens, safeInput: budget.safeInput, evidenceReserve: budget.evidenceReserve, capacityGuard: budget.capacityGuard, workGuard: budget.workGuard },
        plan: {
          displayBudgetTokens: plan.displayBudgetTokens, fixedTokens: plan.fixedTokens, directoryBudgetTokens: plan.directoryBudgetTokens,
          bodyTokens: plan.bodyTokens, plannedMarkerTokens: plan.plannedMarkerTokens,
          maxItems: plan.maxItems, maxSourceRefsPerStatement: plan.maxSourceRefsPerStatement, maxDirectorySources: plan.maxDirectorySources, maxPreviewChars: plan.maxPreviewChars,
        },
        chunk1: {
          responseCallId: response.callId, retry: response.retry, rawChars: response.raw.length, rawBodyTokens: rawTokens,
          markerTokens: projected.tokens, markerBodyTokens: projected.bodyTokens, directoryTokens: projected.directoryTokens,
          directorySources: projected.directorySources, envelopeSources: envelopeSources.length,
          coveredMessages: coveredOffsets.length, plannedMessages: start.coverage.plannedMessages,
          oldInjectionBudget: recordedOldInjection, recordedOldMarkerTokens: recordedOldMarkers[name],
          reconstructedLegacyMarkerTokens: legacyTokens, reductionVsOldInjectionPct: reductionOldInjection, reductionVsLegacyMarkerPct: reductionLegacy,
          withinDisplayBudget: projected.tokens <= plan.displayBudgetTokens, installableBody: rawTokens <= plan.bodyTokens,
        },
        chunk2: null,
      };
    }

    if (name.endsWith('r2')) {
      const chunk2 = compactionResponses(trial).find(item => item.chunk === 2 && !item.repair);
      check('summary@65536--r2: recorded chunk-2 response found', Boolean(chunk2), chunk2 ? `call ${chunk2.callId.slice(0, 8)} rawChars ${chunk2.raw.length}` : 'missing');
      if (chunk2) {
        const parsedJson = JSON.parse(chunk2.raw);
        const criticalRefs = Array.isArray(parsedJson.critical_source_refs) ? parsedJson.critical_source_refs.length : -1;
        const bodyTokens = estimateTextTokens(chunk2.raw);
        const parseCode = errorCode(() => parseSummary(chunk2.raw, id => sources.resolve(id), new Set(), plan.bodyTokens * 4));
        check('summary@65536--r2: chunk-2 legacy response has 37 critical_source_refs', criticalRefs === 37, `critical_source_refs=${criticalRefs}`);
        check('summary@65536--r2: chunk-2 passes the v2 structural parser', parseCode === 'NO_ERROR', `parseResult=${parseCode}`);
        check('summary@65536--r2: chunk-2 body exceeds the planned body budget', bodyTokens > plan.bodyTokens,
          `body=${bodyTokens} > plan.bodyTokens=${plan.bodyTokens} (rawChars=${chunk2.raw.length} <= charCeiling=${plan.bodyTokens * 4})`);
        check('summary@65536--r2: chunk-2 classified as needing bounded repair, not installable as-is', parseCode === 'NO_ERROR' && bodyTokens > plan.bodyTokens,
          'structure valid; body over budget => one bounded repair required before install');
        trialResults[name].chunk2 = {
          responseCallId: chunk2.callId, rawChars: chunk2.raw.length, rawBodyTokens: bodyTokens,
          criticalSourceRefs: criticalRefs, structuralParse: parseCode, charCeiling: plan.bodyTokens * 4,
          bodyOverBudget: bodyTokens > plan.bodyTokens, classification: 'needs-bounded-repair', installableAsIs: false,
        };
      }
    }
  } finally {
    trial.close();
  }
}

// ------------------------------------------------------ synthetic contract cases
{
  const trial = readTrial('summary@65536--r1');
  try {
    const budget = budgetForTrial(trial);
    const { start, archive } = budget;
    const sources = rebuildSources(archive, start.archivedRef, start.coveredOffsets, trial.blob);
    const resolver = id => sources.resolve(id);
    const base = { goal: 'Boundary replay.', decisions: [], completed: [], failed_attempts: [], pending: [], hypotheses: [], knowledge_refs: [] };
    const parse = (value, maxChars = 40_000) => parseSummary(JSON.stringify(value), resolver, new Set(), maxChars);

    const boundary = {};
    for (const count of [30, 31, 37]) {
      const cited = Array.from({ length: count }, (_, index) => `S${(index % 20) + 1}`);
      const code = errorCode(() => parse({ ...base, critical_source_refs: cited }));
      const parsed = code === 'NO_ERROR' ? parse({ ...base, critical_source_refs: cited }) : null;
      boundary[`critical_${count}`] = { parse: code, uniqueAfterDedupe: parsed?.critical_source_refs.length ?? null };
      check(`synthetic: ${count} critical_source_refs accepted under the v2 caps`, code === 'NO_ERROR' && parsed?.critical_source_refs.length === 20,
        `parse=${code} uniqueAfterDedupe=${parsed?.critical_source_refs.length ?? 'n/a'}`);
    }
    synthetic.boundary = boundary;

    const dup = parse({ ...base, decisions: [{ text: 'Dedupe.', source_refs: ['S1', 'S1', 'S2'] }], critical_source_refs: ['S1', 'S1', 'S2', 'S2'] });
    check('synthetic: duplicate refs deduped per array', dup.decisions[0].source_refs.length === 2 && dup.critical_source_refs.length === 2,
      `statementRefs=${dup.decisions[0].source_refs.length} criticalRefs=${dup.critical_source_refs.length}`);
    synthetic.dedupe = { statementRefs: dup.decisions[0].source_refs, criticalRefs: dup.critical_source_refs };

    const unknown = errorCode(() => parse({ ...base, decisions: [{ text: 'Unknown.', source_refs: ['S999999'] }] }));
    const numeric = errorCode(() => parse({ ...base, decisions: [{ text: 'Numeric.', source_refs: ['2'] }] }));
    check('synthetic: unknown and bare-numeric refs still fail explicitly', unknown === 'SUMMARY_SOURCE' && numeric === 'SUMMARY_SOURCE',
      `unknown=${unknown} numeric=${numeric}`);
    synthetic.rejected = { unknown, numeric };

    const reverse = new SummarySources();
    for (const source of [...sources.list()].reverse()) reverse.add({ ...source });
    const firstId = sources.list()[0].id;
    const crossAlias = reverse.resolve('S1') !== firstId;
    const stale = sources.resolve('S999999') === null;
    const emptyIndex = new SummarySources().resolve('S1') === null;
    check('synthetic: short ids are checkpoint-local (pure mapping)', crossAlias && stale && emptyIndex,
      're-registered order maps S1 to a different source; unknown/stale ids resolve to null (readSummarySource needs a live Store, out of scope for this read-only replay)');
    synthetic.checkpointBinding = { crossMappingDiffers: crossAlias, unknownResolvesNull: stale, emptyIndexResolvesNull: emptyIndex };

    const sevenKey = parse(base);
    const eightKey = parse({ ...base, critical_source_refs: ['S1'] });
    check('synthetic: 7-key and legacy 8-key responses both accepted', sevenKey.critical_source_refs.length === 0 && eightKey.critical_source_refs.length === 1,
      `7key critical=${sevenKey.critical_source_refs.length}; 8key critical=${eightKey.critical_source_refs.length}`);
    synthetic.keys = { sevenKey: 'accepted', eightKey: 'accepted', legacyCriticalArchived: eightKey.critical_source_refs.length === 1 };
  } finally {
    trial.close();
  }
}

// ------------------------------------------------------------------- reporting
const failedChecks = checks.filter(item => !item.ok);
const summary = {
  pass: failedChecks.length === 0,
  total: checks.length,
  passed: checks.length - failedChecks.length,
  failed: failedChecks.length,
};
const output = {
  generatedAt: new Date().toISOString(),
  scope: 'Serialization/contract replay only: recorded raw responses re-parsed and re-projected with the built pure dist functions. No Store write, no provider call, no installation, no semantic or cost proof.',
  estimator: 'Kodo estimateTextTokens / production input estimator; conservative estimate, not a provider tokenizer.',
  readOnlyInputs: 'node:sqlite readOnly + immutable JSON blobs under .kodo/qa-retention-budget-repair-real-20261023-235818',
  disclaimer: 'PASS here means the recorded serialized responses satisfy the v2 parse/projection contract. It does NOT prove atomic install, semantic quality, task continuation, or cost savings.',
  planner: {
    workInputTokens: 65_536,
    oldInjectionBudget: recordedOldInjection,
    recordedOldMarkers,
    formula: 'displayBudget=max(0,min(built-retained-64, min(H,safeInput)-retained-evidenceReserve-256)); requestedBody=min(8192,8%H,maxOutput); planSummaryProjection(displayBudget, requestedBody)',
  },
  trials: trialResults,
  synthetic,
  checks,
  summary,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`);
console.log(`\nReplay summary written to ${path.relative(root, outFile)}`);
console.log(`RESULT: ${summary.pass ? 'PASS' : 'FAIL'} (${summary.passed}/${summary.total} checks)`);
if (!recordingSanity()) process.exitCode = 1;
function recordingSanity() {
  if (failedChecks.length) return false;
  const r1 = trialResults['summary@65536--r1']?.chunk1;
  const r2 = trialResults['summary@65536--r2'];
  return Boolean(r1 && r2?.chunk1 && r2.chunk2 && r2.chunk2.structuralParse === 'NO_ERROR' && r2.chunk2.installableAsIs === false);
}
