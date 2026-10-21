import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { test } from 'node:test';
import { URL } from 'node:url';
import { assessReportContent, assessReportFacts, latestReportArtifacts, reportCompletionCheck, hasCompleteTestSummary, restoreProcessOutput } from './assessment.mjs';
import { createFixtures } from './fixtures.mjs';
import path from 'node:path';

const scripts = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).scripts;
const reads = ['README.md', 'package.json', 'src/runtime/history.ts', 'src/runtime/context.ts'];
// Exact anonymous reports from quality-comparison-1792463752368, not rewritten
// model answers. Keep them portable so regressions run without old .kodo state.
const expected = {
  A: [], B: ['recoveryIdentity'], C: ['historyOffsetBound', 'fileSearchFailures'], D: [], E: [],
};
for (const [label, failures] of Object.entries(expected)) test(`real report ${label}: structure and operational facts remain separate`, async () => {
  const text = await readFile(new URL(`./testdata/reports/${label}.md`, import.meta.url), 'utf8');
  const result = assessReportContent({ text, reads, scripts });
  assert.equal(result.structure.passed, true);
  assert.deepEqual(result.facts.findings.map(finding => finding.id), failures);
  assert.equal(result.facts.passed, failures.length === 0);
  assert.equal(result.passed, failures.length === 0);
  assert.equal(Object.values(result.checks).every(Boolean), result.passed);
  for (const finding of result.facts.findings) {
    assert.ok(finding.line > 0);
    assert.ok(text.split(/\r?\n/)[finding.line - 1].includes(finding.quote));
    assert.ok(finding.expected);
  }
});

test('correct conditional recovery branches and explicit repudiations are not false positives', () => {
  const examples = [
    'resume 继续中断运行，或为失败的 UNKNOWN_WRITE 运行创建恢复延续任务。',
    'resume：中断运行从原 run ID 继续；已失败 UNKNOWN_WRITE 的运行创建延续任务。',
    'resume 不会创建延续运行来恢复 interrupted 状态。',
    '不是所有 resume 都创建延续任务；中断状态保持同一身份。',
    '错误说法：“resume 创建恢复延续任务”。实际只有失败 UNKNOWN_WRITE 才创建新运行。',
    'resume does not create a new run for an interrupted run.',
    'resume creates a continuation for a failed UNKNOWN_WRITE run.',
    'resume 可以创建恢复延续任务。中断运行继续原 run；已失败 UNKNOWN_WRITE 才创建延续。',
    'resume can create a continuation. Interrupted runs retain identity.',
  ];
  for (const text of examples) assert.equal(assessReportFacts(text).passed, true, text);
  for (const text of ['核实后 resume 创建恢复延续任务。', 'resume always creates a new run.']) {
    assert.equal(assessReportFacts(text).checks.recoveryIdentity, false, text);
  }
});

test('real Pi report 2 retains its failed UNKNOWN_WRITE condition across semicolons', () => {
  // Exact complete recovery bullet from pi-256k-repository-report-2-9b7912/result.json.
  const paragraph = '- `UNKNOWN_WRITE` 状态阻止同会话（以及同数据目录下相同/嵌套工作目录的其他会话）继续写入，但允许只读调查；核实后 `resume` 创建恢复延续任务，沿用已确认的调用结果与预算，原失败运行记录不变；重复恢复不会重复执行。**自动补偿尚未实现**（`README.md` 声明）。';
  const result = assessReportFacts(paragraph);
  assert.equal(result.passed, true);
  assert.deepEqual(result.findings, []);
  assert.equal(result.scope, 'repository-report-known-contradictions-v2');
});

