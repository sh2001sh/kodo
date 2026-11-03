// Zero-cost E0 attribution for the frozen Task A continuation run.
// Reads SQLite and immutable blobs in read-only mode, never imports a provider,
// never resolves credentials, and never mutates the recorded experiment.
import { createHash } from 'node:crypto';
import console from 'node:console';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(import.meta.dirname, '..', '..');
const defaultInput = path.join(repository, '.kodo', 'continuation-paid-20261024-a');
const defaultOutput = path.join(repository, '.kodo', 'research', 'compaction-e0-20261024');
const placeholderRef = '0'.repeat(64);

const digest = value => createHash('sha256').update(value).digest('hex');
const asNumber = value => Number.isFinite(value) ? Number(value) : 0;
const round = value => Math.round(value * 1000) / 1000;

function parseArguments(argv) {
  const result = { input: defaultInput, output: defaultOutput };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--input' || name === '--out') {
      const value = argv[++index];
      if (!value) throw new Error(`${name} requires a path`);
      if (name === '--input') result.input = path.resolve(value);
      else result.output = path.resolve(value);
    } else if (name === '--help' || name === '-h') result.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(name)}`);
  }
  return result;
}

function readExperiment(inputRoot) {
  const taskRoot = path.join(inputRoot, 'task-a');
  const stateRoot = path.join(taskRoot, 'kodo-state');
  const databasePath = path.join(stateRoot, 'kodo.sqlite');
  for (const file of [databasePath, path.join(taskRoot, 'report.json'), path.join(inputRoot, 'runner.json')]) {
    if (!existsSync(file)) throw new Error(`required frozen evidence is missing: ${file}`);
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const parseRows = table => database.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row, ...JSON.parse(row.data) }));
  const events = database.prepare('SELECT seq,type,time,data FROM events ORDER BY seq').all().map(row => ({ seq: row.seq, type: row.type, time: row.time, ...JSON.parse(row.data) }));
  const runs = parseRows('runs');
  const sessions = parseRows('sessions');
  const calls = parseRows('calls');
  const blob = ref => JSON.parse(readFileSync(path.join(stateRoot, 'blobs', `${ref}.json`), 'utf8'));
  return {
    inputRoot, taskRoot, stateRoot, database, events, runs, sessions, calls, blob,
    report: JSON.parse(readFileSync(path.join(taskRoot, 'report.json'), 'utf8')),
    runner: JSON.parse(readFileSync(path.join(inputRoot, 'runner.json'), 'utf8')),
  };
}

function pointerOf(message) {
  if (message?.role !== 'tool') return null;
  try {
    const value = JSON.parse(message.content);
    if (value?.contextHidden && value.read?.tool === 'history.read') return value.read.args;
    if (value?.preview) return value.history;
  } catch { /* plain tool result */ }
  return null;
}

function resolveOriginal(archiveRef, offset, message, blob) {
  let current = message;
  let ref = archiveRef;
  let position = offset;
  const visited = new Set();
  for (let depth = 0; depth < 32; depth++) {
    const pointer = pointerOf(current);
    if (!pointer || typeof pointer.ref !== 'string' || !Number.isSafeInteger(pointer.offset)) break;
    const key = `${pointer.ref}:${pointer.offset}`;
    if (visited.has(key)) throw new Error(`cyclic history pointer at ${key}`);
    visited.add(key);
    const restored = blob(pointer.ref)?.messages?.[pointer.offset];
    if (!restored) throw new Error(`history pointer cannot be resolved: ${key}`);
    ref = pointer.ref;
    position = pointer.offset;
    current = restored;
  }
  return { ref, offset: position, message: current };
}

function evidenceIdentity(resolved) {
  const message = resolved.message;
  if (message.role === 'tool') return `tool:${message.tool_call_id}`;
  if (message.role === 'assistant' && message.tool_calls?.length) return `assistant:${message.tool_calls.map(call => call.id).join(',')}`;
  return `${message.role}:${digest(JSON.stringify(message))}`;
}

function hiddenOriginalTokens(messages) {
  let count = 0;
  let tokens = 0;
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    try {
      const value = JSON.parse(message.content);
      if (!value?.contextHidden) continue;
      count++;
      tokens += Number.isSafeInteger(value.originalTokens) ? value.originalTokens : Math.ceil(asNumber(value.originalChars) / 4);
    } catch { /* plain tool result */ }
  }
  return { count, tokens };
}

function addSource(sources, source) {
  return sources.add(source);
}

function rebuildSources({ archive, start, previousEnvelope, blob, SummarySources, historySource, previewOf }) {
  const fold = new Set(start.coveredOffsets);
  const sources = new SummarySources(previousEnvelope?.sources ?? []);
  archive.messages.forEach((message, index) => {
    if (!fold.has(index) && message.role === 'user' && message.content !== previousEnvelope?.marker) {
      addSource(sources, historySource(start.archivedRef, index, previewOf(message)));
    }
  });
  const identities = [];
  for (const offset of start.coveredOffsets) {
    const resolved = resolveOriginal(start.archivedRef, offset, archive.messages[offset], blob);
    addSource(sources, historySource(resolved.ref, resolved.offset, previewOf(resolved.message)));
    identities.push({
      id: evidenceIdentity(resolved), ref: resolved.ref, offset: resolved.offset,
      role: resolved.message.role, toolCallId: resolved.message.tool_call_id ?? null,
    });
  }
  return { sources, identities };
}

function sourceAvailable(source, blob) {
  const match = /^history:([a-f0-9]{64}):(\d+)$/.exec(source.id);
  if (!match) return true;
  try { return Boolean(blob(match[1])?.messages?.[Number(match[2])]); }
  catch { return false; }
}

function referencedSources(content, sources, archivedRef, firstOffset) {
  const cited = new Set([
    ...content.critical_source_refs,
    ...content.decisions.flatMap(item => item.source_refs),
    ...content.completed.flatMap(item => item.source_refs),
    ...content.failed_attempts.flatMap(item => item.source_refs),
    `history:${archivedRef}:${firstOffset}`,
  ]);
  return sources.list().filter(source => cited.has(source.id)).map(source => ({ ...source, short: sources.shortId(source.id) }));
}

function callAccounting(events, start, terminal) {
  const selected = events.filter(event => event.seq >= start.seq && event.seq <= terminal.seq && event.type === 'model.finished' && event.purpose === 'compaction');
  const started = new Map(events.filter(event => event.type === 'model.started').map(event => [event.callId, event]));
  return {
    requests: selected.length,
    input: selected.reduce((sum, event) => sum + asNumber(event.usage?.input), 0),
    output: selected.reduce((sum, event) => sum + asNumber(event.usage?.output), 0),
    cacheRead: selected.reduce((sum, event) => sum + asNumber(event.usage?.cacheRead), 0),
    cacheWrite: selected.reduce((sum, event) => sum + asNumber(event.usage?.cacheWrite), 0),
    elapsedMs: selected.reduce((sum, event) => sum + Math.max(0, Date.parse(event.time) - Date.parse(started.get(event.callId)?.time ?? event.time)), 0),
    missingUsage: selected.filter(event => !event.usage).length,
    callIds: selected.map(event => event.callId),
  };
}

function normalWorkBetween(events, terminal, next) {
  if (!next) return null;
  const selected = events.filter(event => event.seq > terminal.seq && event.seq < next.seq);
  return {
    modelRequests: selected.filter(event => event.type === 'model.started' && !event.purpose).length,
    toolObservations: selected.filter(event => event.type === 'tool.finished').length,
    elapsedMs: Math.max(0, Date.parse(next.time) - Date.parse(terminal.time)),
  };
}

function overlap(current, previous, weights) {
  if (!previous) return { messages: 0, messageRate: 0, tokens: 0, tokenRate: 0 };
  const old = new Set(previous.map(item => item.id));
  const shared = current.filter(item => old.has(item.id));
  const allTokens = current.reduce((sum, item) => sum + (weights.get(item.id) ?? 0), 0);
  const sharedTokens = shared.reduce((sum, item) => sum + (weights.get(item.id) ?? 0), 0);
  return {
    messages: shared.length,
    messageRate: current.length ? round(shared.length / current.length) : 0,
    tokens: sharedTokens,
    tokenRate: allTokens ? round(sharedTokens / allTokens) : 0,
  };
}

function markdown(result) {
  const lines = [
    '# Task A E0 离线触发归因', '',
    `生成时间：${result.generatedAt}。输入：\`${result.input}\`。本报告只读既有 SQLite/blob，未调用 provider。`, '',
    '## 历史事实', '',
    `- 运行完成，验收 ${result.historical.verification}；摘要尝试 ${result.historical.attempts} 次，安装 ${result.historical.installs} 次，确定性失败 ${result.historical.failures} 次。`,
    `- 全运行 ${result.historical.modelRequests} 次模型请求、${result.historical.totalTokens.toLocaleString('en-US')} token；摘要维护 ${result.historical.compactionRequests} 次请求、${result.historical.compactionTokens.toLocaleString('en-US')} token。`,
    '- 四次已付费摘要尝试都发生在活动输入估算超过 H 的时刻；归档中没有 `contextHidden` 正文，因此本批没有触发到 hidden-history-only 分支。', '',
    '| 尝试 | seq/step | 活动输入 / H | 折叠消息 | 与上次重叠（消息/token） | 新证据 | display / v2.1 hard body | 原结果 | 维护请求/token |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |',
  ];
  for (const item of result.attempts) {
    lines.push(`| ${item.index} | ${item.seq}/${item.step} | ${item.trigger.activeInputTokens.toLocaleString('en-US')} / ${item.trigger.workInputTokens.toLocaleString('en-US')} | ${item.fold.messages} | ${Math.round(item.fold.overlap.messageRate * 100)}% / ${Math.round(item.fold.overlap.tokenRate * 100)}% | ${item.fold.newMessages} | ${item.budgets.displayBudgetTokens.toLocaleString('en-US')} / ${item.counterfactual.hardBodyTokens.toLocaleString('en-US')} | ${item.historical.outcome} | ${item.maintenance.requests} / ${(item.maintenance.input + item.maintenance.output).toLocaleString('en-US')} |`);
  }
  lines.push('', '## v2.1 同响应反事实', '',
    '这里复用旧模型已经返回的同一 JSON，只替换当前预算/规范化计量代码；它不是新模型运行。', '',
    '| 尝试 | 规范正文 | 硬上限 | marker / display | 模拟安装后输入 | 判定 |',
    '| ---: | ---: | ---: | ---: | ---: | --- |');
  for (const item of result.attempts) {
    const counter = item.counterfactual;
    lines.push(`| ${item.index} | ${counter.bodyTokens.toLocaleString('en-US')} | ${counter.hardBodyTokens.toLocaleString('en-US')} | ${counter.markerTokens.toLocaleString('en-US')} / ${item.budgets.displayBudgetTokens.toLocaleString('en-US')} | ${counter.afterTokens.toLocaleString('en-US')} | ${counter.accepted ? '可接受' : `拒绝：${counter.error}`} |`);
  }
  lines.push('', '## 一步固定后续观察模拟', '',
    '每行只问：若该次旧响应在当时安装，再把旧轨迹到下一检查点的观察原样加入，下一检查点是否仍超过 H。各行互相独立，不构成一条修复后真实模型轨迹。', '',
    '| 当前尝试 → 下一检查点 | 新常规模型步 | 新工具观察 | 模拟输入 / H | 仍会触发 |',
    '| --- | ---: | ---: | ---: | --- |');
  for (const item of result.attempts.filter(item => item.fixedFollowUp)) {
    const follow = item.fixedFollowUp;
    lines.push(`| ${item.index} → ${item.index + 1} | ${follow.normalModelRequests} | ${follow.toolObservations} | ${follow.activeInputTokens.toLocaleString('en-US')} / ${follow.workInputTokens.toLocaleString('en-US')} | ${follow.wouldTrigger ? '是' : '否'} |`);
  }
  lines.push('', '## 结论边界', '',
    `- v2.1 对四份旧原始响应的离线接受数是 ${result.conclusions.counterfactualAccepted}/${result.historical.attempts}；这只证明预算契约不再误拒绝这些固定输入输出对。`,
    `- 四次触发均为活动窗口压力；不存在“仅隐藏历史达到阈值”的观测，因此 E0 不支持修改 hidden-history 触发分支。`,
    `- 一步模拟中 ${result.conclusions.followUpsStillPressured}/${result.conclusions.followUpsObserved} 个下一检查点仍超过 H。新增大观察能解释至少一部分再次压缩，不能把四次一概归为无进展抖动。`,
    '- 没有重新测语义保留、闭卷准确率、任务 B 或真实成本收益；这些仍未观测。', '');
  return `${lines.join('\n')}\n`;
}

