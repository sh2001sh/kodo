// C6 "incremental multi-compaction" experiment: does a long-running task keep
// project facts and execution state across *repeated* compactions that happen
// during normal incremental work?
//
// compaction-qa-retention.mjs seeds a full 42-round history at once and then
// compresses it in a single pass; the review (docs/context-compaction-experiment-
// review.md §3.2) notes that this measures over-window import, not incremental
// work. This script therefore grows one run batch by batch:
//
//   batch 1 (7 real file.read rounds)  -> app.run (model confirms)
//   batch 2 (+8 rounds, compaction)    -> app.run
//   batch 3 (+8 rounds, compaction)    -> app.run
//   batch 4 (+8 rounds, compaction)    -> app.run
//   final closed-book QA (20 questions) -> app.run (compaction allowed unless frozen)
//
// Each batch is appended as authentic assistant tool-call + tool-result rounds to
// the same run.contextRef (which keeps the previous, possibly compressed
// history), the run is requeued, and app.run is called again, so prepareContext
// sees the real growing history and applies the arm policy as production does.
// 16 KF markers (KF-1..KF-16) are inserted mid-page into real repository pages,
// four facts per batch. The early pinned user message carries the objective, the
// immutable user constraints, the confirmed plan and the unknown-write rule; the
// final QA scores those execution-state answers separately from the 16 facts.
//
// --freeze-final-qa (default off) mirrors the QA script's phase-2 freeze: it
// temporarily disables coordinator.compaction and raises the final run's session
// window to the model-declared 1,000,000 context, then restores both and records
// the control telemetry. Without it the final stage may compress normally and its
// compaction count is reported.
//
// Safety: --dry-run (default) never resolves credentials and never calls a model;
// it simulates each arm's batch-by-batch buildContext/compaction path. The real
// credential is read only in --run mode, never printed, never written to disk,
// and is visible only to the loopback relay in this parent process.
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import console from 'node:console';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { URL } from 'node:url';
import ts from 'typescript';
import { Application } from '../../dist/application/index.js';
import { buildContext } from '../../dist/runtime/context.js';
import { estimateInputTokens, estimateTextTokens } from '../../dist/runtime/context-tokens.js';
import { runBudget } from '../../dist/runtime/coordinator.js';
import { contextOutputReserve } from '../../dist/providers/model-limits.js';
import { createBudgetRelay } from './relay.mjs';
import { historicRates, usageScorecard } from './real-scorecard.mjs';

const EVALUATION_VERSION = 'compaction-qa-incremental-v1';
const FROZEN_MODEL = 'deepseek-v4.1-flash';
const DEFAULT_PROVIDER_CONFIG = 'C:/Users/admin/.config/opencode/opencode.json';
const DEFAULT_PROVIDER = 'codego1';
const DEFAULT_ARMS = 'off,mask,summary:65536,hybrid:65536';
const DEFAULT_WORK_TOKENS = 65_536;
const DEFAULT_WINDOW_TOKENS = 131_072;
const DEFAULT_REPEATS = 2;
const MIN_WORK_TOKENS = 1_024;
const MAX_WORK_TOKENS = 10_000_000;
const MAX_REPEATS = 3;
const LIMITS = Object.freeze({ context: 1_000_000, output: 393_216 });
const WINDOW_OUTPUT_CAP = 16_384;
// The session budget is shared by every batch run of a trial; a real 5-run
// incremental lifecycle needs more than the single-run 300s default.
const MAX_DURATION_MS = 900_000;
const TOOL_TIMEOUT_MS = 120_000;
const BATCH_COUNT = 4;
const FACTS_PER_BATCH = 4;
// Batch 1 stays below the 65,536 work budget so the first compaction happens on
// batch 2 (the documented incremental pattern); later batches carry more tokens.
const FILLER_PLAN = Object.freeze([3, 4, 4, 4]);
const MIN_PAGES_PER_BATCH = 6;
const MAX_PAGES_PER_BATCH = 8;
const FACT_PAGE_MIN_CHARS = 18_000;
const FACT_PAGE_MAX_CHARS = 24_000;
const FILLER_PAGE_MIN_CHARS = 18_000;
const FILLER_PAGE_MAX_CHARS = 24_000;
const FACT_ANCHOR_DEPTH_MIN = 0.15;
const FACT_ANCHOR_DEPTH_MAX = 0.85;
const FACT_TARGET_DEPTH_MIN = 0.18;
const FACT_TARGET_DEPTH_MAX = 0.82;
const REQUIRED_COMPACTIONS = 3;
const COVERAGE_PENDING_NOTE = 'coverage telemetry pending host implementation';
const REPOSITORY = path.resolve(import.meta.dirname, '..', '..');
const KF = id => `KF-${id}`;
const COMPACTION_EVENT_TYPES = ['context.compacted', 'context.summary.started', 'context.summary.installed', 'context.summary.failed', 'context.summary.skipped', 'context.summary.discarded'];
const TRACE_EVENT_TYPES = new Set(['model.started', 'model.finished', 'model.failed', 'model.retry', 'run.completed', 'run.failed', 'context.archived', ...COMPACTION_EVENT_TYPES]);
// Real repository text only: never vendored dependencies, generated output,
// previous evidence roots, or the comparison tooling that produced the experiment.
const FILLER_ROOTS = ['src', 'docs', 'examples', 'tests', '.github'];
const FILLER_ROOT_FILES = ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.mjs', 'eslint.config.mjs'];
const FILLER_EXTENSIONS = new Set(['.ts', '.md', '.mjs', '.js', '.css', '.html', '.json', '.yml', '.yaml']);
const FILLER_EXCLUDED_PREFIXES = ['node_modules/', '.kodo/', 'dist/', '.git/', 'scripts/'];
const MIN_FILLER_FILE_BYTES = 512;
const MAX_FILLER_FILE_BYTES = 2_000_000;
const CARD_DIGEST = createHash('sha256').update('compaction-qa-incremental-card-v1').digest('hex');