test('recovery conditions do not exempt unqualified or explicitly interrupted creation claims', () => {
  const valid = [
    '- 失败的 UNKNOWN_WRITE 运行经核实后；resume 创建恢复延续任务。',
    '- UNKNOWN_WRITE 阻止写入；核实后 resume 创建延续任务，原失败运行保持不变。',
  ];
  const invalid = [
    '- UNKNOWN_WRITE 阻止写入；核实后 resume 创建恢复延续任务。',
    '- UNKNOWN_WRITE 阻止写入，原失败运行保持不变。\n- 核实后 resume 创建恢复延续任务。',
    '失败 UNKNOWN_WRITE 已核实。\n\nresume creates a new run.',
    '- 失败 UNKNOWN_WRITE 已核实。resume creates a new run.',
    '- 失败 UNKNOWN_WRITE 会创建延续；resume creates a new run for an interrupted run.',
    '- UNKNOWN_WRITE 阻止写入；resume 为 interrupted 状态创建新 run，原失败运行保持不变。',
    'resume 对 interrupted 状态创建恢复延续任务；失败 UNKNOWN_WRITE 才需要核实。',
    'resume creates a continuation for an interrupted run, unlike failed UNKNOWN_WRITE recovery.',
    'resume can create a new run for an interrupted run.',
    '对中断运行，resume 可以创建新运行。',
  ];
  for (const text of valid) assert.equal(assessReportFacts(text).checks.recoveryIdentity, true, text);
  for (const text of invalid) {
    const result = assessReportFacts(text);
    assert.equal(result.checks.recoveryIdentity, false, text);
    assert.ok(result.findings.some(finding => finding.id === 'recoveryIdentity'));
  }
});

test('offset bound checks distinguish limit, lower bounds and negated upper bounds', () => {
  const examples = [
    'history.read 的 limit ≤100；offset 为非负安全整数。',
    'offset 可超过100，limit 不得超过100。',
    'offset 不是 ≤100；它没有100的上限。',
    '错误说法：“offset/limit ≤100”。只有 limit 有这个上限。',
    'offset >100 is allowed; limit is at most100.',
  ];
  for (const text of examples) assert.equal(assessReportFacts(text).checks.historyOffsetBound, true, text);
  for (const text of ['消息分页（offset/limit ≤100）', 'offset 不得超过100', 'offset and limit are at most 100']) {
    assert.equal(assessReportFacts(text).checks.historyOffsetBound, false, text);
  }
});

test('search errors follow the tool subject and explicit negation', () => {
  const examples = [
    'file.search 跳过超大和 NUL 文件，file.read 报 FILE_SIZE 或 FILE_ENCODING。',
    'file.search 不抛 FILE_ENCODING 或 FILE_SIZE。',
    'file.search does not throw FILE_ENCODING for malformed UTF-8.',
    '错误说法：“file.search 报 FILE_ENCODING”。实际搜索按替换字符解码。',
    'file.search 跳过过大文件；file.read 对非UTF8报 FILE_ENCODING。',
  ];
  for (const text of examples) assert.equal(assessReportFacts(text).checks.fileSearchFailures, true, text);
  for (const text of ['file.read/file.search 仅支持 UTF-8 文本，非法编码报 FILE_ENCODING。', 'file.search throws FILE_SIZE for an oversized file.', 'file.search does not throw FILE_SIZE but throws FILE_ENCODING.', 'file.search 不抛 FILE_ENCODING，但会报 FILE_SIZE。']) {
    assert.equal(assessReportFacts(text).checks.fileSearchFailures, false, text);
  }
});

test('facts cannot compensate for missing structure and do not claim universal accuracy', () => {
  const result = assessReportContent({ text: 'Nothing to deliver', reads: [], scripts });
  assert.equal(result.facts.passed, true);
  assert.equal(result.structure.passed, false);
  assert.equal(result.passed, false);
  assert.match(result.facts.note, /unverified/);
  const focused = assessReportContent({ text: 'package.json src/runtime/history.ts: maxChars 256–32000，offset/contentOffset/next；跨会话禁止读取。npm run build; npm test; npm run check。offset ≤100。', reads: ['package.json', 'src/runtime/history.ts'], scripts, definitionId: 'focused-report' });
  assert.equal(focused.structure.passed, true);
  assert.equal(focused.facts.passed, false);
  assert.equal(focused.passed, false);
});

