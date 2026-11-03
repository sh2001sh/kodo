// C4 independent paired-task experiment: closed-book retention after one
// compression pass, measured on 3 related-layout task instances.
//
// The review (docs/context-compaction-experiment-review.md §3.5) notes that the
// previous runs had only one seed and therefore 16/20 answers shared one
// compression pass; per-question counts are not independent samples. This script
// therefore builds three layout variants over strongly overlapping facts:
//
//   task-1/2/3: different real repository page sets and page order, different
//   fact-page insertion offsets and marker depths, and a different KF slot ->
//   frozen fact mapping (so Q1..Q16 ask different questions per task). Every
//   task seeds 16 real 18-24k-character pages carrying unique KF-1..KF-16
//   markers plus real filler pages until the seed exceeds the 128k window.
//
// Per task, four arms run with the same H=65,536 and window=131,072:
//   off (hard-capacity baseline), mask@65536, summary@65536, hybrid@65536
// with one repeat by default. Phase 1 does one compression pass over the seed;
// phase 2 is a closed-book QA follow-up over the phase-1 terminal projection.
// Phase 2 is always frozen exactly like the retention script: coordinator
// .compaction is temporarily disabled and the phase-2 session window is raised to
// the model-declared 1,000,000 context, then both are restored. A freeze
// violation invalidates that trial's retention measurement.
//
// Statistics: the descriptive unit is the task (n=3 related layouts), not the 16
// questions inside a task. summary.json reports a per-task paired table (arms
// side by side, per-question pass matrix, delta vs off) plus per-arm mean/range
// across tasks, and states that the 48 task x arm answers are paired
// observations, not 48 independent samples.
//
// Safety: --dry-run (default) never resolves credentials and never calls a model.
// The real credential is read only in --run mode, never printed, never written
// to disk, and is visible only to the loopback relay in this parent process.
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

const EVALUATION_VERSION = 'compaction-qa-related-layout-v2';
const FROZEN_MODEL = 'deepseek-v4.1-flash';
const DEFAULT_PROVIDER_CONFIG = 'C:/Users/admin/.config/opencode/opencode.json';
const DEFAULT_PROVIDER = 'codego1';
const DEFAULT_ARMS = 'off,mask:65536,summary:65536,hybrid:65536';
const DEFAULT_WORK_TOKENS = 65_536;
const DEFAULT_WINDOW_TOKENS = 131_072;
const DEFAULT_REPEATS = 1;
const DEFAULT_SEED_TOKENS = 360_000;
const MIN_WORK_TOKENS = 1_024;
const MAX_WORK_TOKENS = 10_000_000;
const MAX_REPEATS = 3;
const LIMITS = Object.freeze({ context: 1_000_000, output: 393_216 });
const WINDOW_OUTPUT_CAP = 16_384;
const MAX_DURATION_MS = 900_000;
const TOOL_TIMEOUT_MS = 120_000;
const PAGE_MIN_CHARS = 18_000;
const PAGE_MAX_CHARS = 24_000;
const ANCHOR_DEPTH_MIN = 0.15;
const ANCHOR_DEPTH_MAX = 0.85;
const TASK_COUNT = 3;
const FACTS_PER_TASK = 16;
const COVERAGE_PENDING_NOTE = 'coverage telemetry pending host implementation';
const KERNEL_STATE_PREFIX = 'Kernel execution state: ';
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
const CARD_DIGEST = createHash('sha256').update('compaction-qa-independent-card-v1').digest('hex');

const PHASE1_OBJECTIVE = '请阅读当前项目上下文证据并确认已掌握；本轮只需简短确认，不要展开分析，不调用工具。';
const CONSTRAINTS = [
  '用户约束（本任务为只读任务，以下要求全程不可违反）：',
  '1. 本次只读；不得修改 src/runtime/history.ts（只允许读取）。',
  '2. 不得伪造未运行过的测试结果。',
  '3. 在真实实验前不得宣称新压缩策略已提速降本。',
].join('\n');
const CARD = Object.freeze({
  id: 'qa-independent-closed-book',
  version: '1.0.0',
  name: 'Independent paired-task closed-book QA',
  prompt: '独立配对任务实验：第一阶段压缩真实项目证据；第二阶段闭卷问答，只依据保留的上下文作答，不读取文件、不调用工具、不猜测。',
  digest: CARD_DIGEST,
  tools: [],
});
const DRY_BINDING = Object.freeze({ protocol: 'chat-completions', model: FROZEN_MODEL, baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_QA_INDEPENDENT_UNUSED', limits: LIMITS });
const PHASE2_OBJECTIVE = '第二阶段：闭卷问答（只依据第一阶段保留的压缩投影作答，禁止重读文件或调用工具）。';

// Frozen fact catalog: the deep-preset facts from compaction-qa-retention.mjs
// (that script cannot be imported safely because its top-level main executes).
// Fact 19 (the user constraint) is not a page fact; it stays in CONSTRAINTS.
const FACT_CATALOG = [
  { factId: 1, category: '预算与阈值', path: 'src/runtime/context.ts', anchor: '65_536', text: '默认 workInputTokens 工作预算是 65536 token。', prompt: '默认的 workInputTokens 工作预算（单位 token）是多少？', expected: ['65536|65,536|65_536'] },
  { factId: 2, category: '预算与阈值', path: 'src/runtime/context.ts', anchor: '0.70', text: '压缩目标 targetTokens 是工作预算的 70%。', prompt: '压缩目标 targetTokens 是工作预算的百分之多少？', expected: ['70\\s*%|0\\.7'] },
  { factId: 3, category: '预算与阈值', path: 'src/runtime/context.ts', anchor: '16_384', text: '近期原文预算的固定上限是 16384 token。', prompt: '近期原文预算由固定上限与工作预算的 25% 取较小值；这个固定上限是多少 token？', expected: ['16,?384|16_384'] },
  { factId: 4, category: '预算与阈值', path: 'src/runtime/compaction.ts', anchor: '8192', text: '任务摘要输出预算的内容上限是 8192 token。', prompt: '摘要输出预算的内容上限（固定上限）是多少 token？', expected: ['8192|8,192'] },
  { factId: 5, category: '预算与阈值', path: 'src/runtime/compaction.ts', anchor: '60_000', text: '摘要请求超时是 60 秒；摘要输出预算低于 128 token 时跳过摘要。', prompt: '摘要请求的超时时间是多少秒？摘要输出预算低于多少 token 时直接跳过摘要？', expected: ['(60\\s*秒|60s|60,?000|60_000)', '128'] },
  { factId: 6, category: 'API 与存储', path: 'README.md', anchor: '--compaction', text: 'CLI 用 --compaction 启用压缩，三种策略分别是 mask、summary、hybrid。', prompt: 'CLI 中启用压缩的参数是什么？可选的三种策略名称分别是什么？', expected: ['--compaction', 'mask', 'summary', 'hybrid'] },
  { factId: 7, category: 'API 与存储', path: 'src/storage/index.ts', anchor: 'PRIMARY KEY(project_id,id)', text: 'knowledge_nodes 的主键是 PRIMARY KEY(project_id,id)，同项目知识唯一约束是 UNIQUE(project_id,knowledge_id)。', prompt: 'knowledge_nodes 表的主键约束是什么？同一项目内的知识唯一约束是什么？', expected: ['project_id\\s*,\\s*id|PRIMARY KEY\\s*\\(\\s*project_id\\s*,\\s*id\\s*\\)', 'project_id\\s*,\\s*knowledge_id|UNIQUE\\s*\\(\\s*project_id\\s*,\\s*knowledge_id\\s*\\)'] },
  { factId: 8, category: 'API 与存储', path: 'src/knowledge/index.ts', anchor: 'at most two folder levels', text: '知识目录最多两层分类。', prompt: '知识目录最多允许几层分类（根目录不计入深度）？', expected: ['(两|二|2)\\s*层|two folder levels'] },
  { factId: 9, category: 'API 与存储', path: 'src/storage/index.ts', anchor: 'PRAGMA user_version = 5', text: '当前存储的 PRAGMA user_version 是 5。', prompt: '当前存储使用的 PRAGMA user_version 值是多少？', expected: ['user_version[^\\n]{0,20}5|user_version\\s*=\\s*5|^\\s*5\\s*$|(?:值为?|版本)[^\\n]{0,10}5'] },
  { factId: 10, category: '设计与取舍', path: 'docs/context-compaction.md', anchor: '首版不采用递归聚类', text: 'RAPTOR 首版不采用递归聚类、向量索引和自动父节点摘要。', prompt: 'RAPTOR 是否被 Kodo 首版采用？原因涉及哪类做法？', expected: ['((不|未)(被)?(首版)?采用|没有采用|不引入|未引入)', '(递归|聚类|向量)'] },
  { factId: 11, category: '设计与取舍', path: 'docs/context-compaction.md', anchor: '结构指路', text: 'PageIndex 借鉴的是“结构指路，原文作证”（结构定位与原文读取分离）。', prompt: 'Kodo 从 PageIndex 借鉴的核心思路是什么？', expected: ['结构', '(原文|正文)'] },
  { factId: 12, category: '设计与取舍', path: 'docs/context-compaction.md', anchor: '项目知识', occurrence: 'best', text: '目录用于整理项目知识，任务摘要用于继续当前工作。', prompt: '知识目录与任务摘要各自的分工是什么？', expected: ['项目知识', '(当前任务|当前工作)'] },
  { factId: 13, category: '预算与阈值', path: 'docs/context-compaction.md', anchor: '仍超过 H', text: '旧观察隐藏后仍超过工作预算 H，且存在可折叠历史时触发二级摘要。', prompt: '二级模型任务摘要的触发条件是什么？', expected: ['(超过|超出|高于)[^\\n]{0,12}(工作预算|软预算|预算|H)|超预算|(仍|依然|还)[^\\n]{0,8}超', '摘要|总结'] },
  { factId: 14, category: '预算与阈值', path: 'README.md', anchor: '默认关闭', occurrence: 'best', text: '新压缩策略默认关闭。', prompt: '默认情况下，新的压缩策略是否启用？', expected: ['默认关闭|默认不启用|不默认启用|off by default'] },
  { factId: 15, category: '设计与取舍', path: 'docs/context-compaction.md', anchor: '可复现实验起点', text: '64k 工作预算只是实验起点，尚未验证收益。', prompt: '文档如何定位 64k 工作预算（例如实验状态或是否已验证）？', expected: ['实验起点|实验参数|未验证|未验收|不能宣称'] },
  { factId: 16, category: '设计与取舍', path: 'src/runtime/compaction.ts', anchor: 'sources', occurrence: 'best', text: 'SummaryEnvelope.sources 是摘要的准确读取入口。', prompt: 'SummaryEnvelope.sources 字段的用途是什么？', expected: ['读取入口|read|来源引用|引用'] },
  { factId: 17, category: 'API 与存储', path: 'src/runtime/history.ts', anchor: '128_000', text: 'history.search 单页最多 5 条，扫描上限 128000 字符。', prompt: 'history.search 单页最多返回几条结果？扫描字符上限是多少？', expected: ['(每页|单页)[^\\n]{0,20}5|limit[^\\n]{0,10}5', '128,?000'] },
  { factId: 18, category: 'API 与存储', path: 'src/knowledge/index.ts', anchor: 'limit > 20', text: 'knowledge.browse 每页最多 20 条。', prompt: 'knowledge.browse 每页最多返回多少条？', expected: ['\\b20\\b'] },
  { factId: 20, category: '约束与恢复', path: 'docs/context-compaction.md', anchor: 'history.search', text: '摘要遗漏细节后通过 history.read/history.search 的读取参数找回原文。', prompt: '摘要遗漏细节后，应通过什么方式找回原文？', expected: ['history\\.(read|search)|读取参数|归档'] },
];
const FACT_BY_ID = new Map(FACT_CATALOG.map(fact => [fact.factId, fact]));

// Three related-layout task instances. Each selects 16 catalog facts (different
// subsets), maps its KF-1..16 slots through a task-specific shuffle (so the same
// question number asks a different fact per task), uses a different marker-depth
// pattern, a different fact-page insertion offset, and a different deterministic
// filler-page order/selection.
const TASK_DEFS = [
  {
    id: 'task-1', label: '预算与存储（顺序 A）',
    description: '16 条事实按预算/存储主题排序，页序与插入位置按 A 组种子生成。',
    factIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    shuffleSeed: 1101, depthPattern: 'ascending', insertionOffset: 0, fillerSeed: 2101,
  },
  {
    id: 'task-2', label: 'API 与设计（顺序 B）',
    description: '事实整体后移（含 KF-17/18），深度反转，页序与插入位置按 B 组种子生成。',
    factIds: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    shuffleSeed: 1202, depthPattern: 'descending', insertionOffset: 3, fillerSeed: 2202,
  },
  {
    id: 'task-3', label: '混合与恢复（顺序 C）',
    description: '混合主题（含 KF-20 恢复事实），深度锯齿，页序与插入位置按 C 组种子生成。',
    factIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20],
    shuffleSeed: 1303, depthPattern: 'zigzag', insertionOffset: 7, fillerSeed: 2303,
  },
];

const CLI_OPTIONS = {
  root: { type: 'string' },
  'provider-config': { type: 'string', default: DEFAULT_PROVIDER_CONFIG },
  provider: { type: 'string', default: DEFAULT_PROVIDER },
  model: { type: 'string', default: FROZEN_MODEL },
  arms: { type: 'string', default: DEFAULT_ARMS },
  'work-tokens': { type: 'string', default: String(DEFAULT_WORK_TOKENS) },
  'window-tokens': { type: 'string', default: String(DEFAULT_WINDOW_TOKENS) },
  'seed-tokens': { type: 'string', default: String(DEFAULT_SEED_TOKENS) },
  repeats: { type: 'string', default: String(DEFAULT_REPEATS) },
  'dry-run': { type: 'boolean', default: false },
  run: { type: 'boolean', default: false },
  'include-answers': { type: 'boolean', default: false },
};

const state = {
  runMode: false,
  includeAnswers: false,
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
  seedTokens: DEFAULT_SEED_TOKENS,
  repeats: DEFAULT_REPEATS,
  arms: [],
  tasks: [],
};

const emit = value => console.log(JSON.stringify(value));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const mean = values => {
  const numbers = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? Number((numbers.reduce((total, value) => total + value, 0) / numbers.length).toFixed(4)) : null;
};
const rate = summary => (summary && typeof summary.rate === 'number' ? summary.rate : null);
const pad = (value, width) => String(value ?? '-').padEnd(width);
const redact = text => (state.secret ? String(text).replaceAll(state.secret, '[redacted]') : String(text));
const redactedJson = value => redact(JSON.stringify(value, null, 2));
const writeJson = (file, value) => writeFile(file, `${redactedJson(value)}\n`);
const appendLine = (file, value) => appendFileSync(file, `${redact(typeof value === 'string' ? value : JSON.stringify(value))}\n`);

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seededShuffle(list, seed) {
  const random = mulberry32(seed);
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

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

// ---- task instances: real repository pages, unique KF markers, closed-book QA ----

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

/** Candidate pages of PAGE_MIN_CHARS..maxChars characters whose real text hits
 *  every expected regex with the anchor inside the depth band. Pages that already
 *  mention KF markers are rejected: the experiment owns that namespace. */
function pageCandidates(text, starts, anchorPos, anchorLength, expected, maxChars) {
  const candidates = [];
  for (const startChar of starts) {
    if (startChar > anchorPos) break;
    const minimum = startChar + PAGE_MIN_CHARS;
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
    if (chars < PAGE_MIN_CHARS || chars > maxChars) continue;
    if (anchorPos + anchorLength > endChar) continue;
    const depth = (anchorPos - startChar) / chars;
    if (depth < ANCHOR_DEPTH_MIN || depth > ANCHOR_DEPTH_MAX) continue;
    const content = text.slice(startChar, endChar);
    if (/KF-\d+\b/.test(content)) continue;
    if (!expected.every(source => new RegExp(source).test(content))) continue;
    candidates.push({ startChar, endChar, content, chars, depth: Number(depth.toFixed(4)) });
  }
  return candidates;
}

function targetDepthFor(definition, index) {
  const ratio = index / (FACTS_PER_TASK - 1);
  if (definition.depthPattern === 'descending') return 0.78 - 0.56 * ratio;
  if (definition.depthPattern === 'zigzag') return index % 2 === 0 ? 0.28 + 0.06 * ratio : 0.72 - 0.06 * ratio;
  return 0.22 + 0.56 * ratio;
}

async function buildFactPage(definition, slot, fact, pageCache) {
  const marker = KF(slot);
  const markerText = `【项目事实 ${marker}】${fact.text}`;
  const targetDepth = targetDepthFor(definition, slot - 1);
  if (!pageCache.has(fact.path)) pageCache.set(fact.path, await readFile(path.join(REPOSITORY, fact.path), 'utf8'));
  const text = pageCache.get(fact.path);
  const occurrences = occurrencesOf(text, fact.anchor);
  if (!occurrences.length) throw new Error(`${definition.id} slot ${slot}: anchor ${JSON.stringify(fact.anchor)} not found in ${fact.path}`);
  const starts = lineBoundaries(text);
  const pool = fact.occurrence === 'best' ? occurrences : [occurrences[0]];
  const candidates = [];
  for (const anchorPos of pool) candidates.push(...pageCandidates(text, starts, anchorPos, fact.anchor.length, fact.expected, PAGE_MAX_CHARS - markerText.length - 2));
  if (!candidates.length) throw new Error(`${definition.id} slot ${slot} (fact ${fact.factId}): no ${PAGE_MIN_CHARS}-${PAGE_MAX_CHARS} character page in ${fact.path} hits expected ${JSON.stringify(fact.expected)} around ${JSON.stringify(fact.anchor)}`);
  candidates.sort((left, right) => (Math.abs(left.depth - targetDepth) - Math.abs(right.depth - targetDepth)) || (right.chars - left.chars) || (left.startChar - right.startChar));
  const best = candidates[0];
  const targetChar = Math.max(1, Math.min(best.content.length - 1, Math.round(best.content.length * targetDepth)));
  const lineStart = best.content.lastIndexOf('\n', targetChar) + 1;
  const content = `${best.content.slice(0, lineStart)}${markerText}\n${best.content.slice(lineStart)}`;
  if (content.length > PAGE_MAX_CHARS) throw new Error(`${definition.id} slot ${slot}: fact page is ${content.length} characters, over ${PAGE_MAX_CHARS}`);
  const offset = text.slice(0, best.startChar).split('\n').length;
  return {
    kind: 'fact', taskId: definition.id, slot, factId: fact.factId, marker, markerText,
    markerDepth: Number((content.indexOf(markerText) / content.length).toFixed(4)),
    path: fact.path, anchor: fact.anchor, anchorDepth: best.depth, targetDepth: Number(targetDepth.toFixed(4)),
    offset, end: offset + content.split('\n').length - 1, total: text.split('\n').length,
    content, chars: content.length, tokens: estimateTextTokens(content), hash: sha256(content),
    expectedMatched: fact.expected.every(source => new RegExp(source).test(content)),
  };
}

/** Split one real repository text file into ≤maxChars pages, keeping line offsets. */
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

async function loadFillerPool() {
  const factPaths = new Set(FACT_CATALOG.map(fact => fact.path));
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
    if (/KF-\d+\b/.test(text)) continue;
    for (const page of paginateText(relative, text, PAGE_MAX_CHARS)) {
      if (page.chars < PAGE_MIN_CHARS || page.chars > PAGE_MAX_CHARS) continue;
      pool.push({ ...page, kind: 'filler', hash: sha256(page.content) });
    }
  }
  if (pool.length < 8) throw new Error(`only ${pool.length} real filler pages of ${PAGE_MIN_CHARS}-${PAGE_MAX_CHARS} characters are available; related-layout tasks need more`);
  return pool;
}

function closedBookInput(task) {
  return [
    '【第二阶段：闭卷问答】上一阶段的压缩/交接已经完成。现在只依据当前上下文中保留的信息回答下面的 16 个问题；',
    '禁止使用工具、重新读取文件或猜测；无法确定时写 UNKNOWN，不要编造数字或引文。',
    '每题单独一行，以 "Q<id>: " 开头（例如 "Q1: KF-1 65536"），只写答案本身，不写解释，按顺序回答全部题目。',
    '每道题的答案必须以对应 KF-<id> 标记开头；未看到该标记就写 UNKNOWN。',
    '',
    ...task.questions.map(question => `Q${question.id}: ${question.prompt}`),
  ].join('\n');
}

async function buildTasks(fillerPool) {
  const pageCache = new Map();
  const tasks = [];
  for (const definition of TASK_DEFS) {
    const facts = seededShuffle(definition.factIds.map(factId => FACT_BY_ID.get(factId)), definition.shuffleSeed);
    if (facts.length !== FACTS_PER_TASK || facts.some(fact => !fact)) throw new Error(`${definition.id}: expected ${FACTS_PER_TASK} known facts`);
    const factPages = [];
    for (let index = 0; index < facts.length; index++) factPages.push(await buildFactPage(definition, index + 1, facts[index], pageCache));
    const factTokens = factPages.reduce((total, page) => total + page.tokens, 0);
    // Task-specific deterministic filler order; distinct files first, then repeats,
    // until the per-task content-token target is reached.
    const order = seededShuffle(fillerPool, definition.fillerSeed);
    const fillers = [];
    const usedPaths = new Set();
    let contentTokens = factTokens;
    for (const page of order) {
      if (contentTokens >= state.seedTokens) break;
      if (usedPaths.has(page.path)) continue;
      usedPaths.add(page.path);
      fillers.push(page);
      contentTokens += page.tokens;
    }
    for (const page of order) {
      if (contentTokens >= state.seedTokens) break;
      if (fillers.includes(page)) continue;
      fillers.push(page);
      contentTokens += page.tokens;
    }
    if (contentTokens < state.seedTokens) throw new Error(`${definition.id}: only ${contentTokens} content tokens are available from the repository page pool; need ${state.seedTokens}`);
    // Equally spaced fact pages with a task-specific rotation, so insertion
    // positions differ between tasks.
    const totalPages = fillers.length + factPages.length;
    const positions = new Map();
    for (let index = 0; index < factPages.length; index++) {
      let position = Math.round((index * (totalPages - 1)) / (factPages.length - 1));
      position = (position + definition.insertionOffset) % totalPages;
      while (positions.has(position)) position = (position + 1) % totalPages;
      positions.set(position, factPages[index]);
    }
    const pages = [];
    let fillerIndex = 0;
    for (let position = 0; position < totalPages; position++) pages.push(positions.get(position) ?? fillers[fillerIndex++]);
    const questions = facts.map((fact, index) => ({
      id: index + 1, marker: KF(index + 1), factId: fact.factId, category: fact.category,
      prompt: `根据上下文中标注为 ${KF(index + 1)} 的项目事实回答：${fact.prompt}`,
      expected: [`${KF(index + 1)}\\b`, ...fact.expected],
      factText: fact.text,
    }));
    const rounds = pages.map((page, index) => {
      const callId = `read-${definition.id}-${index + 1}`;
      return [
        {
          role: 'assistant',
          content: `读取 ${page.path} 第 ${page.offset}-${page.end} 行（文件共 ${page.total} 行），记录项目证据。`,
          tool_calls: [{ id: callId, name: 'file.read', arguments: JSON.stringify({ path: page.path, offset: page.offset, limit: page.end - page.offset + 1 }) }],
        },
        { role: 'tool', tool_call_id: callId, content: JSON.stringify({ path: page.path, offset: page.offset, total: page.total, content: page.content }) },
      ];
    }).flat();
    const task = {
      id: definition.id, label: definition.label, description: definition.description, definition,
      facts: facts.map((fact, index) => ({ slot: index + 1, marker: KF(index + 1), factId: fact.factId, category: fact.category, text: fact.text, expected: fact.expected })),
      factPages, fillers, pages, questions,
      seedMessages: [{ role: 'user', content: CONSTRAINTS }, ...rounds],
      contentChars: pages.reduce((total, page) => total + page.chars, 0),
      contentTokens: pages.reduce((total, page) => total + page.tokens, 0),
      factTokens,
      fillerTokens: contentTokens - factTokens,
      contentHash: sha256(JSON.stringify(pages.map(page => ({ path: page.path, offset: page.offset, hash: page.hash })))),
    };
    task.qaText = closedBookInput(task);
    tasks.push(task);
  }
  return tasks;
}

function checkTaskPages(task) {
  const problems = [];
  if (task.factPages.length !== FACTS_PER_TASK) problems.push(`${task.id}: ${task.factPages.length} fact pages; expected ${FACTS_PER_TASK}`);
  if (task.questions.length !== FACTS_PER_TASK) problems.push(`${task.id}: ${task.questions.length} questions; expected ${FACTS_PER_TASK}`);
  if (task.pages.length < FACTS_PER_TASK) problems.push(`${task.id}: ${task.pages.length} pages; expected at least ${FACTS_PER_TASK}`);
  const globalCounts = new Map(Array.from({ length: FACTS_PER_TASK }, (_, index) => [KF(index + 1), 0]));
  for (const page of task.pages) for (const marker of globalCounts.keys()) {
    const count = (page.content.match(new RegExp(`${marker}\\b`, 'g')) ?? []).length;
    if (count) globalCounts.set(marker, globalCounts.get(marker) + count);
  }
  for (const page of task.pages) if (page.chars < PAGE_MIN_CHARS || page.chars > PAGE_MAX_CHARS) problems.push(`${task.id} page ${page.path}:${page.offset} is ${page.chars} chars; expected ${PAGE_MIN_CHARS}-${PAGE_MAX_CHARS}`);
  for (const page of task.factPages) {
    const question = task.questions.find(item => item.id === page.slot);
    if (!page.expectedMatched) problems.push(`${task.id} ${page.marker} (fact ${page.factId}): fact page does not hit expected ${JSON.stringify(question.expected.slice(1))}`);
    const pageCount = (page.content.match(new RegExp(`${page.marker}\\b`, 'g')) ?? []).length;
    if (pageCount !== 1) problems.push(`${task.id} ${page.marker}: marker appears ${pageCount} times on its fact page; expected 1`);
    if (page.markerDepth < ANCHOR_DEPTH_MIN || page.markerDepth > ANCHOR_DEPTH_MAX) problems.push(`${task.id} ${page.marker}: markerDepth ${page.markerDepth} outside ${ANCHOR_DEPTH_MIN}-${ANCHOR_DEPTH_MAX}`);
    if (page.factId !== task.facts[page.slot - 1]?.factId) problems.push(`${task.id} ${page.marker}: factId ${page.factId} does not match slot mapping`);
  }
  for (const [marker, count] of globalCounts) if (count !== 1) problems.push(`${task.id}: global marker ${marker} appears ${count} times; expected exactly 1`);
  return { passed: problems.length === 0, problems, markers: [...globalCounts.entries()].map(([marker, count]) => ({ marker, count })), minPageChars: Math.min(...task.pages.map(page => page.chars)), maxPageChars: Math.max(...task.pages.map(page => page.chars)) };
}

function checkQuestionCoverage(task) {
  return task.questions.map(question => {
    const page = task.factPages.find(item => item.slot === question.id);
    const checks = question.expected.map(source => ({ source, present: new RegExp(source).test(page ? page.content : '') }));
    return { id: question.id, marker: question.marker, factId: question.factId, category: question.category, checks, passed: Boolean(page) && checks.every(check => check.present) };
  });
}

/** Full seeded-input estimate in a no-compaction probe: the cumulative context a
 *  trial feeds in before any compression, independent of arm behaviour. */
async function measureTaskSeed(task) {
  const directory = path.join(state.root, '_dry-run', task.id, 'full-seed');
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const app = new Application(path.join(directory, 'kodo-state'));
  app.coordinator.mailbox.specs = () => [];
  try {
    const run = app.createRun({
      objective: PHASE1_OBJECTIVE, workspace, binding: DRY_BINDING, permissions: ['read'],
      budget: { ...budgetForWindow(), maxContextTokens: LIMITS.context, maxOutputTokens: WINDOW_OUTPUT_CAP },
      card: CARD,
    });
    const initial = app.store.readBlob(run.contextRef);
    const all = [...initial, ...task.seedMessages];
    const inputTokens = estimateInputTokens(app.store, run, all, []);
    return { messages: all.length, inputTokens, contentTokens: task.contentTokens, contentChars: task.contentChars, ratioToWindow: Number((inputTokens / state.windowTokens).toFixed(3)) };
  } finally {
    await app.shutdown();
  }
}

// ---- phase-2 freeze control (always on for this experiment) ----

function phase2ControlPlan() {
  const baseBudget = budgetForWindow();
  const probeSession = {
    id: 'phase2-window-probe', workspace: '<probe>', permissions: ['read'],
    budget: baseBudget,
    modelBudgetCeilings: { maxContextTokens: baseBudget.maxContextTokens, maxOutputTokens: baseBudget.maxOutputTokens },
    tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, createdAt: 'phase2-window-probe',
  };
  const probeRun = { id: 'phase2-window-probe', sessionId: probeSession.id, modelLimits: { context: LIMITS.context, output: LIMITS.output } };
  const before = runBudget(probeRun, probeSession);
  // Raising budget.maxContextTokens alone is not enough: runBudget also clamps to
  // the session modelBudgetCeilings persisted by createRun, so both are raised.
  const raised = {
    ...probeSession,
    budget: { ...probeSession.budget, maxContextTokens: LIMITS.context },
    modelBudgetCeilings: { ...probeSession.modelBudgetCeilings, maxContextTokens: LIMITS.context },
  };
  const phase2 = runBudget(probeRun, raised);
  return {
    mode: 'freeze', frozen: true, modelContext: LIMITS.context,
    window: {
      before: { maxContextTokens: before.maxContextTokens, maxOutputTokens: before.maxOutputTokens },
      phase2: { maxContextTokens: phase2.maxContextTokens, maxOutputTokens: phase2.maxOutputTokens },
      raisedForFreeze: phase2.maxContextTokens > before.maxContextTokens,
    },
  };
}

async function checkPhase2ControlMechanics() {
  const plan = phase2ControlPlan();
  const problems = [];
  if (plan.window.phase2.maxContextTokens !== plan.modelContext) problems.push(`freeze window ${plan.window.phase2.maxContextTokens} does not reach the model context ${plan.modelContext}`);
  if (plan.window.phase2.maxOutputTokens > plan.window.before.maxOutputTokens) problems.push('freeze window must not raise the output reserve');
  const directory = path.join(state.root, '_dry-run', 'phase2-controls');
  await mkdir(directory, { recursive: true });
  const app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, { compaction: { strategy: 'hybrid', workInputTokens: state.workTokens } });
  try {
    const policyBefore = app.coordinator.compaction;
    if (!policyBefore) problems.push('Application did not install the probe compaction policy');
    app.coordinator.compaction = undefined;
    const toggleable = app.coordinator.compaction === undefined;
    app.coordinator.compaction = policyBefore;
    const restored = app.coordinator.compaction === policyBefore;
    if (!toggleable) problems.push('coordinator.compaction cannot be temporarily disabled; phase-2 freeze would not work');
    if (!restored) problems.push('coordinator.compaction was not restored after the freeze probe');
    return { passed: problems.length === 0, ...plan, coordinatorCompactionToggleable: toggleable, coordinatorPolicyRestored: restored, problems };
  } finally {
    await app.shutdown();
  }
}

