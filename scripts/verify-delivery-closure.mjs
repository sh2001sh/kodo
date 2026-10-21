import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { Application, ModelProvider } from '../dist/application/index.js';
import { runProcess } from '../dist/tools/index.js';
import { createBudgetRelay } from './comparison/relay.mjs';

assert.ok(process.env.KODO_API_KEY, 'Configure KODO_API_KEY in the launcher environment');
const root = path.resolve('.kodo', `delivery-closure-${Date.now()}`);
await mkdir(root, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const model = 'deepseek-v4.1-flash';
const budget = { maxTokens: null, maxModelCalls: null, maxToolCalls: null, maxDurationMs: null, maxContextChars: null, maxContextTokens: 1000000, maxOutputTokens: 393216, maxChildren: 8, maxConcurrentModels: 2, toolTimeoutMs: 120000 };
const publicTests = `const {test}=require('node:test'); const assert=require('node:assert/strict'); const {sum}=require('../src/math.cjs');
test('sums numbers',()=>assert.equal(sum([1,2,3]),6));
test('empty and fractional input',()=>{assert.equal(sum([]),0);assert.equal(sum([1.5,-.5]),1)});
test('rejects non-array',()=>assert.throws(()=>sum(null),TypeError));
test('rejects invalid members',()=>{for(const x of ['1',null,NaN,Infinity])assert.throws(()=>sum([x]),TypeError)});
`;
const hidden = `const assert=require('node:assert/strict');const {sum}=require(process.argv[2]); assert.equal(sum([9,-2,-7]),0); assert.equal(sum([0]),0); assert.throws(()=>sum([true]),TypeError); assert.throws(()=>sum({}),TypeError); assert.throws(()=>sum(Array(2)),TypeError); const values=[3,-1,4]; assert.equal(sum(values),6); assert.deepEqual(values,[3,-1,4]); assert.equal(sum(Object.freeze([2,3])),5); console.log('independent behavior PASS');`;
await writeFile(path.join(root, 'independent.cjs'), hidden);
await mkdir(path.join(root, 'snapshot'));
for (const name of ['src', 'dist']) await cp(name, path.join(root, 'snapshot', name), { recursive: true });
await cp(import.meta.filename, path.join(root, 'runner.mjs'));
await cp('scripts/comparison/relay.mjs', path.join(root, 'relay-source.mjs'));
await writeFile(path.join(root, 'conditions.json'), JSON.stringify({ model, protocol: 'chat-completions', upstream: 'https://codegoai.com/v1', limits: { context: 1000000, output: 393216 }, budget,
  trials: ['natural-repair', 'seeded-incomplete-candidate'], seeded: 'Second trial injects one nonempty incomplete candidate before the first real model request. Its zero-usage local response is recorded separately; not a natural model failure or autonomy experiment.',
  public: 'Compile current src/math.cjs, run immutable public tests in actual delivery directory, reject test changes and source changes during checks; feedback is public.', hidden: 'Independent behavior runs only after termination, never returned as correction feedback.', publicTestsSha256: sha(publicTests), hiddenSha256: sha(hidden),
  pricesCNYPerMillion: { input: .5, cached: .01, output: 2 }, accounting: 'HTTP429=0; other missing usage unknown; missing cache gives an interval over known usage only; all failures retained.' }, null, 2));

function fee(calls) {
  let low = 0, high = 0, input = 0, output = 0, missingUsage = 0;
  for (const call of calls) {
    if (call.httpStatus === 429) continue;
    const u = call.usage;
    if (!Number.isSafeInteger(u?.prompt_tokens) || !Number.isSafeInteger(u?.completion_tokens)) { missingUsage++; continue; }
    input += u.prompt_tokens; output += u.completion_tokens;
    const hit = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
    if (Number.isSafeInteger(hit)) {
      const value = ((u.prompt_tokens - hit) * .5 + hit * .01 + u.completion_tokens * 2) / 1e6; low += value; high += value;
    } else { low += (u.prompt_tokens * .01 + u.completion_tokens * 2) / 1e6; high += (u.prompt_tokens * .5 + u.completion_tokens * 2) / 1e6; }
  }
  return { input, output, low, high, missingUsage, currency: 'CNY' };
}
const results = [];
for (const name of ['natural-repair', 'seeded-incomplete-candidate']) {
  const directory = path.join(root, name), workspace = path.join(directory, 'workspace'), wire = path.join(directory, 'wire');
  await mkdir(path.join(workspace, 'src'), { recursive: true }); await mkdir(path.join(workspace, 'tests')); await mkdir(wire);
  await writeFile(path.join(workspace, 'src/math.cjs'), name === 'natural-repair' ? 'exports.sum = values => values.reduce((a,b)=>a+b);\n' : 'exports.sum = ;\n');
  await writeFile(path.join(workspace, 'tests/math.test.cjs'), publicTests);
  const relay = await createBudgetRelay({ directory: wire, upstream: 'https://codegoai.com/v1', key: process.env.KODO_API_KEY, model, maxContextChars: Infinity, maxOutputTokens: 393216, unrestricted: true });
  process.env.KODO_DELIVERY_RELAY = 'loopback-only';
  let seeded = name === 'seeded-incomplete-candidate';
  const remote = new ModelProvider();
  const app = new Application(path.join(directory, 'state'), { async complete(...args) {
    if (seeded) { seeded = false; return { message: { role: 'assistant', content: '实现已完成，可交付。' }, finishReason: 'stop', usage: { input: 0, output: 0 } }; }
    return remote.complete(...args);
  } });
  const events = [], checks = [];
  const off = app.store.subscribe(event => events.push(event));
  const objective = `修复 src/math.cjs 的 sum(values)：输入必须是数组，成员必须逐项是有限number，否则抛TypeError；空数组返回0；不改输入。只修改该源码，不改已有测试。阅读并运行公开测试 tests/math.test.cjs，公开完成检查会在实际交付目录执行 node --check src/math.cjs 及 node --test tests/math.test.cjs，失败会返回真实错误。完成后简短说明修改和实际验证。Node路径：${process.execPath}。`;
  const run = app.createRun({ objective, workspace, permissions: ['read', 'write', 'exec'], binding: { model, baseURL: relay.baseURL, apiKeyEnv: 'KODO_DELIVERY_RELAY', protocol: 'chat-completions', limits: { context: 1000000, output: 393216 } }, budget });
  app.setCompletionValidator(run.id, async ({ signal }) => {
    const startedAt = Date.now();
    const before = sha(await readFile(path.join(workspace, 'src/math.cjs')));
    const immutableTests = sha(await readFile(path.join(workspace, 'tests/math.test.cjs'))) === sha(publicTests);
    const compile = await runProcess(process.execPath, ['--check', 'src/math.cjs'], workspace, 'KODO_API_KEY', signal);
    const tests = await runProcess(process.execPath, ['--test', 'tests/math.test.cjs'], workspace, 'KODO_API_KEY', signal);
    const after = sha(await readFile(path.join(workspace, 'src/math.cjs')));
    const passed = immutableTests && before === after && [compile, tests].every(x => x.exitCode === 0 && !x.cancelled && !x.outputLimitExceeded);
    const check = { startedAt, endedAt: Date.now(), passed, before, after, immutableTests, compile, tests };
    checks.push(check);
    return { passed, feedback: passed ? undefined : `Public checks failed. Restore immutable tests if changed, fix the current source, and rerun.\n${compile.stdout}\n${compile.stderr}\n${tests.stdout}\n${tests.stderr}`.slice(0, 16000), evidence: check };
  });
  const startedAt = Date.now();
  let row;
  try {
    const final = await app.run(run.id);
    const endedAt = Date.now();
    const artifact = final.resultRef ? app.store.readBlob(final.resultRef) : null;
    const independent = await runProcess(process.execPath, [path.join(root, 'independent.cjs'), path.join(workspace, 'src/math.cjs')], workspace, 'KODO_API_KEY', new globalThis.AbortController().signal);
    const corrections = events.filter(e => e.type === 'completion.correction_requested');
    const firstCorrectionAt = corrections.length ? Date.parse(corrections[0].time) : null;
    row = { name, injectedCandidates: name === 'seeded-incomplete-candidate' ? 1 : 0, status: final.status, error: final.error, artifact, independent,
      passed: final.status === 'completed' && artifact?.text?.trim().length > 0 && artifact.quality.status === 'passed' && independent.exitCode === 0 && sha(await readFile(path.join(workspace, 'tests/math.test.cjs'))) === sha(publicTests),
      executionMs: endedAt - startedAt, publicCheckMs: checks.reduce((n, c) => n + c.endedAt - c.startedAt, 0), checks, corrections: corrections.length,
      events, calls: app.store.calls(run.id), session: app.store.session(run.sessionId), wire: relay.stats, usage: fee(relay.stats.calls),
      recovery: { startsAfterFirstCorrection: firstCorrectionAt, elapsedMs: firstCorrectionAt === null ? 0 : endedAt - firstCorrectionAt, requests: firstCorrectionAt === null ? 0 : relay.stats.calls.filter(c => c.startedAt >= firstCorrectionAt).length, usage: fee(firstCorrectionAt === null ? [] : relay.stats.calls.filter(c => c.startedAt >= firstCorrectionAt)), note: 'Post-feedback work includes repair and verification; this is not the causal overhead of the gate.' } };
  } finally { off(); await app.shutdown(); await relay.close(); }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(row, null, 2));
  results.push(row);
  console.log(JSON.stringify({ name, passed: row.passed, status: row.status, requests: row.wire.requests, corrections: row.corrections, executionMs: row.executionMs, usage: row.usage }));
}
await writeFile(path.join(root, 'summary.json'), JSON.stringify(results.map(({ name, injectedCandidates, passed, status, executionMs, publicCheckMs, corrections, usage, recovery, wire }) => ({ name, injectedCandidates, passed, status, executionMs, publicCheckMs, corrections, usage, recovery, requests: wire.requests })), null, 2));
console.log(JSON.stringify({ root, trials: results.length, passed: results.filter(r => r.passed).length }));
if (results.some(r => !r.passed)) process.exitCode = 1;