test('repository reports must actually inspect source, not merely cite it after reading documentation', async () => {
  const text = await readFile(new URL('./testdata/reports/A.md', import.meta.url), 'utf8');
  const documentationReads = ['README.md', 'package.json', 'docs/implementation-plan.md', 'docs/task-capability-evaluation.md'];
  const result = assessReportContent({ text, reads: documentationReads, scripts });
  assert.equal(result.checks.inspectedRealFiles, true);
  assert.equal(result.checks.citesRealPaths, true);
  assert.equal(result.facts.passed, true);
  assert.equal(result.checks.inspectedSource, false);
  assert.equal(result.structure.passed, false);
  assert.equal(result.passed, false);
  assert.match(reportCompletionCheck(result).feedback, /Read at least one src\/ source file/);
  for (const source of ['src/runtime/context.ts', './src/runtime/context.ts', 'src\\runtime\\context.ts']) {
    assert.equal(assessReportContent({ text, reads: [...documentationReads, source], scripts }).passed, true, source);
  }
});

test('comparison fixture uses factual acceptance for actual saved artifacts', async () => {
  const text = await readFile(new URL('./testdata/reports/B.md', import.meta.url), 'utf8');
  const blobs = { write: { id: 'artifact' } };
  const calls = [{ name: 'artifact.write', status: 'succeeded', resultRef: 'write' }];
  for (const [index, file] of reads.entries()) {
    blobs[index] = { arguments: JSON.stringify({ path: file }) };
    calls.push({ name: 'file.read', status: 'succeeded', requestRef: index });
  }
  const facade = { store: { readBlob: ref => blobs[ref], readArtifact: () => ({ content: text }) } };
  const repository = path.resolve(import.meta.dirname, '../..');
  const result = await createFixtures(repository, repository).assessReport(facade, { id: 'run' }, calls, { id: 'repository-report' });
  assert.equal(result.structure.passed, true);
  assert.equal(result.facts.checks.recoveryIdentity, false);
  assert.equal(result.checks.reportFacts, false);
  assert.equal(result.passed, false);
  assert.equal(result.artifacts[0].content, text);
});

test('latest report selection retains different names, excludes stale versions and preserves source evidence', () => {
  const versions = [
    { name: 'report.md', content: 'old contradiction' },
    { name: 'appendix.md', content: 'independent report' },
    { name: 'report.md', content: 'corrected current report' },
    { name: 'stale.md', content: 'old decision', provenance: { stale: true } },
    { content: 'unnamed one' }, { content: 'unnamed two' },
  ];
  const original = JSON.stringify(versions);
  const current = latestReportArtifacts(versions);
  assert.deepEqual(current.map(artifact => artifact.content), ['independent report', 'corrected current report', 'unnamed one', 'unnamed two']);
  assert.equal(JSON.stringify(versions), original);
  assert.equal(versions.length, 6);
});

test('saved same-name correction clears earlier facts, while different-name contradictory reports still fail', async () => {
  const bad = await readFile(new URL('./testdata/reports/B.md', import.meta.url), 'utf8');
  const good = await readFile(new URL('./testdata/reports/A.md', import.meta.url), 'utf8');
  const versions = [
    { name: 'report.md', content: bad },
    { name: 'report.md', content: good },
    { name: 'discarded.md', content: bad, provenance: { stale: true } },
  ];
  const blobs = {};
  const calls = reads.map((file, index) => {
    blobs[`read-${index}`] = { arguments: JSON.stringify({ path: file }) };
    return { name: 'file.read', status: 'succeeded', requestRef: `read-${index}` };
  });
  const facade = { store: { readBlob: ref => blobs[ref], readArtifact: (_run, id) => versions[id] } };
  const repository = path.resolve(import.meta.dirname, '../..');
  const fixture = createFixtures(repository, repository);
  const appendWrites = () => versions.forEach((_artifact, index) => {
    blobs[`write-${index}`] = { id: index };
    calls.push({ name: 'artifact.write', status: 'succeeded', resultRef: `write-${index}` });
  });
  appendWrites();
  let result = await fixture.assessReport(facade, { id: 'run' }, calls, { id: 'repository-report' });
  assert.equal(result.passed, true);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifactVersions.length, 3);
  assert.equal(result.artifactVersions[0].content, bad);
  assert.equal(reportCompletionCheck(result).passed, true);
  versions.push({ name: 'other-report.md', content: bad });
  blobs['write-3'] = { id: 3 };
  calls.push({ name: 'artifact.write', status: 'succeeded', resultRef: 'write-3' });
  result = await fixture.assessReport(facade, { id: 'run' }, calls, { id: 'repository-report' });
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.artifactVersions.length, 4);
  assert.equal(result.passed, false);
  const validation = reportCompletionCheck(result);
  assert.equal(validation.passed, false);
  assert.match(validation.feedback, /reportFacts/);
  assert.match(validation.feedback, /Interrupted runs resume with the same run ID/);
  assert.match(validation.feedback, /same artifact name/);
  assert.equal(validation.evidence.facts, result.facts);
  assert.equal(validation.evidence.structure, result.structure);
  assert.equal(validation.evidence.scope, result.facts.scope);
});

test('completion feedback stays within the host contract while full evidence is retained', () => {
  const findings = Array.from({ length: 1000 }, () => ({ id: 'fact', expected: 'x'.repeat(100) }));
  const assessment = { passed: false, checks: { reportFacts: false }, structure: { passed: true }, facts: { scope: 'test', findings } };
  const validation = reportCompletionCheck(assessment);
  assert.ok(validation.feedback.length <= 16_000);
  assert.match(validation.feedback, /same artifact name/);
  assert.equal(validation.evidence.facts.findings.length, 1000);
});

test('full designated-test evidence rejects skipped, failed, zero and partial summaries', () => {
  for (const output of [' Tests 15 passed (15)\n', '\u001b[32m Tests 210 passed (210)\u001b[0m\r\n']) {
    assert.equal(hasCompleteTestSummary(output), true, output);
  }
  for (const output of ['Tests 1 passed | 14 skipped (15)', 'Tests 1 passed | 14 failed (15)', 'Tests 1 passed (15)', 'Tests 0 passed (0)', 'prefix Tests 15 passed (15)', 'Tests 15 passed (15) and 1 skipped']) {
    assert.equal(hasCompleteTestSummary(output), false, output);
  }
});

test('process acceptance restores the private complete output instead of the 4000-character preview', () => {
  const full = { exitCode: 0, stdout: `${'noise\n'.repeat(1000)}Tests 15 passed (15)\n`, stderr: 'private diagnostic', truncated: false, cancelled: false, outputLimitExceeded: false };
  const preview = { ...full, stdout: full.stdout.slice(0, 4000), stderr: '', truncated: true, outputArtifact: { id: 'private-capture', capturedComplete: true } };
  const before = JSON.stringify(preview);
  const reads = [];
  const store = { readArtifact: (runId, id) => { reads.push({ runId, id }); return { name: 'process-output', content: JSON.stringify(full), provenance: { stale: false } }; } };
  assert.equal(hasCompleteTestSummary(preview.stdout), false);
  const restored = restoreProcessOutput(store, 'owner-run', preview);
  assert.equal(restored.stdout, full.stdout);
  assert.equal(restored.stderr, full.stderr);
  assert.equal(restored.capturedComplete, true);
  assert.equal(hasCompleteTestSummary(restored.stdout), true);
  assert.deepEqual(reads, [{ runId: 'owner-run', id: 'private-capture' }]);
  assert.equal(JSON.stringify(preview), before);
});