export async function analyzeContinuationTriggers(inputRoot = defaultInput, outputRoot = defaultOutput) {
  const distUrl = relative => pathToFileURL(path.join(repository, 'dist', relative)).href;
  for (const file of ['runtime/context-tokens.js', 'runtime/summary-input.js', 'runtime/summary-projection.js', 'runtime/summary-schema.js']) {
    if (!existsSync(path.join(repository, 'dist', file))) throw new Error(`dist/${file} is missing; run npm run build`);
  }
  const { createInputTokenEstimator, estimateTextTokens } = await import(distUrl('runtime/context-tokens.js'));
  const { SummarySources, historySource, previewOf } = await import(distUrl('runtime/summary-input.js'));
  const { planSummaryProjection, projectSummary } = await import(distUrl('runtime/summary-projection.js'));
  const { canonicalSummaryBodyJson, extractSummaryJson, parseSummary } = await import(distUrl('runtime/summary-schema.js'));
  const evidence = readExperiment(inputRoot);
  try {
    const run = evidence.runs[0];
    const session = evidence.sessions[0];
    const starts = evidence.events.filter(event => event.type === 'context.summary.started');
    const calls = new Map(evidence.calls.map(call => [call.id, call]));
    const installed = evidence.events.filter(event => event.type === 'context.summary.installed');
    const markerByRef = new Map(installed.map(event => [event.summaryRef, event.marker]));
    const firstNormal = evidence.events.find(event => event.type === 'model.started' && !event.purpose);
    const tools = evidence.blob(firstNormal.requestRef).tools;
    const estimatorStore = { run: () => run, events: () => evidence.events, recentModelCalls: () => [] };
    const estimateInput = createInputTokenEstimator(estimatorStore, run, tools).estimate;
    const workInputTokens = evidence.report.task.workInputTokens;
    const attempts = [];
    let previousFold = null;

    for (const [position, start] of starts.entries()) {
      const next = starts[position + 1] ?? null;
      const terminal = evidence.events.find(event => event.seq > start.seq && event.attemptKey === start.attemptKey && ['context.summary.installed', 'context.summary.failed'].includes(event.type));
      if (!terminal) throw new Error(`attempt ${start.attemptKey} has no terminal event`);
      const archive = evidence.blob(start.archivedRef);
      const previousMarker = start.previousSummaryRef ? markerByRef.get(start.previousSummaryRef) : undefined;
      const previousEnvelope = start.previousSummaryRef ? evidence.blob(start.previousSummaryRef) : null;
      const rebuilt = rebuildSources({ archive, start, previousEnvelope: previousEnvelope ? { ...previousEnvelope, marker: previousMarker } : null, blob: evidence.blob, SummarySources, historySource, previewOf });
      const weights = new Map();
      for (const [offset, identity] of start.coveredOffsets.map((offset, index) => [offset, rebuilt.identities[index]])) {
        const resolved = resolveOriginal(start.archivedRef, offset, archive.messages[offset], evidence.blob);
        weights.set(identity.id, estimateTextTokens(JSON.stringify(resolved.message)) + 16);
      }
      const previousIds = previousFold ? new Set(previousFold.map(item => item.id)) : new Set();
      const foldOverlap = overlap(rebuilt.identities, previousFold, weights);
      const newMessages = rebuilt.identities.filter(item => !previousIds.has(item.id)).length;
      const newTokens = rebuilt.identities.filter(item => !previousIds.has(item.id)).reduce((sum, item) => sum + (weights.get(item.id) ?? 0), 0);
      const activeInputTokens = estimateInput(archive.messages);
      const hidden = hiddenOriginalTokens(archive.messages);
      const triggerReason = activeInputTokens > workInputTokens ? (hidden.tokens >= workInputTokens * 0.25 ? 'both' : 'active_pressure') : hidden.tokens >= workInputTokens * 0.25 ? 'hidden_history' : 'none';
      const plan = planSummaryProjection({ displayBudgetTokens: start.budgets.displayBudgetTokens, requestedBodyTokens: start.budgets.bodyTokens });
      const responseCall = calls.get(start.callId);
      const response = evidence.blob(responseCall.resultRef);
      const raw = extractSummaryJson(response.message?.content ?? null);
      let counterfactual;
      let projectedMarker = null;
      let candidateMessages = null;
      try {
        if (response.finishReason !== 'stop') throw new Error(`finishReason=${response.finishReason ?? 'missing'}`);
        const content = parseSummary(raw, ref => rebuilt.sources.resolve(ref), new Set(), plan.hardBodyTokens * 4);
        const bodyTokens = estimateTextTokens(canonicalSummaryBodyJson(content, id => rebuilt.sources.shortId(id)));
        const sources = referencedSources(content, rebuilt.sources, start.archivedRef, start.coveredOffsets[0]);
        const coverage = {
          plannedMessages: start.coverage.plannedMessages,
          coveredMessages: start.coveredOffsets.length,
          uncoveredMessages: start.coverage.plannedMessages - start.coveredOffsets.length,
          uncoveredOffsets: [], excerptedMessages: 0, chunks: start.chunks,
        };
        const projected = projectSummary({
          plan, summaryRef: placeholderRef, archivedRef: start.archivedRef, content, sources, coverage,
          firstOffset: start.coveredOffsets[0], lastOffset: start.coveredOffsets.at(-1),
        });
        const removed = new Set(start.coveredOffsets);
        candidateMessages = archive.messages.filter((message, index) => !removed.has(index) && !(previousMarker && message.role === 'user' && message.content === previousMarker));
        projectedMarker = { role: 'user', content: projected.text };
        candidateMessages.push(projectedMarker);
        const afterTokens = estimateInput(candidateMessages);
        const unavailableSources = sources.filter(source => !sourceAvailable(source, evidence.blob)).map(source => source.id);
        const failures = [
          ...(bodyTokens > plan.hardBodyTokens ? [`body ${bodyTokens} > hard ${plan.hardBodyTokens}`] : []),
          ...(projected.tokens > plan.displayBudgetTokens ? [`marker ${projected.tokens} > display ${plan.displayBudgetTokens}`] : []),
          ...(afterTokens >= activeInputTokens ? [`no gain ${afterTokens} >= ${activeInputTokens}`] : []),
          ...(unavailableSources.length ? [`unavailable sources: ${unavailableSources.join(', ')}`] : []),
        ];
        counterfactual = {
          accepted: failures.length === 0, error: failures.join('; ') || null,
          preferredBodyTokens: plan.bodyTokens, hardBodyTokens: plan.hardBodyTokens,
          bodyTokens, markerTokens: projected.tokens, afterTokens,
          gainTokens: activeInputTokens - afterTokens, sources: sources.length,
          allSourcesReadable: unavailableSources.length === 0,
        };
      } catch (error) {
        counterfactual = {
          accepted: false, error: error?.message ?? String(error), preferredBodyTokens: plan.bodyTokens,
          hardBodyTokens: plan.hardBodyTokens, bodyTokens: 0, markerTokens: 0, afterTokens: activeInputTokens,
          gainTokens: 0, sources: 0, allSourcesReadable: false,
        };
      }

      const historical = terminal.type === 'context.summary.installed' ? {
        outcome: 'installed', beforeTokens: terminal.beforeTokens, afterTokens: terminal.afterTokens,
        gainTokens: terminal.beforeTokens - terminal.afterTokens, reason: null,
      } : { outcome: 'SUMMARY_BUDGET', beforeTokens: activeInputTokens, afterTokens: activeInputTokens, gainTokens: 0, reason: terminal.reason };
      const normal = normalWorkBetween(evidence.events, terminal, next);
      const item = {
        index: position + 1, seq: start.seq, step: responseCall.step, attemptKey: start.attemptKey,
        previousSummaryRef: start.previousSummaryRef ?? null,
        trigger: {
          reason: triggerReason, activeInputTokens, workInputTokens,
          overByTokens: Math.max(0, activeInputTokens - workInputTokens),
          hiddenMessages: hidden.count, hiddenOriginalTokens: hidden.tokens,
        },
        budgets: {
          retainedTokens: start.budgets.retainedTokens,
          displayBudgetTokens: start.budgets.displayBudgetTokens,
          historicalPreferredBodyTokens: start.budgets.bodyTokens,
          providerOutputTokens: start.budgets.providerOutputTokens,
        },
        fold: {
          archivedRef: start.archivedRef, messages: rebuilt.identities.length,
          estimatedTokens: [...weights.values()].reduce((sum, value) => sum + value, 0),
          identities: rebuilt.identities, overlap: foldOverlap, newMessages, newTokens,
        },
        historical, counterfactual,
        maintenance: callAccounting(evidence.events, start, terminal),
        untilNextAttempt: normal,
        fixedFollowUp: null,
      };
      attempts.push({
        item, archive, projectedMarker, candidateMessages,
        foldIdentities: new Set(rebuilt.identities.map(identity => identity.id)),
        replacedMarker: terminal.type === 'context.summary.installed' ? terminal.marker : previousMarker,
      });
      previousFold = rebuilt.identities;
    }

    for (let index = 0; index < attempts.length - 1; index++) {
      const current = attempts[index];
      const following = attempts[index + 1];
      if (!current.item.counterfactual.accepted || !current.projectedMarker) continue;
      const simulated = following.archive.messages.filter(message => {
        if (current.replacedMarker && message.role === 'user' && message.content === current.replacedMarker) return false;
        const identity = evidenceIdentity(resolveOriginal(following.item.fold.archivedRef, following.archive.messages.indexOf(message), message, evidence.blob));
        return !current.foldIdentities.has(identity);
      });
      simulated.push(current.projectedMarker);
      const activeInputTokens = estimateInput(simulated);
      current.item.fixedFollowUp = {
        activeInputTokens, workInputTokens, wouldTrigger: activeInputTokens > workInputTokens,
        normalModelRequests: current.item.untilNextAttempt.modelRequests,
        toolObservations: current.item.untilNextAttempt.toolObservations,
        elapsedMs: current.item.untilNextAttempt.elapsedMs,
        note: 'one-step fixed-observation simulation; not a sequential repaired model trajectory',
      };
    }

    const publicAttempts = attempts.map(entry => entry.item);
    const totalCompaction = publicAttempts.reduce((sum, item) => sum + item.maintenance.input + item.maintenance.output, 0);
    const result = {
      version: 'continuation-trigger-analysis-e0-v1',
      generatedAt: new Date().toISOString(),
      input: path.relative(repository, inputRoot).split(path.sep).join('/'),
      mode: 'offline-read-only', providerCalls: 0,
      historical: {
        runStatus: run.status, verification: `${evidence.report.verify.exitCode === 0 ? '27/27, exit 0' : `exit ${evidence.report.verify.exitCode}`}`,
        attempts: starts.length, installs: installed.length,
        failures: evidence.events.filter(event => event.type === 'context.summary.failed').length,
        modelRequests: session.modelCalls, totalTokens: session.tokens,
        compactionRequests: publicAttempts.reduce((sum, item) => sum + item.maintenance.requests, 0),
        compactionTokens: totalCompaction,
      },
      attempts: publicAttempts,
      conclusions: {
        allTriggersActivePressure: publicAttempts.every(item => ['active_pressure', 'both'].includes(item.trigger.reason)),
        hiddenHistoryOnlyTriggers: publicAttempts.filter(item => item.trigger.reason === 'hidden_history').length,
        counterfactualAccepted: publicAttempts.filter(item => item.counterfactual.accepted).length,
        followUpsObserved: publicAttempts.filter(item => item.fixedFollowUp).length,
        followUpsStillPressured: publicAttempts.filter(item => item.fixedFollowUp?.wouldTrigger).length,
        supportsTriggerPolicyChange: false,
      },
      checks: [],
    };
    const expectedHard = [1820, 2720, 2473, 2617];
    const checks = [
      ['four historical attempts', result.historical.attempts === 4, result.historical.attempts],
      ['one historical install', result.historical.installs === 1, result.historical.installs],
      ['three deterministic failures', result.historical.failures === 3, result.historical.failures],
      ['v2.1 hard ceilings match frozen recalculation', JSON.stringify(publicAttempts.map(item => item.counterfactual.hardBodyTokens)) === JSON.stringify(expectedHard), publicAttempts.map(item => item.counterfactual.hardBodyTokens)],
      ['all four triggers had active-window pressure', result.conclusions.allTriggersActivePressure, publicAttempts.map(item => item.trigger.reason)],
      ['no hidden-history-only trigger observed', result.conclusions.hiddenHistoryOnlyTriggers === 0, result.conclusions.hiddenHistoryOnlyTriggers],
      ['all four same responses pass v2.1 contract', result.conclusions.counterfactualAccepted === 4, result.conclusions.counterfactualAccepted],
      ['all cited historical sources remain readable', publicAttempts.every(item => item.counterfactual.allSourcesReadable), publicAttempts.map(item => item.counterfactual.allSourcesReadable)],
      ['maintenance ledger matches seven recorded requests', result.historical.compactionRequests === 7, result.historical.compactionRequests],
      ['maintenance token ledger matches 81,802', result.historical.compactionTokens === 81802, result.historical.compactionTokens],
      ['first fixed-follow-up reproduces the recorded next active input', publicAttempts[0].fixedFollowUp?.activeInputTokens === publicAttempts[1].trigger.activeInputTokens, [publicAttempts[0].fixedFollowUp?.activeInputTokens, publicAttempts[1].trigger.activeInputTokens]],
    ].map(([name, ok, actual]) => ({ name, ok: Boolean(ok), actual }));
    result.checks = checks;
    await mkdir(outputRoot, { recursive: true });
    await writeFile(path.join(outputRoot, 'analysis.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputRoot, 'REPORT.md'), markdown(result), 'utf8');
    return result;
  } finally {
    evidence.database.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/comparison/continuation-trigger-analysis.mjs [--input <frozen-run>] [--out <research-dir>]');
    return;
  }
  const result = await analyzeContinuationTriggers(options.input, options.output);
  for (const check of result.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} — ${JSON.stringify(check.actual)}`);
  console.log(`E0 attempts=${result.historical.attempts} activePressure=${result.attempts.filter(item => item.trigger.reason === 'active_pressure').length} counterfactualAccepted=${result.conclusions.counterfactualAccepted} maintenanceTokens=${result.historical.compactionTokens}`);
  console.log(`E0 output=${options.output}`);
  if (result.checks.some(check => !check.ok)) process.exitCode = 1;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });

