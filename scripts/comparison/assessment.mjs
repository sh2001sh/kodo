// Task-specific regression checks for three operational claims independently
// falsified in the repository-report comparison. This is not a general fact checker.
import { stripVTControlCharacters } from 'node:util';

const scope = 'repository-report-known-contradictions-v2';

// Selection only: immutable stored artifact versions and tool-call evidence are
// retained by callers. Distinct report names remain distinct deliverables.
export function latestReportArtifacts(artifacts) {
  const latest = new Map();
  for (const artifact of artifacts) {
    if (artifact.provenance?.stale === true) continue;
    const key = typeof artifact.name === 'string' && artifact.name ? artifact.name : Symbol('unnamed-artifact');
    latest.delete(key);
    latest.set(key, artifact);
  }
  return [...latest.values()];
}

export function hasCompleteTestSummary(output) {
  const summary = /(?:^|\n)[ \t]*Tests[ \t]+([1-9]\d*) passed[ \t]+\(\1\)[ \t]*(?:\r?\n|$)/;
  return summary.test(stripVTControlCharacters(output));
}

// A process preview cannot prove complete test execution. Resolve its private
// captured-output artifact through the session-aware store, never a model path.
export function restoreProcessOutput(store, runId, output) {
  if (!output || typeof output.stdout !== 'string' || typeof output.stderr !== 'string') throw new Error('PROCESS_EVIDENCE: expected process output strings');
  if (!output.outputArtifact) return { ...output, capturedComplete: !output.truncated && !output.outputLimitExceeded && !output.cancelled };
  const reference = output.outputArtifact;
  if (typeof reference.id !== 'string' || !reference.id) throw new Error('PROCESS_EVIDENCE: missing captured-output artifact ID');
  const artifact = store.readArtifact(runId, reference.id);
  if (artifact?.name !== 'process-output' || typeof artifact.content !== 'string' || artifact.provenance?.stale === true) throw new Error('PROCESS_EVIDENCE: expected current private process-output artifact');
  let captured;
  try { captured = JSON.parse(artifact.content); }
  catch { throw new Error('PROCESS_EVIDENCE: captured-output artifact is not valid JSON'); }
  if (!captured || typeof captured.stdout !== 'string' || typeof captured.stderr !== 'string' || captured.exitCode !== output.exitCode) throw new Error('PROCESS_EVIDENCE: captured output metadata does not match the process result');
  return { ...output, ...captured, outputArtifact: reference,
    capturedComplete: reference.capturedComplete === true && captured.truncated === false && captured.outputLimitExceeded === false && !captured.cancelled };
}

// Delegated work belongs to the same measured session, including failed children.
export function collectSessionEvidence(store, runId) {
  const sessionId = store.run(runId).sessionId;
  const runs = store.listRuns().filter(run => run.sessionId === sessionId);
  const calls = runs.flatMap(run => store.calls(run.id));
  const processEvidence = calls.filter(call => call.name === 'process.exec' && call.status === 'succeeded')
    .map(call => ({ runId: call.runId, callId: call.id, request: store.readBlob(call.requestRef),
      result: restoreProcessOutput(store, call.runId, store.readBlob(call.resultRef)) }));
  const runLedger = runs.map(run => ({ id: run.id, parentId: run.parentId, objective: run.objective,
    status: run.status, error: run.error, createdAt: run.createdAt,
    modelCalls: calls.filter(call => call.runId === run.id && call.kind === 'model').length,
    toolCalls: calls.filter(call => call.runId === run.id && call.kind === 'tool').length,
    result: run.resultRef ? store.readBlob(run.resultRef) : undefined }));
  return { calls, processEvidence, runLedger };
}

export function reportCompletionCheck(assessment) {
  const failedChecks = Object.entries(assessment.checks).filter(([, passed]) => !passed).map(([name]) => name);
  const facts = assessment.facts.findings.map(finding => `${finding.id}: ${finding.expected}`);
  const sourceFeedback = assessment.checks.inspectedSource === false ? 'Read at least one src/ source file using file.read; documentation alone does not meet this task requirement.' : '';
  const feedback = `Report checks failed: ${failedChecks.join(', ')}. ${sourceFeedback} ${facts.join(' ')}`;
  return { passed: assessment.passed,
    feedback: assessment.passed ? undefined : `${feedback.slice(0, 15_000)} Correct and save the report again using the same artifact name; old versions remain preserved as evidence.`,
    evidence: { scope: assessment.facts.scope, structure: assessment.structure, facts: assessment.facts } };
}