test('incomplete captured output cannot prove full tests, even if its preview contains a passing summary', () => {
  const full = { exitCode: 0, stdout: 'Tests 15 passed (15)\n', stderr: '', truncated: false, cancelled: false, outputLimitExceeded: false };
  const store = { readArtifact: () => ({ name: 'process-output', content: JSON.stringify(full) }) };
  assert.equal(restoreProcessOutput(store, 'run', full).capturedComplete, true);
  assert.equal(restoreProcessOutput(store, 'run', { ...full, truncated: true }).capturedComplete, false);
  const preview = { ...full, truncated: true, outputArtifact: { id: 'capture', capturedComplete: false } };
  assert.equal(restoreProcessOutput(store, 'run', preview).capturedComplete, false);
  preview.outputArtifact.capturedComplete = true;
  for (const changes of [{ truncated: true }, { outputLimitExceeded: true }, { cancelled: true }]) {
    const incomplete = { readArtifact: () => ({ name: 'process-output', content: JSON.stringify({ ...full, ...changes }) }) };
    assert.equal(restoreProcessOutput(incomplete, 'run', preview).capturedComplete, false);
  }
});

test('captured-output retrieval fails explicitly on denied, stale, malformed or mismatched evidence', () => {
  const full = { exitCode: 0, stdout: 'Tests 15 passed (15)\n', stderr: '', truncated: false, cancelled: false, outputLimitExceeded: false };
  const preview = { ...full, truncated: true, outputArtifact: { id: 'capture', capturedComplete: true } };
  const denied = new Error('ARTIFACT_DENIED');
  assert.throws(() => restoreProcessOutput({ readArtifact: () => { throw denied; } }, 'foreign-run', preview), error => error === denied);
  for (const artifact of [
    { name: 'report.md', content: JSON.stringify(full) },
    { name: 'process-output', content: JSON.stringify(full), provenance: { stale: true } },
    { name: 'process-output', content: 'not JSON' },
    { name: 'process-output', content: JSON.stringify({ ...full, exitCode: 1 }) },
    { name: 'process-output', content: JSON.stringify({ ...full, stdout: null }) },
  ]) assert.throws(() => restoreProcessOutput({ readArtifact: () => artifact }, 'run', preview), /PROCESS_EVIDENCE/);
  assert.throws(() => restoreProcessOutput({}, 'run', { ...preview, outputArtifact: {} }), /PROCESS_EVIDENCE/);
});

test('task-evaluation CLI uses token-window defaults and independent character limits before any provider access', () => {
  const env = { ...process.env };
  delete env.KODO_MODEL;
  delete env.KODO_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.KODO_PROMPT_CACHE;
  const script = path.resolve(import.meta.dirname, '../evaluate-tasks.mjs');
  const run = (args = [], cache) => {
    const result = spawnSync(process.execPath, [script, ...args], { env: { ...env, ...(cache === undefined ? {} : { KODO_PROMPT_CACHE: cache }) }, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    return result.stderr;
  };
  assert.match(run(), /NOT VERIFIED: configure a real KODO_MODEL/);
  assert.match(run(['--context-tokens', '256000', '--context-chars', String(Number.MAX_SAFE_INTEGER)]), /NOT VERIFIED/);
  assert.match(run(['--context-tokens', '256000', '--context-chars', '20000']), /NOT VERIFIED/);
  assert.match(run(['--context-tokens', '3072']), /context-tokens must be/);
  assert.match(run(['--context-tokens', '256000.5']), /context-tokens must be/);
  assert.match(run(['--context-chars', '9999']), /context-chars must be/);
  assert.match(run(['--context-chars', '9007199254740992']), /context-chars must be/);
  for (const cache of ['off', 'session']) assert.match(run([], cache), /NOT VERIFIED/);
  assert.match(run([], 'unsupported'), /KODO_PROMPT_CACHE must be off or session/);
});
