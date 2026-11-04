// Phase-2 deep-fact QA (docs/kodo-final-positioning-20261103.md §2.5, §5 phase 2).
//
//   node scripts/context-store/dfqa.mjs --dry-run
//   node scripts/context-store/dfqa.mjs --run --provider-config test_api.json --provider codego1 \
//     --model deepseek-v4.1-flash --arms closed,open --repeat 3 [--out DIR]
//
// One frozen task: a workspace of ~30 material pages (frozen docs from the phase-0
// baseline commit, ~360k tokens) with 16 synthetic facts buried at 25-75% depth.
// Phase 1 replays a history in which the main agent read every page, then runs one
// step on a 128k window, so the default context policy must compact. Phase 2 asks
// 16 questions in the same conversation:
//   closed  the answer step cannot call tools (only the compacted context);
//   open    the answer step keeps every default tool (history.read/search,
//           file.read/search over the still-present workspace).
// A context-store change is judged by running `open` on its branch: accuracy
// >= 90% of `open` on the reference and phase-2 input <= 2x `closed` (§2.5).
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { fileURLToPath } from 'node:url';
import { Application, ModelProvider } from '../../dist/application/index.js';
import { estimateTextTokens } from '../../dist/runtime/context-tokens.js';
import { parseArgs, resolveCredentials, relayBinding, dryBinding, stamp, writeJson, errorText, finalText } from '../comparison/v3-eval-common.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CORPUS_COMMIT = '2f95839';
const SEED_TOKENS = 360_000;
const PAGE_CHARS = 12_000;
const WINDOW_TOKENS = 131_072;
const OUTPUT_TOKENS = 16_384;
const RNG_SEED = 20261104;

function mulberry32(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

const ENTITIES = ['青岚', '赤松', '白榆', '墨川', '金穗', '远山', '素问', '霁月', '苍梧', '星槎', '鹿鸣', '琼华', '松涛', '云栖', '寒汀', '澄湖'];
const WORDS = ['HOLLY', 'AMBER', 'CEDAR', 'FJORD', 'MAPLE', 'ONYX', 'QUILL', 'RAVEN'];
const PEOPLE = ['韩知远', '沈晏清', '陆鸣舟', '苏念白', '顾时雨', '温以宁', '程砚秋', '叶南星'];
const TEMPLATES = [
  (e, r) => { const n = 17 + Math.floor(r() * 80); return { fact: `「${e}」归档集群的冷备份保留 ${n} 天。`, prompt: `「${e}」归档集群的冷备份保留多少天？`, expected: [`(^|\\D)${n}(\\D|$)`] }; },
  (e, r) => { const w = WORDS[Math.floor(r() * WORDS.length)]; const n = 100 + Math.floor(r() * 900); return { fact: `「${e}」项目的验收口令是 ${w}-${n}。`, prompt: `「${e}」项目的验收口令是什么？`, expected: [`${w}-${n}`] }; },
  (e, r) => { const n = 40 + Math.floor(r() * 460); return { fact: `「${e}」实验室单批样本上限为 ${n} 份。`, prompt: `「${e}」实验室单批样本上限是多少份？`, expected: [`(^|\\D)${n}(\\D|$)`] }; },
  (e, r) => { const n = 3 + Math.floor(r() * 40); const d = '一二三四五'[Math.floor(r() * 5)]; return { fact: `「${e}」评审会定在第 ${n} 周的周${d}召开。`, prompt: `「${e}」评审会定在哪一周的周几召开？`, expected: [`第\\s*${n}\\s*周`, `周${d}`] }; },
  (e, r) => { const p = (5 + Math.floor(r() * 90) + 0.5).toFixed(1); return { fact: `「${e}」数据集的抽样比例是 ${p}%。`, prompt: `「${e}」数据集的抽样比例是多少？`, expected: [p.replace('.', '\\.')] }; },
  (e, r) => { const n = 250 + Math.floor(r() * 9750); return { fact: `「${e}」服务的请求超时阈值设为 ${n} 毫秒。`, prompt: `「${e}」服务的请求超时阈值是多少毫秒？`, expected: [`(^|\\D)${n}(\\D|$)`] }; },
  (e, r) => { const p = (1 + Math.floor(r() * 18) + 0.25).toFixed(2); return { fact: `「${e}」合同约定的违约金比例为 ${p}%。`, prompt: `「${e}」合同约定的违约金比例是多少？`, expected: [p.replace('.', '\\.')] }; },
  (e, r) => { const name = PEOPLE[Math.floor(r() * PEOPLE.length)]; return { fact: `「${e}」课题的负责人是${name}。`, prompt: `「${e}」课题的负责人是谁？`, expected: [name] }; },
];

/** Frozen pages from the baseline commit's docs, paginated at paragraph boundaries. */
export function buildCorpus() {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', CORPUS_COMMIT, 'docs'], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(f => f.endsWith('.md')).sort();
  const pages = [];
  let tokens = 0;
  for (const file of files) {
    const text = execFileSync('git', ['show', `${CORPUS_COMMIT}:${file}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64e6 }).replace(/\r\n/g, '\n');
    const paragraphs = text.split(/\n{2,}/);
    let current = [];
    const flush = () => { if (!current.length) return; const body = current.join('\n\n'); pages.push({ name: `${path.basename(file, '.md')}-p${pages.filter(page => page.source === file).length + 1}.md`, source: file, body }); tokens += estimateTextTokens(body); current = []; };
    for (const paragraph of paragraphs) {
      if (current.join('\n\n').length + paragraph.length > PAGE_CHARS) flush();
      current.push(paragraph.slice(0, PAGE_CHARS));
      if (tokens >= SEED_TOKENS) break;
    }
    flush();
    if (tokens >= SEED_TOKENS) break;
  }
  return { pages, tokens };
}

/** 16 synthetic facts on distinct pages at 25-75% depth; every value is unique to its page. */
export function buildTask() {
  const random = mulberry32(RNG_SEED);
  const { pages, tokens } = buildCorpus();
  const candidates = pages.map((_, index) => index).filter(index => index >= 1 && index < pages.length - 1);
  const chosen = [];
  while (chosen.length < ENTITIES.length) { const pick = candidates[Math.floor(random() * candidates.length)]; if (!chosen.includes(pick)) chosen.push(pick); }
  const questions = ENTITIES.map((entity, index) => {
    const item = TEMPLATES[index % TEMPLATES.length](entity, random);
    const page = pages[chosen[index]];
    const paragraphs = page.body.split('\n\n');
    const at = Math.max(1, Math.min(paragraphs.length - 1, Math.round(paragraphs.length * (0.25 + random() * 0.5))));
    paragraphs.splice(at, 0, `【备忘】${item.fact}`);
    page.body = paragraphs.join('\n\n');
    return { id: index + 1, entity, page: page.name, depth: Number((at / paragraphs.length).toFixed(3)), ...item };
  });
  for (const question of questions) for (const page of pages) {
    const hits = question.expected.every(source => new RegExp(source).test(page.body));
    if (hits && page.name !== question.page && page.body.includes(question.entity)) throw new Error(`fact ${question.id} is answerable from ${page.name}`);
  }
  return { pages, tokens, questions };
}

export const qaText = questions => [
  '请回答下面的问题。只依据本次任务中读过的材料作答，不要猜测；材料里找不到就写 unknown。每行一个答案，格式为「Q编号: 答案」。',
  ...questions.map(question => `Q${question.id}: ${question.prompt}`),
].join('\n');

export function scoreAnswers(questions, text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const answers = new Map();
  for (const line of lines) { const match = /^\s*(?:[-*]\s*)?\**Q\s*(\d+)\**\s*[:：.、)]\s*(.*)$/i.exec(line); if (match && !answers.has(Number(match[1]))) answers.set(Number(match[1]), match[2].trim()); }
  const rows = questions.map(question => {
    const answer = answers.get(question.id) ?? '';
    return { id: question.id, answer, pass: Boolean(answer) && !/^unknown/i.test(answer) && question.expected.every(source => new RegExp(source).test(answer)) };
  });
  return { passed: rows.filter(row => row.pass).length, total: rows.length, rows };
}

function writeWorkspace(directory, pages) {
  mkdirSync(path.join(directory, 'materials'), { recursive: true });
  for (const page of pages) writeFileSync(path.join(directory, 'materials', page.name), page.body, 'utf8');
}

/** A replayed history in which the main agent read every page once. */
function seedHistory(pages) {
  return pages.flatMap((page, index) => [
    { role: 'assistant', content: null, tool_calls: [{ id: `seed-read-${index + 1}`, name: 'file.read', arguments: JSON.stringify({ path: `materials/${page.name}` }) }] },
    { role: 'tool', tool_call_id: `seed-read-${index + 1}`, content: JSON.stringify({ path: `materials/${page.name}`, content: page.body }) },
  ]);
}

function modelUsage(app, runIds) {
  const usage = { calls: 0, input: 0, output: 0, cacheRead: 0, compactionCalls: 0, compactionInput: 0, toolCalls: 0, tools: {} };
  for (const runId of runIds) for (const call of app.store.calls(runId)) {
    if (call.kind === 'tool') { usage.toolCalls++; usage.tools[call.name] = (usage.tools[call.name] ?? 0) + 1; continue; }
    if (call.kind !== 'model' || !call.resultRef) continue;
    const response = app.store.readBlob(call.resultRef);
    const u = response?.usage ?? {};
    if (call.purpose === 'compaction') { usage.compactionCalls++; usage.compactionInput += u.input ?? 0; continue; }
    usage.calls++; usage.input += u.input ?? 0; usage.output += u.output ?? 0; usage.cacheRead += u.cacheRead ?? 0;
  }
  return usage;
}

function dryProvider(questions) {
  return { async complete(request) {
    const last = request.messages.at(-1);
    const text = typeof last?.content === 'string' && last.content.includes('Q1:') ? questions.map(question => `Q${question.id}: unknown`).join('\n') : 'READY';
    return { message: { role: 'assistant', content: text }, finishReason: 'stop', usage: { input: 1000, output: 20 } };
  } };
}

async function trial({ task, arm, directory, cli, credentials }) {
  mkdirSync(directory, { recursive: true });
  const workspace = path.join(directory, 'workspace');
  writeWorkspace(workspace, task.pages);
  let relay;
  let binding = dryBinding(cli.model, WINDOW_TOKENS, OUTPUT_TOKENS);
  if (cli.run) ({ relay, binding } = await relayBinding({ directory: path.join(directory, 'wire'), credentials, model: cli.model, maxCalls: 80, maxTokens: 6_000_000, maxOutputTokens: OUTPUT_TOKENS, contextTokens: 1_048_576 }));
  const app = new Application(path.join(directory, 'state'), cli.run ? new ModelProvider() : dryProvider(task.questions), undefined, { instructions: { global: false } });
  const started = Date.now();
  try {
    const budget = { maxContextTokens: WINDOW_TOKENS, maxOutputTokens: OUTPUT_TOKENS, maxModelCalls: 60, maxTokens: 6_000_000, maxDurationMs: 2_400_000 };
    const phase1 = app.createRun({ objective: '你已经读完 materials/ 下的全部材料。不要再读取文件，直接只回复 READY。', workspace, binding, permissions: ['read'], budget });
    const initial = app.store.readBlob(phase1.contextRef);
    app.store.updateRun(phase1.id, { contextRef: app.store.blob([...initial.slice(0, -1), ...seedHistory(task.pages), initial.at(-1)]) });
    const first = await app.run(phase1.id).catch(error => ({ status: 'failed', error: errorText(error) }));
    const phase1Usage = modelUsage(app, [phase1.id]);
    const compactions = app.store.events(phase1.id).filter(event => event.type.startsWith('context.')).map(event => event.type);
    if (first.status !== 'completed') return { arm, status: 'phase1_failed', error: first.error ?? first.status, phase1: phase1Usage, compactions };
    // Phase 2 continues the same conversation: the compacted terminal context plus the questions.
    const qa = app.submitInput(phase1.id, qaText(task.questions), { mode: 'follow_up' });
    const projection = app.store.readBlob(app.store.run(phase1.id).contextRef);
    app.store.updateRun(qa.id, { contextRef: app.store.blob([...projection, { role: 'user', content: qaText(task.questions) }]), step: 1, inputCursor: app.store.inbox(qa.id).at(-1)?.seq ?? 0, ...(arm === 'closed' ? { toolChoice: 'none' } : {}) });
    const answered = await app.run(qa.id).catch(error => ({ status: 'failed', error: errorText(error) }));
    const text = finalText(app.store, app.store.run(qa.id));
    const score = scoreAnswers(task.questions, text);
    return { arm, status: answered.status, error: answered.error ?? null, score: { passed: score.passed, total: score.total }, rows: score.rows, phase1: phase1Usage, phase2: modelUsage(app, [qa.id]), compactions, ms: Date.now() - started, answer: text };
  } finally {
    await app.shutdown().catch(() => {});
    if (relay) await relay.close().catch(() => {});
  }
}

const OPTIONS = { 'dry-run': { kind: 'boolean', default: false }, run: { kind: 'boolean', default: false }, 'provider-config': { kind: 'string' }, provider: { kind: 'string', default: 'codego1' }, model: { kind: 'string', default: 'deepseek-v4.1-flash' }, arms: { kind: 'list', default: ['closed', 'open'] }, repeat: { kind: 'integer', default: 3 }, out: { kind: 'string' } };

async function main() {
  const cli = parseArgs(process.argv.slice(2), OPTIONS);
  const task = buildTask();
  const out = path.resolve(repoRoot, cli.out ?? path.join('.kodo', 'context-store', `dfqa-${cli.run ? 'run' : 'dry'}-${stamp()}`));
  if (existsSync(path.join(out, 'summary.json'))) throw new Error(`${out} already has results`);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'task.json'), JSON.stringify({ corpusCommit: CORPUS_COMMIT, seedTokens: task.tokens, pages: task.pages.length, questions: task.questions.map(({ fact, ...rest }) => ({ ...rest, fact })) }, null, 2));
  const credentials = cli.run ? await resolveCredentials({ providerConfig: cli['provider-config'], provider: cli.provider }) : null;
  const arms = cli.arms;
  if (arms.some(arm => !['closed', 'open'].includes(arm))) throw new Error('--arms accepts closed and open');
  const results = [];
  for (let repeat = 1; repeat <= cli.repeat; repeat++) for (const arm of repeat % 2 ? arms : [...arms].reverse()) {
    const directory = path.join(out, 'trials', `${arm}-r${repeat}`);
    const result = await trial({ task, arm, directory, cli, credentials }).catch(error => ({ arm, status: 'harness_failed', error: errorText(error) }));
    results.push({ repeat, ...result });
    await writeJson(path.join(directory, 'result.json'), { repeat, ...result }, credentials?.key);
    console.log(JSON.stringify({ trial: `${arm}-r${repeat}`, status: result.status, score: result.score, phase2Input: result.phase2?.input, phase2Calls: result.phase2?.calls, tools: result.phase2?.tools, error: result.error ?? undefined }));
  }
  const summary = Object.fromEntries(arms.map(arm => {
    const rows = results.filter(row => row.arm === arm && row.score);
    const sum = key => rows.reduce((total, row) => total + key(row), 0);
    return [arm, { trials: rows.length, accuracy: rows.length ? Number((sum(row => row.score.passed) / sum(row => row.score.total)).toFixed(4)) : null, meanPhase2Input: rows.length ? Math.round(sum(row => row.phase2.input) / rows.length) : null, meanPhase2Calls: rows.length ? Number((sum(row => row.phase2.calls) / rows.length).toFixed(2)) : null, failed: results.filter(row => row.arm === arm && !row.score).length }];
  }));
  await writeJson(path.join(out, 'summary.json'), { generatedAt: new Date().toISOString(), mode: cli.run ? 'paid' : 'dry', model: cli.model, seedTokens: task.tokens, windowTokens: WINDOW_TOKENS, summary, results: results.map(({ answer: _answer, ...row }) => row) }, credentials?.key);
  console.log(JSON.stringify({ out, summary }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