function statements(text) {
  const output = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    // A semicolon can continue a condition in the same bullet. Keep its prefix
    // without allowing a previous bullet, paragraph or sentence to qualify it.
    for (const sentence of line.split(/[。]|(?<=[.!?])\s+(?=[A-Z])/u)) {
      let prefix = '';
      for (const part of sentence.split(/[；;]/u)) {
        const normalized = part.replace(/[`*]/g, '').trim();
        if (normalized) output.push({ line: index + 1, quote: part.trim(), text: normalized, prefix });
        prefix += `${normalized}；`;
      }
    }
  }
  return output;
}

const failedUnknown = /(?:失败|failed).{0,35}UNKNOWN_WRITE|UNKNOWN_WRITE.{0,35}(?:失败|failed)/i;

function explicitInterruptedCreation(claim, creates) {
  const interrupted = /\binterrupted\b|中断(?:状态|运行|任务)?/i;
  const before = claim.text.slice(0, creates.index);
  const creationClause = claim.text.slice(Math.max(before.lastIndexOf('，'), before.lastIndexOf(',')) + 1).split(/[，,]/u)[0];
  // An explicit interrupted-run creation claim stays wrong even when the same
  // bullet also mentions the separate failed UNKNOWN_WRITE recovery branch.
  return interrupted.test(creationClause) || (interrupted.test(before) && !failedUnknown.test(before));
}

function failedUnknownWriteRecovery(claim, creates) {
  if (explicitInterruptedCreation(claim, creates)) return false;
  if (failedUnknown.test(claim.text)) return true;
  return !/\binterrupted\b|中断(?:状态|运行|任务)?/i.test(claim.prefix)
    && (failedUnknown.test(claim.prefix)
      || (/\bUNKNOWN_WRITE\b/i.test(claim.prefix)
        && /原失败(?:运行|任务)|(?:已)?失败(?:的)?(?:运行|任务)|(?:original|already|previously) failed (?:run|task)/i.test(claim.text)));
}

// Exclude explicit repudiations, not every sentence containing a negative word.
// In particular, “不得超过 100” is a positive assertion of an upper bound.
function repudiated(statement, index) {
  const prefix = statement.slice(0, index);
  return /(?:错误(?:说法|描述|断言|表述)|误称|误写|误以为|incorrect(?:ly)?|false claim)[^，,：:]*[：:“"「『]?[^，,]*$/i.test(prefix)
    || /(?:并非|并不是|不是所有|不能(?:说|声称)|不应(?:说|声称)|it is (?:incorrect|false) (?:that|to say))[^，,]*$/i.test(prefix)
    || /(?:不|不会|并不|does not|do not|never|not)\s*$/i.test(prefix)
    || /(?:这种说法|该说法|上述说法).{0,12}(?:错误|不正确)|(?:is|are) (?:incorrect|false)\b/i.test(statement.slice(index));
}

export function assessReportFacts(text, definitionId = 'repository-report') {
  const checks = { recoveryIdentity: true, historyOffsetBound: true, fileSearchFailures: true };
  const findings = [];
  const relevant = ['repository-report', 'focused-report'].includes(definitionId);
  const add = (id, claim, expected) => {
    checks[id] = false;
    findings.push({ id, line: claim.line, quote: claim.quote, expected });
  };
  if (relevant) for (const claim of statements(text)) {
    const value = claim.text;
    if (definitionId === 'repository-report' && /\bresume\b/i.test(value)) {
      const creates = /(?:创建|新建|产生).{0,12}(?:延续|运行|任务|\brun\b)|creat(?:e|es|ing).{0,25}(?:run|continuation)/i.exec(value);
      // Creating a continuation is valid specifically for a failed UNKNOWN_WRITE
      // run. A general “resume creates a run” claim erases interrupted-run identity.
      if (creates && !repudiated(value, creates.index)
        && (!/(?:可以|可能|may|can)\s*$/i.test(value.slice(0, creates.index)) || explicitInterruptedCreation(claim, creates))
        && !failedUnknownWriteRecovery(claim, creates)) {
        add('recoveryIdentity', claim, 'Interrupted runs resume with the same run ID; only failed UNKNOWN_WRITE recovery creates a continuation.');
      }
    }

    const offsetBound = /\boffset\b(?:\s*[/／、,]\s*limit|\s+and\s+limit)?[^，,。；;]{0,35}?(?:≤|<=|最多|上限(?:为|是|为)?|不(?:得|能)超过|at most|up to|maximum(?: of)?|limited to)\s*100\b/i.exec(value);
    if (offsetBound && !repudiated(value, offsetBound.index)
      && !/\boffset\b[^，,]{0,25}(?:不受|没有|无|不是|并非|not)/i.test(offsetBound[0])) {
      add('historyOffsetBound', claim, 'history.read limit is 1–100; offset is a nonnegative safe integer and can exceed 100.');
    }

    // Follow the tool subject across comma-separated clauses. This prevents a
    // later file.read error claim from being attributed to an earlier file.search.
    let subject = '';
    for (const clause of value.split(/[，,]/u)) {
      const tools = [...clause.matchAll(/\bfile\.(?:read|search)\b/g)].map(match => match[0]);
      if (tools.length) subject = tools.includes('file.search') ? 'file.search' : 'file.read';
      if (subject !== 'file.search') continue;
      const failures = clause.matchAll(/(?:报|抛|throw(?:s)?|rais(?:e|es)|return(?:s)?(?: an? error)?)[^，,]{0,35}?(?:FILE_ENCODING|FILE_SIZE)|(?:FILE_ENCODING|FILE_SIZE)[^，,]{0,20}(?:错误|报错|error)/gi);
      if ([...failures].some(failure => !repudiated(clause, failure.index))) {
        add('fileSearchFailures', claim, 'file.search skips oversized/NUL files and replaces invalid UTF-8; it does not throw file.read FILE_SIZE/FILE_ENCODING errors for those inputs.');
        break;
      }
    }
  }
  return { passed: Object.values(checks).every(Boolean), checks, findings, scope,
    note: 'Bounded task-specific contradiction checks, including explicit negations/corrections. Unmentioned facts and unrecognized paraphrases remain unverified; passing is not a proof that every report claim is correct.' };
}

export function assessReportContent({ text, reads, scripts, definitionId = 'repository-report' }) {
  reads = [...new Set(reads.map(file => file.replaceAll('\\', '/')))];
  const commands = [...new Set(text.match(/npm (?:run [a-zA-Z0-9:_-]+|test|ci)/g) ?? [])];
  const supported = new Set(['npm ci', 'npm test', ...Object.keys(scripts).map(name => `npm run ${name}`)]);
  const checks = { reportSaved: Boolean(text.trim()), inspectedRealFiles: reads.filter(file => file !== 'START_HERE.md').length >= 3, supportedCommands: commands.filter(command => supported.has(command)).length >= 3 && commands.every(command => supported.has(command)), coversContext: /上下文|context|压缩|compact/i.test(text), coversRecovery: /恢复|recover|reconcile|未知写|unknown/i.test(text), namesUnimplementedProductFeatures: /MCP/.test(text) && /Web|网页/i.test(text) && /未实现|尚未|暂不|not (?:yet )?(?:implemented|available)|unsupported/i.test(text), citesRealPaths: ['README.md', 'package.json', 'src/'].filter(value => text.includes(value)).length >= 2 };
  if (definitionId === 'repository-report') checks.inspectedSource = reads.some(file => /^(?:\.\/)*src\//.test(file));
  if (definitionId === 'focused-report') {
    delete checks.coversContext;
    delete checks.coversRecovery;
    delete checks.namesUnimplementedProductFeatures;
    checks.inspectedRealFiles = ['package.json', 'src/runtime/history.ts'].every(file => reads.includes(file));
    checks.citesRealPaths = ['package.json', 'src/runtime/history.ts'].every(file => text.includes(file));
    checks.bounds = /256/.test(text) && /32[_, ]?000/.test(text);
    checks.cursor = ['offset', 'contentOffset', 'next'].every(value => text.includes(value));
    checks.permissionBoundary = /跨|其他|foreign|session/i.test(text) && /拒绝|禁止|不允许|不能|denied/i.test(text);
  }
  const structure = { passed: Object.values(checks).every(Boolean), checks: { ...checks } };
  const facts = assessReportFacts(text, definitionId);
  // Keep this boolean in checks: comparison runners append checks and recompute
  // passed from all check values. They must not accidentally discard fact failures.
  checks.reportFacts = facts.passed;
  return { passed: structure.passed && facts.passed, checks, structure, facts, reads, commands,
    note: 'Structure and the three known factual failure modes are checked separately. Other operational claims and usefulness still require independent review.' };
}