function beginPhase2Controls(app, run) {
  const plan = phase2ControlPlan();
  const sessionId = run.sessionId;
  const session = app.store.session(sessionId);
  const policyBefore = app.coordinator.compaction;
  const originalBudget = { ...session.budget };
  const originalCeilings = session.modelBudgetCeilings ? { ...session.modelBudgetCeilings } : undefined;
  app.coordinator.compaction = undefined;
  app.store.putSession({
    ...session,
    budget: { ...session.budget, maxContextTokens: LIMITS.context },
    modelBudgetCeilings: { ...(session.modelBudgetCeilings ?? {}), maxContextTokens: LIMITS.context },
  });
  const effective = runBudget(app.store.run(run.id), app.store.session(sessionId));
  return { ...plan, sessionId, runId: run.id, policyBefore, originalBudget, originalCeilings, appliedWindow: { maxContextTokens: effective.maxContextTokens, maxOutputTokens: effective.maxOutputTokens }, restored: false };
}

function endPhase2Controls(app, controls) {
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

// ---- dry-run: phase-1 buildContext simulation + frozen phase-2 projection ----

function countHidden(messages) {
  return messages.filter(message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('"contextHidden":true')).length;
}

/** Reconstruct the host-injected header prepareContext adds before buildContext.
 *  The kernel execution-state line exists only when a compaction policy is set,
 *  so it is present in phase 1 (strategy arms) and absent in frozen phase 2. */
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

async function simulateTaskArm(task, arm) {
  const directory = path.join(state.root, '_dry-run', task.id, arm.name.replaceAll(':', '-'));
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, applicationOptions(arm));
  app.coordinator.mailbox.specs = () => [];
  try {
    let run = app.createRun({ objective: PHASE1_OBJECTIVE, workspace, binding: DRY_BINDING, permissions: ['read'], budget: budgetForWindow(), card: CARD });
    const initial = app.store.readBlob(run.contextRef);
    const seeded = [...initial, ...task.seedMessages];
    const prepared = simulationPreparedContext(run, seeded, arm.strategy);
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
    const phase1 = {
      preTokens, builtTokens: built.estimatedInputTokens,
      buildStrategy: built.strategy ?? null, masked: countHidden(built.messages), omittedMessages: built.omittedMessages ?? 0,
      summaryPlan: built.summaryPlan ? { foldMessages: built.summaryPlan.foldOffsets.length, recentMessages: built.summaryPlan.recentOffsets.length } : null,
      compactionTriggered: Boolean(built.archivedRef || built.strategy || built.summaryPlan),
      archivedRef: built.archivedRef ?? null, targetMet: built.targetMet ?? null,
      workInputTokens: built.workInputTokens ?? null, targetTokens: built.targetTokens ?? null,
    };
    // Frozen phase 2: append the QA sheet to the phase-1 terminal projection and
    // build once with compaction disabled and the model-declared 1M window.
    const qaContext = simulationPreparedContext(current, [...built.messages, { role: 'user', content: task.qaText }], null);
    const frozenRun = app.store.updateRun(current.id, { contextRef: app.store.blob(qaContext) });
    const frozen = app.store.run(frozenRun.id);
    const frozenBudget = runBudget(frozen, app.store.session(frozen.sessionId));
    const qaPreTokens = estimateInputTokens(app.store, frozen, qaContext, []);
    const qaBuilt = buildContext(app.store, frozen, frozenBudget.maxContextChars, [], {
      maxContextTokens: LIMITS.context,
      maxOutputTokens: Math.min(WINDOW_OUTPUT_CAP, frozenBudget.maxOutputTokens),
      maxInputTokens: frozen.modelLimits?.input,
    });
    const phase2 = {
      frozen: true, preTokens: qaPreTokens, builtTokens: qaBuilt.estimatedInputTokens,
      buildStrategy: qaBuilt.strategy ?? null, masked: countHidden(qaBuilt.messages), omittedMessages: qaBuilt.omittedMessages ?? 0,
      summaryPlan: qaBuilt.summaryPlan ? { foldMessages: qaBuilt.summaryPlan.foldOffsets.length, recentMessages: qaBuilt.summaryPlan.recentOffsets.length } : null,
      compactionTriggered: Boolean(qaBuilt.archivedRef || qaBuilt.strategy || qaBuilt.summaryPlan),
      windowTokens: LIMITS.context,
    };
    return { taskId: task.id, arm: arm.name, strategy: arm.strategy, workInputTokens: arm.workInputTokens, phase1, phase2 };
  } finally {
    await app.shutdown();
  }
}

function assertDryRun(tasks, checks, fullSeeds, simulations, controls) {
  const problems = [];
  for (const task of tasks) {
    const check = checks.get(task.id);
    if (!check.passed) for (const problem of check.problems) problems.push(`task pages: ${problem}`);
    const seed = fullSeeds.get(task.id);
    if (!seed || seed.inputTokens <= state.windowTokens) problems.push(`${task.id}: seeded input estimate ${seed?.inputTokens} does not exceed the run window ${state.windowTokens}`); 
    if (task.contentTokens < state.seedTokens) problems.push(`${task.id}: content tokens ${task.contentTokens} below --seed-tokens ${state.seedTokens}`);
  }
  for (const simulation of simulations) {
    if (simulation.strategy) {
      if (!simulation.phase1.compactionTriggered) problems.push(`${simulation.taskId} ${simulation.arm}: phase 1 did not trigger compaction`);
      if (simulation.strategy === 'mask' && (simulation.phase1.buildStrategy !== 'mask' || !(simulation.phase1.masked > 0))) problems.push(`${simulation.taskId} ${simulation.arm}: mask arm did not hide observations (strategy=${simulation.phase1.buildStrategy}, masked=${simulation.phase1.masked})`);
      if (simulation.strategy === 'summary' && !simulation.phase1.summaryPlan) problems.push(`${simulation.taskId} ${simulation.arm}: summary arm produced no summaryPlan`);
    } else if (simulation.phase1.buildStrategy !== 'hard' || !(simulation.phase1.omittedMessages > 0)) {
      problems.push(`${simulation.taskId} ${simulation.arm}: off arm did not hit the hard-capacity trimmer (strategy=${simulation.phase1.buildStrategy}, omitted=${simulation.phase1.omittedMessages})`);
    }
    if (simulation.phase2.compactionTriggered) problems.push(`${simulation.taskId} ${simulation.arm}: frozen phase 2 still triggered compaction (${simulation.phase2.buildStrategy ?? 'summary plan'})`);
  }
  if (!controls.passed) for (const problem of controls.problems) problems.push(`phase-2 freeze: ${problem}`);
  if (problems.length) throw new Error(`dry-run assertions failed:\n- ${problems.join('\n- ')}`);
}

function printReport(tasks, checks, fullSeeds, simulations, controls) {
  const lines = [];
  lines.push('');
  lines.push('='.repeat(112));
  lines.push('独立配对任务实验 — dry-run 校验（不调用真实模型）');
  lines.push('='.repeat(112));
  lines.push(`evaluationVersion: ${EVALUATION_VERSION} | model: ${state.model} | provider: ${state.provider}`);
  lines.push(`arms: ${state.arms.map(arm => arm.name).join(', ')} | 统一 H: ${state.workTokens} | run window: ${state.windowTokens} | output budget: ${budgetForWindow().maxOutputTokens} | repeats: ${state.repeats}`);
  lines.push(`phase-2 控制: freeze（禁 coordinator.compaction；window ${controls.window.before.maxContextTokens} → ${controls.window.phase2.maxContextTokens} = 模型声明 ${controls.modelContext}，结束后恢复）| 静态探针: ${controls.passed ? 'PASS' : 'FAIL'}`);
  lines.push('');
  for (const task of tasks) {
    const check = checks.get(task.id);
    const seed = fullSeeds.get(task.id);
    lines.push(`【${task.id}】${task.label} — ${task.description}`);
    lines.push(`  pages: ${task.pages.length}（fact ${task.factPages.length} + filler ${task.fillers.length}）| chars: ${task.contentChars} | contentTokens: ${task.contentTokens}（fact ${task.factTokens} + filler ${task.fillerTokens}）| seed 输入估算: ${seed.inputTokens} (window×${seed.ratioToWindow})`);
    lines.push(`  KF 唯一性/页字符: ${check.passed ? 'PASS' : 'FAIL'}（markers ${check.markers.filter(marker => marker.count === 1).length}/${FACTS_PER_TASK} unique，页字符 ${check.minPageChars}–${check.maxPageChars}）`);
    for (const problem of check.problems) lines.push(`  PROBLEM: ${problem}`);
    lines.push(`  事实页/问题映射（slot ↔ fact ≤ 0.85 markerDepth 检查见 manifest）:`);
    for (const question of task.questions) {
      const page = task.factPages.find(item => item.slot === question.id);
      lines.push(`    Q${pad(question.id, 2)} ${question.marker} → fact ${question.factId} [${question.category}] ${pad(page.path, 30)} depth=${page.markerDepth} chars=${page.chars}`);
    }
    lines.push(`  arm 模拟（phase-1 压缩 + phase-2 冻结投影）:`);
    lines.push(`    ${pad('arm', 16)} | ${pad('seedTokens', 11)} | ${pad('phase1Built', 12)} | ${pad('strategy', 13)} | ${pad('masked', 6)} | ${pad('omitted', 8)} | ${pad('summaryPlan', 14)} | ${pad('phase2Built', 12)} | phase2Triggered`);
    for (const simulation of simulations.filter(item => item.taskId === task.id)) {
      lines.push(`    ${pad(simulation.arm, 16)} | ${pad(simulation.phase1.preTokens, 11)} | ${pad(simulation.phase1.builtTokens, 12)} | ${pad(simulation.phase1.buildStrategy ?? '-', 13)} | ${pad(simulation.phase1.masked, 6)} | ${pad(simulation.phase1.omittedMessages, 8)} | ${pad(simulation.phase1.summaryPlan ? `${simulation.phase1.summaryPlan.foldMessages}/${simulation.phase1.summaryPlan.recentMessages}` : '-', 14)} | ${pad(simulation.phase2.builtTokens, 12)} | ${simulation.phase2.compactionTriggered}`);
    }
    lines.push('');
  }
  lines.push('='.repeat(112));
  console.log(lines.join('\n'));
}

// ---- credential resolution + telemetry helpers ----

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

function zeroCompactionEvents() {
  return Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, 0]));
}

function compactionEventCounts(events) {
  const counts = zeroCompactionEvents();
  for (const event of events) if (event.type in counts) counts[event.type]++;
  return counts;
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
      available: true, estimatedInputTokens: current.estimatedInputTokens, messageCount: current.messageCount,
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

// ---- real execution: phase 1 compression, frozen phase 2 closed-book QA ----

function phaseTelemetry(app, runId, phase, initialEventCount = 0) {
  let events = [];
  let calls = [];
  try {
    events = app.store.events(runId).slice(initialEventCount);
    calls = app.store.calls(runId);
  } catch { /* store may be closing; telemetry stays empty */ }
  const counts = compactionEventCounts(events);
  return {
    events: counts, compactionTriggered: events.some(event => event.type === 'context.compacted' || event.type === 'context.summary.started'),
    contextCompacted: counts['context.compacted'], summaryStarted: counts['context.summary.started'],
    summaryInstalled: counts['context.summary.installed'], summaryFailed: counts['context.summary.failed'],
    installed: events.filter(event => event.type === 'context.summary.installed').map(event => installedSummaryRow(event, phase)),
    modelCalls: callsUsage(app, calls), toolCalls: calls.filter(call => call.kind === 'tool').length,
    inspection: inspectRun(app, runId),
  };
}

async function runHarness(task, arm, workspace, directory, relayBaseURL) {
  const traceFile = path.join(directory, 'trace.jsonl');
  const trace = (type, data) => appendLine(traceFile, { type, time: new Date().toISOString(), ...data });
  process.env.KODO_REAL_TASK_RELAY_KEY = 'fixture-relay-key';
  let app;
  try {
    app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, applicationOptions(arm));
    app.coordinator.mailbox.specs = () => [];
    app.store.subscribe(event => {
      if (TRACE_EVENT_TYPES.has(event.type)) trace(event.type, { taskId: task.id, runId: event.runId, ...event.data });
    });
    const phase1 = app.createRun({ objective: PHASE1_OBJECTIVE, workspace, binding: liveBinding(relayBaseURL), permissions: ['read'], budget: budgetForWindow(), card: CARD });
    const initial = app.store.readBlob(phase1.contextRef);
    app.store.updateRun(phase1.id, { contextRef: app.store.blob([...initial, ...task.seedMessages]) });
    trace('qa.phase1.seeded', { taskId: task.id, arm: arm.name, initialMessages: initial.length, seedMessages: task.seedMessages.length, toolRounds: task.seedMessages.filter(message => message.role === 'tool').length, questionSheetIncluded: false });
    const phase1Started = Date.now();
    let phase1Final;
    try { phase1Final = await app.run(phase1.id); } catch (error) { phase1Final = { status: 'failed', error: error.message }; }
    const phase1Ms = Date.now() - phase1Started;
    const phase1Text = resultText(app, phase1Final);
    const phase1Telemetry = phaseTelemetry(app, phase1.id, 'phase1');
    trace('qa.phase1.finished', {
      runId: phase1.id, status: phase1Final.status, error: phase1Final.error ?? null, textChars: phase1Text.length, executionMs: phase1Ms,
      events: phase1Telemetry.events, summaryInstalled: phase1Telemetry.summaryInstalled, summaryFailed: phase1Telemetry.summaryFailed,
      estimatedInputTokens: phase1Telemetry.inspection.estimatedInputTokens ?? null, hiddenObservations: phase1Telemetry.inspection.hiddenObservations ?? null,
    });
    if (phase1Final.status !== 'completed') {
      return {
        status: 'failed', error: `PHASE1_${phase1Final.status}: ${phase1Final.error ?? 'phase 1 did not complete'}`,
        phase1: { ...phase1Telemetry, status: phase1Final.status, error: phase1Final.error ?? null, text: phase1Text, ms: phase1Ms, runId: phase1.id },
        phase2: null, answerText: '', executionMs: phase1Ms,
      };
    }
    // Phase 2: follow-up run whose context is the pinned phase-1 terminal
    // projection (minus the kernel-state line) plus the QA sheet. step=1 skips the
    // step-0 follow-up regeneration; the freeze controls are applied before run.
    const projection = app.store.readBlob(app.store.run(phase1.id).contextRef).filter(message => !(message.role === 'system' && typeof message.content === 'string' && message.content.startsWith(KERNEL_STATE_PREFIX)));
    const qaRun = app.submitInput(phase1.id, task.qaText, { mode: 'follow_up' });
    const pending = app.store.inbox(qaRun.id);
    app.store.updateRun(qaRun.id, { contextRef: app.store.blob([...projection, { role: 'user', content: task.qaText }]), step: 1, inputCursor: pending.at(-1)?.seq ?? 0 });
    const controls = beginPhase2Controls(app, app.store.run(qaRun.id));
    trace('qa.phase2.controls', {
      runId: qaRun.id, mode: controls.mode, frozen: controls.frozen,
      windowBefore: controls.window.before, windowExpected: controls.window.phase2, windowApplied: controls.appliedWindow, raisedForFreeze: controls.window.raisedForFreeze,
    });
    const phase2Started = Date.now();
    let qaFinal;
    try { qaFinal = await app.run(qaRun.id); } catch (error) { qaFinal = { status: 'failed', error: error.message }; }
    finally { endPhase2Controls(app, controls); }
    const phase2Ms = Date.now() - phase2Started;
    const answerText = resultText(app, qaFinal);
    const phase2Telemetry = phaseTelemetry(app, qaRun.id, 'phase2');
    const phase2EventCount = Object.values(phase2Telemetry.events).reduce((total, value) => total + value, 0);
    trace('qa.phase2.finished', {
      runId: qaRun.id, status: qaFinal.status, error: qaFinal.error ?? null, answerChars: answerText.length, executionMs: phase2Ms,
      events: phase2Telemetry.events, summaryInstalled: phase2Telemetry.summaryInstalled, estimatedInputTokens: phase2Telemetry.inspection.estimatedInputTokens ?? null,
      controls: { mode: controls.mode, frozen: controls.frozen, restored: controls.restored, appliedWindow: controls.appliedWindow, compactionEventCount: phase2EventCount, freezeViolated: phase2EventCount > 0 },
    });
    return {
      status: qaFinal.status, error: qaFinal.error ?? null, answerText,
      phase1: { ...phase1Telemetry, status: phase1Final.status, error: null, text: phase1Text, ms: phase1Ms, runId: phase1.id },
      phase2: {
        ...phase2Telemetry, status: qaFinal.status, error: qaFinal.error ?? null, text: answerText, ms: phase2Ms, runId: qaRun.id,
        inputChars: task.qaText.length, inheritedMessages: projection.length + 1,
        controls: {
          mode: controls.mode, frozen: controls.frozen,
          window: { before: controls.window.before, expected: controls.window.phase2, applied: controls.appliedWindow, raisedForFreeze: controls.window.raisedForFreeze },
          restored: controls.restored, compactionEventCount: phase2EventCount,
          summaryInstalled: phase2Telemetry.summaryInstalled, freezeViolated: phase2EventCount > 0,
        },
      },
      executionMs: phase1Ms + phase2Ms,
    };
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

function scoreAnswers(task, text) {
  const segments = parseAnswerSegments(text);
  const questions = task.questions.map(question => {
    const answer = segments.get(question.id) ?? '';
    const normalized = answer.replace(/\s+/g, ' ').trim();
    const unknown = /^unknown\b/i.test(normalized);
    const checks = question.expected.map(source => ({ source, passed: new RegExp(source).test(normalized) }));
    return {
      id: question.id, marker: question.marker, factId: question.factId, category: question.category, prompt: question.prompt,
      answer, pass: Boolean(normalized) && !unknown && checks.every(check => check.passed), checks, missing: checks.filter(check => !check.passed).map(check => check.source),
    };
  });
  const summarize = list => ({ passed: list.filter(question => question.pass).length, total: list.length, rate: list.length ? Number((list.filter(question => question.pass).length / list.length).toFixed(4)) : null });
  return { questions, ...summarize(questions) };
}

async function trialExecution(task, arm, repeat) {
  const id = `${task.id}--${arm.name.replaceAll(':', '-')}--r${repeat}`;
  const directory = path.join(state.root, 'trials', id);
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
    execution = await runHarness(task, arm, workspace, directory, relay.baseURL);
  } catch (error) {
    execution = { status: 'failed', error: error.message, phase1: null, phase2: null, answerText: '', executionMs: Date.now() - started };
  } finally {
    await relay.close();
  }
  const wireStats = globalThis.structuredClone(relay.stats);
  const usage = usageScorecard(wireStats);
  const scored = scoreAnswers(task, execution.answerText);
  const phase2 = execution.phase2 ?? null;
  const row = {
    id, taskId: task.id, taskLabel: task.label, arm: arm.name, strategy: arm.strategy, workInputTokens: arm.workInputTokens, repeat,
    workspace, directory: path.relative(state.root, directory),
    status: execution.status, error: execution.error ?? null,
    answerText: execution.answerText, answers: scored.questions,
    accuracy: { passed: scored.passed, total: scored.total, rate: scored.rate },
    phase1: execution.phase1,
    phase2,
    phase2Frozen: phase2?.controls?.frozen ?? true,
    phase2FreezeViolated: Boolean(phase2?.controls?.freezeViolated),
    phase2CompactionEvents: phase2?.events ?? zeroCompactionEvents(),
    usage, requests: wireStats.requests,
    executionMs: execution.executionMs ?? Date.now() - started,
    createdAt: new Date().toISOString(),
  };
  await writeJson(path.join(directory, 'result.json'), row);
  await writeFile(path.join(directory, 'answer.txt'), `${redact(execution.answerText)}\n`);
  appendLine(state.eventsPath, {
    event: 'trial', id, taskId: task.id, arm: row.arm, strategy: row.strategy, workInputTokens: row.workInputTokens, repeat,
    status: row.status, error: row.error,
    accuracy: row.accuracy,
    phase1Events: row.phase1?.events ?? null, phase1SummaryInstalled: row.phase1?.summaryInstalled ?? 0, phase1SummaryFailed: row.phase1?.summaryFailed ?? 0,
    phase2Events: row.phase2CompactionEvents, phase2Frozen: row.phase2Frozen, phase2FreezeViolated: row.phase2FreezeViolated,
    phase2Controls: row.phase2?.controls ?? null,
    requests: row.requests, usage: { input: usage.input, output: usage.output, estimatedCny: usage.estimatedCny }, executionMs: row.executionMs,
  });
  return row;
}

// ---- summaries (statistics unit = task) and root outputs ----

function summarize(rows) {
  const armNames = state.arms.map(arm => arm.name);
  const byTask = state.tasks.map(task => {
    const taskRows = rows.filter(row => row.taskId === task.id);
    const accuracyByArm = Object.fromEntries(armNames.map(arm => [arm, summarizeChecks(taskRows.filter(row => row.arm === arm).flatMap(row => row.answers))]));
    const deltasVsOff = Object.fromEntries(armNames.filter(arm => arm !== 'off').map(arm => {
      const base = rate(accuracyByArm.off);
      const current = rate(accuracyByArm[arm]);
      return [arm, base === null || current === null ? null : Number((current - base).toFixed(4))];
    }));
    const matrix = task.questions.map(question => ({
      id: question.id, marker: question.marker, factId: question.factId, category: question.category, prompt: question.prompt,
      byArm: Object.fromEntries(armNames.map(arm => {
        const attempts = taskRows.filter(row => row.arm === arm).map(row => row.answers.find(answer => answer.id === question.id)?.pass).filter(value => typeof value === 'boolean');
        return [arm, attempts.length ? Number((attempts.filter(Boolean).length / attempts.length).toFixed(4)) : null];
      })),
    }));
    const eventsByArm = Object.fromEntries(armNames.map(arm => {
      const armRows = taskRows.filter(row => row.arm === arm);
      return [arm, {
        phase1Events: sumEventCounts(...armRows.map(row => row.phase1?.events)),
        phase2Events: sumEventCounts(...armRows.map(row => row.phase2CompactionEvents)),
        summaryInstalled: armRows.reduce((total, row) => total + (row.phase1?.summaryInstalled ?? 0), 0),
        summaryFailed: armRows.reduce((total, row) => total + (row.phase1?.summaryFailed ?? 0), 0),
        freezeViolations: armRows.filter(row => row.phase2FreezeViolated).length,
      }];
    }));
    // Per task x arm record: accuracy, summary install/coverage, compaction
    // events, input/output tokens, estimated cost and duration.
    const armDetails = Object.fromEntries(armNames.map(arm => {
      const armRows = taskRows.filter(row => row.arm === arm);
      const sum = selector => armRows.reduce((total, row) => total + (selector(row) ?? 0), 0);
      return [arm, {
        attempts: armRows.length,
        completed: armRows.filter(row => row.status === 'completed').length,
        accuracy: accuracyByArm[arm],
        tokens: {
          requests: sum(row => row.usage?.requests), input: sum(row => row.usage?.input), output: sum(row => row.usage?.output), total: sum(row => row.usage?.total),
          estimatedCny: { low: sum(row => row.usage?.estimatedCny?.low), high: sum(row => row.usage?.estimatedCny?.high), complete: armRows.every(row => row.usage?.usageComplete !== false) },
        },
        durationMs: { mean: mean(armRows.map(row => row.executionMs)), total: sum(row => row.executionMs) },
        phase1Events: sumEventCounts(...armRows.map(row => row.phase1?.events)),
        phase2Events: sumEventCounts(...armRows.map(row => row.phase2CompactionEvents)),
        summaryInstalled: sum(row => row.phase1?.summaryInstalled),
        summaryFailed: sum(row => row.phase1?.summaryFailed),
        summaryCoverage: {
          source: 'context.summary.installed',
          rows: armRows.flatMap(row => row.phase1?.installed ?? []).concat(armRows.flatMap(row => row.phase2?.installed ?? [])),
          pendingNote: COVERAGE_PENDING_NOTE,
        },
        freezeViolations: armRows.filter(row => row.phase2FreezeViolated).length,
      }];
    }));
    return {
      taskId: task.id, label: task.label, description: task.description,
      seed: { pages: task.pages.length, factPages: task.factPages.length, fillers: task.fillers.length, chars: task.contentChars, contentTokens: task.contentTokens, factTokens: task.factTokens, contentHash: task.contentHash },
      facts: task.facts,
      questions: task.questions.map(question => ({ id: question.id, marker: question.marker, factId: question.factId, category: question.category, prompt: question.prompt, expected: question.expected })),
      attempts: taskRows.length,
      completed: taskRows.filter(row => row.status === 'completed').length,
      accuracyByArm, deltasVsOff, matrix, eventsByArm, armDetails,
    };
  });
  const armSummary = armNames.map(arm => {
    const armRows = rows.filter(row => row.arm === arm);
    const taskRates = state.tasks.map(task => {
      const taskAnswers = armRows.filter(row => row.taskId === task.id).flatMap(row => row.answers);
      return taskAnswers.length ? Number((taskAnswers.filter(answer => answer.pass).length / taskAnswers.length).toFixed(4)) : null;
    });
    const finiteRates = taskRates.filter(value => typeof value === 'number');
    return {
      arm, strategy: state.arms.find(item => item.name === arm)?.strategy ?? null,
      workInputTokens: state.arms.find(item => item.name === arm)?.workInputTokens ?? null,
      attempts: armRows.length,
      completed: armRows.filter(row => row.status === 'completed').length,
      failed: armRows.filter(row => row.status !== 'completed').length,
      accuracy: {
        pooled: summarizeChecks(armRows.flatMap(row => row.answers)),
        taskRates,
        meanTaskRate: mean(taskRates),
        minTaskRate: finiteRates.length ? Math.min(...finiteRates) : null,
        maxTaskRate: finiteRates.length ? Math.max(...finiteRates) : null,
        perTaskMean: byTask.map(task => ({ taskId: task.taskId, rate: rate(task.accuracyByArm[arm]) })),
      },
      compaction: {
        phase1Events: sumEventCounts(...armRows.map(row => row.phase1?.events)),
        phase2Events: sumEventCounts(...armRows.map(row => row.phase2CompactionEvents)),
        trialsWithPhase1Compaction: armRows.filter(row => row.phase1?.compactionTriggered).length,
        summaryInstalled: armRows.reduce((total, row) => total + (row.phase1?.summaryInstalled ?? 0), 0),
        summaryFailed: armRows.reduce((total, row) => total + (row.phase1?.summaryFailed ?? 0), 0),
        summaryModelCalls: armRows.reduce((total, row) => total + (row.phase1?.modelCalls?.summaryCalls ?? 0) + (row.phase2?.modelCalls?.summaryCalls ?? 0), 0),
        freezeViolations: armRows.filter(row => row.phase2FreezeViolated).length,
        coverage: {
          source: 'context.summary.installed',
          rows: armRows.flatMap(row => row.phase1?.installed ?? []).concat(armRows.flatMap(row => row.phase2?.installed ?? [])),
          pendingNote: COVERAGE_PENDING_NOTE,
        },
      },
      tokens: {
        requests: armRows.reduce((total, row) => total + (row.usage?.requests ?? 0), 0),
        input: armRows.reduce((total, row) => total + (row.usage?.input ?? 0), 0),
        output: armRows.reduce((total, row) => total + (row.usage?.output ?? 0), 0),
        total: armRows.reduce((total, row) => total + (row.usage?.total ?? 0), 0),
        cached: armRows.reduce((total, row) => total + (row.usage?.cached ?? 0), 0),
        estimatedCny: {
          low: armRows.reduce((total, row) => total + (row.usage?.estimatedCny?.low ?? 0), 0),
          high: armRows.reduce((total, row) => total + (row.usage?.estimatedCny?.high ?? 0), 0),
          complete: armRows.every(row => row.usage?.usageComplete !== false),
        },
      },
      durationMs: { mean: mean(armRows.map(row => row.executionMs)), total: armRows.reduce((total, row) => total + (row.executionMs ?? 0), 0) },
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    evaluationVersion: EVALUATION_VERSION,
    mode: state.runMode ? 'run' : 'dry-run',
    model: state.model,
    provider: state.provider,
    seedTokensTarget: state.seedTokens,
    workTokens: state.workTokens,
    windowTokens: state.windowTokens,
    repeats: state.repeats,
    arms: state.arms.map(describeArm),
    attempts: rows.length,
    statisticsUnit: 'task',
    relatedLayoutTasks: TASK_COUNT,
    pairedTables: {
      unit: 'task',
      tasks: TASK_COUNT,
      arms: armNames,
      byTask,
    },
    armSummary,
    caveats: [
      '统计以 task 为描述性单位：3 个相关布局 task（n=3）；每个 task 的 16 题共享同一次压缩与同一 seed，不是 16 个独立样本。禁止按 48/64 个答案计算置信区间或显著性；byArm 只作描述性配对（均值/范围）。',
      'task 相关性：4 个 arm 在每个 task 内使用相同模型、相同 seed 内容、相同 H=65536 与 window=128k，仅策略不同；task 之间改变页集合/页序/插入位置/KF 槽位映射/问题，但 16 条事实两两重叠 13–14 条，主要测位置与布局敏感性。',
      'phase-2 freeze：最终问答 run 前临时禁用 coordinator.compaction，并把该 run 的 session window 与 modelBudgetCeilings 抬到模型声明 context=1,000,000，结束后恢复。phase2FreezeViolated 必须为 false，否则该 task×arm 的保留率测量不可信。',
      'summary/hybrid 只有摘要实际安装后才压缩；摘要失败时保留硬容量/遮罩投影。必须同时看 summaryInstalled / summaryFailed 与 accuracyByArm，不能把失败重试当作策略效果。',
      'KF 标记只在其事实页出现一次；问题文本本身含 KF 标记，因此“答案含标记”不等于证明来源页保留；标记+数值正则同时命中用于排除从其他重复数值页猜测（复核文档 §3.4 的局限仍成立）。',
      'repeats 默认 1；增加 repeats 只测运行波动，不增加相关布局 task 数，也不改变“统计以 task 为描述性单位”。',
      'off 是无新策略开关的硬容量基线；mask/summary/hybrid 在工作预算 H=65536 触发。实际路径按事件报告，不因参数 H 相同就假定信息量相同。',
      `摘要覆盖率遥测从 context.summary.installed 读取可选 coverage 字段；当前宿主未写该字段时写 null 并标记 ${COVERAGE_PENDING_NOTE}，不猜测覆盖率。`,
    ],
  };
}

function summarizeChecks(checks) {
  const passed = checks.filter(check => check.pass).length;
  return { passed, total: checks.length, rate: checks.length ? Number((passed / checks.length).toFixed(4)) : null };
}

async function writeRootOutputs(rows) {
  const summary = summarize(rows);
  const includeAnswers = state.includeAnswers;
  const results = rows.map(row => ({
    ...row,
    answerText: includeAnswers ? row.answerText : undefined,
    answers: row.answers.map(answer => ({ id: answer.id, marker: answer.marker, factId: answer.factId, category: answer.category, pass: answer.pass, checks: answer.checks, ...(includeAnswers ? { answer: answer.answer } : {}) })),
    phase1: row.phase1 ? { ...row.phase1, text: includeAnswers ? row.phase1.text : undefined } : null,
    phase2: row.phase2 ? { ...row.phase2, text: includeAnswers ? row.phase2.text : undefined } : null,
  }));
  await writeJson(path.join(state.root, 'results.json'), {
    evaluationVersion: EVALUATION_VERSION, createdAt: state.createdAt, mode: state.runMode ? 'run' : 'dry-run',
    model: state.model, provider: state.provider, upstream: state.upstream ?? null, sourceHash: state.sourceHash,
    seedTokensTarget: state.seedTokens, workTokens: state.workTokens, windowTokens: state.windowTokens, repeats: state.repeats,
    arms: state.arms.map(describeArm),
    tasks: state.tasks.map(task => ({ id: task.id, label: task.label, pages: task.pages.length, contentTokens: task.contentTokens, contentHash: task.contentHash })),
    results, summary,
  });
  await writeJson(path.join(state.root, 'summary.json'), summary);
}

async function writeManifest(dryRun) {
  const manifest = {
    evaluationVersion: EVALUATION_VERSION, mode: state.runMode ? 'run' : 'dry-run', createdAt: state.createdAt,
    model: state.model, provider: state.provider, upstream: state.upstream ?? null, sourceHash: state.sourceHash,
    seedTokensTarget: state.seedTokens, workTokens: state.workTokens, windowTokens: state.windowTokens,
    outputTokens: budgetForWindow().maxOutputTokens, repeats: state.repeats,
    arms: state.arms.map(describeArm),
    phase2Compaction: phase2ControlPlan(),
    limits: { model: LIMITS, budget: budgetForWindow(), maxDurationMs: MAX_DURATION_MS },
    design: {
      purpose: 'C4 相关布局配对压力测试：3 个强重叠事实布局（不同页集合/顺序、插入位置、KF 槽位映射与问题），每个 task 在相同 H/window 下跑 off/mask/summary/hybrid，phase-1 单次压缩 + phase-2 冻结闭卷问答；结果仅作描述性位置敏感性分析。',
      tasks: TASK_COUNT, factsPerTask: FACTS_PER_TASK,
      phase1: '真实仓库 file.read 轮次 + 早期只读约束；一次 app.run 触发 prepareContext 压缩（不包含任何问题）。',
      phase2Objective: PHASE2_OBJECTIVE,
      phase2: 'phase-1 终态投影（去 Kernel execution state 行）+ 16 题闭卷 QA；app.submitInput(follow_up) + step=1 固定投影；phase-2 冻结（禁 compaction + window 抬到模型声明 1M），结束后恢复。',
      scoring: '按 Q<id> 抽取答案段落；每题必须同时命中 KF<slot> 标记与事实值正则；UNKNOWN/缺失记失败。',
      pairing: '每 task 内 4 arms 共享同一 seed 与 H/window；task 间页集合/顺序/插入位置/KF 映射/问题不同。',
      independence: '描述性单位是相关布局 task（n=3），task 间事实强重叠，16 题/task 也不构成独立样本。',
    },
    tasks: state.tasks.map(task => ({
      id: task.id, label: task.label, description: task.description,
      definition: { factIds: task.definition.factIds, shuffleSeed: task.definition.shuffleSeed, depthPattern: task.definition.depthPattern, insertionOffset: task.definition.insertionOffset, fillerSeed: task.definition.fillerSeed },
      seed: { contentChars: task.contentChars, contentTokens: task.contentTokens, factTokens: task.factTokens, fillerTokens: task.fillerTokens, contentHash: task.contentHash },
      facts: task.facts,
      questions: task.questions.map(question => ({ id: question.id, marker: question.marker, factId: question.factId, category: question.category, prompt: question.prompt, expected: question.expected })),
      pages: task.pages.map(page => ({
        kind: page.kind, path: page.path, offset: page.offset, end: page.end, total: page.total, chars: page.chars, tokens: page.tokens, hash: page.hash,
        ...(page.kind === 'fact' ? { slot: page.slot, marker: page.marker, factId: page.factId, anchor: page.anchor, anchorDepth: page.anchorDepth, markerDepth: page.markerDepth, targetDepth: page.targetDepth, expectedMatched: page.expectedMatched } : {}),
      })),
    })),
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
  state.createdAt = new Date().toISOString();
  state.model = values.model;
  if (state.model !== FROZEN_MODEL) throw new Error(`This frozen experiment describes ${FROZEN_MODEL} capacities only; pass --model ${FROZEN_MODEL}`);
  state.provider = typeof values.provider === 'string' ? values.provider.trim() : '';
  if (!state.provider) throw new Error('--provider must be nonempty');
  state.workTokens = Number(values['work-tokens']);
  if (!Number.isSafeInteger(state.workTokens) || state.workTokens < MIN_WORK_TOKENS || state.workTokens > MAX_WORK_TOKENS) throw new Error(`--work-tokens must be an integer ${MIN_WORK_TOKENS}..${MAX_WORK_TOKENS}`);
  state.windowTokens = Number(values['window-tokens']);
  if (!Number.isSafeInteger(state.windowTokens) || state.windowTokens < 32_768 || state.windowTokens >= LIMITS.context) throw new Error(`--window-tokens must be an integer 32768..${LIMITS.context - 1} (the model declaration stays ${LIMITS.context})`);
  state.seedTokens = Number(values['seed-tokens']);
  if (!Number.isSafeInteger(state.seedTokens) || state.seedTokens < 100_000 || state.seedTokens > 1_000_000) throw new Error('--seed-tokens must be an integer 100000..1000000 (per task, content tokens)');
  state.repeats = Number(values.repeats);
  if (!Number.isSafeInteger(state.repeats) || state.repeats < 1 || state.repeats > MAX_REPEATS) throw new Error(`--repeats must be an integer 1..${MAX_REPEATS}`);
  state.arms = parseArms(values.arms);
  const requestedRoot = values.root ?? path.join(REPOSITORY, '.kodo', `compaction-qa-independent-${state.runMode ? 'run' : 'dry'}-${Date.now()}`);
  state.root = path.resolve(requestedRoot);
  if (existsSync(state.root)) throw new Error('Use a fresh --root directory; previous evidence is never overwritten');
  await mkdir(state.root, { recursive: true });
  state.eventsPath = path.join(state.root, 'events.jsonl');
  await writeFile(state.eventsPath, '');
  emit({ event: 'qa-independent.preparing', root: state.root, mode: state.runMode ? 'run' : 'dry-run', model: state.model, provider: state.provider, arms: state.arms.map(describeArm), repeats: state.repeats, workTokens: state.workTokens, windowTokens: state.windowTokens, seedTokens: state.seedTokens });

  const fillerPool = await loadFillerPool();
  const tasks = await buildTasks(fillerPool);
  state.tasks = tasks;
  const checks = new Map();
  const fullSeeds = new Map();
  for (const task of tasks) {
    const check = checkTaskPages(task);
    checks.set(task.id, check);
    const coverage = checkQuestionCoverage(task);
    const missing = coverage.filter(row => !row.passed);
    if (missing.length) throw new Error(`${task.id}: question coverage failed: ${missing.map(row => `Q${row.id}: ${row.checks.filter(item => !item.present).map(item => item.source).join(' | ')}`).join('; ')}`);
    const seed = await measureTaskSeed(task);
    fullSeeds.set(task.id, seed);
    appendLine(state.eventsPath, { event: 'task.seed', taskId: task.id, pages: task.pages.length, factPages: task.factPages.length, fillers: task.fillers.length, contentTokens: task.contentTokens, contentHash: task.contentHash, seed, checks: { passed: check.passed, problems: check.problems, minPageChars: check.minPageChars, maxPageChars: check.maxPageChars, uniqueMarkers: check.markers.filter(marker => marker.count === 1).length }, coverage });
    emit({ event: 'task.loaded', taskId: task.id, label: task.label, pages: task.pages.length, factPages: task.factPages.length, fillers: task.fillers.length, contentTokens: task.contentTokens, seed, markers: task.facts.map(fact => `${fact.marker}->${fact.factId}`) });
  }
  const controls = await checkPhase2ControlMechanics();
  const simulations = [];
  for (const task of tasks) for (const arm of state.arms) simulations.push(await simulateTaskArm(task, arm));
  for (const simulation of simulations) appendLine(state.eventsPath, { event: 'dry-run.arm', ...simulation });
  printReport(tasks, checks, fullSeeds, simulations, controls);
  state.sourceHash = sha256(JSON.stringify({ evaluationVersion: EVALUATION_VERSION, windowTokens: state.windowTokens, seedTokens: state.seedTokens, tasks: tasks.map(task => ({ id: task.id, contentHash: task.contentHash, questions: task.questions.map(question => ({ id: question.id, marker: question.marker, expected: question.expected })) })) }));
  const dryRun = {
    createdAt: state.createdAt, fullSeeds: Object.fromEntries(fullSeeds), taskChecks: Object.fromEntries([...checks].map(([id, check]) => [id, check])),
    simulations, controls, seedTokens: state.seedTokens, windowTokens: state.windowTokens, workTokens: state.workTokens,
  };
  await writeJson(path.join(state.root, 'dry-run.json'), dryRun);
  await writeManifest(dryRun);
  assertDryRun(tasks, checks, fullSeeds, simulations, controls);
  emit({
    event: 'dry-run.complete', root: state.root, tasks: tasks.length, seedTokens: state.seedTokens,
    tasksDetail: tasks.map(task => ({ taskId: task.id, pages: task.pages.length, factPages: task.factPages.length, contentTokens: task.contentTokens, seedInputTokens: fullSeeds.get(task.id).inputTokens, ratioToWindow: fullSeeds.get(task.id).ratioToWindow, uniqueMarkers: checks.get(task.id).markers.filter(marker => marker.count === 1).length })),
    simulations: simulations.map(simulation => ({ taskId: simulation.taskId, arm: simulation.arm, phase1Triggered: simulation.phase1.compactionTriggered, phase1Strategy: simulation.phase1.buildStrategy, phase2Triggered: simulation.phase2.compactionTriggered })),
    controls: { passed: controls.passed, frozen: controls.frozen, window: controls.window, problems: controls.problems },
  });
  if (!state.runMode) {
    // Dry-run still materializes the root output contract.
    await writeRootOutputs([]);
    await writeManifest(dryRun);
    return;
  }

  const credentials = await resolveRelayCredentials(state.provider, values['provider-config']);
  state.secret = credentials.key;
  state.upstream = credentials.upstream;
  appendLine(state.eventsPath, { event: 'matrix.started', root: state.root, arms: state.arms.map(describeArm), repeats: state.repeats, model: state.model, provider: state.provider, upstream: state.upstream, tasks: tasks.map(task => task.id) });
  const rows = [];
  const totalTrials = state.repeats * state.tasks.length * state.arms.length;
  let trialIndex = 0;
  for (let repeat = 1; repeat <= state.repeats; repeat++) {
    for (const task of tasks) {
      const order = repeat % 2 === 1 ? state.arms : [...state.arms].reverse();
      for (const arm of order) {
        trialIndex++;
        emit({ event: 'trial.started', index: trialIndex, total: totalTrials, taskId: task.id, arm: arm.name, strategy: arm.strategy, workInputTokens: arm.workInputTokens, repeat });
        const row = await trialExecution(task, arm, repeat);
        rows.push(row);
        await writeRootOutputs(rows);
        emit({
          event: 'trial.finished', index: trialIndex, total: totalTrials, id: row.id, taskId: row.taskId, arm: row.arm, strategy: row.strategy,
          workInputTokens: row.workInputTokens, repeat, status: row.status, error: row.error, accuracy: row.accuracy,
          phase1Events: row.phase1?.events ?? null, phase1SummaryInstalled: row.phase1?.summaryInstalled ?? 0, phase1SummaryFailed: row.phase1?.summaryFailed ?? 0,
          phase2Events: row.phase2CompactionEvents, phase2FreezeViolated: row.phase2FreezeViolated,
          requests: row.requests, usage: { input: row.usage.input, output: row.usage.output, estimatedCny: row.usage.estimatedCny }, executionMs: row.executionMs,
        });
      }
    }
  }
  const summary = summarize(rows);
  await writeRootOutputs(rows);
  await writeManifest(dryRun);
  appendLine(state.eventsPath, { event: 'matrix.finished', root: state.root, attempts: rows.length, armSummary: summary.armSummary });
  emit({ event: 'matrix.finished', root: state.root, attempts: rows.length, statisticsUnit: 'task', armSummary: summary.armSummary.map(arm => ({ arm: arm.arm, attempts: arm.attempts, accuracy: arm.accuracy, compaction: arm.compaction, tokens: arm.tokens, durationMs: arm.durationMs })) });
  if (rows.some(row => row.status !== 'completed')) process.exitCode = 1;
}

try {
  const { values } = parseArgs({ options: CLI_OPTIONS });
  await main(values);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