const TASK_OBJECTIVE = '在只读权限下完成增量证据核对：分批读取真实仓库页并保持任务目标、用户约束、执行计划与未知写入处理规则，在多次上下文压缩后继续推进并给出下一步；最后闭卷回答事实题与执行状态题。';
const INITIAL_USER_MESSAGE = [
  '任务目标：在只读约束下完成增量证据核对（分批读取真实仓库页），在多次上下文压缩后保持任务目标、用户约束与执行计划，最后给出下一步。',
  '用户约束（全程不可违反）：',
  '1. 本次只读；不得修改 src/runtime/history.ts（只允许读取）。',
  '2. 不得伪造未运行过的测试结果；在真实实验前不得宣称新压缩策略已提速降本。',
  '已确认计划：先逐批核对证据与项目事实，再给出下一步；不得跳过核对直接宣称收益。',
  '未知写入处理：任何结果不确定的写操作必须标记为 UNKNOWN 并等待核对，不得重复执行。',
].join('\n');
const CARD = Object.freeze({
  id: 'qa-incremental-closed-book',
  version: '1.0.0',
  name: 'Incremental multi-compaction task',
  prompt: '正常增量执行实验：每批只读载入真实仓库证据后简短确认；最终阶段闭卷回答事实与执行状态问题。不调用工具、不修改文件、不猜测；无法确定时写 UNKNOWN。',
  digest: CARD_DIGEST,
  tools: [],
});
const DRY_BINDING = Object.freeze({ protocol: 'chat-completions', model: FROZEN_MODEL, baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_QA_INCREMENTAL_UNUSED', limits: LIMITS });

// The 16 fact texts and acceptance regexes are frozen copies of the deep preset
// in compaction-qa-retention.mjs (that script cannot be imported safely because
// its top-level main executes). KF-1..KF-16 are used; Q19's user constraints are
// the pinned execution-state control instead of a page fact.
const FACT_TEXT = {
  1: '默认 workInputTokens 工作预算是 65536 token。',
  2: '压缩目标 targetTokens 是工作预算的 70%。',
  3: '近期原文预算的固定上限是 16384 token。',
  4: '任务摘要输出预算的内容上限是 8192 token。',
  5: '摘要请求超时是 60 秒；摘要输出预算低于 128 token 时跳过摘要。',
  6: 'CLI 用 --compaction 启用压缩，三种策略分别是 mask、summary、hybrid。',
  7: 'knowledge_nodes 的主键是 PRIMARY KEY(project_id,id)，同项目知识唯一约束是 UNIQUE(project_id,knowledge_id)。',
  8: '知识目录最多两层分类。',
  9: '当前存储的 PRAGMA user_version 是 5。',
  10: 'RAPTOR 首版不采用递归聚类、向量索引和自动父节点摘要。',
  11: 'PageIndex 借鉴的是“结构指路，原文作证”（结构定位与原文读取分离）。',
  12: '目录用于整理项目知识，任务摘要用于继续当前工作。',
  13: '旧观察隐藏后仍超过工作预算 H，且存在可折叠历史时触发二级摘要。',
  14: '新压缩策略默认关闭。',
  15: '64k 工作预算只是实验起点，尚未验证收益。',
  16: 'SummaryEnvelope.sources 是摘要的准确读取入口。',
};
const FACT_EXPECTED = {
  1: ['65536|65,536|65_536'], 2: ['70\\s*%|0\\.7'], 3: ['16,?384|16_384'], 4: ['8192|8,192'],
  5: ['(60\\s*秒|60s|60,?000|60_000)', '128'], 6: ['--compaction', 'mask', 'summary', 'hybrid'],
  7: ['project_id\\s*,\\s*id|PRIMARY KEY\\s*\\(\\s*project_id\\s*,\\s*id\\s*\\)', 'project_id\\s*,\\s*knowledge_id|UNIQUE\\s*\\(\\s*project_id\\s*,\\s*knowledge_id\\s*\\)'],
  8: ['(两|二|2)\\s*层|two folder levels'], 9: ['user_version[^\\n]{0,20}5|user_version\\s*=\\s*5|^\\s*5\\s*$|(?:值为?|版本)[^\\n]{0,10}5'],
  10: ['((不|未)(被)?(首版)?采用|没有采用|不引入|未引入)', '(递归|聚类|向量)'],
  11: ['结构', '(原文|正文)'], 12: ['项目知识', '(当前任务|当前工作)'],
  13: ['(超过|超出|高于)[^\\n]{0,12}(工作预算|软预算|预算|H)|超预算|(仍|依然|还)[^\\n]{0,8}超', '摘要|总结'],
  14: ['默认关闭|默认不启用|不默认启用|off by default'], 15: ['实验起点|实验参数|未验证|未验收|不能宣称'],
  16: ['读取入口|read|来源引用|引用'],
};
const FACT_CATEGORIES = { 1: '预算与阈值', 2: '预算与阈值', 3: '预算与阈值', 4: '预算与阈值', 5: '预算与阈值', 6: 'API 与存储', 7: 'API 与存储', 8: 'API 与存储', 9: 'API 与存储', 10: '设计与取舍', 11: '设计与取舍', 12: '设计与取舍', 13: '预算与阈值', 14: '预算与阈值', 15: '设计与取舍', 16: '设计与取舍' };
const FACT_PROMPTS = {
  1: '默认的 workInputTokens 工作预算（单位 token）是多少？',
  2: '压缩目标 targetTokens 是工作预算的百分之多少？',
  3: '近期原文预算由固定上限与工作预算的 25% 取较小值；这个固定上限是多少 token？',
  4: '摘要输出预算的内容上限（固定上限）是多少 token？',
  5: '摘要请求的超时时间是多少秒？摘要输出预算低于多少 token 时直接跳过摘要？',
  6: 'CLI 中启用压缩的参数是什么？可选的三种策略名称分别是什么？',
  7: 'knowledge_nodes 表的主键约束是什么？同一项目内的知识唯一约束是什么？',
  8: '知识目录最多允许几层分类（根目录不计入深度）？',
  9: '当前存储使用的 PRAGMA user_version 值是多少？',
  10: 'RAPTOR 是否被 Kodo 首版采用？原因涉及哪类做法？',
  11: 'Kodo 从 PageIndex 借鉴的核心思路是什么？',
  12: '知识目录与任务摘要各自的分工是什么？',
  13: '二级模型任务摘要的触发条件是什么？',
  14: '默认情况下，新的压缩策略是否启用？',
  15: '文档如何定位 64k 工作预算（例如实验状态或是否已验证）？',
  16: 'SummaryEnvelope.sources 字段的用途是什么？',
};
// Frozen deep-preset page specs for KF-1..KF-16 (paths/anchors copied from
// compaction-qa-retention.mjs DEEP_FACT_SPECS; best-occurrence notes retained).
const FACT_SPECS = [
  { questionId: 1, path: 'src/runtime/context.ts', anchor: '65_536' },
  { questionId: 2, path: 'src/runtime/context.ts', anchor: '0.70' },
  { questionId: 3, path: 'src/runtime/context.ts', anchor: '16_384' },
  { questionId: 4, path: 'src/runtime/compaction.ts', anchor: '8192' },
  { questionId: 5, path: 'src/runtime/compaction.ts', anchor: '60_000' },
  { questionId: 6, path: 'README.md', anchor: '--compaction' },
  { questionId: 7, path: 'src/storage/index.ts', anchor: 'PRIMARY KEY(project_id,id)' },
  { questionId: 8, path: 'src/knowledge/index.ts', anchor: 'at most two folder levels' },
  { questionId: 9, path: 'src/storage/index.ts', anchor: 'PRAGMA user_version = 5' },
  { questionId: 10, path: 'docs/context-compaction.md', anchor: '首版不采用递归聚类' },
  { questionId: 11, path: 'docs/context-compaction.md', anchor: '结构指路' },
  { questionId: 12, path: 'docs/context-compaction.md', anchor: '项目知识', occurrence: 'best' },
  { questionId: 13, path: 'docs/context-compaction.md', anchor: '仍超过 H' },
  { questionId: 14, path: 'README.md', anchor: '默认关闭', occurrence: 'best' },
  { questionId: 15, path: 'docs/context-compaction.md', anchor: '可复现实验起点' },
  { questionId: 16, path: 'src/runtime/compaction.ts', anchor: 'sources', occurrence: 'best' },
];
// 16 fact questions (Q1..Q16) plus 4 execution-state questions (Q17..Q20).
const FACT_QUESTIONS = Object.keys(FACT_TEXT).map(Number).map(id => ({ id, kind: 'fact', category: FACT_CATEGORIES[id], prompt: FACT_PROMPTS[id], expected: FACT_EXPECTED[id] }));
const EXECUTION_QUESTIONS = [
  { id: 17, kind: 'executionState', category: '执行状态', prompt: '当前任务的总体目标是什么？', expected: ['(增量|分批|逐批)', '(核对|证据|事实)'] },
  { id: 18, kind: 'executionState', category: '执行状态', prompt: '任务开始时用户给出了哪些不可违反的约束？', expected: ['只读', 'history\\.ts', '(不得|禁止|不能)'] },
  { id: 19, kind: 'executionState', category: '执行状态', prompt: '已确认的下一步计划是什么？', expected: ['(核对|检查|确认)', '(下一步|计划|给出)'] },
  { id: 20, kind: 'executionState', category: '执行状态', prompt: '遇到结果不确定的未知写入应如何处理？', expected: ['(未知写入|不确定的写操作|结果不确定的写操作|UNKNOWN)', '(标记|UNKNOWN)', '(不得|不要|不能|禁止)[^\\n]{0,12}重复'] },
];
const QUESTIONS = [...FACT_QUESTIONS, ...EXECUTION_QUESTIONS];

function effectiveQuestion(question) {
  if (question.kind !== 'fact') return question;
  return {
    ...question,
    prompt: `根据上下文中标注为 ${KF(question.id)} 的项目事实回答：${question.prompt}`,
    expected: [`${KF(question.id)}\\b`, ...question.expected],
  };
}

function qaSheet() {
  return [
    '【最终闭卷问答】增量执行阶段已结束。只依据当前上下文中保留的材料回答下面的 20 个问题；',
    '禁止使用工具、重新读取文件或猜测；无法确定时写 UNKNOWN，不要编造数字或引文。',
    '每题单独一行，以 "Q<id>: " 开头（例如 "Q1: KF-1 65536"），只写答案本身，不写解释，按顺序回答全部题目。',
    'Q1–Q16 是项目事实题：答案必须以对应的 KF-<id> 标记开头；Q17–Q20 是执行状态题，直接回答即可。',
    '',
    ...QUESTIONS.map(question => `Q${question.id}: ${effectiveQuestion(question).prompt}`),
  ].join('\n');
}

function batchNote(batch) {
  return `【批次 ${batch.index}/${BATCH_COUNT} 已载入】本批新增 ${batch.pages.length} 页真实仓库证据，其中包含 ${batch.facts.length} 条带编号的项目事实。请继续当前只读任务：先核对本批证据，再用不超过两句话确认已载入并给出下一步。不要调用工具，不要展开分析。`;
}

const CLI_OPTIONS = {
  root: { type: 'string' },
  'provider-config': { type: 'string', default: DEFAULT_PROVIDER_CONFIG },
  provider: { type: 'string', default: DEFAULT_PROVIDER },
  model: { type: 'string', default: FROZEN_MODEL },
  arms: { type: 'string', default: DEFAULT_ARMS },
  'work-tokens': { type: 'string', default: String(DEFAULT_WORK_TOKENS) },
  'window-tokens': { type: 'string', default: String(DEFAULT_WINDOW_TOKENS) },
  repeats: { type: 'string', default: String(DEFAULT_REPEATS) },
  'freeze-final-qa': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  run: { type: 'boolean', default: false },
  'include-answers': { type: 'boolean', default: false },
};

const state = {
  runMode: false,
  includeAnswers: false,
  freezeFinalQA: false,
  model: FROZEN_MODEL,
  provider: DEFAULT_PROVIDER,
  upstream: null,
  secret: null,
  createdAt: null,
  sourceHash: null,
  eventsPath: null,
  root: null,
  workTokens: DEFAULT_WORK_TOKENS,
  windowTokens: DEFAULT_WINDOW_TOKENS,
  repeats: DEFAULT_REPEATS,
  arms: [],
  seed: null,
  currentRepeat: 0,
};

const emit = value => console.log(JSON.stringify(value));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const mean = values => {
  const numbers = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? Number((numbers.reduce((total, value) => total + value, 0) / numbers.length).toFixed(2)) : null;
};
const pad = (value, width) => String(value ?? '-').padEnd(width);
const redact = text => (state.secret ? String(text).replaceAll(state.secret, '[redacted]') : String(text));
const redactedJson = value => redact(JSON.stringify(value, null, 2));
const writeJson = (file, value) => writeFile(file, `${redactedJson(value)}\n`);
const appendLine = (file, value) => appendFileSync(file, `${redact(typeof value === 'string' ? value : JSON.stringify(value))}\n`);

function parseArms(text) {
  const entries = String(text ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) throw new Error('--arms must name at least one arm: off, mask[:H], summary[:H], hybrid[:H]');
  const seen = new Set();
  return entries.map(entry => {
    const parts = entry.split(':');
    if (parts.length > 2) throw new Error(`Malformed arm ${entry}; syntax is off, mask[:H], summary[:H], hybrid[:H]`);
    const [name, rawWork] = parts;
    if (!['off', 'mask', 'summary', 'hybrid'].includes(name)) throw new Error(`Unknown arm ${name}`);
    if (name === 'off') {
      if (rawWork !== undefined) throw new Error('The off arm takes no work budget; it reproduces hard-capacity trimming');
      if (seen.has('off')) throw new Error('Duplicate arm off');
      seen.add('off');
      return { name: 'off', strategy: null, workInputTokens: null };
    }
    const workInputTokens = rawWork === undefined ? state.workTokens : Number(rawWork);
    if (!Number.isSafeInteger(workInputTokens) || workInputTokens < MIN_WORK_TOKENS || workInputTokens > MAX_WORK_TOKENS) throw new Error(`Arm ${name} needs a work budget ${MIN_WORK_TOKENS}..${MAX_WORK_TOKENS}`);
    // Algorithm comparison must run at one shared H, so an explicit per-arm budget
    // is only accepted when it equals --work-tokens.
    if (workInputTokens !== state.workTokens) throw new Error(`Arm ${entry} declares ${workInputTokens} work tokens but --work-tokens is ${state.workTokens}; keep all strategy arms at the same H`);
    const label = `${name}@${workInputTokens}`;
    if (seen.has(label)) throw new Error(`Duplicate arm ${label}`);
    seen.add(label);
    return { name: label, strategy: name, workInputTokens };
  });
}

function describeArm(arm) {
  return { arm: arm.name, strategy: arm.strategy, workInputTokens: arm.workInputTokens };
}

function applicationOptions(arm) {
  return arm.strategy ? { compaction: { strategy: arm.strategy, workInputTokens: arm.workInputTokens } } : {};
}

function budgetForWindow() {
  return {
    maxTokens: null,
    maxModelCalls: null,
    maxToolCalls: null,
    maxDurationMs: MAX_DURATION_MS,
    maxContextTokens: state.windowTokens,
    maxOutputTokens: Math.min(WINDOW_OUTPUT_CAP, Math.floor(state.windowTokens / 8)),
    maxContextChars: null,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
  };
}

// ---- real repository pages: 4 fact pages per batch, 3-4 filler pages per batch ----

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function lineBoundaries(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  if (starts.at(-1) !== text.length) starts.push(text.length);
  return starts;
}

function occurrencesOf(text, anchor) {
  const occurrences = [];
  let position = text.indexOf(anchor);
  while (position >= 0) {
    occurrences.push(position);
    position = text.indexOf(anchor, position + 1);
  }
  return occurrences;
}

/** Candidate pages of FACT_PAGE_MIN_CHARS..maxChars characters whose real text hits every expected regex with the anchor inside the depth band. */
function factPageCandidates(text, starts, anchorPos, anchorLength, expected, maxChars) {
  const candidates = [];
  for (const startChar of starts) {
    if (startChar > anchorPos) break;
    const minimum = startChar + FACT_PAGE_MIN_CHARS;
    if (minimum > text.length) continue;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] >= minimum) high = middle;
      else low = middle + 1;
    }
    const endChar = starts[low];
    const chars = endChar - startChar;
    if (chars < FACT_PAGE_MIN_CHARS || chars > maxChars) continue;
    if (anchorPos + anchorLength > endChar) continue;
    const depth = (anchorPos - startChar) / chars;
    if (depth < FACT_ANCHOR_DEPTH_MIN || depth > FACT_ANCHOR_DEPTH_MAX) continue;
    const content = text.slice(startChar, endChar);
    // The experiment owns the KF-<n> marker namespace: a candidate page that
    // already mentions KF markers (e.g. the design doc's "KF-1～KF-8" note) would
    // break global uniqueness, so it is never used as a fact page.
    if (/KF-\d+\b/.test(content)) continue;
    if (!expected.every(source => new RegExp(source).test(content))) continue;
    candidates.push({ startChar, endChar, content, chars, depth: Number(depth.toFixed(4)) });
  }
  return candidates;
}

async function buildFactPages() {
  const textCache = new Map();
  const pages = [];
  const problems = [];
  for (let index = 0; index < FACT_SPECS.length; index++) {
    const spec = FACT_SPECS[index];
    const marker = KF(spec.questionId);
    const markerText = `【项目事实 ${marker}】${FACT_TEXT[spec.questionId]}`;
    const question = FACT_QUESTIONS.find(item => item.id === spec.questionId);
    const batch = Math.floor(index / FACTS_PER_BATCH) + 1;
    const targetDepth = FACT_TARGET_DEPTH_MIN + ((FACT_TARGET_DEPTH_MAX - FACT_TARGET_DEPTH_MIN) * index) / (FACT_SPECS.length - 1);
    if (!textCache.has(spec.path)) textCache.set(spec.path, await readFile(path.join(REPOSITORY, spec.path), 'utf8'));
    const text = textCache.get(spec.path);
    const occurrences = occurrencesOf(text, spec.anchor);
    if (!occurrences.length) {
      problems.push(`Q${spec.questionId}: anchor ${JSON.stringify(spec.anchor)} not found in ${spec.path}`);
      continue;
    }
    const starts = lineBoundaries(text);
    const pool = spec.occurrence === 'best' ? occurrences : [occurrences[0]];
    const candidates = [];
    for (const anchorPos of pool) {
      for (const candidate of factPageCandidates(text, starts, anchorPos, spec.anchor.length, question.expected, FACT_PAGE_MAX_CHARS - markerText.length - 2)) {
        candidates.push({ ...candidate, anchorPos });
      }
    }
    if (!candidates.length) {
      problems.push(`Q${spec.questionId}: no ${FACT_PAGE_MIN_CHARS}-${FACT_PAGE_MAX_CHARS} character page in ${spec.path} hits expected ${JSON.stringify(question.expected)} around ${JSON.stringify(spec.anchor)}`);
      continue;
    }
    // Prefer larger pages so the incremental seed actually exceeds two windows,
    // then the occurrence closest to the batched target depth.
    candidates.sort((left, right) => (right.chars - left.chars) || (Math.abs(left.depth - targetDepth) - Math.abs(right.depth - targetDepth)) || (left.anchorPos - right.anchorPos));
    const best = candidates[0];
    const targetChar = Math.max(1, Math.min(best.content.length - 1, Math.round(best.content.length * best.depth)));
    const lineStart = best.content.lastIndexOf('\n', targetChar) + 1;
    const content = `${best.content.slice(0, lineStart)}${markerText}\n${best.content.slice(lineStart)}`;
    if (content.length > FACT_PAGE_MAX_CHARS) throw new Error(`Q${spec.questionId}: fact page is ${content.length} characters, over ${FACT_PAGE_MAX_CHARS}`);
    const offset = text.slice(0, best.startChar).split('\n').length;
    const total = text.split('\n').length;
    pages.push({
      kind: 'fact', batch, factId: spec.questionId, marker, markerText,
      markerDepth: Number((content.indexOf(markerText) / content.length).toFixed(4)),
      path: spec.path, anchor: spec.anchor, anchorDepth: best.depth, targetDepth: Number(targetDepth.toFixed(4)),
      offset, end: offset + content.split('\n').length - 1, total,
      content, chars: content.length, tokens: estimateTextTokens(content), hash: sha256(content),
      expectedMatched: question.expected.every(source => new RegExp(source).test(content)),
    });
  }
  if (problems.length) throw new Error(`fact pages failed:\n- ${problems.join('\n- ')}`);
  if (pages.length !== FACT_SPECS.length) throw new Error(`built ${pages.length} fact pages, expected ${FACT_SPECS.length}`);
  return pages;
}

/** Split one real repository text file into ≤maxChars pages, keeping 1-based line offsets. */
function paginateText(relativePath, text, maxChars) {
  const rawLines = text.split('\n');
  const units = [];
  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index];
    if (line.length <= maxChars) units.push({ line: index + 1, content: line });
    else for (let position = 0; position < line.length; position += maxChars) units.push({ line: index + 1, content: line.slice(position, position + maxChars) });
  }
  const pages = [];
  let buffer = [];
  let chars = 0;
  let startLine = 1;
  let endLine = 1;
  const flush = () => {
    if (!buffer.length) return;
    const content = buffer.join('\n');
    if (content.trim()) pages.push({ path: relativePath, offset: startLine, end: endLine, total: rawLines.length, content, chars: content.length, tokens: estimateTextTokens(content) });
    buffer = [];
    chars = 0;
  };
  for (const unit of units) {
    if (chars + unit.content.length + 1 > maxChars && buffer.length) flush();
    if (!buffer.length) startLine = unit.line;
    buffer.push(unit.content);
    chars += unit.content.length + 1;
    endLine = unit.line;
  }
  flush();
  return pages;
}

async function loadFillerPages() {
  const factPaths = new Set(FACT_SPECS.map(spec => spec.path));
  const absoluteFiles = [];
  for (const root of FILLER_ROOTS) {
    try { absoluteFiles.push(...await walkFiles(path.join(REPOSITORY, root))); } catch { /* optional tree */ }
  }
  for (const rootFile of FILLER_ROOT_FILES) {
    const absolute = path.join(REPOSITORY, rootFile);
    if (existsSync(absolute)) absoluteFiles.push(absolute);
  }
  const pool = [];
  for (const absolute of absoluteFiles.sort()) {
    const relative = path.relative(REPOSITORY, absolute).replaceAll('\\', '/');
    if (factPaths.has(relative) || FILLER_EXCLUDED_PREFIXES.some(prefix => relative.startsWith(prefix))) continue;
    if (!FILLER_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    let info;
    try { info = await stat(absolute); } catch { continue; }
    if (!info.isFile() || info.size < MIN_FILLER_FILE_BYTES || info.size > MAX_FILLER_FILE_BYTES) continue;
    let text;
    try { text = await readFile(absolute, 'utf8'); } catch { continue; }
    // The experiment owns the KF-<id> marker namespace; a filler page carrying a
    // marker would break global uniqueness and could leak an answer.
    if (/KF-\d+\b/.test(text)) continue;
    for (const page of paginateText(relative, text, FILLER_PAGE_MAX_CHARS)) {
      if (page.chars < FILLER_PAGE_MIN_CHARS || page.chars > FILLER_PAGE_MAX_CHARS) continue;
      pool.push({ ...page, kind: 'filler' });
    }
  }
  const needed = FILLER_PLAN.reduce((total, count) => total + count, 0);
  if (pool.length < needed) throw new Error(`only ${pool.length} real filler pages of ${FILLER_PAGE_MIN_CHARS}-${FILLER_PAGE_MAX_CHARS} characters are available; ${needed} are required`);
  // Batch 1 gets the three smallest token pages (keeps it under the work budget),
  // and the remaining pages go to batches 2-4 round-robin from largest to smallest
  // so those batches stay token-balanced. Distinct files are preferred first.
  const byTokensAsc = [...pool].sort((left, right) => (left.tokens - right.tokens) || left.path.localeCompare(right.path) || (left.offset - right.offset));
  const batchOne = [];
  const usedPaths = new Set();
  for (const page of byTokensAsc) {
    if (batchOne.length >= FILLER_PLAN[0]) break;
    if (usedPaths.has(page.path)) continue;
    usedPaths.add(page.path);
    batchOne.push({ ...page, batch: 1, hash: sha256(page.content) });
  }
  const rest = pool.filter(page => !batchOne.some(chosen => chosen.path === page.path && chosen.offset === page.offset));
  rest.sort((left, right) => (right.tokens - left.tokens) || left.path.localeCompare(right.path) || (left.offset - right.offset));
  const target = needed - batchOne.length;
  const selectedRest = [];
  for (const page of rest) {
    if (selectedRest.length >= target) break;
    if (selectedRest.some(chosen => chosen.path === page.path)) continue;
    selectedRest.push(page);
  }
  for (const page of rest) {
    if (selectedRest.length >= target) break;
    if (selectedRest.includes(page)) continue;
    selectedRest.push(page);
  }
  const others = [2, 3, 4].flatMap(batch => Array.from({ length: FILLER_PLAN[batch - 1] }, () => batch));
  const assigned = selectedRest.map((page, index) => ({ ...page, batch: others[index % others.length], hash: sha256(page.content) }));
  return [...batchOne, ...assigned];
}

function buildBatches(factPages, fillerPages) {
  const batches = [];
  for (let index = 1; index <= BATCH_COUNT; index++) {
    const facts = factPages.filter(page => page.batch === index).sort((left, right) => left.factId - right.factId);
    const fillers = fillerPages.filter(page => page.batch === index).sort((left, right) => left.tokens - right.tokens);
    if (facts.length !== FACTS_PER_BATCH) throw new Error(`batch ${index} has ${facts.length} fact pages; expected ${FACTS_PER_BATCH}`);
    if (fillers.length !== FILLER_PLAN[index - 1]) throw new Error(`batch ${index} has ${fillers.length} filler pages; expected ${FILLER_PLAN[index - 1]}`);
    const pages = [];
    for (let slot = 0; slot < Math.max(facts.length, fillers.length); slot++) {
      if (fillers[slot]) pages.push(fillers[slot]);
      if (facts[slot]) pages.push(facts[slot]);
    }
    if (pages.length < MIN_PAGES_PER_BATCH || pages.length > MAX_PAGES_PER_BATCH) throw new Error(`batch ${index} has ${pages.length} pages; expected ${MIN_PAGES_PER_BATCH}-${MAX_PAGES_PER_BATCH}`);
    const messages = pages.flatMap((page, pageIndex) => {
      const callId = `read-b${index}-p${pageIndex + 1}`;
      return [
        {
          role: 'assistant',
          content: `读取 ${page.path} 第 ${page.offset}-${page.end} 行（文件共 ${page.total} 行），记录项目证据。`,
          tool_calls: [{ id: callId, name: 'file.read', arguments: JSON.stringify({ path: page.path, offset: page.offset, limit: page.end - page.offset + 1 }) }],
        },
        { role: 'tool', tool_call_id: callId, content: JSON.stringify({ path: page.path, offset: page.offset, total: page.total, content: page.content }) },
      ];
    });
    const batch = {
      index, pages, facts, markerIds: facts.map(page => page.factId), messages,
      contentChars: pages.reduce((total, page) => total + page.chars, 0),
      contentTokens: pages.reduce((total, page) => total + page.tokens, 0),
      toolRounds: pages.length,
      note: '',
      noteTokens: 0,
    };
    batch.note = batchNote(batch);
    batch.noteTokens = estimateTextTokens(batch.note);
    batches.push(batch);
  }
  return batches;
}

async function loadSeed() {
  const factPages = await buildFactPages();
  const fillerPages = await loadFillerPages();
  const batches = buildBatches(factPages, fillerPages);
  const messages = [];
  for (const batch of batches) messages.push(...batch.messages, { role: 'user', content: batch.note });
  const pages = batches.flatMap(batch => batch.pages);
  return {
    factPages, fillerPages, batches, messages, pages,
    contentChars: pages.reduce((total, page) => total + page.chars, 0),
    contentTokens: pages.reduce((total, page) => total + page.tokens, 0),
    contentHash: sha256(JSON.stringify(pages.map(page => ({ path: page.path, offset: page.offset, hash: page.hash })))),
  };
}

function batchTokenSummary(seed) {
  return seed.batches.map(batch => ({
    batch: batch.index, pages: batch.pages.length, facts: batch.facts.length,
    chars: batch.contentChars, contentTokens: batch.contentTokens, toolRounds: batch.toolRounds,
    markers: batch.facts.map(page => page.marker),
  }));
}

/** Full seeded-input estimate in a no-compaction probe: the cumulative context a
 *  trial feeds in before any compression, independent of arm behaviour. */
async function measureFullSeed(seed) {
  const directory = path.join(state.root, '_dry-run', 'full-seed');
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const app = new Application(path.join(directory, 'kodo-state'));
  app.coordinator.mailbox.specs = () => [];
  try {
    const run = app.createRun({
      objective: TASK_OBJECTIVE, workspace, binding: DRY_BINDING, permissions: ['read'],
      budget: { ...budgetForWindow(), maxContextTokens: LIMITS.context, maxOutputTokens: WINDOW_OUTPUT_CAP },
      card: CARD,
    });
    const initial = app.store.readBlob(run.contextRef);
    const all = [...initial, { role: 'user', content: INITIAL_USER_MESSAGE }, ...seed.messages];
    const inputTokens = estimateInputTokens(app.store, run, all, []);
    return { messages: all.length, inputTokens, contentTokens: seed.contentTokens, contentChars: seed.contentChars, ratioToWindow: Number((inputTokens / state.windowTokens).toFixed(3)) };
  } finally {
    await app.shutdown();
  }
}

// ---- dry-run: per-arm buildContext simulation over the four batches ----

function countHidden(messages) {
  return messages.filter(message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('"contextHidden":true')).length;
}

/** Reconstruct the host-injected header prepareContext adds before buildContext.
 *  The kernel execution-state line exists only when a compaction policy is set. */
function simulationPreparedContext(run, context, policy) {
  const retained = context.filter(message => !(message.role === 'system' && (message.content.startsWith('Current decision version:') || message.content.startsWith('Kernel execution state: '))));
  const decisions = 'Current decision version: 0. Effective permissions: read. Current user decisions: []\nCurrent execution environment: simulated dry-run (no model, no tools). Native file scope (relative workspace roots): {}. Omitted sides inherit workspace access; empty arrays deny that operation.';
  const prepared = retained.length ? [retained[0], { role: 'system', content: decisions }, ...retained.slice(1)] : [{ role: 'system', content: decisions }];
  if (policy) {
    const kernel = { objective: run.objective, decisionVersion: 0, children: [], waits: [], calls: [], knowledge: [], note: 'Authoritative runtime status, not task acceptance. Unknown writes require reconciliation, never repetition. Use inspect_run for bounded evidence; knowledge versions are fixed.' };
    prepared.push({ role: 'system', content: `Kernel execution state: ${JSON.stringify(kernel)}` });
  }
  return prepared;
}

function simulationRow(batch, arm, built) {
  return {
    batch: batch.index, pages: batch.pages.length, facts: batch.facts.length, markers: batch.facts.map(page => page.marker),
    preTokens: null, builtTokens: built.estimatedInputTokens,
    buildStrategy: built.strategy ?? null, masked: countHidden(built.messages), omittedMessages: built.omittedMessages ?? 0,
    summaryPlan: built.summaryPlan ? { foldMessages: built.summaryPlan.foldOffsets.length, recentMessages: built.summaryPlan.recentOffsets.length } : null,
    compactionTriggered: Boolean(built.archivedRef || built.strategy || built.summaryPlan),
    originalInputTokens: built.originalInputTokens ?? null, workInputTokens: built.workInputTokens ?? null,
    targetTokens: built.targetTokens ?? null, targetMet: built.targetMet ?? null,
    method: arm.strategy ? `${arm.strategy}@${arm.workInputTokens}` : 'off',
  };
}

async function simulateArm(arm, seed) {
  const directory = path.join(state.root, '_dry-run', arm.name.replaceAll(':', '-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, applicationOptions(arm));
  app.coordinator.mailbox.specs = () => [];
  try {
    let run = app.createRun({ objective: TASK_OBJECTIVE, workspace, binding: DRY_BINDING, permissions: ['read'], budget: budgetForWindow(), card: CARD });
    run = app.store.updateRun(run.id, { contextRef: app.store.blob([...app.store.readBlob(run.contextRef), { role: 'user', content: INITIAL_USER_MESSAGE }]) });
    const rows = [];
    for (const batch of seed.batches) {
      const latest = app.store.run(run.id);
      const appended = [...batch.messages, { role: 'user', content: batch.note }];
      const prepared = simulationPreparedContext(latest, [...app.store.readBlob(latest.contextRef), ...appended], arm.strategy);
      run = app.store.updateRun(run.id, { contextRef: app.store.blob(prepared) });
      const current = app.store.run(run.id);
      const budget = runBudget(current, app.store.session(current.sessionId));
      const preTokens = estimateInputTokens(app.store, current, prepared, []);
      const built = buildContext(app.store, current, budget.maxContextChars, [], {
        maxContextTokens: budget.maxContextTokens,
        maxOutputTokens: contextOutputReserve(budget),
        maxInputTokens: current.modelLimits?.input,
        ...(arm.strategy ? { compaction: { strategy: arm.strategy, workInputTokens: arm.workInputTokens } } : {}),
      });
      const row = simulationRow(batch, arm, built);
      row.preTokens = preTokens;
      rows.push(row);
      run = app.store.updateRun(run.id, { contextRef: app.store.blob(built.messages) });
    }
    // Final QA stage: append the question sheet and build once with the final
    // control plan (frozen = no policy + model-declared 1M window).
    const latest = app.store.run(run.id);
    const qaContext = [...app.store.readBlob(latest.contextRef), { role: 'user', content: qaSheet() }];
    const prepared = simulationPreparedContext(latest, qaContext, state.freezeFinalQA ? null : arm.strategy);
    app.store.updateRun(run.id, { contextRef: app.store.blob(prepared) });
    const current = app.store.run(run.id);
    const budget = runBudget(current, app.store.session(current.sessionId));
    const options = state.freezeFinalQA
      ? { maxContextTokens: LIMITS.context, maxOutputTokens: Math.min(WINDOW_OUTPUT_CAP, budget.maxOutputTokens), maxInputTokens: current.modelLimits?.input }
      : {
        maxContextTokens: budget.maxContextTokens,
        maxOutputTokens: contextOutputReserve(budget),
        maxInputTokens: current.modelLimits?.input,
        ...(arm.strategy ? { compaction: { strategy: arm.strategy, workInputTokens: arm.workInputTokens } } : {}),
      };
    const preTokens = estimateInputTokens(app.store, current, prepared, []);
    const built = buildContext(app.store, current, budget.maxContextChars, [], options);
    const finalQA = {
      frozen: state.freezeFinalQA, preTokens, builtTokens: built.estimatedInputTokens,
      buildStrategy: built.strategy ?? null, masked: countHidden(built.messages), omittedMessages: built.omittedMessages ?? 0,
      summaryPlan: built.summaryPlan ? { foldMessages: built.summaryPlan.foldOffsets.length, recentMessages: built.summaryPlan.recentOffsets.length } : null,
      compactionTriggered: Boolean(built.archivedRef || built.strategy || built.summaryPlan),
    };
    return {
      arm: arm.name, strategy: arm.strategy, workInputTokens: arm.workInputTokens,
      batches: rows,
      batchesWithCompaction: rows.filter(row => row.compactionTriggered).length,
      summaryPlans: rows.filter(row => row.summaryPlan).length,
      finalQA,
    };
  } finally {
    await app.shutdown();
  }
}

function checkFactPages(seed) {
  const problems = [];
  const globalCounts = new Map(Object.keys(FACT_TEXT).map(Number).map(id => [KF(id), 0]));
  for (const page of seed.pages) for (const marker of globalCounts.keys()) {
    const count = (page.content.match(new RegExp(`${marker}\\b`, 'g')) ?? []).length;
    if (count) globalCounts.set(marker, globalCounts.get(marker) + count);
  }
  for (const page of seed.factPages) {
    if (!page.expectedMatched) problems.push(`Q${page.factId}: fact page does not hit expected ${JSON.stringify(FACT_QUESTIONS.find(question => question.id === page.factId).expected)}`);
    const pageCount = (page.content.match(new RegExp(`${page.marker}\\b`, 'g')) ?? []).length;
    if (pageCount !== 1) problems.push(`Q${page.factId}: marker ${page.marker} appears ${pageCount} times on its fact page; expected 1`);
    if (page.markerDepth < FACT_ANCHOR_DEPTH_MIN || page.markerDepth > FACT_ANCHOR_DEPTH_MAX) problems.push(`Q${page.factId}: markerDepth ${page.markerDepth} outside ${FACT_ANCHOR_DEPTH_MIN}-${FACT_ANCHOR_DEPTH_MAX}`);
  }
  const markers = [...globalCounts.entries()];
  for (const [marker, count] of markers) if (count !== 1) problems.push(`global marker ${marker} appears ${count} times; expected exactly 1`);
  const pageSizes = seed.pages.map(page => page.chars);
  for (const batch of seed.batches) {
    for (const page of batch.pages) if (page.chars < FACT_PAGE_MIN_CHARS || page.chars > FACT_PAGE_MAX_CHARS) problems.push(`batch ${batch.index} page ${page.path}:${page.offset} is ${page.chars} chars; expected ${FACT_PAGE_MIN_CHARS}-${FACT_PAGE_MAX_CHARS}`);
    if (batch.facts.length < FACTS_PER_BATCH) problems.push(`batch ${batch.index} has ${batch.facts.length} facts; expected at least ${FACTS_PER_BATCH}`);
  }
  return { passed: problems.length === 0, markers: markers.map(([marker, count]) => ({ marker, count })), minPageChars: Math.min(...pageSizes), maxPageChars: Math.max(...pageSizes), problems };
}

function checkFactCoverage(seed) {
  return QUESTIONS.map(question => {
    const evidence = question.kind === 'executionState' ? INITIAL_USER_MESSAGE : (seed.factPages.find(page => page.factId === question.id)?.content ?? '');
    const checks = effectiveQuestion(question).expected.map(source => ({ source, present: new RegExp(source).test(evidence) }));
    return { id: question.id, kind: question.kind, category: question.category, checks, passed: checks.every(check => check.present) };
  });
}

function assertDryRun(seed, coverage, fullSeed, simulations, factChecks) {
  const problems = [];
  if (!fullSeed.inputTokens || fullSeed.inputTokens <= 2 * state.windowTokens) problems.push(`cumulative seeded input estimate ${fullSeed.inputTokens} is not greater than 2x window (${2 * state.windowTokens})`);
  if (!factChecks.passed) for (const problem of factChecks.problems) problems.push(`fact page: ${problem}`);
  for (const row of coverage) if (!row.passed) problems.push(`coverage Q${row.id}: ${row.checks.filter(check => !check.present).map(check => check.source).join(' | ')}`);
  for (const batch of seed.batches) {
    if (batch.pages.length < MIN_PAGES_PER_BATCH || batch.pages.length > MAX_PAGES_PER_BATCH) problems.push(`batch ${batch.index} has ${batch.pages.length} pages; expected ${MIN_PAGES_PER_BATCH}-${MAX_PAGES_PER_BATCH}`);
    if (batch.facts.length < FACTS_PER_BATCH) problems.push(`batch ${batch.index} has ${batch.facts.length} facts; expected at least ${FACTS_PER_BATCH}`);
  }
  for (const simulation of simulations) {
    const minimum = simulation.strategy ? REQUIRED_COMPACTIONS : 2;
    if (simulation.batchesWithCompaction < minimum) problems.push(`arm ${simulation.arm}: only ${simulation.batchesWithCompaction} batches triggered compaction; expected at least ${minimum}`);
    if (state.freezeFinalQA && simulation.finalQA.compactionTriggered) problems.push(`arm ${simulation.arm}: frozen final QA still triggered compaction (${simulation.finalQA.buildStrategy ?? 'summary plan'})`);
  }
  if (problems.length) throw new Error(`dry-run assertions failed:\n- ${problems.join('\n- ')}`);
}

function printReport(seed, coverage, fullSeed, simulations, factChecks, finalControls) {
  const lines = [];
  lines.push('');
  lines.push('='.repeat(112));
  lines.push('正常增量执行中的多次压缩 — dry-run 校验（不调用真实模型）');
  lines.push('='.repeat(112));
  lines.push(`evaluationVersion: ${EVALUATION_VERSION} | model: ${state.model} | provider: ${state.provider}`);
  lines.push(`arm 统一工作预算 H: ${state.workTokens} | run window: ${state.windowTokens} | final output budget: ${budgetForWindow().maxOutputTokens} | batches: ${BATCH_COUNT} | fillerPlan: ${JSON.stringify(FILLER_PLAN)} | facts/batch: ${FACTS_PER_BATCH}`);
  lines.push(`seed 内容字符: ${seed.contentChars} | 内容 token 估算: ${seed.contentTokens} | 全量 seed 输入 token 估算: ${fullSeed.inputTokens} (window×${fullSeed.ratioToWindow}, 要求 > 2×window = ${2 * state.windowTokens})`);
  lines.push(`final QA 压缩控制: ${finalControls.mode}${finalControls.frozen ? `（冻结：临时禁用 coordinator.compaction，最终 run window ${finalControls.window.before.maxContextTokens} → ${finalControls.window.phase2.maxContextTokens} = 模型声明 ${finalControls.modelContext}，结束后恢复）` : '（允许最终问答阶段正常压缩并记录次数）'}`);
  lines.push('');
  lines.push(`批次组成（每批 ${MIN_PAGES_PER_BATCH}–${MAX_PAGES_PER_BATCH} 页真实仓库页；每页 18000–24000 字符；事实 4 条/批，KF 标记插入页中部）:`);
  lines.push(`  ${pad('batch', 6)} | ${pad('pages', 6)} | ${pad('facts', 6)} | ${pad('chars', 8)} | ${pad('contentTokens', 14)} | markers`);
  for (const row of batchTokenSummary(seed)) lines.push(`  ${pad(row.batch, 6)} | ${pad(row.pages, 6)} | ${pad(row.facts, 6)} | ${pad(row.chars, 8)} | ${pad(row.contentTokens, 14)} | ${row.markers.join(',')}`);
  lines.push('');
  lines.push('事实页位置（KF 标记必须全局唯一；anchor/marker 深度均在 0.15–0.85）:');
  lines.push(`  ${pad('Q', 3)} | ${pad('batch', 6)} | ${pad('path', 30)} | ${pad('offset', 7)} | ${pad('chars', 6)} | ${pad('tokens', 7)} | ${pad('anchorDepth', 11)} | ${pad('markerDepth', 11)} | expected | marker`);
  for (const page of seed.factPages) lines.push(`  ${pad(page.factId, 3)} | ${pad(page.batch, 6)} | ${pad(page.path, 30)} | ${pad(page.offset, 7)} | ${pad(page.chars, 6)} | ${pad(page.tokens, 7)} | ${pad(page.anchorDepth, 11)} | ${pad(page.markerDepth, 11)} | ${page.expectedMatched ? 'PASS' : 'FAIL'} | ${page.marker}`);
  lines.push(`  检查: ${factChecks.passed ? 'PASS' : 'FAIL'} | 页面字符 ${factChecks.minPageChars}–${factChecks.maxPageChars} | markers collected: ${factChecks.markers.length}`);
  for (const problem of factChecks.problems) lines.push(`  PROBLEM: ${problem}`);
  lines.push('');
  lines.push('问题事实在真实页中的覆盖（每道事实题的所有 expected 正则都必须命中其事实页；执行状态题必须命中 pinned 用户消息）:');
  for (const row of coverage) lines.push(`  - Q${pad(row.id, 3)} [${row.kind === 'fact' ? 'fact' : 'exec'}] ${row.passed ? 'PASS' : 'MISSING'} ${row.checks.map(check => `${check.present ? '✓' : '✗'} ${check.source}`).join(' | ')}`);
  lines.push('');
  lines.push('各 arm 的 buildContext 分批模拟（每次 run 前的上下文；不调用 provider）:');
  for (const simulation of simulations) {
    lines.push(`  arm ${simulation.arm} | 触发压缩的批次数: ${simulation.batchesWithCompaction}/${BATCH_COUNT} | summaryPlans: ${simulation.summaryPlans}`);
    lines.push(`    ${pad('batch', 6)} | ${pad('preTokens', 10)} | ${pad('builtTokens', 11)} | ${pad('buildStrategy', 13)} | ${pad('masked', 6)} | ${pad('omitted', 8)} | ${pad('summaryPlan', 14)} | triggered`);
    for (const row of simulation.batches) lines.push(`    ${pad(row.batch, 6)} | ${pad(row.preTokens, 10)} | ${pad(row.builtTokens, 11)} | ${pad(row.buildStrategy ?? '-', 13)} | ${pad(row.masked, 6)} | ${pad(row.omittedMessages, 8)} | ${pad(row.summaryPlan ? `${row.summaryPlan.foldMessages}/${row.summaryPlan.recentMessages}` : '-', 14)} | ${row.compactionTriggered}`);
    lines.push(`    final QA (${simulation.finalQA.frozen ? 'frozen' : 'allow'}): preTokens=${simulation.finalQA.preTokens} builtTokens=${simulation.finalQA.builtTokens} strategy=${simulation.finalQA.buildStrategy ?? '-'} summaryPlan=${Boolean(simulation.finalQA.summaryPlan)} triggered=${simulation.finalQA.compactionTriggered}`);
  }
  lines.push('');
  lines.push('='.repeat(112));
  console.log(lines.join('\n'));
}

// ---- final QA freeze controls (mirrors compaction-qa-retention phase-2 plan) ----

function finalControlPlan() {
  const baseBudget = budgetForWindow();
  const probeSession = {
    id: 'final-qa-window-probe', workspace: '<probe>', permissions: ['read'],
    budget: baseBudget,
    modelBudgetCeilings: { maxContextTokens: baseBudget.maxContextTokens, maxOutputTokens: baseBudget.maxOutputTokens },
    tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, createdAt: 'final-qa-window-probe',
  };
  const probeRun = { id: 'final-qa-window-probe', sessionId: probeSession.id, modelLimits: { context: LIMITS.context, output: LIMITS.output } };
  const frozen = state.freezeFinalQA;
  const before = runBudget(probeRun, probeSession);
  // Raising budget.maxContextTokens alone is not enough: runBudget also clamps to
  // the session modelBudgetCeilings persisted by createRun, so both are raised.
  const raised = frozen ? {
    ...probeSession,
    budget: { ...probeSession.budget, maxContextTokens: LIMITS.context },
    modelBudgetCeilings: { ...probeSession.modelBudgetCeilings, maxContextTokens: LIMITS.context },
  } : probeSession;
  const phase2 = runBudget(probeRun, raised);
  return {
    mode: frozen ? 'freeze' : 'allow', frozen, modelContext: LIMITS.context,
    window: {
      before: { maxContextTokens: before.maxContextTokens, maxOutputTokens: before.maxOutputTokens },
      phase2: { maxContextTokens: phase2.maxContextTokens, maxOutputTokens: phase2.maxOutputTokens },
      raisedForFreeze: frozen && phase2.maxContextTokens > before.maxContextTokens,
    },
  };
}

async function checkFinalControlMechanics() {
  const plan = finalControlPlan();
  const problems = [];
  if (plan.frozen && plan.window.phase2.maxContextTokens !== plan.modelContext) problems.push(`freeze window probe ${plan.window.phase2.maxContextTokens} does not reach the model context ${plan.modelContext}`);
  if (plan.frozen && plan.window.phase2.maxOutputTokens > plan.window.before.maxOutputTokens) problems.push('freeze window probe must not raise the output reserve');
  if (!plan.frozen) return { passed: true, ...plan, coordinatorCompactionToggleable: null, coordinatorPolicyRestored: null, problems };
  const directory = path.join(state.root, '_dry-run', 'final-controls');
  await mkdir(directory, { recursive: true });
  const app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, { compaction: { strategy: 'hybrid', workInputTokens: state.workTokens } });
  try {
    const policyBefore = app.coordinator.compaction;
    if (!policyBefore) problems.push('Application did not install the probe compaction policy');
    app.coordinator.compaction = undefined;
    const toggleable = app.coordinator.compaction === undefined;
    app.coordinator.compaction = policyBefore;
    const restored = app.coordinator.compaction === policyBefore;
    if (!toggleable) problems.push('coordinator.compaction cannot be temporarily disabled; freeze would not stop final-stage compaction');
    if (!restored) problems.push('coordinator.compaction was not restored after the freeze probe');
    return { passed: problems.length === 0, ...plan, coordinatorCompactionToggleable: toggleable, coordinatorPolicyRestored: restored, problems };
  } finally {
    await app.shutdown();
  }
}

function beginFinalControls(app, run) {
  const plan = finalControlPlan();
  const sessionId = run.sessionId;
  const session = app.store.session(sessionId);
  const policyBefore = app.coordinator.compaction;
  const originalBudget = { ...session.budget };
  const originalCeilings = session.modelBudgetCeilings ? { ...session.modelBudgetCeilings } : undefined;
  if (plan.frozen) {
    app.coordinator.compaction = undefined;
    app.store.putSession({
      ...session,
      budget: { ...session.budget, maxContextTokens: LIMITS.context },
      modelBudgetCeilings: { ...(session.modelBudgetCeilings ?? {}), maxContextTokens: LIMITS.context },
    });
  }
  const effective = runBudget(app.store.run(run.id), app.store.session(sessionId));
  return { ...plan, sessionId, runId: run.id, policyBefore, originalBudget, originalCeilings, appliedWindow: { maxContextTokens: effective.maxContextTokens, maxOutputTokens: effective.maxOutputTokens }, restored: false };
}

function endFinalControls(app, controls) {
  app.coordinator.compaction = controls.policyBefore;
  const latest = app.store.session(controls.sessionId);
  app.store.putSession({
    ...latest,
    budget: controls.originalBudget,
    ...(controls.originalCeilings ? { modelBudgetCeilings: controls.originalCeilings } : { modelBudgetCeilings: undefined }),
  });
  controls.restored = true;
  return controls;
}

async function resolveRelayCredentials(provider, providerConfigPath) {
  let key = process.env.KODO_API_KEY ?? process.env.OPENAI_API_KEY;
  let upstream = process.env.KODO_BASE_URL;
  const absolute = path.resolve(providerConfigPath);
  let text;
  try {
    text = await readFile(absolute, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read --provider-config for provider ${provider} (${error.code ?? 'read error'}); environment variables remain supported`, { cause: error });
  }
  const parsed = ts.parseConfigFileTextToJson(absolute, text);
  if (parsed.error) throw new Error(`Cannot parse --provider-config for provider ${provider}`);
  const providerOptions = parsed.config?.provider?.[provider]?.options;
  key ??= providerOptions?.apiKey;
  upstream ??= providerOptions?.baseURL;
  if (typeof key !== 'string' || !key || typeof upstream !== 'string' || !upstream) throw new Error('Configure the existing provider through environment variables or --provider-config; never pass a key on the command line');
  let endpoint;
  try {
    endpoint = new URL(upstream);
  } catch {
    throw new Error('Provider URL is not a valid absolute URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Provider URL must be plain HTTP(S) without credentials or query parameters');
  return { key, upstream };
}

// ---- telemetry helpers (no model) ----

function zeroCompactionEvents() {
  return Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, 0]));
}

function compactionEventCounts(events) {
  const counts = zeroCompactionEvents();
  for (const event of events) if (event.type in counts) counts[event.type]++;
  return counts;
}

function compactionTriggered(events) {
  return events.some(event => event.type === 'context.compacted' || event.type === 'context.summary.started');
}

function sumEventCounts(...counts) {
  return Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, counts.reduce((total, count) => total + (count?.[type] ?? 0), 0)]));
}

function installedSummaryRow(event, phase) {
  const coverage = event.data.coverage;
  const planned = Number.isSafeInteger(coverage?.plannedMessages) ? coverage.plannedMessages : null;
  const covered = Number.isSafeInteger(coverage?.coveredMessages) ? coverage.coveredMessages : null;
  const uncovered = Number.isSafeInteger(coverage?.uncoveredMessages) ? coverage.uncoveredMessages : null;
  const missing = planned === null || covered === null || uncovered === null;
  return {
    phase, runId: event.runId,
    beforeTokens: event.data.beforeTokens ?? null, afterTokens: event.data.afterTokens ?? null, targetMet: event.data.targetMet ?? null,
    sources: event.data.sources ?? null,
    coveredMessages: Array.isArray(event.data.coveredOffsets) ? event.data.coveredOffsets.length : null,
    coverage: missing ? null : { plannedMessages: planned, coveredMessages: covered, uncoveredMessages: uncovered },
    coverageNote: missing ? COVERAGE_PENDING_NOTE : null,
  };
}

function callsUsage(app, calls) {
  const modelCalls = calls.filter(call => call.kind === 'model');
  let input = 0;
  let output = 0;
  let measured = 0;
  let unmeasured = 0;
  for (const call of modelCalls) {
    let response;
    try { response = call.resultRef ? app.store.readBlob(call.resultRef) : undefined; } catch { response = undefined; }
    const usage = response?.usage;
    if (usage && Number.isSafeInteger(usage.input) && Number.isSafeInteger(usage.output)) {
      input += usage.input;
      output += usage.output;
      measured++;
    } else if (call.status === 'succeeded') unmeasured++;
  }
  return { calls: modelCalls.length, summaryCalls: modelCalls.filter(call => call.purpose === 'compaction').length, input, output, measuredCalls: measured, unmeasuredCalls: unmeasured };
}

function inspectRun(app, runId) {
  try {
    const current = app.context(runId);
    return current.error ? { available: false, error: current.error } : {
      available: true, estimatedInputTokens: current.estimatedInputTokens, parts: current.parts, messageCount: current.messageCount,
      hiddenObservations: current.hiddenObservations, latestCompaction: current.latestCompaction,
      summary: current.summary ? { present: true, ref: current.summary.ref, sources: current.summary.sources, coveredOffsets: current.summary.coveredOffsets, previousSummaryRef: current.summary.previousSummaryRef ?? null, beforeTokens: current.summary.beforeTokens, afterTokens: current.summary.afterTokens } : { present: false },
      usage: current.usage,
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

function resultText(app, run) {
  try {
    return run?.resultRef ? String(app.store.readBlob(run.resultRef).text ?? '') : '';
  } catch {
    return '';
  }
}

function liveBinding(baseURL) {
  return { protocol: 'chat-completions', model: state.model, baseURL, apiKeyEnv: 'KODO_REAL_TASK_RELAY_KEY', limits: LIMITS };
}

// ---- real execution: four batches then the closed-book QA run ----

async function runHarness(arm, workspace, directory, relayBaseURL) {
  const traceFile = path.join(directory, 'trace.jsonl');
  const trace = (type, data) => appendLine(traceFile, { type, time: new Date().toISOString(), ...data });
  process.env.KODO_REAL_TASK_RELAY_KEY = 'fixture-relay-key';
  let app;
  const batchRows = [];
  try {
    app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, applicationOptions(arm));
    app.coordinator.mailbox.specs = () => [];
    app.store.subscribe(event => {
      if (TRACE_EVENT_TYPES.has(event.type)) trace(event.type, { runId: event.runId, ...event.data });
    });
    let run = app.createRun({ objective: TASK_OBJECTIVE, workspace, binding: liveBinding(relayBaseURL), permissions: ['read'], budget: budgetForWindow(), card: CARD });
    run = app.store.updateRun(run.id, { contextRef: app.store.blob([...app.store.readBlob(run.contextRef), { role: 'user', content: INITIAL_USER_MESSAGE }]) });
    const runId = run.id;
    trace('qa.incremental.seeded', { arm: arm.name, objective: TASK_OBJECTIVE, questionSheetIncludedBeforeFinal: false, plan: '4 batches, model confirms, final closed-book QA' });
    for (const batch of state.seed.batches) {
      const latest = app.store.run(runId);
      const priorEventCount = app.store.events(runId).length;
      const priorCallIds = new Set(app.store.calls(runId).map(call => call.id));
      const context = app.store.readBlob(latest.contextRef);
      const appended = [...batch.messages, { role: 'user', content: batch.note }];
      const appendedTokens = estimateInputTokens(app.store, latest, appended, []);
      const preTokens = estimateInputTokens(app.store, latest, [...context, ...appended], []);
      app.store.updateRun(runId, {
        contextRef: app.store.blob([...context, ...appended]),
        status: 'queued',
        stepCallId: undefined,
        resultRef: undefined,
        error: undefined,
      });
      trace('batch.seeded', { batch: batch.index, pages: batch.pages.length, facts: batch.markerIds, toolRounds: batch.toolRounds, appendedTokens, preTokens, contextMessages: context.length + appended.length });
      const started = Date.now();
      let final;
      try { final = await app.run(runId); } catch (error) { final = { status: 'failed', error: error.message }; }
      const durationMs = Date.now() - started;
      const text = resultText(app, final);
      const events = app.store.events(runId).slice(priorEventCount);
      const calls = app.store.calls(runId).filter(call => !priorCallIds.has(call.id));
      const inspection = inspectRun(app, runId);
      const counts = compactionEventCounts(events);
      const row = {
        batch: batch.index, pages: batch.pages.length, facts: batch.facts.length, markers: batch.markerIds, toolRounds: batch.toolRounds,
        appendedMessages: appended.length, appendedTokens, preTokens,
        postTokens: inspection.estimatedInputTokens ?? null,
        status: final.status, error: final.error ?? null, durationMs, text: text.slice(0, 4_000),
        events: counts, compactionTriggered: compactionTriggered(events),
        contextCompacted: counts['context.compacted'], summaryStarted: counts['context.summary.started'],
        summaryInstalled: counts['context.summary.installed'], summaryFailed: counts['context.summary.failed'],
        installed: events.filter(event => event.type === 'context.summary.installed').map(event => installedSummaryRow(event, `batch${batch.index}`)),
        hiddenObservations: inspection.hiddenObservations ?? null,
        modelCalls: callsUsage(app, calls), toolCalls: calls.filter(call => call.kind === 'tool').length,
        runStep: app.store.run(runId).step, runStatus: app.store.run(runId).status,
      };
      batchRows.push(row);
      trace('batch.finished', { batch: row.batch, status: row.status, error: row.error, durationMs, preTokens, postTokens: row.postTokens, events: row.events, summaryInstalled: row.summaryInstalled, modelCalls: row.modelCalls, text: row.text });
      appendLine(state.eventsPath, { event: 'trial.batch', trial: `${arm.name.replaceAll(':', '-')}--r${state.currentRepeat}`, batch: row.batch, status: row.status, error: row.error, appendedTokens, preTokens, postTokens: row.postTokens, events: row.events, markers: row.markers, durationMs });
      if (final.status !== 'completed') {
        return { status: 'failed', error: `BATCH_${batch.index}_${final.status}: ${final.error ?? 'batch run did not complete'}`, batchRows, finalQA: null, answerText: '', durationMs: batchRows.reduce((total, item) => total + item.durationMs, 0) };
      }
    }
    // Final closed-book QA over the retained incremental projection.
    const latest = app.store.run(runId);
    const priorEventCount = app.store.events(runId).length;
    const priorCallIds = new Set(app.store.calls(runId).map(call => call.id));
    const qaContext = [...app.store.readBlob(latest.contextRef), { role: 'user', content: qaSheet() }];
    const preTokens = estimateInputTokens(app.store, latest, qaContext, []);
    app.store.updateRun(runId, { contextRef: app.store.blob(qaContext), status: 'queued', stepCallId: undefined, resultRef: undefined, error: undefined });
    const controls = beginFinalControls(app, app.store.run(runId));
    trace('qa.final.controls', { runId, mode: controls.mode, frozen: controls.frozen, windowBefore: controls.window.before, windowExpected: controls.window.phase2, windowApplied: controls.appliedWindow, raisedForFreeze: controls.window.raisedForFreeze });
    const started = Date.now();
    let finalRun;
    try { finalRun = await app.run(runId); } catch (error) { finalRun = { status: 'failed', error: error.message }; }
    finally { endFinalControls(app, controls); }
    const durationMs = Date.now() - started;
    const answerText = resultText(app, finalRun);
    const events = app.store.events(runId).slice(priorEventCount);
    const calls = app.store.calls(runId).filter(call => !priorCallIds.has(call.id));
    const inspection = inspectRun(app, runId);
    const counts = compactionEventCounts(events);
    const eventCount = Object.values(counts).reduce((total, value) => total + value, 0);
    const finalQA = {
      mode: controls.mode, frozen: controls.frozen, status: finalRun.status, error: finalRun.error ?? null,
      preTokens, postTokens: inspection.estimatedInputTokens ?? null, durationMs, answerChars: answerText.length,
      events: counts, compactionTriggered: compactionTriggered(events), compactionEventCount: eventCount,
      summaryInstalled: counts['context.summary.installed'], contextCompacted: counts['context.compacted'],
      installed: events.filter(event => event.type === 'context.summary.installed').map(event => installedSummaryRow(event, 'finalQA')),
      controls: {
        mode: controls.mode, frozen: controls.frozen,
        window: { before: controls.window.before, expected: controls.window.phase2, applied: controls.appliedWindow, raisedForFreeze: controls.window.raisedForFreeze },
        restored: controls.restored, summaryInstalled: counts['context.summary.installed'],
        compactionEventCount: eventCount, freezeViolated: controls.frozen && eventCount > 0,
      },
      hiddenObservations: inspection.hiddenObservations ?? null,
      modelCalls: callsUsage(app, calls), runStatus: app.store.run(runId).status, text: answerText.slice(0, 12_000),
    };
    trace('qa.final.finished', { runId, status: finalQA.status, error: finalQA.error, answerChars: finalQA.answerChars, durationMs, preTokens, postTokens: finalQA.postTokens, events: finalQA.events, controls: finalQA.controls });
    appendLine(state.eventsPath, { event: 'trial.finalQA', trial: `${arm.name.replaceAll(':', '-')}--r${state.currentRepeat}`, status: finalQA.status, error: finalQA.error, preTokens, postTokens: finalQA.postTokens, events: finalQA.events, compactionTriggered: finalQA.compactionTriggered, controls: finalQA.controls, durationMs });
    return { status: finalRun.status, error: finalRun.error ?? null, batchRows, finalQA, answerText, durationMs: batchRows.reduce((total, item) => total + item.durationMs, 0) + durationMs };
  } finally {
    try {
      if (app) await app.shutdown();
    } finally {
      delete process.env.KODO_REAL_TASK_RELAY_KEY;
    }
  }
}

// ---- scoring ----

function parseAnswerSegments(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const marker = /^\s*(?:[-*•]\s*)?(?:\*\*)?Q\s*(\d+)\s*(?:\*\*)?\s*[:：.)、）]\s*(.*)$/i;
  const markers = [];
  for (let index = 0; index < lines.length; index++) {
    const match = marker.exec(lines[index]);
    if (match) markers.push({ id: Number(match[1]), start: index, rest: match[2] });
  }
  const segments = new Map();
  for (let index = 0; index < markers.length; index++) {
    const row = markers[index];
    if (segments.has(row.id)) continue;
    const end = index + 1 < markers.length ? markers[index + 1].start : lines.length;
    segments.set(row.id, [row.rest, ...lines.slice(row.start + 1, end)].join('\n').trim());
  }
  return segments;
}

function scoreAnswers(text) {
  const segments = parseAnswerSegments(text);
  const questions = QUESTIONS.map(original => {
    const question = effectiveQuestion(original);
    const answer = segments.get(question.id) ?? '';
    const normalized = answer.replace(/\s+/g, ' ').trim();
    const unknown = /^unknown\b/i.test(normalized);
    const checks = question.expected.map(source => ({ source, passed: new RegExp(source).test(normalized) }));
    return { id: question.id, kind: original.kind, category: original.category, prompt: question.prompt, answer, pass: Boolean(normalized) && !unknown && checks.every(check => check.passed), checks, missing: checks.filter(check => !check.passed).map(check => check.source) };
  });
  const summarize = list => ({ passed: list.filter(question => question.pass).length, total: list.length, rate: list.length ? Number((list.filter(question => question.pass).length / list.length).toFixed(4)) : null });
  return {
    questions,
    facts: summarize(questions.filter(question => question.kind === 'fact')),
    executionState: summarize(questions.filter(question => question.kind === 'executionState')),
    overall: summarize(questions),
    byCategory: Object.fromEntries([...new Set(QUESTIONS.map(question => question.category))].map(category => [category, summarize(questions.filter(question => question.category === category))])),
  };
}

async function trialExecution(arm, repeat) {
  const id = `${arm.name.replaceAll(':', '-')}--r${repeat}`;
  state.currentRepeat = repeat;
  const directory = path.join(state.root, id);
  const workspace = path.join(directory, 'workspace');
  await mkdir(directory, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(directory, 'trace.jsonl'), '');
  const wireDirectory = path.join(directory, 'wire');
  await mkdir(wireDirectory, { recursive: true });
  const relay = await createBudgetRelay({ directory: wireDirectory, upstream: state.upstream, key: state.secret, model: state.model, maxContextChars: Number.MAX_SAFE_INTEGER, maxOutputTokens: LIMITS.output, unrestricted: true });
  const started = Date.now();
  let execution;
  try {
    execution = await runHarness(arm, workspace, directory, relay.baseURL);
  } catch (error) {
    execution = { status: 'failed', error: error.message, batchRows: [], finalQA: null, answerText: '', durationMs: Date.now() - started };
  } finally {
    await relay.close();
  }
  const wireStats = globalThis.structuredClone(relay.stats);
  const usage = usageScorecard(wireStats);
  const scored = scoreAnswers(execution.answerText);
  const batches = execution.batchRows;
  const finalQA = execution.finalQA;
  const batchEvents = batches.reduce((counts, row) => sumEventCounts(counts, row.events), zeroCompactionEvents());
  const events = sumEventCounts(batchEvents, finalQA?.events);
  const batchPasses = batches.filter(batch => batch.compactionTriggered).length;
  const row = {
    id, arm: arm.name, strategy: arm.strategy, workInputTokens: arm.workInputTokens, repeat,
    workspace, directory: path.relative(state.root, directory),
    status: execution.status, error: execution.error ?? null,
    answerText: execution.answerText, answers: scored.questions,
    accuracy: { facts: scored.facts, executionState: scored.executionState, overall: scored.overall, byCategory: scored.byCategory },
    batches, finalQA,
    compaction: {
      batchPasses, batchesWithCompaction: batchPasses,
      totalBatchEvents: batchEvents, totalEvents: events,
      summaryModelCalls: batches.reduce((total, batch) => total + batch.modelCalls.summaryCalls, 0) + (finalQA?.modelCalls.summaryCalls ?? 0),
      summaryInstalled: events['context.summary.installed'], summaryFailed: events['context.summary.failed'],
      finalPasses: finalQA?.compactionTriggered ? 1 : 0, finalSummaryInstalled: finalQA?.summaryInstalled ?? 0,
      finalFrozen: Boolean(finalQA?.frozen), freezeViolated: Boolean(finalQA?.controls?.freezeViolated),
    },
    usage, requests: wireStats.requests, executionMs: execution.durationMs ?? Date.now() - started,
    createdAt: new Date().toISOString(),
  };
  await writeJson(path.join(directory, 'result.json'), row);
  await writeFile(path.join(directory, 'answer.txt'), `${redact(execution.answerText)}\n`);
  appendLine(state.eventsPath, {
    event: 'trial', id, arm: row.arm, strategy: row.strategy, workInputTokens: row.workInputTokens, repeat,
    status: row.status, error: row.error, batchPasses: row.compaction.batchPasses,
    batches: batches.map(batch => ({ batch: batch.batch, status: batch.status, appendedTokens: batch.appendedTokens, preTokens: batch.preTokens, postTokens: batch.postTokens, compactionTriggered: batch.compactionTriggered, events: batch.events, summaryInstalled: batch.summaryInstalled, modelCalls: batch.modelCalls, durationMs: batch.durationMs })),
    finalQA: finalQA ? { status: finalQA.status, mode: finalQA.mode, frozen: finalQA.frozen, compactionTriggered: finalQA.compactionTriggered, events: finalQA.events, summaryInstalled: finalQA.summaryInstalled, controls: finalQA.controls, durationMs: finalQA.durationMs } : null,
    accuracy: row.accuracy, requests: row.requests,
    usage: { input: usage.input, output: usage.output, estimatedCny: usage.estimatedCny },
    executionMs: row.executionMs,
  });
  return row;
}

// ---- summaries and root outputs ----

function summarizeChecks(checks) {
  const passed = checks.filter(check => check.pass).length;
  return { passed, total: checks.length, rate: checks.length ? Number((passed / checks.length).toFixed(4)) : null };
}

function summarizeRows(rows) {
  const armSummaries = state.arms.map(arm => {
    const armRows = rows.filter(row => row.arm === arm.name);
    const checks = armRows.flatMap(row => row.answers);
    const sum = selector => armRows.reduce((total, row) => total + (selector(row) ?? 0), 0);
    const batchRows = armRows.flatMap(row => row.batches);
    const finalQARows = armRows.map(row => row.finalQA).filter(Boolean);
    const batchIndexOf = index => batchRows.filter(batch => batch.batch === index);
    return {
      arm: arm.name, strategy: arm.strategy, workInputTokens: arm.workInputTokens,
      attempts: armRows.length,
      completed: armRows.filter(row => row.status === 'completed').length,
      failed: armRows.filter(row => row.status !== 'completed').length,
      accuracy: {
        facts: summarizeChecks(checks.filter(check => check.kind === 'fact')),
        executionState: summarizeChecks(checks.filter(check => check.kind === 'executionState')),
        overall: summarizeChecks(checks),
        meanTrialRate: mean(armRows.map(row => row.accuracy?.overall?.rate)),
        byCategory: Object.fromEntries([...new Set(QUESTIONS.map(question => question.category))].map(category => [category, summarizeChecks(checks.filter(check => check.category === category))])),
      },
      perQuestion: QUESTIONS.map(question => ({ id: question.id, kind: question.kind, category: question.category, ...summarizeChecks(checks.filter(check => check.id === question.id)) })),
      batches: {
        expected: BATCH_COUNT,
        meanPages: mean(batchRows.map(batch => batch.pages)),
        meanFacts: mean(batchRows.map(batch => batch.facts)),
        meanAppendedTokens: mean(batchRows.map(batch => batch.appendedTokens)),
        meanPreTokens: mean(batchRows.map(batch => batch.preTokens)),
        meanPostTokens: mean(batchRows.map(batch => batch.postTokens)),
        byIndex: Array.from({ length: BATCH_COUNT }, (_, index) => ({
          batch: index + 1, rows: batchIndexOf(index + 1).length,
          meanAppendedTokens: mean(batchIndexOf(index + 1).map(batch => batch.appendedTokens)),
          meanPreTokens: mean(batchIndexOf(index + 1).map(batch => batch.preTokens)),
          meanPostTokens: mean(batchIndexOf(index + 1).map(batch => batch.postTokens)),
          trialsWithCompaction: batchIndexOf(index + 1).filter(batch => batch.compactionTriggered).length,
        })),
      },
      compaction: {
        batchPasses: sum(row => row.compaction?.batchPasses),
        batchesWithCompaction: sum(row => row.compaction?.batchesWithCompaction),
        events: sumEventCounts(...armRows.map(row => row.compaction?.totalBatchEvents)),
        finalQAPasses: sum(row => row.compaction?.finalPasses),
        finalQAEvents: sumEventCounts(...armRows.map(row => row.finalQA?.events)),
        summaryInstalled: sum(row => row.compaction?.summaryInstalled),
        summaryFailed: sum(row => row.compaction?.summaryFailed),
        summaryModelCalls: sum(row => row.compaction?.summaryModelCalls),
        trialsWithAtLeastThreeBatchCompactions: armRows.filter(row => (row.compaction?.batchPasses ?? 0) >= REQUIRED_COMPACTIONS).length,
        finalFrozenTrials: finalQARows.filter(item => item.frozen).length,
        freezeViolations: armRows.filter(row => row.compaction?.freezeViolated).length,
        coverage: {
          source: 'context.summary.installed',
          rows: armRows.flatMap(row => row.batches.flatMap(batch => batch.installed ?? [])).concat(finalQARows.flatMap(item => item.installed ?? [])),
          pendingNote: COVERAGE_PENDING_NOTE,
        },
      },
      tokens: {
        requests: sum(row => row.usage?.requests),
        input: sum(row => row.usage?.input),
        output: sum(row => row.usage?.output),
        total: sum(row => row.usage?.total),
        cached: sum(row => row.usage?.cached),
        estimatedCny: { low: sum(row => row.usage?.estimatedCny?.low), high: sum(row => row.usage?.estimatedCny?.high), complete: armRows.every(row => row.usage?.usageComplete !== false) },
      },
      durationMs: { mean: mean(armRows.map(row => row.executionMs)), total: sum(row => row.executionMs) },
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    evaluationVersion: EVALUATION_VERSION,
    mode: state.runMode ? 'run' : 'dry-run',
    freezeFinalQA: state.freezeFinalQA,
    freezeFinalQAControlPlan: finalControlPlan(),
    attempts: rows.length,
    questions: QUESTIONS.map(question => { const effective = effectiveQuestion(question); return { id: question.id, kind: question.kind, category: question.category, prompt: effective.prompt, expected: effective.expected }; }),
    arms: armSummaries,
    caveats: [
      '增量设计：同一 run 逐批追加真实 file.read 轮次，每批后 app.run；压缩发生在每次 run 的 prepareContext，而不是一次性灌入超长历史。',
      state.freezeFinalQA
        ? 'final QA 冻结（--freeze-final-qa）：最终问答 run 前临时禁用 coordinator.compaction，并把该 run 的 session window 与 modelBudgetCeilings 抬到模型声明 context=1,000,000，结束后恢复；freezeViolated 必须为 false 才能把最终答案解释为“冻结投影上的闭卷保留”。'
        : 'final QA 允许正常压缩：最终问答阶段可能再次压缩，其压缩次数记录在 finalQA.events/finalPasses；因此最终答案衡量的是允许最终压缩的真实产品行为，不是单次压缩保真。',
      '事实题（Q1–Q16）的 expected 要求答案以对应 KF 标记开头，标记只在其事实页出现一次；问题文本本身含标记，所以“命中标记”不等于证明来源页保留，这只排除从其他重复数值页猜测（见复核文档 §3.4）。',
      '执行状态题（Q17–Q20）来自早期 pinned 用户消息（目标/约束/计划/未知写入规则）；它们与事实题分开汇总。pinned 用户消息不会被压缩，因此这组分数是执行状态保留的正控制，不是压缩难度指标。',
      'off 是无新策略开关的硬容量基线，只在超过 run window 时触发 context.compacted/hard；mask/summary/hybrid 在工作预算 H 触发。不同 arm 的实际路径与次数必须按实际事件报告。',
      '摘要覆盖率遥测从 context.summary.installed 读取可选 coverage 字段；当前宿主未写该字段时写 null 并标记 coverage telemetry pending host implementation，不猜测覆盖率。',
      'repeats 默认 2，属探索性描述统计；不声称统计显著性，也不作为默认启用新压缩策略的依据。',
    ],
  };
}

async function writeRootOutputs(rows) {
  const summary = summarizeRows(rows);
  const includeAnswers = state.includeAnswers;
  const results = rows.map(row => ({
    ...row,
    answerText: includeAnswers ? row.answerText : undefined,
    answers: row.answers.map(answer => ({ id: answer.id, kind: answer.kind, category: answer.category, pass: answer.pass, checks: answer.checks, ...(includeAnswers ? { answer: answer.answer } : {}) })),
    finalQA: row.finalQA ? { ...row.finalQA, text: includeAnswers ? row.finalQA.text : undefined } : null,
    batches: row.batches.map(batch => ({ ...batch, text: includeAnswers ? batch.text : undefined })),
  }));
  await writeJson(path.join(state.root, 'results.json'), {
    evaluationVersion: EVALUATION_VERSION, createdAt: state.createdAt, mode: state.runMode ? 'run' : 'dry-run',
    freezeFinalQA: state.freezeFinalQA, model: state.model, provider: state.provider, upstream: state.upstream ?? null,
    sourceHash: state.sourceHash, workTokens: state.workTokens, windowTokens: state.windowTokens,
    seedTokens: state.seed?.contentTokens ?? null,
    batches: state.seed?.batches.map(batch => ({ batch: batch.index, pages: batch.pages.length, facts: batch.facts.length, chars: batch.contentChars, contentTokens: batch.contentTokens })) ?? null,
    arms: state.arms.map(describeArm), results, summary,
  });
  await writeJson(path.join(state.root, 'summary.json'), summary);
}

async function writeManifest(dryRun) {
  const seed = state.seed;
  const manifest = {
    evaluationVersion: EVALUATION_VERSION, mode: state.runMode ? 'run' : 'dry-run', createdAt: state.createdAt,
    model: state.model, provider: state.provider, upstream: state.upstream ?? null, sourceHash: state.sourceHash,
    workTokens: state.workTokens, windowTokens: state.windowTokens, outputTokens: budgetForWindow().maxOutputTokens,
    freezeFinalQA: state.freezeFinalQA, freezeFinalQAControlPlan: finalControlPlan(),
    arms: state.arms.map(describeArm), repeats: state.repeats,
    limits: { model: LIMITS, budget: budgetForWindow(), maxDurationMs: MAX_DURATION_MS },
    design: {
      purpose: '验证正常增量执行中多次压缩后的项目事实保留与执行状态保留：同一 run 分 4 批增长上下文，每批执行一次模型，最后闭卷问答。',
      batchCount: BATCH_COUNT, fillerPlan: FILLER_PLAN, factsPerBatch: FACTS_PER_BATCH,
      batches: '第 1–4 批逐批把 6-8 页真实仓库 file.read 轮次追加到同一 run.contextRef，并 requeue 后 app.run；第 4 批后追加 20 题闭卷 QA 再 run。',
      objective: TASK_OBJECTIVE, initialUserMessage: INITIAL_USER_MESSAGE, questionSheetIncludedBeforeFinal: false,
      pageCharRange: [FACT_PAGE_MIN_CHARS, FACT_PAGE_MAX_CHARS],
      fillerSource: '真实仓库文件（src/docs/examples/tests/.github 与根配置文件；排除 vendor、构建产物、.kodo、scripts 与含 KF 标记的文件）',
      arms: { off: '无新策略开关的硬容量裁剪基线', mask: `成批隐藏旧工具正文（H=${state.workTokens}）`, summary: `有界模型任务摘要（H=${state.workTokens}）`, hybrid: `先隐藏旧观察，仍超 H 再摘要（H=${state.workTokens}）` },
      scoring: '按 Q<id> 抽取最终答案段落；事实题要求 KF 标记 + 全部 expected 正则，执行状态题要求全部 expected 正则；UNKNOWN/缺失记失败；facts 16 与 executionState 4 分开汇总。',
      finalQACompaction: state.freezeFinalQA ? 'freeze：临时禁用 coordinator.compaction + 最终 run window 抬到模型声明 1M，结束后恢复；应无最终阶段压缩' : 'allow：最终问答阶段可正常压缩并记录次数',
    },
    seed: {
      contentChars: seed.contentChars, contentTokens: seed.contentTokens, contentHash: seed.contentHash,
      batches: batchTokenSummary(seed),
      pages: seed.batches.map(batch => ({
        batch: batch.index,
        pages: batch.pages.map(page => ({
          kind: page.kind, path: page.path, offset: page.offset, end: page.end, total: page.total, chars: page.chars, tokens: page.tokens, hash: page.hash,
          ...(page.kind === 'fact' ? { factId: page.factId, marker: page.marker, anchor: page.anchor, anchorDepth: page.anchorDepth, markerDepth: page.markerDepth, targetDepth: page.targetDepth, expectedMatched: page.expectedMatched } : {}),
        })),
      })),
    },
    questions: QUESTIONS.map(question => { const effective = effectiveQuestion(question); return { id: question.id, kind: question.kind, category: question.category, prompt: effective.prompt, expected: effective.expected }; }),
    accounting: {
      rates: historicRates,
      tokens: '以 relay 记录的上游 usage 为准；usage 缺失时保留估算并标记，不当作账单。',
      cost: '估算费用基于历史公开默认组费率，非供应商发票。',
    },
    dryRun,
    host: { platform: process.platform, release: os.release(), node: process.version, cpu: os.cpus()[0]?.model ?? null },
  };
  await writeJson(path.join(state.root, 'manifest.json'), manifest);
}

// ---- main ----

async function main(values) {
  if (values.run && values['dry-run']) throw new Error('--run and --dry-run are mutually exclusive');
  state.runMode = Boolean(values.run);
  state.includeAnswers = Boolean(values['include-answers']);
  state.freezeFinalQA = Boolean(values['freeze-final-qa']);
  state.createdAt = new Date().toISOString();
  state.model = values.model;
  if (state.model !== FROZEN_MODEL) throw new Error(`This frozen experiment describes ${FROZEN_MODEL} capacities only; pass --model ${FROZEN_MODEL}`);
  state.provider = typeof values.provider === 'string' ? values.provider.trim() : '';
  if (!state.provider) throw new Error('--provider must be nonempty');
  state.workTokens = Number(values['work-tokens']);
  if (!Number.isSafeInteger(state.workTokens) || state.workTokens < MIN_WORK_TOKENS || state.workTokens > MAX_WORK_TOKENS) throw new Error(`--work-tokens must be an integer ${MIN_WORK_TOKENS}..${MAX_WORK_TOKENS}`);
  state.windowTokens = Number(values['window-tokens']);
  if (!Number.isSafeInteger(state.windowTokens) || state.windowTokens < 32_768 || state.windowTokens >= LIMITS.context) throw new Error(`--window-tokens must be an integer 32768..${LIMITS.context - 1} (the model declaration stays ${LIMITS.context})`);
  state.repeats = Number(values.repeats);
  if (!Number.isSafeInteger(state.repeats) || state.repeats < 1 || state.repeats > MAX_REPEATS) throw new Error(`--repeats must be an integer 1..${MAX_REPEATS}`);
  state.arms = parseArms(values.arms);
  const requestedRoot = values.root ?? path.join(REPOSITORY, '.kodo', `compaction-qa-incremental-${state.runMode ? 'run' : 'dry'}-${Date.now()}`);
  state.root = path.resolve(requestedRoot);
  if (existsSync(state.root)) throw new Error('Use a fresh --root directory; previous evidence is never overwritten');
  await mkdir(state.root, { recursive: true });
  state.eventsPath = path.join(state.root, 'events.jsonl');
  await writeFile(state.eventsPath, '');
  emit({ event: 'qa-incremental.preparing', root: state.root, mode: state.runMode ? 'run' : 'dry-run', model: state.model, provider: state.provider, arms: state.arms.map(describeArm), repeats: state.repeats, workTokens: state.workTokens, windowTokens: state.windowTokens, outputTokens: budgetForWindow().maxOutputTokens, freezeFinalQA: state.freezeFinalQA });

  const seed = await loadSeed();
  state.seed = seed;
  appendLine(state.eventsPath, { event: 'seed.loaded', batches: batchTokenSummary(seed), contentChars: seed.contentChars, contentTokens: seed.contentTokens, contentHash: seed.contentHash, pages: seed.pages.map(page => ({ kind: page.kind, path: page.path, offset: page.offset, chars: page.chars, tokens: page.tokens, batch: page.batch, factId: page.factId ?? null, marker: page.marker ?? null, hash: page.hash })) });
  emit({ event: 'seed.loaded', batches: batchTokenSummary(seed), pages: seed.pages.length, contentChars: seed.contentChars, contentTokens: seed.contentTokens, markerCount: seed.factPages.length });
  const factChecks = checkFactPages(seed);
  const coverage = checkFactCoverage(seed);
  for (const row of coverage) appendLine(state.eventsPath, { event: 'dry-run.fact', question: row.id, kind: row.kind, category: row.category, passed: row.passed, checks: row.checks });
  const fullSeed = await measureFullSeed(seed);
  emit({ event: 'dry-run.fullSeed', ...fullSeed, windowTokens: state.windowTokens, required: 2 * state.windowTokens });
  appendLine(state.eventsPath, { event: 'dry-run.fullSeed', ...fullSeed, windowTokens: state.windowTokens, required: 2 * state.windowTokens });
  const simulations = [];
  for (const arm of state.arms) {
    const simulation = await simulateArm(arm, seed);
    simulations.push(simulation);
    emit({ event: 'dry-run.arm', arm: simulation.arm, strategy: simulation.strategy, batchesWithCompaction: simulation.batchesWithCompaction, summaryPlans: simulation.summaryPlans, batches: simulation.batches.map(row => ({ batch: row.batch, preTokens: row.preTokens, builtTokens: row.builtTokens, buildStrategy: row.buildStrategy, masked: row.masked, omittedMessages: row.omittedMessages, summaryPlan: Boolean(row.summaryPlan), compactionTriggered: row.compactionTriggered })), finalQA: simulation.finalQA });
    appendLine(state.eventsPath, { event: 'dry-run.arm', arm: simulation.arm, strategy: simulation.strategy, workInputTokens: simulation.workInputTokens, batches: simulation.batches, batchesWithCompaction: simulation.batchesWithCompaction, summaryPlans: simulation.summaryPlans, finalQA: simulation.finalQA });
  }
  const finalControls = await checkFinalControlMechanics();
  printReport(seed, coverage, fullSeed, simulations, factChecks, finalControls);
  state.sourceHash = sha256(JSON.stringify({ evaluationVersion: EVALUATION_VERSION, windowTokens: state.windowTokens, content: seed.contentHash, questions: QUESTIONS.map(question => ({ id: question.id, expected: question.expected })) }));
  const dryRun = { createdAt: state.createdAt, fullSeed, factChecks, factCoverage: coverage, simulations, finalControls, windowTokens: state.windowTokens, workTokens: state.workTokens, freezeFinalQA: state.freezeFinalQA };
  await writeJson(path.join(state.root, 'dry-run.json'), dryRun);
  await writeManifest(dryRun);
  assertDryRun(seed, coverage, fullSeed, simulations, factChecks);
  if (!finalControls.passed) throw new Error(`final QA control probe failed:\n- ${finalControls.problems.join('\n- ')}`);
  emit({
    event: 'dry-run.complete', root: state.root, batches: batchTokenSummary(seed), fullSeed,
    factChecks: { passed: factChecks.passed, minPageChars: factChecks.minPageChars, maxPageChars: factChecks.maxPageChars, uniqueMarkers: factChecks.markers.filter(marker => marker.count === 1).length },
    simulations: simulations.map(simulation => ({ arm: simulation.arm, batchesWithCompaction: simulation.batchesWithCompaction, summaryPlans: simulation.summaryPlans, finalQACompactionTriggered: simulation.finalQA.compactionTriggered, finalQAFrozen: simulation.finalQA.frozen })),
    finalControls: { passed: finalControls.passed, mode: finalControls.mode, frozen: finalControls.frozen, window: finalControls.window, problems: finalControls.problems },
  });
  if (!state.runMode) {
    // Dry-run still materializes the root output contract (results/summary/
    // manifest/events) so the Lead can inspect the planned matrix and controls.
    await writeRootOutputs([]);
    await writeManifest(dryRun);
    return;
  }

  const credentials = await resolveRelayCredentials(state.provider, values['provider-config']);
  state.secret = credentials.key;
  state.upstream = credentials.upstream;
  appendLine(state.eventsPath, { event: 'matrix.started', root: state.root, arms: state.arms.map(describeArm), repeats: state.repeats, model: state.model, provider: state.provider, upstream: state.upstream, freezeFinalQA: state.freezeFinalQA });
  const rows = [];
  const totalTrials = state.repeats * state.arms.length;
  let trialIndex = 0;
  for (let repeat = 1; repeat <= state.repeats; repeat++) {
    const order = repeat % 2 === 1 ? state.arms : [...state.arms].reverse();
    for (const arm of order) {
      trialIndex++;
      emit({ event: 'trial.started', index: trialIndex, total: totalTrials, arm: arm.name, strategy: arm.strategy, workInputTokens: arm.workInputTokens, repeat });
      const row = await trialExecution(arm, repeat);
      rows.push(row);
      await writeRootOutputs(rows);
      emit({
        event: 'trial.finished', index: trialIndex, total: totalTrials, id: row.id, arm: row.arm, strategy: row.strategy, workInputTokens: row.workInputTokens, repeat,
        status: row.status, error: row.error,
        accuracy: { facts: row.accuracy.facts, executionState: row.accuracy.executionState, overall: row.accuracy.overall },
        batchPasses: row.compaction.batchPasses,
        batches: row.batches.map(batch => ({ batch: batch.batch, status: batch.status, preTokens: batch.preTokens, postTokens: batch.postTokens, compactionTriggered: batch.compactionTriggered, events: batch.events, summaryInstalled: batch.summaryInstalled, modelCalls: batch.modelCalls })),
        finalQA: row.finalQA ? { status: row.finalQA.status, mode: row.finalQA.mode, frozen: row.finalQA.frozen, compactionTriggered: row.finalQA.compactionTriggered, events: row.finalQA.events, summaryInstalled: row.finalQA.summaryInstalled, controls: row.finalQA.controls } : null,
        requests: row.requests, usage: { input: row.usage.input, output: row.usage.output, estimatedCny: row.usage.estimatedCny }, executionMs: row.executionMs,
      });
    }
  }
  const summary = summarizeRows(rows);
  await writeRootOutputs(rows);
  await writeManifest(dryRun);
  appendLine(state.eventsPath, { event: 'matrix.finished', root: state.root, attempts: rows.length, arms: summary.arms.map(arm => ({ arm: arm.arm, attempts: arm.attempts, accuracy: arm.accuracy, compaction: arm.compaction, tokens: arm.tokens })) });
  emit({
    event: 'matrix.finished', root: state.root, attempts: rows.length, freezeFinalQA: state.freezeFinalQA,
    arms: summary.arms.map(arm => ({ arm: arm.arm, attempts: arm.attempts, accuracy: { facts: arm.accuracy.facts, executionState: arm.accuracy.executionState, overall: arm.accuracy.overall }, compaction: { batchPasses: arm.compaction.batchPasses, summaryInstalled: arm.compaction.summaryInstalled, summaryFailed: arm.compaction.summaryFailed, finalQAPasses: arm.compaction.finalQAPasses }, tokens: arm.tokens })),
  });
  if (rows.some(row => row.status !== 'completed')) process.exitCode = 1;
}

try {
  const { values } = parseArgs({ options: CLI_OPTIONS });
  await main(values);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
