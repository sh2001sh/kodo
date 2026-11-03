// C5 "compressed project cognition" experiment: QA over real project evidence,
// in two phases so that the compression pass is measured honestly.
//
// Phase 1 (compression) is identical in every mode: real repository pages are
// seeded as authentic file.read tool rounds plus an early read-only user
// constraint, but the QA sheet is NOT part of this context. A neutral objective
// drives one run so prepareContext compresses/installs the handoff summary
// exactly as the arm policy dictates. In v1 the question sheet lived in this
// context and the summary model answered the questions itself (SUMMARY_INVALID
// truncation), so the summary arm silently fell back to the full context.
//
// Phase 2 (QA over the retained projection) has three modes, selected with
// --phase2-mode (default closed, which keeps the original path unchanged):
//   closed   : follow-up run whose context is the pinned phase-1 projection and
//              whose card allows no project re-read; questions are closed-book.
//   open     : same follow-up lineage (history.read is only authorized along the
//              predecessor chain) but the run card allows history.read /
//              history.search and the QA instruction tells the model to recover
//              compressed evidence through the read pointers embedded in the
//              projection. Every tool call, its result size, recovered characters
//              and failures are recorded per trial.
//   knowledge: the 19 deep-preset KF facts are consolidated into 5 private
//              project knowledge entries seeded exactly like tests/knowledge.test.ts
//              (exploration owner run -> real file.read evidence -> putCall ->
//              knowledge.prepare/persist) inside the same trial workspace. The
//              phase-2 run is fresh (so it cannot fall back to history.read of the
//              phase-1 projection) and may use knowledge.browse/search/read.
// Answers are still scored per question against grounded facts that provably
// exist in the raw seed text, so tool use cannot change the acceptance regexes.
//
// --phase2-compaction (default freeze) controls whether phase 2 may compress
// again, because a phase-2 re-compaction would contaminate the "one compression
// pass" retention measurement. freeze temporarily disables the coordinator
// compaction policy for the phase-2 run and raises that run's session window to
// the model-declared context (LIMITS.context = 1M) so hard capacity cannot trim
// it either; both are restored after the run. allow preserves the real behavior
// in which phase 2 may summarize again. --phase2-max-tool-calls (default 12,
// 0 = unlimited) bounds the phase-2 tool rounds in open/knowledge modes so a
// tool loop cannot exhaust the session TIME_BUDGET.
//
// Arms: off (existing hard-capacity trimming, no experimental switch), mask,
// summary, and hybrid at the default --work-tokens budget plus summary@65536 /
// hybrid@65536 (the documented production starting point). Every trial uses a
// fresh data directory. Closed mode continues to use an empty card.tools list so
// the model cannot re-read the project; dry-run never calls a model.
//
// Safety: the real credential is only read in --run mode, never printed, never
// written to disk, and is visible only to the loopback relay in this parent
// process. --dry-run never resolves provider credentials and never calls a model.
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import console from 'node:console';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { URL } from 'node:url';
import ts from 'typescript';
import { Application } from '../../dist/application/index.js';
import { buildContext, initialContext, summaryPrefix } from '../../dist/runtime/context.js';
import { estimateInputTokens, estimateTextTokens } from '../../dist/runtime/context-tokens.js';
import { runBudget } from '../../dist/runtime/coordinator.js';
import { contextOutputReserve } from '../../dist/providers/model-limits.js';
import { createBudgetRelay } from './relay.mjs';
import { historicRates, usageScorecard } from './real-scorecard.mjs';

const EVALUATION_VERSION = 'compaction-qa-retention-v5';
const FROZEN_MODEL = 'deepseek-v4.1-flash';
const DEFAULT_PROVIDER_CONFIG = 'C:/Users/admin/.config/opencode/opencode.json';
const DEFAULT_PROVIDER = 'codego1';
const DEFAULT_ARMS = 'off,mask,summary,summary:65536,hybrid,hybrid:65536';
const DEFAULT_WORK_TOKENS = 16_384;
const DEFAULT_REPEATS = 2;
const DEFAULT_PHASE2_MAX_TOOL_CALLS = 12;
const MAX_PHASE2_TOOL_CALLS = 10_000;
const COVERAGE_PENDING_NOTE = 'coverage telemetry unavailable for this installed summary';
const CATALOG_SOURCE = 'manual-host-seeded（读取正控制）';
const MIN_WORK_TOKENS = 1_024;
const MAX_WORK_TOKENS = 10_000_000;
const MAX_PAGE_CHARS = 24_000;
const MIN_SEED_TOKENS = 40_000;
const MIN_SEED_ROUNDS = 10;
const MAX_SEED_ROUNDS = 12;
const SEED_PRESETS = ['standard', 'large', 'deep'];
const DEFAULT_SEED_PRESET = 'standard';
const LARGE_DEFAULT_SEED_TOKENS = 360_000;
const LARGE_DEFAULT_WINDOW_TOKENS = 131_072;
const LARGE_MIN_ROUNDS = 40;
const LARGE_MAX_ROUNDS = 80;
const LARGE_OUTPUT_CAP = 16_384;
// Some current source modules are shorter than the original 18k lower bound.
// Keep pages real and single-source instead of padding them with unrelated text;
// 8k still leaves the answer anchor well away from the hard trimmer's excerpts.
const DEEP_PAGE_MIN_CHARS = 8_000;
const DEEP_PAGE_MAX_CHARS = 22_000;
const DEEP_ANCHOR_DEPTH_MIN = 0.15;
const DEEP_ANCHOR_DEPTH_MAX = 0.85;
const DEEP_TARGET_DEPTH_MIN = 0.25;
const DEEP_TARGET_DEPTH_MAX = 0.75;
const LIMITS = Object.freeze({ context: 1_000_000, output: 393_216 });
const MAX_DURATION_MS = 300_000;
const TOOL_TIMEOUT_MS = 120_000;
const PHASE1_OBJECTIVE = '请阅读当前项目上下文证据并确认已掌握；本轮只需简短确认，不要展开分析。';
const KERNEL_STATE_PREFIX = 'Kernel execution state: ';
const REPOSITORY = path.resolve(import.meta.dirname, '..', '..');
const STRATEGIES = ['mask', 'summary', 'hybrid'];
const ARM_NAMES = ['off', ...STRATEGIES];
const CATEGORY_ORDER = ['预算与阈值', 'API 与存储', '设计与取舍', '约束与恢复'];
const COMPACTION_EVENT_TYPES = ['context.compacted', 'context.summary.started', 'context.summary.installed', 'context.summary.failed', 'context.summary.skipped', 'context.summary.discarded'];
const TRACE_EVENT_TYPES = new Set(['model.started', 'model.finished', 'model.failed', 'model.retry', 'run.completed', 'run.failed', 'context.archived', ...COMPACTION_EVENT_TYPES]);
// Large-preset filler pages come from real repository text only, never from
// vendored dependencies, generated output, previous evidence roots, or the
// benchmark/comparison tooling that produced this experiment.
const FILLER_ROOTS = ['src', 'docs', 'examples', 'tests', '.github'];
const FILLER_ROOT_FILES = ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.mjs', 'eslint.config.mjs'];
const FILLER_EXTENSIONS = new Set(['.ts', '.md', '.mjs', '.js', '.css', '.html', '.json', '.yml', '.yaml']);
const FILLER_EXCLUDED_PREFIXES = ['node_modules/', '.kodo/', 'dist/', '.git/', 'scripts/'];
const FILLER_PAGE_CAPS = [24_000, 20_000, 16_000, 12_000, 10_000, 8_000, 6_000, 4_000, 3_000];
const MIN_FILLER_FILE_BYTES = 512;
const MAX_FILLER_FILE_BYTES = 2_000_000;
const CARD_DIGEST = createHash('sha256').update('compaction-qa-retention-card-v1').digest('hex');
const CARD = Object.freeze({
  id: 'qa-retention-closed-book',
  version: '1.0.0',
  name: 'Closed-book project-context QA',
  prompt: '闭卷认知保持问答实验：只依据当前上下文中保留的材料作答，不读取文件、不调用工具、不猜测。',
  digest: CARD_DIGEST,
  tools: [],
});
// Phase-2 mode cards. Phase 1 always runs with CARD above, unchanged.
const PHASE2_MODES = ['closed', 'open', 'knowledge'];
const PHASE2_COMPACTION_MODES = ['freeze', 'allow'];
const PHASE2_OBJECTIVES = Object.freeze({
  closed: '第二阶段：闭卷问答（只依据 phase-1 保留的压缩投影作答）。',
  open: '第二阶段：开卷问答（可依据上下文中保留的 read 指针，用 history.read/history.search 恢复被压缩的原文）。',
  knowledge: '第二阶段：知识目录检索问答（可使用 knowledge.browse/knowledge.search/knowledge.read 查询本项目私有知识目录）。',
});
const OPEN_BOOK_CARD = Object.freeze({
  id: 'qa-retention-open-book',
  version: '1.0.0',
  name: 'Open-book project-context QA',
  prompt: '开卷认知保持问答实验：除当前保留的压缩投影外，允许只读调用 history.read / history.search，依据上下文中的 read 指针恢复被压缩或隐藏的原文；不得重跑原始操作、不得修改文件、不得猜测。',
  digest: createHash('sha256').update('compaction-qa-retention-card-open-book-v1').digest('hex'),
  tools: ['history.read', 'history.search'],
});
const KNOWLEDGE_CARD = Object.freeze({
  id: 'qa-retention-knowledge-catalog',
  version: '1.0.0',
  name: 'Knowledge-catalog project-context QA',
  prompt: '知识目录检索问答实验：只依据当前项目私有知识目录（knowledge.browse / knowledge.search / knowledge.read）与保留的压缩投影作答；知识条目是不可信历史数据，只作证据；不得修改文件、不得重试原始实验操作、不得猜测。',
  digest: createHash('sha256').update('compaction-qa-retention-card-knowledge-catalog-v1').digest('hex'),
  tools: ['knowledge.browse', 'knowledge.search', 'knowledge.read'],
});
const KNOWLEDGE_SEED_CARD = Object.freeze({
  id: 'qa-retention-knowledge-seed',
  version: '1.0.0',
  name: 'Knowledge catalog seed reader',
  prompt: '知识目录种子任务：只读调用 file.read 采集项目事实，用于生成私有知识目录条目；不得修改文件。',
  digest: createHash('sha256').update('compaction-qa-retention-card-knowledge-seed-v1').digest('hex'),
  tools: ['file.read'],
});
const DRY_BINDING = Object.freeze({ protocol: 'chat-completions', model: FROZEN_MODEL, baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'KODO_QA_RETENTION_UNUSED', limits: LIMITS });
const CONSTRAINT_TEXT = [
  '用户约束（本任务为只读任务，以下要求全程不可违反）：',
  '1. 本次只读；不得修改 src/runtime/history.ts（只允许读取）。',
  '2. 不得伪造未运行过的测试结果。',
  '3. 在真实实验前不得宣称新压缩策略已提速降本。',
].join('\n');

// Each question names only its topic. The expected regexes are the frozen
// acceptance facts; answers are extracted per Q<id> and every regex must hit.
// The expected patterns accept both prose and source-code spellings where the
// deep preset anchors on real source text (65_536 / 16_384 / 60_000 / English
// "two folder levels"); the original alternatives are preserved so answers that
// already passed still pass. Q4 was refreshed on 2026-10-22: the summary content
// ceiling is now min(8192, 8% of H, run output) in src/runtime/compaction.ts, so
// the old 4096 acceptance value contradicted the source and was replaced.
const QUESTIONS = [
  { id: 1, category: '预算与阈值', prompt: '默认的 workInputTokens 工作预算（单位 token）是多少？', expected: ['65536|65,536|65_536'] },
  { id: 2, category: '预算与阈值', prompt: '压缩目标 targetTokens 是工作预算的百分之多少？', expected: ['70\\s*%|0\\.7'] },
  { id: 3, category: '预算与阈值', prompt: '近期原文预算由固定上限与工作预算的 25% 取较小值；这个固定上限是多少 token？', expected: ['16,?384|16_384'] },
  { id: 4, category: '预算与阈值', prompt: '摘要输出预算的内容上限（固定上限）是多少 token？', expected: ['8192|8,192'] },
  { id: 5, category: '预算与阈值', prompt: '摘要请求的超时时间是多少秒？摘要输出预算低于多少 token 时直接跳过摘要？', expected: ['(60\\s*秒|60s|60,?000|60_000)', '128'] },
  { id: 6, category: 'API 与存储', prompt: 'CLI 中启用压缩的参数是什么？可选的三种策略名称分别是什么？', expected: ['--compaction', 'mask', 'summary', 'hybrid'] },
  { id: 7, category: 'API 与存储', prompt: 'knowledge_nodes 表的主键约束是什么？同一项目内的知识唯一约束是什么？', expected: ['project_id\\s*,\\s*id|PRIMARY KEY\\s*\\(\\s*project_id\\s*,\\s*id\\s*\\)', 'project_id\\s*,\\s*knowledge_id|UNIQUE\\s*\\(\\s*project_id\\s*,\\s*knowledge_id\\s*\\)'] },
  { id: 8, category: 'API 与存储', prompt: '知识目录最多允许几层分类（根目录不计入深度）？', expected: ['(两|二|2)\\s*层|two folder levels'] },
  { id: 9, category: 'API 与存储', prompt: '当前存储使用的 PRAGMA user_version 值是多少？', expected: ['user_version[^\\n]{0,20}5|user_version\\s*=\\s*5|^\\s*5\\s*$|(?:值为?|版本)[^\\n]{0,10}5'] },
  { id: 10, category: '设计与取舍', prompt: 'RAPTOR 是否被 Kodo 首版采用？原因涉及哪类做法？', expected: ['((不|未)(被)?(首版)?采用|没有采用|不引入|未引入)', '(递归|聚类|向量)'] },
  { id: 11, category: '设计与取舍', prompt: 'Kodo 从 PageIndex 借鉴的核心思路是什么？', expected: ['结构', '(原文|正文)'] },
  { id: 12, category: '设计与取舍', prompt: '知识目录与任务摘要各自的分工是什么？', expected: ['项目知识', '(当前任务|当前工作)'] },
  { id: 13, category: '预算与阈值', prompt: '二级模型任务摘要的触发条件是什么？', expected: ['(超过|超出|高于)[^\\n]{0,12}(工作预算|软预算|预算|H)|超预算|(仍|依然|还)[^\\n]{0,8}超', '摘要|总结'] },
  { id: 14, category: '预算与阈值', prompt: '默认情况下，新的压缩策略是否启用？', expected: ['默认关闭|默认不启用|不默认启用|off by default'] },
  { id: 15, category: '设计与取舍', prompt: '文档如何定位 64k 工作预算（例如实验状态或是否已验证）？', expected: ['实验起点|实验参数|未验证|未验收|不能宣称'] },
  { id: 16, category: '设计与取舍', prompt: 'SummaryEnvelope.sources 字段的用途是什么？', expected: ['读取入口|read|来源引用|引用'] },
  { id: 17, category: 'API 与存储', prompt: 'history.search 单页最多返回几条结果？扫描字符上限是多少？', expected: ['(每页|单页)[^\\n]{0,20}5|limit[^\\n]{0,10}5', '128,?000'] },
  { id: 18, category: 'API 与存储', prompt: 'knowledge.browse 每页最多返回多少条？', expected: ['\\b20\\b'] },
  { id: 19, category: '约束与恢复', prompt: '任务开始时用户给出的不可违反约束有哪些？', expected: ['(不得|不能|禁止)修改.{0,20}history\\.ts|只读', '(不得|不能)(伪造|宣称)|不得伪造|不得宣称'] },
  { id: 20, category: '约束与恢复', prompt: '摘要遗漏细节后，应通过什么方式找回原文？', expected: ['history\\.(read|search)|读取参数|归档'] },
];

// Evidence pages are real repository reads. Ranges are line based (1-based,
// inclusive). Docs are split evenly by characters so the whole design document is
// covered; other files use targeted windows that contain the frozen facts.
const SEED_SPECS = [
  { path: 'src/runtime/context.ts', kind: 'anchor', anchor: '65_536', beforeAnchor: 8 },
  { path: 'src/runtime/compaction.ts', kind: 'whole', maxPages: 2 },
  { path: 'src/storage/index.ts', kind: 'range', start: 1, end: 240 },
  { path: 'src/knowledge/index.ts', kind: 'range', start: 150, end: 330 },
  { path: 'src/runtime/history.ts', kind: 'whole', maxPages: 1 },
  { path: 'README.md', kind: 'range', start: 190, end: 230 },
  { path: 'docs/context-compaction.md', kind: 'split', pages: 3 },
];

// Deep preset: one real page per question with the answer anchor placed near the
// middle of the page (target depth varies uniformly over 0.25..0.75 by question
// order) so the old hard-capacity head/tail excerpts cannot recover the fact.
// `occurrence: 'best'` searches every occurrence and picks the one whose page
// best matches the target depth while the page still hits the expected regexes.
const DEEP_FACT_SPECS = [
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
  { questionId: 12, path: 'docs/context-compaction.md', anchor: '项目知识', occurrence: 'best', note: '原锚点“目录用于整理项目知识”在文件开头（pos 712），无法达到页面中段深度；改用同文档“项目知识”的最优出现位置，页面仍命中 expected。' },
  { questionId: 13, path: 'docs/context-compaction.md', anchor: '仍超过 H' },
  { questionId: 14, path: 'README.md', anchor: '默认关闭', occurrence: 'best', note: 'README 首次出现 pos 545 深度不足；改用最优出现位置，页面仍命中 expected。' },
  { questionId: 15, path: 'docs/context-compaction.md', anchor: '可复现实验起点' },
  { questionId: 16, path: 'src/runtime/compaction.ts', anchor: 'sources', occurrence: 'best', note: '原锚点“准确读取入口”不存在于 src/runtime/compaction.ts（仅 docs 有），改用同文件 sources 的最优出现位置，页面命中 expected（读取入口/read）。' },
  { questionId: 17, path: 'src/runtime/history.ts', anchor: '128_000' },
  { questionId: 18, path: 'src/knowledge/index.ts', anchor: 'limit > 20' },
  { questionId: 20, path: 'docs/context-compaction.md', anchor: 'history.search' },
];

// Deep preset facts are real project facts, but each page carries a unique KF
// marker. Questions require the marker in the answer, so another page that
// happens to repeat the same number cannot be used as a fallback.
const DEEP_FACT_TEXT = {
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
  17: 'history.search 单页最多 5 条，扫描上限 128000 字符。',
  18: 'knowledge.browse 每页最多 20 条。',
  20: '摘要遗漏细节后通过 history.read/history.search 的读取参数找回原文。',
};
const deepMarker = id => `KF-${id}`;
const deepMarkerLine = id => `【项目事实 ${deepMarker(id)}】${DEEP_FACT_TEXT[id]}`;
const DEEP_FACT_IDS = new Set(Object.keys(DEEP_FACT_TEXT).map(Number));
function factIdsIn(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return [...new Set([...text.matchAll(/KF-(\d+)\b/g)].map(match => Number(match[1])).filter(id => DEEP_FACT_IDS.has(id)))].sort((left, right) => left - right);
}
function questionForRun(question) {
  if (state.seedPreset !== 'deep' || !DEEP_FACT_TEXT[question.id]) return question;
  return {
    ...question,
    prompt: `根据上下文中标注为 ${deepMarker(question.id)} 的项目事实回答：${question.prompt}`,
    expected: [`${deepMarker(question.id)}\\b`, ...question.expected],
  };
}

// ---- knowledge-catalog arm: consolidate the 19 deep-preset facts into 5 entries ----
// Each entry is seeded as a real exploration owner run + real file.read evidence,
// then persisted with knowledge.prepare/persist (same host-owned pipeline as
// tests/knowledge.test.ts). The entry summary carries the KF markers/values so
// knowledge.search can find the entry; claims carry one fact each; the retained
// evidence excerpt is the fact file written into the trial workspace.
const KNOWLEDGE_FACT_19_TEXT = '任务开始时用户给出的不可违反约束：本次只读；不得修改 src/runtime/history.ts（只允许读取）；不得伪造未运行过的测试结果；在真实实验前不得宣称新压缩策略已提速降本。';
const KNOWLEDGE_GROUPS = [
  { id: 'kf-budget', title: '压缩预算与阈值', questionIds: [1, 2, 3, 4, 5, 13, 14] },
  { id: 'kf-storage', title: '知识存储与 API', questionIds: [6, 7, 8, 9] },
  { id: 'kf-retrieval', title: '检索与分页上限', questionIds: [17, 18] },
  { id: 'kf-design', title: '设计与取舍', questionIds: [10, 11, 12, 15, 16] },
  { id: 'kf-constraints', title: '约束与恢复', questionIds: [19, 20] },
];
const MAX_KNOWLEDGE_ENTRY_CHARS = 32_000;
const MAX_KNOWLEDGE_SUMMARY_CHARS = 2_000;

function knowledgeFact(questionId) {
  if (questionId === 19) return { questionId, marker: null, text: KNOWLEDGE_FACT_19_TEXT };
  const text = DEEP_FACT_TEXT[questionId];
  if (!text) throw new Error(`knowledge catalog has no frozen fact text for Q${questionId}; the catalog is only defined for the deep preset`);
  return { questionId, marker: deepMarker(questionId), text };
}

function buildKnowledgeCatalog() {
  return KNOWLEDGE_GROUPS.map((group, index) => {
    const facts = group.questionIds.map(knowledgeFact);
    const markers = facts.map(fact => fact.marker ?? 'Q19').join('、');
    const factLines = facts.map(fact => fact.marker ? `【项目事实 ${fact.marker}】${fact.text}` : `【任务约束】${fact.text}`);
    const content = [
      `# ${group.title}`,
      `知识目录条目 ${group.id}（${group.title}）按类别汇总以下项目事实，供第二阶段检索问答使用。`,
      '',
      ...factLines,
    ].join('\n');
    const summary = `${group.title}（知识目录 ${group.id}）：${facts.map(fact => fact.marker ? `${fact.marker}=${fact.text}` : `Q19=${fact.text}`).join('；')}`;
    return {
      id: group.id,
      index,
      title: group.title,
      objective: `知识目录条目 ${group.id}：${group.title}；覆盖项目事实 ${markers}。`,
      facts,
      content,
      summary: summary.slice(0, MAX_KNOWLEDGE_SUMMARY_CHARS),
    };
  });
}

function checkKnowledgeCatalog(catalog = buildKnowledgeCatalog()) {
  const problems = [];
  const kfFacts = Object.keys(DEEP_FACT_TEXT).map(Number);
  const allFacts = QUESTIONS.map(question => question.id);
  const covered = new Map();
  if (catalog.length !== KNOWLEDGE_GROUPS.length) problems.push(`knowledge catalog has ${catalog.length} entries; expected ${KNOWLEDGE_GROUPS.length}`);
  const ids = new Set();
  for (const entry of catalog) {
    if (ids.has(entry.id)) problems.push(`duplicate knowledge entry id ${entry.id}`);
    ids.add(entry.id);
    if (!entry.content.trim()) problems.push(`${entry.id}: empty entry content`);
    if (entry.content.length > MAX_KNOWLEDGE_ENTRY_CHARS) problems.push(`${entry.id}: ${entry.content.length} characters exceeds the ${MAX_KNOWLEDGE_ENTRY_CHARS} evidence cap`);
    if (entry.summary.length > MAX_KNOWLEDGE_SUMMARY_CHARS) problems.push(`${entry.id}: summary ${entry.summary.length} characters exceeds ${MAX_KNOWLEDGE_SUMMARY_CHARS}`);
    if (!entry.facts.length || entry.facts.length > 30) problems.push(`${entry.id}: ${entry.facts.length} claims is outside 1..30`);
    for (const fact of entry.facts) {
      if (covered.has(fact.questionId)) problems.push(`Q${fact.questionId} appears in both ${covered.get(fact.questionId)} and ${entry.id}`);
      covered.set(fact.questionId, entry.id);
      if (fact.marker) {
        const occurrences = (entry.content.match(new RegExp(`${fact.marker}\\b`, 'g')) ?? []).length;
        if (occurrences !== 1) problems.push(`${entry.id}: marker ${fact.marker} appears ${occurrences} times; expected exactly 1`);
        if (!entry.summary.includes(fact.marker)) problems.push(`${entry.id}: summary does not carry ${fact.marker}; search could not find it`);
      }
      const question = QUESTIONS.find(item => item.id === fact.questionId);
      if (!question) problems.push(`${entry.id}: unknown question Q${fact.questionId}`);
      else for (const source of question.expected) if (!new RegExp(source).test(entry.content)) problems.push(`Q${fact.questionId}: ${entry.id} content does not match expected ${JSON.stringify(source)}`);
    }
  }
  for (const id of kfFacts) if (!covered.has(id)) problems.push(`knowledge catalog misses KF fact Q${id}`);
  for (const id of allFacts) if (!covered.has(id)) problems.push(`knowledge catalog misses question Q${id}`);
  return {
    passed: problems.length === 0,
    entries: catalog.length,
    expectedFacts: kfFacts.length,
    factsCovered: kfFacts.filter(id => covered.has(id)).length,
    expectedQuestions: allFacts.length,
    questionsCovered: allFacts.filter(id => covered.has(id)).length,
    constraintCovered: covered.has(19),
    totalChars: catalog.reduce((total, entry) => total + entry.content.length, 0),
    summariesSearchable: catalog.every(entry => /kf-|q19/i.test(`${entry.id} ${entry.objective} ${entry.summary}`)),
    problems,
  };
}

const CLI_OPTIONS = {
  root: { type: 'string' },
  'provider-config': { type: 'string', default: DEFAULT_PROVIDER_CONFIG },
  provider: { type: 'string', default: DEFAULT_PROVIDER },
  model: { type: 'string', default: FROZEN_MODEL },
  arms: { type: 'string', default: DEFAULT_ARMS },
  'work-tokens': { type: 'string', default: String(DEFAULT_WORK_TOKENS) },
  repeats: { type: 'string', default: String(DEFAULT_REPEATS) },
  'seed-preset': { type: 'string', default: DEFAULT_SEED_PRESET },
  'seed-tokens': { type: 'string' },
  'window-tokens': { type: 'string' },
  'phase2-mode': { type: 'string', default: 'closed' },
  'phase2-compaction': { type: 'string', default: 'freeze' },
  'phase2-max-tool-calls': { type: 'string', default: String(DEFAULT_PHASE2_MAX_TOOL_CALLS) },
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
  repeats: DEFAULT_REPEATS,
  arms: [],
  seedPreset: DEFAULT_SEED_PRESET,
  seedTargetTokens: null,
  windowTokens: LIMITS.context,
  seed: null,
  phase2Mode: 'closed',
  phase2Compaction: 'freeze',
  phase2MaxToolCalls: DEFAULT_PHASE2_MAX_TOOL_CALLS,
  knowledgeCatalog: null,
};

// The model declaration keeps its 1M/393216 capacity; the run window and the
// window-local output reserve are experiment parameters. Large contexts derive
// an in-window output budget (131072 -> 16384) so createRun's output<context
// validation holds and the context output reserve stays realistic.
function budgetForWindow() {
  const windowTokens = state.windowTokens;
  const maxOutputTokens = state.seedPreset === 'standard'
    ? Math.min(LIMITS.output, windowTokens - 1)
    : Math.min(LARGE_OUTPUT_CAP, Math.floor(windowTokens / 8));
  return {
    maxTokens: null,
    maxModelCalls: null,
    maxToolCalls: null,
    maxDurationMs: MAX_DURATION_MS,
    maxContextTokens: windowTokens,
    maxOutputTokens,
    maxContextChars: null,
    toolTimeoutMs: TOOL_TIMEOUT_MS,
  };
}

const emit = value => console.log(JSON.stringify(value));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const mean = values => {
  const numbers = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? Number((numbers.reduce((total, value) => total + value, 0) / numbers.length).toFixed(2)) : null;
};
const pad = (value, width) => String(value).padEnd(width);
const redact = text => {
  const secret = state.secret;
  return secret ? String(text).replaceAll(secret, '[redacted]') : String(text);
};
const redactedJson = value => redact(JSON.stringify(value, null, 2));
const writeJson = (file, value) => writeFile(file, `${redactedJson(value)}\n`);
const appendLine = (file, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  appendFileSync(file, `${redact(text)}\n`);
};

function parseArms(text, fallbackWorkTokens) {
  const entries = String(text ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) throw new Error('--arms must name at least one arm: off, mask[:tokens], summary[:tokens], hybrid[:tokens]');
  const seen = new Set();
  return entries.map(entry => {
    const parts = entry.split(':');
    if (parts.length > 2) throw new Error(`Malformed arm ${entry}; syntax is off, mask[:tokens], summary[:tokens], hybrid[:tokens]`);
    const [name, rawWork] = parts;
    if (!ARM_NAMES.includes(name)) throw new Error(`Unknown arm ${name}; expected off, mask[:tokens], summary[:tokens] or hybrid[:tokens]`);
    if (name === 'off') {
      if (rawWork !== undefined) throw new Error('The off arm takes no token budget; it reproduces the existing hard-capacity trimming');
      if (seen.has('off')) throw new Error('Duplicate arm off');
      seen.add('off');
      return { name: 'off', strategy: null, workInputTokens: null, usesDefaultWorkTokens: false };
    }
    const workInputTokens = rawWork === undefined ? fallbackWorkTokens : Number(rawWork);
    if (!Number.isSafeInteger(workInputTokens) || workInputTokens < MIN_WORK_TOKENS || workInputTokens > MAX_WORK_TOKENS) throw new Error(`Arm ${name} needs workInputTokens ${MIN_WORK_TOKENS}..${MAX_WORK_TOKENS}`);
    const label = rawWork === undefined ? name : `${name}@${workInputTokens}`;
    if (seen.has(label)) throw new Error(`Duplicate arm ${label}`);
    seen.add(label);
    return { name: label, strategy: name, workInputTokens, usesDefaultWorkTokens: rawWork === undefined };
  });
}

function describeArm(arm) {
  return { arm: arm.name, strategy: arm.strategy, workInputTokens: arm.workInputTokens, explicitWorkTokens: !arm.usesDefaultWorkTokens };
}

function applicationOptions(arm) {
  const options = arm.strategy ? { compaction: { strategy: arm.strategy, workInputTokens: arm.workInputTokens } } : {};
  // The knowledge arm needs app.coordinator.knowledge. Application enables
  // exploration by default (ApplicationOptions.exploration !== false); making it
  // explicit here records the contract and protects the arm from a default change.
  if (state.phase2Mode === 'knowledge') options.exploration = true;
  return options;
}

function phase2CardForMode() {
  if (state.phase2Mode === 'open') return OPEN_BOOK_CARD;
  if (state.phase2Mode === 'knowledge') return KNOWLEDGE_CARD;
  return CARD;
}

function describeCard(card) {
  return { id: card.id, version: card.version, name: card.name, tools: [...card.tools], digest: card.digest };
}

function phase2ModeEnabled() {
  return state.phase2Mode !== 'closed';
}

function phase2ToolsEnabled() {
  return state.phase2Mode !== 'closed';
}

function phase2CompactionFrozen() {
  return state.phase2Compaction === 'freeze';
}

// Pure phase-2 control plan: no Application, no model. Dry-run prints and
// asserts exactly what a real phase-2 run would do, and the run path uses the
// same math when it applies/restores the live controls.
function phase2ControlPlan() {
  const baseBudget = budgetForWindow();
  const probeSession = {
    id: 'phase2-window-probe',
    workspace: '<probe>',
    permissions: ['read'],
    budget: baseBudget,
    modelBudgetCeilings: { maxContextTokens: baseBudget.maxContextTokens, maxOutputTokens: baseBudget.maxOutputTokens },
    tokens: 0,
    modelCalls: 0,
    toolCalls: 0,
    usageEstimated: false,
    createdAt: 'phase2-window-probe',
  };
  const probeRun = { id: 'phase2-window-probe', sessionId: probeSession.id, modelLimits: { context: LIMITS.context, output: LIMITS.output } };
  const frozen = phase2CompactionFrozen();
  const before = runBudget(probeRun, probeSession);
  // Raising only budget.maxContextTokens is not enough: runBudget also clamps to
  // the session modelBudgetCeilings persisted by createRun, so both are raised.
  const raisedSession = frozen ? {
    ...probeSession,
    budget: { ...probeSession.budget, maxContextTokens: LIMITS.context },
    modelBudgetCeilings: { ...probeSession.modelBudgetCeilings, maxContextTokens: LIMITS.context },
  } : probeSession;
  const phase2 = runBudget(probeRun, raisedSession);
  return {
    mode: state.phase2Compaction,
    frozen,
    modelContext: LIMITS.context,
    window: {
      before: { maxContextTokens: before.maxContextTokens, maxOutputTokens: before.maxOutputTokens },
      phase2: { maxContextTokens: phase2.maxContextTokens, maxOutputTokens: phase2.maxOutputTokens },
      raisedForFreeze: frozen && phase2.maxContextTokens > before.maxContextTokens,
    },
    toolBudget: phase2ToolsEnabled() ? state.phase2MaxToolCalls : null,
    toolBudgetApplied: phase2ToolsEnabled(),
    catalogSource: state.phase2Mode === 'knowledge' ? CATALOG_SOURCE : null,
  };
}

// Apply the phase-2 controls to the live Application/session. freeze clears the
// coordinator compaction policy and raises the phase-2 session window to the
// model-declared context; open/knowledge modes also set the phase-2 tool budget.
// The previous policy and budget are restored by endPhase2Controls().
function beginPhase2Controls(app, qaRun) {
  const plan = phase2ControlPlan();
  const sessionId = qaRun.sessionId;
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
  if (plan.toolBudgetApplied) {
    const latest = app.store.session(sessionId);
    app.store.putSession({ ...latest, budget: { ...latest.budget, maxToolCalls: plan.toolBudget } });
  }
  const effective = runBudget(app.store.run(qaRun.id), app.store.session(sessionId));
  return {
    ...plan,
    sessionId,
    runId: qaRun.id,
    policyBefore,
    originalBudget,
    originalCeilings,
    appliedWindow: { maxContextTokens: effective.maxContextTokens, maxOutputTokens: effective.maxOutputTokens },
    restored: false,
  };
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

// phase-2 telemetry: what the controls actually were and whether any compaction
// event slipped through while the projection was supposed to be frozen.
function collectPhase2ControlTelemetry(app, qaRun, controls) {
  let events = [];
  try { events = app.store.events(qaRun.id); } catch { /* store may be closing; counts stay zero */ }
  const compactionEvents = Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, events.filter(event => event.type === type).length]));
  const eventCount = Object.values(compactionEvents).reduce((total, value) => total + value, 0);
  return {
    runId: qaRun.id,
    mode: controls.mode,
    frozen: controls.frozen,
    toolBudget: controls.toolBudget,
    toolBudgetApplied: controls.toolBudgetApplied,
    window: {
      before: controls.window.before,
      expected: controls.window.phase2,
      applied: controls.appliedWindow,
      raisedForFreeze: controls.window.raisedForFreeze,
    },
    restored: controls.restored,
    compactionEvents,
    compactionEventCount: eventCount,
    summaryInstalled: compactionEvents['context.summary.installed'] ?? 0,
    freezeViolated: controls.frozen && eventCount > 0,
  };
}

function splitLineRanges(lines, count) {
  const totalChars = lines.reduce((total, line) => total + line.length + 1, 0);
  const boundaries = [];
  let consumed = 0;
  let target = totalChars / count;
  for (let index = 0; index < lines.length; index++) {
    consumed += lines[index].length + 1;
    if (boundaries.length < count - 1 && consumed >= target) {
      boundaries.push(index + 1);
      target = (totalChars * (boundaries.length + 1)) / count;
    }
  }
  const ranges = [];
  let start = 1;
  for (const boundary of boundaries) {
    ranges.push([start, boundary]);
    start = boundary + 1;
  }
  ranges.push([start, lines.length]);
  return ranges;
}

async function paginateFile(spec) {
  const absolute = path.join(REPOSITORY, spec.path);
  const text = await readFile(absolute, 'utf8');
  const lines = text.split('\n');
  const total = lines.length;
  let ranges;
  if (spec.kind === 'range') {
    ranges = [[Math.min(spec.start, total), Math.min(spec.end, total)]];
  } else if (spec.kind === 'whole') {
    const content = lines.join('\n');
    ranges = content.length <= MAX_PAGE_CHARS ? [[1, total]] : splitLineRanges(lines, Math.ceil(content.length / MAX_PAGE_CHARS));
    if (ranges.length > (spec.maxPages ?? 2)) throw new Error(`${spec.path} needs ${ranges.length} pages but the seed spec allows ${spec.maxPages ?? 2}`);
  } else if (spec.kind === 'anchor') {
    const index = text.indexOf(spec.anchor);
    if (index < 0) throw new Error(`Seed anchor "${spec.anchor}" not found in ${spec.path}; update the seed page spec`);
    const anchorLine = text.slice(0, index).split('\n').length;
    const split = Math.max(2, Math.min(total - 1, anchorLine - spec.beforeAnchor));
    ranges = [[1, split], [split + 1, total]];
  } else {
    ranges = splitLineRanges(lines, spec.pages);
  }
  return ranges.map(([start, end]) => {
    const content = lines.slice(start - 1, end).join('\n');
    if (!content.trim()) throw new Error(`${spec.path} page ${start}-${end} is empty; adjust the seed page spec`);
    if (content.length > MAX_PAGE_CHARS) throw new Error(`${spec.path} page ${start}-${end} is ${content.length} characters, over the ${MAX_PAGE_CHARS} page limit`);
    return { path: spec.path, offset: start, end, total, content, chars: content.length, tokens: estimateTextTokens(content), hash: sha256(content) };
  });
}

// Phase-2 user input. This is the only place the 20 questions appear; keeping
// them out of phase 1 means the auxiliary summary model cannot answer them.
function closedBookInput() {
  const lines = [
    '【第二阶段：闭卷问答】上一阶段的压缩/交接已经完成。现在只依据当前上下文中保留的信息回答下面的问题；',
    '禁止使用工具、重新读取文件或猜测；无法确定时写 UNKNOWN，不要编造数字或引文。',
    '每题单独一行，以 "Q<id>: " 开头（例如 "Q1: ..."），只写答案本身，不写解释，按顺序回答全部题目。',
    ...(state.seedPreset === 'deep' ? ['除 Q19 外，每道题的答案必须以对应 KF-<id> 标记开头，例如 "Q1: KF-1 65536"；未看到该标记就写 UNKNOWN。'] : []),
    '',
    ...QUESTIONS.map(question => `Q${question.id}: ${questionForRun(question).prompt}`),
  ];
  return lines.join('\n');
}

// The knowledge arm's questions point at the catalog instead of the projection;
// acceptance regexes are untouched.
function knowledgeQuestion(question) {
  const effective = questionForRun(question);
  if (!DEEP_FACT_TEXT[question.id]) return effective;
  return { ...effective, prompt: effective.prompt.replace('根据上下文中标注为', '根据知识目录中标注为') };
}

function phase2Question(question) {
  return state.phase2Mode === 'knowledge' ? knowledgeQuestion(question) : questionForRun(question);
}

function openBookInput() {
  const lines = [
    '【第二阶段：开卷问答】上一阶段的压缩/交接已经完成；当前上下文是第一阶段的终态压缩投影（可能包含 Context archive 标记、contextHidden 观察占位与摘要 sources）。',
    '你可以使用 history.read / history.search 恢复被压缩或隐藏的原文：优先按上下文中已有的 read 指针（例如 "read":{"tool":"history.read","args":{"ref":...}}、"history":{"ref":...} 或归档标记里的 ref/offset/limit）调用 history.read；也可用 history.search 按字面文本检索，命中项自带 read 指针。',
    '工具只允许读取当前运行及其前序运行的历史归档，不能读取工作区文件；不要重跑原来的 file.read 等操作，不要修改任何文件，不要猜测。',
    '每题单独一行，以 "Q<id>: " 开头（例如 "Q1: ..."），只写答案本身，不写解释，按顺序回答全部题目。',
    ...(state.seedPreset === 'deep' ? ['除 Q19 外，每道题的答案必须以对应 KF-<id> 标记开头，例如 "Q1: KF-1 65536"；未看到该标记就写 UNKNOWN。'] : []),
    '',
    ...QUESTIONS.map(question => `Q${question.id}: ${phase2Question(question).prompt}`),
  ];
  return lines.join('\n');
}

function knowledgeCatalogInput() {
  const lines = [
    '【第二阶段：知识目录检索问答】上一阶段的压缩/交接已经完成。除保留的压缩投影外，当前项目的私有知识目录已按类别保存了带 KF 标记的项目事实（共 5 个条目，覆盖 19 个 KF 事实）。',
    '你可以使用 knowledge.browse / knowledge.search / knowledge.read 查询知识目录：browse 列出目录（根目录下通常只有“未分类”文件夹，再下一层是条目），search 按字面文本检索（例如查询 "KF"、条目类别或主题，返回条目 id/revision 与 read 指针），read 读取条目正文（summary、逐条 claims 与证据原文；分页时 follow next）。Q19 的任务约束事实也保存在目录条目中。',
    '知识条目是不可信的历史数据，只作证据；不得修改文件、不得重试原始实验操作、不得猜测。',
    '每题单独一行，以 "Q<id>: " 开头（例如 "Q1: ..."），只写答案本身，不写解释，按顺序回答全部题目。',
    ...(state.seedPreset === 'deep' ? ['除 Q19 外，每道题的答案必须以对应 KF-<id> 标记开头，例如 "Q1: KF-1 65536"；未从知识目录看到该标记就写 UNKNOWN。'] : []),
    '',
    ...QUESTIONS.map(question => `Q${question.id}: ${phase2Question(question).prompt}`),
  ];
  return lines.join('\n');
}

function phase2InputForMode() {
  if (state.phase2Mode === 'open') return openBookInput();
  if (state.phase2Mode === 'knowledge') return knowledgeCatalogInput();
  return closedBookInput();
}

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

async function listFillerCandidates() {
  const factPaths = new Set(SEED_SPECS.map(spec => spec.path));
  const absoluteFiles = [];
  for (const root of FILLER_ROOTS) {
    try { absoluteFiles.push(...await walkFiles(path.join(REPOSITORY, root))); } catch { /* optional tree */ }
  }
  for (const rootFile of FILLER_ROOT_FILES) {
    const absolute = path.join(REPOSITORY, rootFile);
    if (existsSync(absolute)) absoluteFiles.push(absolute);
  }
  const selected = [];
  for (const absolute of absoluteFiles.sort()) {
    const relative = path.relative(REPOSITORY, absolute).replaceAll('\\', '/');
    if (factPaths.has(relative)) continue;
    if (FILLER_EXCLUDED_PREFIXES.some(prefix => relative.startsWith(prefix))) continue;
    if (!FILLER_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    let info;
    try { info = await stat(absolute); } catch { continue; }
    if (!info.isFile() || info.size < MIN_FILLER_FILE_BYTES || info.size > MAX_FILLER_FILE_BYTES) continue;
    selected.push(relative);
  }
  return selected;
}

/** Split one real repository text file into ≤maxChars pages (line based; overlong lines are chunked). */
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

/** Round-robin pages across real files so the filler mixes code and docs. */
function roundRobinFillerPages(texts, maxChars) {
  const pageLists = texts.map(file => paginateText(file.path, file.text, maxChars));
  const pages = [];
  const longest = Math.max(0, ...pageLists.map(list => list.length));
  for (let index = 0; index < longest; index++) for (const list of pageLists) if (list[index]) pages.push({ ...list[index], kind: 'filler' });
  return pages;
}

/** Insert the 10 fact pages at equal page-index intervals through the whole sequence. */
function interleaveFactPages(fillerPages, factPages) {
  const total = fillerPages.length + factPages.length;
  const slots = new Map();
  for (let index = 0; index < factPages.length; index++) {
    const slot = Math.round((index * (total - 1)) / (factPages.length - 1));
    if (slots.has(slot)) throw new Error(`fact page slots collide at page ${slot}; increase --seed-tokens so there are more rounds`);
    slots.set(slot, factPages[index]);
  }
  const pages = [];
  let filler = 0;
  for (let index = 0; index < total; index++) pages.push(slots.has(index) ? slots.get(index) : fillerPages[filler++]);
  return pages;
}

function factDistribution(pages) {
  const totalTokens = pages.reduce((total, page) => total + page.tokens, 0);
  let consumed = 0;
  const rows = [];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (page.kind === 'fact') rows.push({
      pageIndex: index,
      path: page.path,
      questionId: page.questionId ?? null,
      anchor: page.anchor ?? null,
      anchorDepth: page.anchorDepth ?? null,
      targetDepth: page.targetDepth ?? null,
      anchorOccurrence: page.anchorOccurrence ?? null,
      anchorOccurrences: page.anchorOccurrences ?? null,
      marker: page.marker ?? null,
      markerDepth: page.markerDepth ?? null,
      note: page.note ?? null,
      chars: page.chars,
      tokens: page.tokens,
      tokenStart: consumed,
      tokenFraction: Number(((consumed + page.tokens / 2) / totalTokens).toFixed(4)),
    });
    consumed += page.tokens;
  }
  return { totalTokens, rows };
}

function checkFactDistribution(distribution) {
  const rows = distribution.rows;
  if (rows.length < 2) return { passed: false, minFraction: null, maxFraction: null, maxGap: null, problems: ['fewer than two fact pages'] };
  const fractions = rows.map(row => row.tokenFraction);
  const gaps = fractions.slice(1).map((fraction, index) => Number((fraction - fractions[index]).toFixed(4)));
  const minFraction = Math.min(...fractions);
  const maxFraction = Math.max(...fractions);
  const maxGap = Math.max(...gaps);
  const problems = [];
  if (minFraction > 0.15) problems.push(`first fact token fraction ${minFraction} is not <= 0.15`);
  if (maxFraction < 0.85) problems.push(`last fact token fraction ${maxFraction} is not >= 0.85`);
  if (maxGap > 0.2) problems.push(`adjacent fact gap ${maxGap} is not <= 0.2`);
  return { passed: problems.length === 0, minFraction, maxFraction, maxGap, gaps, problems };
}

async function loadFactPages() {
  const pages = [];
  for (const spec of SEED_SPECS) pages.push(...await paginateFile(spec));
  if (pages.length !== 10) throw new Error(`the frozen fact set must be 10 pages, got ${pages.length}`);
  return pages.map(page => ({ ...page, kind: 'fact' }));
}

function buildSeed(pages, factPages) {
  const rounds = pages.map((page, index) => {
    const callId = `read-${index + 1}`;
    return [
      {
        role: 'assistant',
        content: `读取 ${page.path} 第 ${page.offset}-${page.end} 行（文件共 ${page.total} 行），记录项目事实。`,
        tool_calls: [{ id: callId, name: 'file.read', arguments: JSON.stringify({ path: page.path, offset: page.offset, limit: page.end - page.offset + 1 }) }],
      },
      { role: 'tool', tool_call_id: callId, content: JSON.stringify({ path: page.path, offset: page.offset, total: page.total, content: page.content }) },
    ];
  }).flat();
  // Phase-1 seed: authentic project evidence and the early user constraint only.
  const messages = [{ role: 'user', content: CONSTRAINT_TEXT }, ...rounds];
  const contentChars = pages.reduce((total, page) => total + page.chars, 0);
  const contentTokens = pages.reduce((total, page) => total + page.tokens, 0);
  const evidenceText = [CONSTRAINT_TEXT, ...factPages.map(page => page.content)].join('\n');
  return {
    preset: state.seedPreset,
    pages,
    factPages,
    rounds,
    messages,
    evidenceText,
    contentChars,
    contentTokens,
    pageCount: pages.length,
    factTokens: factPages.reduce((total, page) => total + page.tokens, 0),
    factDistribution: factDistribution(pages),
    contentHash: sha256(JSON.stringify(pages.map(page => ({ path: page.path, offset: page.offset, hash: page.hash })))),
  };
}

async function loadStandardSeed() {
  const factPages = await loadFactPages();
  if (factPages.length < MIN_SEED_ROUNDS || factPages.length > MAX_SEED_ROUNDS) throw new Error(`standard seed has ${factPages.length} tool rounds; the experiment requires ${MIN_SEED_ROUNDS}-${MAX_SEED_ROUNDS}`);
  return buildSeed(factPages, factPages);
}

async function loadFillerTexts() {
  const candidates = await listFillerCandidates();
  if (!candidates.length) throw new Error('no repository filler candidates are available for the large/deep seed preset');
  const texts = [];
  for (const relative of candidates) {
    try {
      const text = await readFile(path.join(REPOSITORY, relative), 'utf8');
      // This experiment owns the KF-<n> marker namespace. Its own evidence docs
      // (e.g. docs/context-compaction-qa-results.md) mention ranges like
      // "KF-1～KF-8"; if such text became filler, the global marker-uniqueness
      // check could no longer prove that only the intended fact page carries a
      // marker, so marker-bearing files never enter the filler pool.
      if (/KF-\d+\b/.test(text)) continue;
      texts.push({ path: relative, text });
    } catch { /* skip unreadable */ }
  }
  return texts;
}

function selectFillerPages(texts, fillerNeeded, factCount) {
  for (const maxChars of FILLER_PAGE_CAPS) {
    const fillerPages = roundRobinFillerPages(texts, maxChars);
    const selected = [];
    let tokens = 0;
    for (const page of fillerPages) {
      selected.push(page);
      tokens += page.tokens;
      if (tokens >= fillerNeeded) break;
    }
    if (tokens < fillerNeeded) continue; // this page size cannot reach the target with the available text
    const rounds = selected.length + factCount;
    if (rounds >= LARGE_MIN_ROUNDS && rounds <= LARGE_MAX_ROUNDS) return { selected, maxChars, rounds, fillerTokens: tokens };
  }
  return null;
}

async function loadLargeSeed() {
  const factPages = await loadFactPages();
  const factTokens = factPages.reduce((total, page) => total + page.tokens, 0);
  const fillerNeeded = state.seedTargetTokens - factTokens;
  if (fillerNeeded <= 0) throw new Error(`--seed-tokens must exceed the ${factTokens} tokens of the 10 fact pages`);
  const texts = await loadFillerTexts();
  const chosen = selectFillerPages(texts, fillerNeeded, factPages.length);
  if (!chosen) throw new Error(`cannot build a ${state.seedTargetTokens}-token large seed with ${LARGE_MIN_ROUNDS}-${LARGE_MAX_ROUNDS} rounds from the available repository pages; adjust --seed-tokens`);
  const pages = interleaveFactPages(chosen.selected, factPages);
  const seed = buildSeed(pages, factPages);
  seed.fillerPageChars = chosen.maxChars;
  seed.fillerPageCount = chosen.selected.length;
  seed.fillerTokens = chosen.fillerTokens;
  return seed;
}

// ---- deep preset: one real page per question with the anchor buried mid-page ----

function lineBoundaries(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  if (starts.at(-1) !== text.length) starts.push(text.length);
  return starts;
}

function deepPageCandidates(text, starts, anchorPos, anchorLength, targetDepth) {
  const candidates = [];
  for (const startChar of starts) {
    if (startChar > anchorPos) break;
    const minimum = startChar + DEEP_PAGE_MIN_CHARS;
    if (minimum > text.length) continue;
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle] >= minimum) high = middle;
      else low = middle + 1;
    }
    for (let endIndex = low; endIndex < starts.length; endIndex++) {
      const endChar = starts[endIndex];
      const chars = endChar - startChar;
      if (chars > DEEP_PAGE_MAX_CHARS) break;
      if (chars < DEEP_PAGE_MIN_CHARS || anchorPos + anchorLength > endChar) continue;
      const depth = (anchorPos - startChar) / chars;
      if (depth < DEEP_ANCHOR_DEPTH_MIN || depth > DEEP_ANCHOR_DEPTH_MAX) continue;
      candidates.push({ startChar, endChar, content: text.slice(startChar, endChar), chars, depth: Number(depth.toFixed(4)), score: Math.abs(depth - targetDepth) });
    }
  }
  return candidates;
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

async function buildDeepFactPages() {
  const textCache = new Map();
  const factPages = [];
  const problems = [];
  for (let index = 0; index < DEEP_FACT_SPECS.length; index++) {
    const spec = DEEP_FACT_SPECS[index];
    const targetDepth = DEEP_TARGET_DEPTH_MIN + ((DEEP_TARGET_DEPTH_MAX - DEEP_TARGET_DEPTH_MIN) * index) / (DEEP_FACT_SPECS.length - 1);
    const question = QUESTIONS.find(item => item.id === spec.questionId);
    if (!question) throw new Error(`deep fact spec references unknown question Q${spec.questionId}`);
    if (!textCache.has(spec.path)) textCache.set(spec.path, await readFile(path.join(REPOSITORY, spec.path), 'utf8'));
    const text = textCache.get(spec.path);
    const starts = lineBoundaries(text);
    const occurrences = occurrencesOf(text, spec.anchor);
    if (!occurrences.length) {
      problems.push(`Q${spec.questionId}: anchor ${JSON.stringify(spec.anchor)} not found in ${spec.path}`);
      continue;
    }
    const pool = spec.occurrence === 'best' ? occurrences : [occurrences[0]];
    const candidates = [];
    for (let occurrenceIndex = 0; occurrenceIndex < pool.length; occurrenceIndex++) {
      for (const candidate of deepPageCandidates(text, starts, pool[occurrenceIndex], spec.anchor.length, targetDepth)) {
        if (!question.expected.every(source => new RegExp(source).test(candidate.content))) continue;
        candidates.push({ ...candidate, occurrenceIndex });
      }
    }
    if (!candidates.length) {
      problems.push(`Q${spec.questionId}: no ${DEEP_PAGE_MIN_CHARS}-${DEEP_PAGE_MAX_CHARS} character page in ${spec.path} hits expected ${JSON.stringify(question.expected)} with anchor ${JSON.stringify(spec.anchor)} inside depth ${DEEP_ANCHOR_DEPTH_MIN}-${DEEP_ANCHOR_DEPTH_MAX}`);
      continue;
    }
    candidates.sort((left, right) => left.score - right.score);
    const best = candidates[0];
    const anchorPos = pool[best.occurrenceIndex];
    const offset = text.slice(0, best.startChar).split('\n').length;
    const total = text.split('\n').length;
    // Put a uniquely identifiable project fact at the anchor depth. Other pages
    // may repeat the same number in real repository text, but only this page
    // carries the KF marker, so scoring cannot fall back to another page.
    const markerText = deepMarkerLine(spec.questionId);
    const targetChar = Math.max(1, Math.min(best.content.length - 1, Math.round(best.content.length * best.depth)));
    const lineStart = best.content.lastIndexOf('\n', targetChar) + 1;
    const content = `${best.content.slice(0, lineStart)}${markerText}\n${best.content.slice(lineStart)}`;
    if (content.length > MAX_PAGE_CHARS) throw new Error(`Q${spec.questionId}: page with KF marker is ${content.length} chars, over ${MAX_PAGE_CHARS}`);
    const markerDepth = content.indexOf(markerText) / content.length;
    factPages.push({
      kind: 'fact',
      questionId: spec.questionId,
      path: spec.path,
      anchor: spec.anchor,
      anchorPos,
      anchorOccurrence: spec.occurrence === 'best' ? best.occurrenceIndex : 0,
      anchorOccurrences: occurrences.length,
      targetDepth: Number(targetDepth.toFixed(4)),
      anchorDepth: best.depth,
      offset,
      end: offset + content.split('\n').length - 1,
      total,
      content,
      chars: content.length,
      tokens: estimateTextTokens(content),
      hash: sha256(content),
      note: spec.note ?? null,
      expected: question.expected,
      expectedMatched: true,
      marker: deepMarker(spec.questionId),
      markerText,
      markerDepth: Number(markerDepth.toFixed(4)),
    });
  }
  if (problems.length) throw new Error(`deep fact pages failed:\n- ${problems.join('\n- ')}`);
  if (factPages.length !== DEEP_FACT_SPECS.length) throw new Error(`deep preset built ${factPages.length} fact pages, expected ${DEEP_FACT_SPECS.length}`);
  return factPages;
}

function checkDeepFacts(seed) {
  const rows = seed.factDistribution.rows.filter(row => row.questionId !== null);
  const problems = [];
  if (rows.length !== DEEP_FACT_SPECS.length) problems.push(`deep fact pages ${rows.length} != ${DEEP_FACT_SPECS.length}`);
  const markerCounts = new Map();
  for (const page of seed.pages) for (const questionId of Object.keys(DEEP_FACT_TEXT)) {
    const marker = deepMarker(Number(questionId));
    const count = (page.content.match(new RegExp(`${marker}\\b`, 'g')) ?? []).length;
    if (count) markerCounts.set(marker, (markerCounts.get(marker) ?? 0) + count);
  }
  const markers = [];
  const detail = rows.map(row => {
    const page = seed.pages[row.pageIndex];
    const question = QUESTIONS.find(item => item.id === row.questionId);
    const marker = deepMarker(row.questionId);
    const expectedMatched = Boolean(page && question && question.expected.every(source => new RegExp(source).test(page.content)));
    if (!expectedMatched) problems.push(`Q${row.questionId}: fact page does not hit expected ${JSON.stringify(question?.expected ?? [])}`);
    if (typeof row.anchorDepth !== 'number' || row.anchorDepth < DEEP_ANCHOR_DEPTH_MIN || row.anchorDepth > DEEP_ANCHOR_DEPTH_MAX) problems.push(`Q${row.questionId}: anchorDepth ${row.anchorDepth} is outside ${DEEP_ANCHOR_DEPTH_MIN}-${DEEP_ANCHOR_DEPTH_MAX}`);
    const pageMarkerCount = page ? (page.content.match(new RegExp(`${marker}\\b`, 'g')) ?? []).length : 0;
    const globalMarkerCount = markerCounts.get(marker) ?? 0;
    const unique = pageMarkerCount === 1 && globalMarkerCount === 1;
    if (!unique) problems.push(`Q${row.questionId}: KF marker ${marker} is not unique (page=${pageMarkerCount}, seed=${globalMarkerCount})`);
    if (typeof row.markerDepth !== 'number' || row.markerDepth < DEEP_ANCHOR_DEPTH_MIN || row.markerDepth > DEEP_ANCHOR_DEPTH_MAX) problems.push(`Q${row.questionId}: markerDepth ${row.markerDepth} is outside ${DEEP_ANCHOR_DEPTH_MIN}-${DEEP_ANCHOR_DEPTH_MAX}`);
    markers.push({ questionId: row.questionId, marker, markerDepth: row.markerDepth, pageIndex: row.pageIndex, tokenFraction: row.tokenFraction, unique });
    return { ...row, expectedMatched, marker, unique };
  });
  const depths = detail.map(row => row.anchorDepth);
  const minDepth = Math.min(...depths);
  const maxDepth = Math.max(...depths);
  if (minDepth > 0.3) problems.push(`deep anchorDepth min ${minDepth} is not <= 0.3`);
  if (maxDepth < 0.7) problems.push(`deep anchorDepth max ${maxDepth} is not >= 0.7`);
  return { passed: problems.length === 0, rows: detail, markers, minDepth, maxDepth, problems };
}

async function loadDeepSeed() {
  const factPages = await buildDeepFactPages();
  const factTokens = factPages.reduce((total, page) => total + page.tokens, 0);
  const fillerNeeded = state.seedTargetTokens - factTokens;
  if (fillerNeeded <= 0) throw new Error(`--seed-tokens must exceed the ${factTokens} tokens of the ${factPages.length} deep fact pages`);
  const texts = await loadFillerTexts();
  const chosen = selectFillerPages(texts, fillerNeeded, factPages.length);
  if (!chosen) throw new Error(`cannot build a ${state.seedTargetTokens}-token deep seed with ${LARGE_MIN_ROUNDS}-${LARGE_MAX_ROUNDS} rounds from the available repository pages; adjust --seed-tokens`);
  const pages = interleaveFactPages(chosen.selected, factPages);
  const seed = buildSeed(pages, factPages);
  seed.fillerPageChars = chosen.maxChars;
  seed.fillerPageCount = chosen.selected.length;
  seed.fillerTokens = chosen.fillerTokens;
  seed.deepChecks = checkDeepFacts(seed);
  return seed;
}

async function loadSeed() {
  if (state.seedPreset === 'deep') return loadDeepSeed();
  return state.seedPreset === 'large' ? loadLargeSeed() : loadStandardSeed();
}

function checkFactCoverage(evidenceText) {
  return QUESTIONS.map(question => {
    const checks = question.expected.map(source => ({ source, present: new RegExp(source).test(evidenceText) }));
    return { id: question.id, category: question.category, checks, passed: checks.every(check => check.present) };
  });
}

function dryRunRow(arm, built, originalInputTokens) {
  const masked = built.messages.filter(message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('"contextHidden":true')).length;
  return {
    arm: arm.name,
    strategy: arm.strategy,
    configuredWorkTokens: arm.workInputTokens,
    originalInputTokens,
    originalChars: built.originalChars,
    estimatedInputTokens: built.estimatedInputTokens,
    compactedChars: built.compactedChars,
    omittedMessages: built.omittedMessages,
    buildStrategy: built.strategy ?? null,
    computedWorkInputTokens: built.workInputTokens ?? null,
    targetTokens: built.targetTokens ?? null,
    targetMet: built.targetMet ?? null,
    masked,
    archivedRef: built.archivedRef ?? null,
    previousRef: built.previousRef ?? null,
    summaryPlan: built.summaryPlan ? { archivedRef: built.summaryPlan.archivedRef, foldMessages: built.summaryPlan.foldOffsets.length, recentMessages: built.summaryPlan.recentOffsets.length } : null,
    messageCount: built.messages.length,
  };
}

async function simulateArm(arm, seedMessages) {
  const directory = path.join(state.root, '_dry-run', arm.name);
  const workspace = path.join(directory, 'workspace');
  await mkdir(workspace, { recursive: true });
  const app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, applicationOptions(arm));
  try {
    const run = app.createRun({ objective: PHASE1_OBJECTIVE, workspace, binding: DRY_BINDING, permissions: ['read'], budget: budgetForWindow(), card: CARD });
    const initial = app.store.readBlob(run.contextRef);
    const seeded = [...initial, ...seedMessages];
    app.store.updateRun(run.id, { contextRef: app.store.blob(seeded) });
    const current = app.store.run(run.id);
    const session = app.store.session(current.sessionId);
    const budget = runBudget(current, session);
    // buildContext only reports originalInputTokens on compaction paths; measure the
    // pre-compaction estimate here so the off (hard-capacity) arm is comparable.
    const originalInputTokens = estimateInputTokens(app.store, current, seeded, []);
    const built = buildContext(app.store, current, budget.maxContextChars, [], {
      maxContextTokens: budget.maxContextTokens,
      maxOutputTokens: contextOutputReserve(budget),
      maxInputTokens: current.modelLimits?.input,
      ...(arm.strategy ? { compaction: { strategy: arm.strategy, workInputTokens: arm.workInputTokens } } : {}),
    });
    return dryRunRow(arm, built, originalInputTokens);
  } finally {
    await app.shutdown();
  }
}

function assertDryRun(rows, seed) {
  const problems = [];
  // The generated run/session IDs and the per-arm data-directory length differ
  // between simulations, so the same seed may estimate a few tokens apart.
  const baselines = rows.map(row => row.originalInputTokens);
  const baseline = Math.min(...baselines);
  const spread = Math.max(...baselines) - baseline;
  if (spread > 500) problems.push(`seeded input estimate differs across arms by ${spread} tokens (${baselines.join(', ')})`);
  const distribution = checkFactDistribution(seed.factDistribution);
  const bigContext = state.seedPreset !== 'standard';
  if (bigContext) {
    if (baseline <= 2 * state.windowTokens) problems.push(`${state.seedPreset} seed input estimate ${baseline} is not greater than 2x window (${2 * state.windowTokens})`);
    if (seed.pageCount < LARGE_MIN_ROUNDS || seed.pageCount > LARGE_MAX_ROUNDS) problems.push(`${state.seedPreset} seed has ${seed.pageCount} tool rounds; expected ${LARGE_MIN_ROUNDS}-${LARGE_MAX_ROUNDS}`);
    if (!distribution.passed) for (const problem of distribution.problems) problems.push(`fact distribution: ${problem}`);
    if (state.seedPreset === 'deep') {
      const deep = seed.deepChecks ?? checkDeepFacts(seed);
      if (!deep.passed) for (const problem of deep.problems) problems.push(`deep fact: ${problem}`);
    }
  } else if (baseline < MIN_SEED_TOKENS) {
    problems.push(`seeded input estimate ${baseline} is not greater than the required ${MIN_SEED_TOKENS}`);
  }
  for (const row of rows) {
    const triggered = Boolean(row.buildStrategy) || Boolean(row.summaryPlan);
    if (!row.strategy) {
      if (bigContext) {
        if (row.buildStrategy !== 'hard') problems.push(`${state.seedPreset} off arm must hit the hard-capacity trimmer (strategy=${row.buildStrategy})`);
        if (!(row.omittedMessages > 0)) problems.push(`${state.seedPreset} off arm omitted no messages (omitted=${row.omittedMessages})`);
        if (!row.archivedRef) problems.push(`${state.seedPreset} off arm produced no archivedRef`);
      } else if (triggered || row.masked > 0 || row.omittedMessages > 0) {
        problems.push(`off arm compacted unexpectedly (strategy=${row.buildStrategy}, summaryPlan=${Boolean(row.summaryPlan)}, masked=${row.masked}, omitted=${row.omittedMessages})`);
      }
      continue;
    }
    const overBudget = row.originalInputTokens > row.workInputTokens;
    if (!overBudget) continue;
    if (row.strategy === 'summary') {
      if (!row.summaryPlan) problems.push(`summary arm did not produce a summaryPlan (original=${row.originalInputTokens}, work=${row.workInputTokens})`);
      if (row.buildStrategy === 'mask') problems.push('summary arm unexpectedly returned the mask strategy');
    } else if (row.strategy === 'mask') {
      if (bigContext) {
        if (!triggered) problems.push(`${state.seedPreset} mask arm did not trigger compaction (original=${row.originalInputTokens}, work=${row.workInputTokens})`);
      } else {
        if (row.buildStrategy !== 'mask') problems.push(`mask arm did not hide observations (strategy=${row.buildStrategy})`);
        if (!(row.masked > 0)) problems.push('mask arm hid zero observations');
        if (row.summaryPlan) problems.push('mask arm must not plan a summary');
      }
    } else if (!triggered) {
      problems.push(`hybrid arm did not trigger compaction (original=${row.originalInputTokens}, work=${row.workInputTokens})`);
    } else if (row.buildStrategy !== 'mask' && row.buildStrategy !== 'hard' && !row.summaryPlan) {
      problems.push('hybrid arm triggered without mask/hard/summaryPlan evidence');
    }
  }
  if (problems.length) throw new Error(`dry-run assertions failed:\n- ${problems.join('\n- ')}`);
}

// Static wiring verification for the non-closed phase-2 arms. It never calls a
// model and never executes a phase-2 run: it checks that the card, tools, host
// knowledge service and (knowledge mode) catalog plan can actually support the
// mode before a real --run starts. Closed mode does not call this at all.
async function checkPhase2Wiring(seed, dryRunRows = []) {
  const mode = state.phase2Mode;
  const card = phase2CardForMode();
  const expectedTools = [...card.tools];
  const problems = [];
  const archivedRows = dryRunRows.filter(row => typeof row.archivedRef === 'string' && row.archivedRef);
  const wiring = {
    mode,
    passed: false,
    card: describeCard(card),
    expectedTools,
    controls: phase2ControlPlan(),
    exposedTools: [],
    bindings: [],
    exploration: 'Application default (exploration !== false); this arm passes exploration: true explicitly for knowledge mode',
    knowledgeAvailable: false,
    knowledgeEntries: 0,
    seededEntries: 0,
    knowledgeFacts: 0,
    knowledgeSearchable: false,
    phase1ArchiveAvailable: archivedRows.length > 0,
    archivedArms: archivedRows.map(row => row.arm),
    problems,
  };
  if (JSON.stringify([...expectedTools].sort()) !== JSON.stringify(mode === 'open' ? ['history.read', 'history.search'] : ['knowledge.browse', 'knowledge.read', 'knowledge.search'])) problems.push(`${mode} card tools ${JSON.stringify(expectedTools)} do not match the frozen arm tools`);
  if (mode === 'open' && !wiring.phase1ArchiveAvailable) problems.push('open-book needs a phase-1 archived projection (no dry-run arm produced archivedRef)');
  if (mode === 'knowledge') {
    const catalogCheck = checkKnowledgeCatalog(state.knowledgeCatalog ?? buildKnowledgeCatalog());
    Object.assign(wiring, {
      knowledgeEntries: catalogCheck.entries,
      seededEntries: catalogCheck.entries,
      knowledgeFacts: catalogCheck.factsCovered,
      knowledgeExpectedFacts: catalogCheck.expectedFacts,
      knowledgeQuestions: catalogCheck.questionsCovered,
      knowledgeExpectedQuestions: catalogCheck.expectedQuestions,
      knowledgeConstraint: catalogCheck.constraintCovered,
      knowledgeSearchable: catalogCheck.summariesSearchable,
      catalogProblems: catalogCheck.problems,
    });
    for (const problem of catalogCheck.problems) problems.push(`knowledge catalog: ${problem}`);
  }
  const directory = path.join(state.root, '_dry-run', `phase2-wiring-${mode}`);
  await mkdir(directory, { recursive: true });
  const app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, mode === 'knowledge' ? { exploration: true } : {});
  try {
    const session = { permissions: ['read'] };
    wiring.exposedTools = app.coordinator.tools.specs(card.tools, session).map(spec => spec.name);
    for (const name of expectedTools) if (!wiring.exposedTools.includes(name)) problems.push(`phase-2 tool ${name} is not exposed in the request tool specs`);
    wiring.bindings = Object.keys(app.coordinator.tools.bindingSnapshot(card.tools, []));
    for (const name of expectedTools) if (!wiring.bindings.includes(name)) problems.push(`phase-2 tool ${name} has no immutable binding fingerprint`);
    wiring.knowledgeAvailable = Boolean(app.coordinator.knowledge);
    if (mode === 'knowledge' && !wiring.knowledgeAvailable) problems.push('app.coordinator.knowledge is undefined; project exploration/knowledge is required for the knowledge arm');
    if (mode === 'knowledge') for (const name of expectedTools) {
      if (!app.coordinator.tools.isRegistered(name)) problems.push(`knowledge tool ${name} is not registered by Application`);
    }
  } finally {
    await app.shutdown();
  }
  wiring.passed = problems.length === 0;
  return wiring;
}

// Static dry-run probe for the phase-2 compaction controls. It never calls a
// model: it verifies that the coordinator compaction field can be temporarily
// cleared and restored, and that the freeze window math reaches the model-declared
// context through both budget.maxContextTokens and the persisted ceilings.
async function checkPhase2ControlMechanics() {
  const plan = phase2ControlPlan();
  const problems = [];
  const directory = path.join(state.root, '_dry-run', 'phase2-controls');
  await mkdir(directory, { recursive: true });
  const app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, { compaction: { strategy: 'hybrid', workInputTokens: state.workTokens } });
  try {
    const policyBefore = app.coordinator.compaction;
    if (!policyBefore) problems.push('Application did not install the probe compaction policy');
    app.coordinator.compaction = undefined;
    const coordinatorCompactionToggleable = app.coordinator.compaction === undefined;
    app.coordinator.compaction = policyBefore;
    const coordinatorPolicyRestored = app.coordinator.compaction === policyBefore;
    if (!coordinatorCompactionToggleable) problems.push('coordinator.compaction cannot be temporarily disabled; freeze would not stop phase-2 re-compaction');
    if (!coordinatorPolicyRestored) problems.push('coordinator.compaction was not restored after the freeze probe');
    if (plan.frozen && plan.window.phase2.maxContextTokens !== plan.modelContext) problems.push(`freeze window probe ${plan.window.phase2.maxContextTokens} does not reach the model context ${plan.modelContext}`);
    if (plan.frozen && plan.window.phase2.maxOutputTokens > plan.window.before.maxOutputTokens) problems.push('freeze window probe must not raise the output reserve');
    return { passed: problems.length === 0, ...plan, coordinatorCompactionToggleable, coordinatorPolicyRestored, problems };
  } finally {
    await app.shutdown();
  }
}

function printReport(seed, coverage, rows, wiring, controls) {
  const baseline = Math.min(...rows.map(row => row.originalInputTokens));
  const distribution = seed.factDistribution;
  const distributionCheck = checkFactDistribution(distribution);
  const bigContext = state.seedPreset !== 'standard';
  const lines = [];
  lines.push('');
  lines.push('='.repeat(110));
  lines.push(state.phase2Mode === 'closed'
    ? '压缩后项目认知保持（闭卷问答）两阶段实验 — dry-run 校验（不调用真实模型）'
    : `压缩后项目认知保持（--phase2-mode ${state.phase2Mode}）两阶段实验 — dry-run 校验（不调用真实模型）`);
  lines.push('='.repeat(110));
  lines.push(`seed preset: ${state.seedPreset} | phase-1 轮次: ${seed.pageCount}（${bigContext ? `${LARGE_MIN_ROUNDS}-${LARGE_MAX_ROUNDS}` : `${MIN_SEED_ROUNDS}-${MAX_SEED_ROUNDS}`}） | 内容字符: ${seed.contentChars} | 内容 token 估算: ${seed.contentTokens}`);
  lines.push(`模型声明: context=${LIMITS.context} / output=${LIMITS.output} | run window: ${state.windowTokens} | run output budget: ${budgetForWindow().maxOutputTokens}`);
  if (bigContext) lines.push(`${state.seedPreset} seed 目标 token: ${state.seedTargetTokens} | filler 页: ${seed.fillerPageCount}（每页 ≤${seed.fillerPageChars} 字符）| 事实页 token: ${seed.factTokens} | 实际内容 token: ${seed.contentTokens}`);
  lines.push(`phase-1 seed 输入 token 估算（off arm originalInputTokens）: ${baseline}（${bigContext ? `要求 > 2×window = ${2 * state.windowTokens}` : `要求 > ${MIN_SEED_TOKENS}`}）`);
  lines.push(state.phase2Mode === 'closed'
    ? `phase-2 输入: ${QUESTIONS.length} 题闭卷问答指令，仅在 submitInput 后追加，不进入 phase-1 上下文`
    : `phase-2 mode: ${state.phase2Mode} | card: ${describeCard(phase2CardForMode()).id} (tools=${JSON.stringify([...phase2CardForMode().tools])}) | 输入: ${QUESTIONS.length} 题 + 允许的恢复/检索指令，不进入 phase-1 上下文`);
  const plan = controls ?? phase2ControlPlan();
  lines.push(`phase-2 压缩控制: ${plan.mode}${plan.frozen
    ? `（freeze：phase-2 前临时禁用 coordinator.compaction，phase-2 session window ${plan.window.before.maxContextTokens} → ${plan.window.phase2.maxContextTokens}（模型声明 context=${plan.modelContext}），phase-2 结束后恢复；预期 phase2 compaction 事件=0）`
    : `（allow：保持真实 phase-2 压缩行为，window=${plan.window.phase2.maxContextTokens}；phase2 可能再次压缩/安装摘要）`}`);
  lines.push(`phase-2 工具预算: ${plan.toolBudgetApplied ? (plan.toolBudget === null ? '0 → budget.maxToolCalls=null（不限）' : `budget.maxToolCalls=${plan.toolBudget}（open/knowledge 模式）`) : '不适用（closed 模式 card 无工具）'}`);
  if (plan.catalogSource) lines.push(`知识目录来源（catalogSource）: ${plan.catalogSource}`);
  if (controls) lines.push(`phase-2 控制静态探针（不调用模型）: coordinator.compaction 可临时禁用=${controls.coordinatorCompactionToggleable} | 之后可恢复=${controls.coordinatorPolicyRestored} | freeze window 命中模型声明=${plan.frozen ? plan.window.phase2.maxContextTokens === plan.modelContext : 'n/a'} → ${controls.passed ? 'PASS' : 'FAIL'}${controls.problems.length ? ` | PROBLEM: ${controls.problems.join('; ')}` : ''}`);
  lines.push('');
  lines.push('expected 事实覆盖（每个 expected 正则都必须命中原始事实页文本）:');
  for (const row of coverage) lines.push(`  - Q${pad(row.id, 3)} [${row.category}] ${row.passed ? 'PASS' : 'MISSING'} ${row.checks.map(check => `${check.present ? '✓' : '✗'} ${check.source}`).join(' | ')}`);
  lines.push('');
  lines.push('事实页分布（按页序号等距插入，token 位置为页中心占全序列估算 token 的比例）:');
  if (state.seedPreset === 'deep') {
    lines.push(`  ${pad('Q', 3)} | ${pad('path', 30)} | ${pad('pageIndex', 9)} | ${pad('tokenFraction', 13)} | ${pad('anchorDepth', 11)} | ${pad('targetDepth', 11)} | ${pad('markerDepth', 11)} | ${pad('chars', 6)} | ${pad('tokens', 7)} | ${pad('unique', 6)} | marker`);
    for (const row of distribution.rows) lines.push(`  ${pad(row.questionId, 3)} | ${pad(row.path, 30)} | ${pad(row.pageIndex, 9)} | ${pad(row.tokenFraction, 13)} | ${pad(row.anchorDepth, 11)} | ${pad(row.targetDepth ?? '-', 11)} | ${pad(row.markerDepth ?? '-', 11)} | ${pad(row.chars, 6)} | ${pad(row.tokens, 7)} | ${pad(row.marker ?? '-', 6)} | ${row.marker ?? '-'}`);
  } else {
    lines.push(`  ${pad('pageIndex', 10)} | ${pad('tokenFraction', 14)} | ${pad('tokens', 8)} | path`);
    for (const row of distribution.rows) lines.push(`  ${pad(row.pageIndex, 10)} | ${pad(row.tokenFraction, 14)} | ${pad(row.tokens, 8)} | ${row.path}`);
  }
  lines.push(`  检查: min=${distributionCheck.minFraction} (≤0.15) | max=${distributionCheck.maxFraction} (≥0.85) | maxGap=${distributionCheck.maxGap} (≤0.2) → ${distributionCheck.passed ? 'PASS' : 'FAIL'}`);
  if (state.seedPreset === 'deep') {
    const deep = seed.deepChecks ?? checkDeepFacts(seed);
    const matched = deep.rows.filter(row => row.expectedMatched).length;
    lines.push(`  深埋检查: expected 命中 ${matched}/${DEEP_FACT_SPECS.length} | anchorDepth min=${deep.minDepth} (≤0.3) max=${deep.maxDepth} (≥0.7) 全部∈[${DEEP_ANCHOR_DEPTH_MIN},${DEEP_ANCHOR_DEPTH_MAX}] → ${deep.passed ? 'PASS' : 'FAIL'}`);
    const uniqueMarkers = deep.markers.filter(marker => marker.unique).length;
    lines.push(`  KF 标记唯一性: ${uniqueMarkers}/${deep.markers.length} 唯一（要求每标记恰好出现在其事实页 1 次）`);
    for (const row of deep.rows) if (row.note) lines.push(`  note Q${row.questionId}: ${row.note}`);
  }
  lines.push('');
  lines.push('各 arm phase-1 压缩模拟表（问答指令不在其中）:');
  lines.push(`  ${pad('arm', 16)} | ${pad('strategy', 8)} | ${pad('workTokens', 10)} | ${pad('originalTokens', 14)} | ${pad('builtTokens', 11)} | ${pad('buildStrategy', 13)} | ${pad('masked', 6)} | ${pad('omitted', 8)} | ${pad('archivedRef', 14)} | ${pad('summaryPlan', 12)} | ${pad('targetTokens', 12)} | targetMet`);
  for (const row of rows) {
    lines.push(`  ${pad(row.arm, 16)} | ${pad(row.strategy ?? 'off', 8)} | ${pad(row.configuredWorkTokens ?? '-', 10)} | ${pad(row.originalInputTokens, 14)} | ${pad(row.estimatedInputTokens, 11)} | ${pad(row.buildStrategy ?? '-', 13)} | ${pad(row.masked, 6)} | ${pad(row.omittedMessages, 8)} | ${pad(row.archivedRef ? row.archivedRef.slice(0, 12) : '-', 14)} | ${pad(row.summaryPlan ? `${row.summaryPlan.foldMessages}/${row.summaryPlan.recentMessages}` : '-', 12)} | ${pad(row.targetTokens ?? '-', 12)} | ${row.targetMet === null ? '-' : String(row.targetMet)}`);
  }
  const off = rows.find(row => !row.strategy);
  if (bigContext && off) lines.push(`  off 硬容量证据: buildStrategy=${off.buildStrategy}, omittedMessages=${off.omittedMessages}, archivedRef=${off.archivedRef ?? 'MISSING'}`);
  if (wiring) {
    lines.push('');
    lines.push(`phase-2 ${wiring.mode} 静态接线检查（不调用真实模型）: ${wiring.passed ? 'PASS' : 'FAIL'}`);
    lines.push(`  card: ${wiring.card.id} ${wiring.card.version} | tools: ${wiring.expectedTools.join(', ')} | 请求暴露: ${wiring.exposedTools.filter(name => wiring.expectedTools.includes(name)).join(', ')}`);
    if (wiring.controls) lines.push(`  phase-2 控制: mode=${wiring.controls.mode} frozen=${wiring.controls.frozen} toolBudget=${wiring.controls.toolBudget ?? 'null'} catalogSource=${wiring.controls.catalogSource ?? '-'}`);
    lines.push(`  toolBinding 指纹: ${wiring.bindings.filter(name => wiring.expectedTools.includes(name)).join(', ')} | knowledge 可用: ${wiring.knowledgeAvailable} | exploration: ${wiring.exploration}`);
    if (wiring.mode === 'open') lines.push(`  phase-1 归档可恢复: ${wiring.phase1ArchiveAvailable} | 产出 archivedRef 的 arm: ${wiring.archivedArms.join(', ') || '-'}`);
    if (wiring.mode === 'knowledge') lines.push(`  知识目录条目: ${wiring.knowledgeEntries}（seededEntries=${wiring.seededEntries}）| KF 事实覆盖: ${wiring.knowledgeFacts}/${wiring.knowledgeExpectedFacts} | 问题覆盖: ${wiring.knowledgeQuestions}/${wiring.knowledgeExpectedQuestions}（含 Q19 约束: ${wiring.knowledgeConstraint}）| summary 可被 search 命中: ${wiring.knowledgeSearchable}`);
    for (const problem of wiring.problems) lines.push(`  PROBLEM: ${problem}`);
  }
  lines.push('');
  console.log(lines.join('\n'));
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

function zeroCompactionEvents() {
  return Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, 0]));
}

function addEventCounts(...counts) {
  return Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, counts.reduce((total, count) => total + (count?.[type] ?? 0), 0)]));
}

// context.summary.installed may carry the host's planned/covered/uncovered
// message accounting (planned = messages the summary plan wanted to fold,
// covered = messages actually summarized, uncovered = archived/hidden but not
// summarized). Older evidence may lack this field, so keep it null instead of
// inferring message coverage from unrelated counters.
function summaryCoverageFromEvent(event) {
  const coverage = event?.data?.coverage;
  const planned = Number.isSafeInteger(coverage?.plannedMessages) ? coverage.plannedMessages : null;
  const covered = Number.isSafeInteger(coverage?.coveredMessages) ? coverage.coveredMessages : null;
  const uncovered = Number.isSafeInteger(coverage?.uncoveredMessages) ? coverage.uncoveredMessages : null;
  if (planned === null || covered === null || uncovered === null) return { coverage: null, note: COVERAGE_PENDING_NOTE };
  return {
    coverage: {
      plannedMessages: planned,
      coveredMessages: covered,
      uncoveredMessages: uncovered,
      ...(Array.isArray(coverage.uncoveredOffsets) ? { uncoveredOffsets: coverage.uncoveredOffsets } : {}),
    },
    note: null,
  };
}

function installedSummaryRow(app, event, phase) {
  const { coverage, note } = summaryCoverageFromEvent(event);
  let inlineFactIds = [];
  try {
    const envelope = typeof event.data.summaryRef === 'string' ? app.store.readBlob(event.data.summaryRef) : null;
    inlineFactIds = factIdsIn(envelope?.content);
  } catch { /* preserve the installed event even if its blob cannot be inspected */ }
  return {
    phase,
    runId: event.runId,
    beforeTokens: event.data.beforeTokens ?? null,
    afterTokens: event.data.afterTokens ?? null,
    targetMet: event.data.targetMet ?? null,
    sources: event.data.sources ?? null,
    coveredMessages: Array.isArray(event.data.coveredOffsets) ? event.data.coveredOffsets.length : null,
    inlineFactIds,
    coverage,
    coverageNote: note,
  };
}

function aggregateSummaryCoverage(rows) {
  const withCoverage = rows.filter(row => row && typeof row.plannedMessages === 'number');
  if (!withCoverage.length) return { trials: 0, plannedMessages: null, coveredMessages: null, uncoveredMessages: null, note: COVERAGE_PENDING_NOTE };
  return {
    trials: withCoverage.length,
    plannedMessages: withCoverage.reduce((total, row) => total + row.plannedMessages, 0),
    coveredMessages: withCoverage.reduce((total, row) => total + row.coveredMessages, 0),
    uncoveredMessages: withCoverage.reduce((total, row) => total + row.uncoveredMessages, 0),
    note: null,
  };
}

function inspectRun(app, runId) {
  try {
    const current = app.context(runId);
    return current.error ? { available: false, error: current.error } : {
      available: true,
      estimatedInputTokens: current.estimatedInputTokens,
      parts: current.parts,
      messageCount: current.messageCount,
      hiddenObservations: current.hiddenObservations,
      latestCompaction: current.latestCompaction,
      summary: current.summary ? { present: true, ref: current.summary.ref, sources: current.summary.sources, coveredOffsets: current.summary.coveredOffsets, previousSummaryRef: current.summary.previousSummaryRef ?? null, beforeTokens: current.summary.beforeTokens, afterTokens: current.summary.afterTokens, contentChars: JSON.stringify(current.summary.content).length } : { present: false },
      usage: current.usage,
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

function runTelemetry(app, runId) {
  if (!runId) return { runId: null, events: zeroCompactionEvents(), summaryModelCalls: 0, summaryRequestFactIds: [], projectionFactIds: [], modelCalls: 0, toolCalls: 0, inspection: { available: false, error: 'run not started' } };
  let events = [];
  let calls = [];
  try {
    events = app.store.events(runId);
    calls = app.store.calls(runId);
  } catch { /* store closed: inspection reports unavailable below */ }
  const eventCounts = Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, events.filter(event => event.type === type).length]));
  const modelCalls = calls.filter(call => call.kind === 'model');
  const summaryRequestFactIds = [...new Set(modelCalls.filter(call => call.purpose === 'compaction').flatMap(call => {
    try { return factIdsIn(app.store.readBlob(call.requestRef)); } catch { return []; }
  }))].sort((left, right) => left - right);
  let projectionFactIds = [];
  try { projectionFactIds = factIdsIn(app.store.readBlob(app.store.run(runId).contextRef)); } catch { /* unavailable after a failed run */ }
  return {
    runId,
    events: eventCounts,
    summaryModelCalls: modelCalls.filter(call => call.purpose === 'compaction').length,
    summaryRequestFactIds,
    projectionFactIds,
    modelCalls: modelCalls.length,
    toolCalls: calls.filter(call => call.kind === 'tool').length,
    inspection: inspectRun(app, runId),
  };
}

// Two-phase telemetry: phase 1 records the compression pass itself, phase 2 the
// retained projection that the closed-book questions were answered from. The
// phase-1 installed summary is the coverage source for reporting which planned
// messages were summarized versus only archived/hidden.
function collectCompaction(app, phase1, phase2, arm) {
  const first = runTelemetry(app, phase1.id);
  const second = runTelemetry(app, phase2?.id);
  let installed = [];
  try {
    installed = [phase1.id, phase2?.id].filter(Boolean).flatMap(runId => app.store.events(runId).map(event => ({ runId, event }))).filter(row => row.event.type === 'context.summary.installed');
  } catch { /* keep empty */ }
  const rows = installed.map(row => installedSummaryRow(app, row.event, row.runId === phase1.id ? 'phase1' : 'phase2'));
  const latestInstalled = rows.at(-1) ?? null;
  const phase1Installed = rows.filter(row => row.phase === 'phase1').at(-1) ?? null;
  const phase2Installed = rows.filter(row => row.phase === 'phase2').at(-1) ?? null;
  return {
    policy: arm.strategy ? { strategy: arm.strategy, workInputTokens: arm.workInputTokens } : null,
    phase1: first,
    phase2: second,
    events: addEventCounts(first.events, second.events),
    summaryModelCalls: first.summaryModelCalls + second.summaryModelCalls,
    modelCalls: first.modelCalls + second.modelCalls,
    toolCalls: first.toolCalls + second.toolCalls,
    latestInstalledSummary: latestInstalled,
    installedSummaries: rows,
    installedSummaryCoverage: phase1Installed,
    phase2InstalledSummary: phase2Installed,
    factFlow: {
      expectedFactIds: [...DEEP_FACT_IDS].sort((left, right) => left - right),
      summaryRequestFactIds: first.summaryRequestFactIds,
      installedSummaryFactIds: phase1Installed?.inlineFactIds ?? [],
      retainedProjectionFactIds: first.projectionFactIds,
    },
    inspection: second.inspection,
    phase1Inspection: first.inspection,
  };
}

function failedCompaction(arm, reason) {
  const empty = () => ({ runId: null, events: zeroCompactionEvents(), summaryModelCalls: 0, summaryRequestFactIds: [], projectionFactIds: [], modelCalls: 0, toolCalls: 0, inspection: { available: false, error: reason } });
  return { policy: arm.strategy ? { strategy: arm.strategy, workInputTokens: arm.workInputTokens } : null, phase1: empty(), phase2: empty(), events: zeroCompactionEvents(), summaryModelCalls: 0, modelCalls: 0, toolCalls: 0, latestInstalledSummary: null, installedSummaries: [], installedSummaryCoverage: null, phase2InstalledSummary: null, factFlow: { expectedFactIds: [...DEEP_FACT_IDS].sort((left, right) => left - right), summaryRequestFactIds: [], installedSummaryFactIds: [], retainedProjectionFactIds: [] }, inspection: { available: false, error: reason }, phase1Inspection: { available: false, error: reason } };
}

function liveBinding(baseURL) {
  return { protocol: 'chat-completions', model: state.model, baseURL, apiKeyEnv: 'KODO_REAL_TASK_RELAY_KEY', limits: LIMITS };
}

function resultText(app, run) {
  try {
    return run?.resultRef ? String(app.store.readBlob(run.resultRef).text ?? '') : '';
  } catch {
    return '';
  }
}

// ---- phase-2 recovery / tool telemetry ----

// Mirrors runtime/context-inspection.ts: index-type reads of retained history or
// knowledge evidence count as recovery reads of the compressed projection.
const RECOVERY_TOOL_NAMES = new Set(['history.read', 'history.search', 'inspect_run', 'knowledge.read', 'knowledge.search', 'knowledge.browse']);

function emptyToolStats() {
  return { total: 0, succeeded: 0, failed: 0, cancelled: 0, byName: {}, recoveryCalls: 0, recoveredChars: 0, knowledgeSearchHits: 0, knowledgeBrowseItems: 0, errors: [] };
}

function toolResultValue(app, call) {
  try {
    return call.resultRef ? app.store.readBlob(call.resultRef) : undefined;
  } catch {
    return undefined;
  }
}

function toolResultChars(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return value.length;
  if (typeof value !== 'object') return 0;
  if (typeof value.text === 'string') return value.text.length;
  if (Array.isArray(value.messages) || Array.isArray(value.fragments)) {
    let chars = 0;
    for (const message of value.messages ?? []) chars += typeof message?.content === 'string' ? message.content.length : JSON.stringify(message).length;
    for (const fragment of value.fragments ?? []) chars += typeof fragment?.text === 'string' ? fragment.text.length : 0;
    return chars;
  }
  return JSON.stringify(value).length;
}

function collectToolStats(app, runId) {
  const stats = emptyToolStats();
  if (!runId) return stats;
  let calls;
  try { calls = app.store.calls(runId).filter(call => call.kind === 'tool'); } catch { return stats; }
  for (const call of calls) {
    const value = toolResultValue(app, call);
    const chars = toolResultChars(value);
    const row = stats.byName[call.name] ?? { calls: 0, succeeded: 0, failed: 0, cancelled: 0, resultChars: 0 };
    stats.byName[call.name] = row;
    row.calls++;
    if (call.status === 'succeeded') row.succeeded++;
    else if (call.status === 'failed') row.failed++;
    else row.cancelled++;
    row.resultChars += chars;
    stats.total++;
    if (call.status === 'succeeded' && RECOVERY_TOOL_NAMES.has(call.name)) {
      stats.recoveryCalls++;
      stats.recoveredChars += chars;
    }
    if (call.status === 'succeeded' && call.name === 'knowledge.search' && Array.isArray(value?.items)) stats.knowledgeSearchHits += value.items.length;
    if (call.status === 'succeeded' && call.name === 'knowledge.browse' && Array.isArray(value?.items)) stats.knowledgeBrowseItems += value.items.length;
    if (call.status === 'failed') stats.errors.push({ tool: call.name, error: typeof value?.error === 'string' ? value.error : null });
  }
  stats.succeeded = Object.values(stats.byName).reduce((total, row) => total + row.succeeded, 0);
  stats.failed = Object.values(stats.byName).reduce((total, row) => total + row.failed, 0);
  stats.cancelled = Object.values(stats.byName).reduce((total, row) => total + row.cancelled, 0);
  return stats;
}

// Phase-2 context for the non-closed arms: a fresh host/method/objective head
// (so the arm's card prompt is the active method), then the phase-1 terminal
// projection with only the phase-1 identity head removed, then the QA sheet.
function phase2EvidenceProjection(projection) {
  return projection.filter((message, index) => {
    if (message.role === 'system' && index === 0) return false;
    if (message.role === 'user' && typeof message.content === 'string') {
      if (message.content.startsWith('Agent method configuration')) return false;
      if (message.content === PHASE1_OBJECTIVE) return false;
    }
    return true;
  });
}

function phase2InheritedContext(workspace, run, card, objective, projection, input) {
  return [...initialContext(workspace, ['read'], card, objective, { id: run.id }), ...phase2EvidenceProjection(projection), { role: 'user', content: input }];
}

// Seed the private project knowledge catalog for one trial. This is the same
// host-owned pipeline tests/knowledge.test.ts exercises: a host-assigned
// exploration owner run in the trial workspace performs a real read-only
// file.read (recorded as a succeeded Call), then knowledge.prepare derives the
// evidence hashes/paths and knowledge.persist writes the immutable entry.
async function seedKnowledgeCatalog(app, workspace, relayBaseURL, trace) {
  const knowledge = app.coordinator.knowledge;
  if (!knowledge) throw new Error('project knowledge is unavailable; Application exploration must be enabled for --phase2-mode knowledge');
  const catalog = state.knowledgeCatalog ?? buildKnowledgeCatalog();
  const entries = [];
  for (const entry of catalog) {
    const relative = `knowledge/${entry.id}.md`;
    const absolute = path.join(workspace, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `${entry.content}\n`, 'utf8');
    const owner = app.createRun({ objective: entry.objective, workspace, binding: liveBinding(relayBaseURL), permissions: ['read'], budget: budgetForWindow(), card: KNOWLEDGE_SEED_CARD });
    app.store.updateRun(owner.id, { exploration: { questionId: entry.id, batchId: 'qa-retention-knowledge-catalog', decisionVersion: 0, consumer: 'qa-retention-knowledge', deliverable: entry.title, knowledgeRefs: [] } });
    const args = { path: relative, maxChars: MAX_KNOWLEDGE_ENTRY_CHARS, limit: 1_000 };
    const result = await app.coordinator.tools.execute(owner.id, 'file.read', args, new globalThis.AbortController().signal);
    if (!result || typeof result !== 'object' || typeof result.content !== 'string') throw new Error(`knowledge seed file.read for ${relative} returned no content`);
    if (result.content.length > MAX_KNOWLEDGE_ENTRY_CHARS) throw new Error(`knowledge seed file ${relative} exceeds the ${MAX_KNOWLEDGE_ENTRY_CHARS}-character evidence cap`);
    const request = { id: randomUUID(), name: 'file.read', arguments: JSON.stringify(args) };
    app.store.putCall({
      id: request.id, runId: owner.id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read',
      evidencePermission: 'read', decisionVersion: 0, requestRef: app.store.blob(request), resultRef: app.store.blob(result), reservedTokens: 0,
    });
    const claims = entry.facts.map(fact => ({
      text: fact.marker ? `${fact.marker}: ${fact.text}` : `Q19: ${fact.text}`,
      basis: 'source_observation',
      evidence_ids: [request.id],
    }));
    const preparedResult = JSON.stringify({ question_id: entry.id, summary: entry.summary, claims, hypotheses: [], open_questions: [] });
    const reference = knowledge.persist(knowledge.prepare(owner.id, preparedResult));
    if (reference.id !== entry.id) throw new Error(`knowledge entry id mismatch: ${reference.id} != ${entry.id}`);
    entries.push({
      id: reference.id,
      revision: reference.revision,
      ownerRunId: owner.id,
      ownerSessionId: owner.sessionId,
      evidencePath: relative,
      contentChars: entry.content.length,
      claimCount: claims.length,
      facts: entry.facts.map(fact => ({ questionId: fact.questionId, marker: fact.marker })),
    });
  }
  const summary = {
    enabled: true,
    entries: entries.length,
    facts: entries.reduce((total, entry) => total + entry.claimCount, 0),
    totalChars: entries.reduce((total, entry) => total + entry.contentChars, 0),
    entryIds: entries.map(entry => entry.id),
    revisions: entries.map(entry => entry.revision),
    evidencePaths: entries.map(entry => entry.evidencePath),
  };
  trace('qa.phase2.knowledge.seeded', summary);
  return { ...summary, entryList: entries };
}

async function runHarness(arm, workspace, directory, relayBaseURL, seedMessages) {
  const traceFile = path.join(directory, 'trace.jsonl');
  const trace = (type, data) => appendLine(traceFile, { type, time: new Date().toISOString(), ...data });
  process.env.KODO_REAL_TASK_RELAY_KEY = 'fixture-relay-key';
  let app;
  try {
    app = new Application(path.join(directory, 'kodo-state'), undefined, undefined, applicationOptions(arm));
    app.coordinator.mailbox.specs = () => [];
    app.store.subscribe(event => {
      if (TRACE_EVENT_TYPES.has(event.type)) trace(event.type, { runId: event.runId, ...event.data });
    });

    // Phase 1: compression only. The closed-book question sheet must not exist
    // yet, otherwise the auxiliary summary model answers the questions itself.
    const phase1 = app.createRun({ objective: PHASE1_OBJECTIVE, workspace, binding: liveBinding(relayBaseURL), permissions: ['read'], budget: budgetForWindow(), card: CARD });
    const initial = app.store.readBlob(phase1.contextRef);
    app.store.updateRun(phase1.id, { contextRef: app.store.blob([...initial, ...seedMessages]) });
    trace('qa.phase1.seeded', { arm: arm.name, initialMessages: initial.length, seedMessages: seedMessages.length, toolRounds: seedMessages.filter(message => message.role === 'tool').length, questionSheet: false });
    const phase1Started = Date.now();
    let phase1Final;
    try {
      phase1Final = await app.run(phase1.id);
    } catch (error) {
      phase1Final = { status: 'failed', error: error.message, resultRef: undefined };
    }
    const phase1Text = resultText(app, phase1Final);
    const phase1Ms = Date.now() - phase1Started;
    const phase1Inspection = inspectRun(app, phase1.id);
    trace('qa.phase1.finished', { status: phase1Final.status, error: phase1Final.error ?? null, textChars: phase1Text.length, executionMs: phase1Ms, estimatedInputTokens: phase1Inspection.estimatedInputTokens ?? null, hiddenObservations: phase1Inspection.hiddenObservations ?? null, summaryPresent: phase1Inspection.summary?.present ?? false });
    if (phase1Final.status !== 'completed') {
      return {
        outcome: {
          status: 'failed',
          error: `PHASE1_${phase1Final.status}: ${phase1Final.error ?? 'phase 1 did not complete'}`,
          text: '',
          executionMs: Date.now() - phase1Started,
          phase1Ms,
          phase2Ms: 0,
          runId: phase1.id,
          phase1RunId: phase1.id,
          phase1Status: phase1Final.status,
          phase1Error: phase1Final.error ?? null,
          phase1Text,
          modelCalls: 0,
          toolCalls: 0,
          phase2Mode: state.phase2Mode,
          phase2: {
            mode: state.phase2Mode,
            card: describeCard(phase2CardForMode()),
            inputChars: 0,
            inheritedMessages: 0,
            tools: emptyToolStats(),
            knowledgeSeed: null,
            failedPhase: 'phase1',
            controls: null,
          },
        },
        compaction: collectCompaction(app, phase1, null, arm),
      };
    }

    // Phase 2: the closed mode keeps the original follow-up path exactly (durable
    // user turn with app.submitInput, pin the phase-1 terminal projection into its
    // context; step=1 skips the step-0 refresh that would regenerate the follow-up
    // context from the source run). Open-book reuses the follow-up lineage because
    // history.read is only authorized along the predecessor chain, replaces the run
    // card with the read tools, and rebuilds the phase-2 context head so the arm's
    // method prompt is the active one. The knowledge catalog arm starts a fresh run
    // in the same data directory/workspace (its own session) so it cannot fall back
    // to history.read of the phase-1 projection, then pins the same projection.
    const phase2InputText = state.phase2Mode === 'closed' ? closedBookInput() : phase2InputForMode();
    const phase1Current = app.store.run(phase1.id);
    const projection = app.store.readBlob(phase1Current.contextRef).filter(message => !(message.role === 'system' && typeof message.content === 'string' && message.content.startsWith(KERNEL_STATE_PREFIX)));
    const phase2Card = phase2CardForMode();
    let qaRun;
    let inherited;
    let knowledgeSeed = null;
    if (state.phase2Mode === 'closed') {
      qaRun = app.submitInput(phase1.id, phase2InputText, { mode: 'follow_up' });
      inherited = [...projection, { role: 'user', content: phase2InputText }];
      const pending = app.store.inbox(qaRun.id);
      app.store.updateRun(qaRun.id, { contextRef: app.store.blob(inherited), step: 1, inputCursor: pending.at(-1)?.seq ?? 0 });
    } else {
      if (state.phase2Mode === 'open') {
        qaRun = app.submitInput(phase1.id, phase2InputText, { mode: 'follow_up' });
        app.registerCard(OPEN_BOOK_CARD);
        app.store.updateRun(qaRun.id, { card: OPEN_BOOK_CARD, toolBindings: app.coordinator.tools.bindingSnapshot(OPEN_BOOK_CARD.tools, []) });
      } else {
        qaRun = app.createRun({ objective: PHASE2_OBJECTIVES.knowledge, workspace, binding: liveBinding(relayBaseURL), permissions: ['read'], budget: budgetForWindow(), card: KNOWLEDGE_CARD });
        knowledgeSeed = await seedKnowledgeCatalog(app, workspace, relayBaseURL, trace);
      }
      qaRun = app.store.run(qaRun.id);
      inherited = phase2InheritedContext(workspace, qaRun, phase2Card, PHASE2_OBJECTIVES[state.phase2Mode], projection, phase2InputText);
      const pending = state.phase2Mode === 'open' ? app.store.inbox(qaRun.id) : [];
      app.store.updateRun(qaRun.id, { contextRef: app.store.blob(inherited), step: 1, ...(state.phase2Mode === 'open' ? { inputCursor: pending.at(-1)?.seq ?? 0 } : {}) });
    }
    trace('qa.phase2.inherited', {
      runId: qaRun.id,
      phase1RunId: phase1.id,
      continuationOf: qaRun.continuationOf ?? null,
      messages: inherited.length,
      hiddenObservations: inherited.filter(message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('"contextHidden":true')).length,
      summaryMarkers: inherited.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(summaryPrefix)).length,
      phase1EstimatedInputTokens: phase1Inspection.estimatedInputTokens ?? null,
      ...(state.phase2Mode === 'closed' ? {} : {
        phase2Mode: state.phase2Mode,
        card: describeCard(phase2Card),
        knowledgeEntries: knowledgeSeed?.entries ?? 0,
        phase2InputChars: phase2InputText.length,
      }),
    });
    const phase2Started = Date.now();
    let qaFinal;
    const phase2Controls = beginPhase2Controls(app, qaRun);
    trace('qa.phase2.controls', {
      runId: qaRun.id,
      sessionId: phase2Controls.sessionId,
      mode: phase2Controls.mode,
      frozen: phase2Controls.frozen,
      toolBudget: phase2Controls.toolBudget,
      toolBudgetApplied: phase2Controls.toolBudgetApplied,
      windowBefore: phase2Controls.window.before,
      windowExpected: phase2Controls.window.phase2,
      windowApplied: phase2Controls.appliedWindow,
      raisedForFreeze: phase2Controls.window.raisedForFreeze,
    });
    try {
      qaFinal = await app.run(qaRun.id);
    } catch (error) {
      qaFinal = { status: 'failed', error: error.message, resultRef: undefined };
    } finally {
      endPhase2Controls(app, phase2Controls);
    }
    const answerText = resultText(app, qaFinal);
    const phase2Ms = Date.now() - phase2Started;
    const qaInspection = inspectRun(app, qaRun.id);
    const calls = [...app.store.calls(phase1.id), ...app.store.calls(qaRun.id)];
    const phase2Tools = collectToolStats(app, qaRun.id);
    const phase2ControlsTelemetry = collectPhase2ControlTelemetry(app, qaRun, phase2Controls);
    trace('qa.phase2.finished', { runId: qaRun.id, status: qaFinal.status, error: qaFinal.error ?? null, answerChars: answerText.length, executionMs: phase2Ms, estimatedInputTokens: qaInspection.estimatedInputTokens ?? null, hiddenObservations: qaInspection.hiddenObservations ?? null, summaryPresent: qaInspection.summary?.present ?? false, phase2CompactionFrozen: phase2ControlsTelemetry.frozen, phase2CompactionEventCount: phase2ControlsTelemetry.compactionEventCount, phase2SummaryInstalled: phase2ControlsTelemetry.summaryInstalled, phase2Window: phase2ControlsTelemetry.window, phase2ToolBudget: phase2ControlsTelemetry.toolBudget });
    trace('qa.phase2.tools', {
      runId: qaRun.id,
      mode: state.phase2Mode,
      total: phase2Tools.total,
      succeeded: phase2Tools.succeeded,
      failed: phase2Tools.failed,
      cancelled: phase2Tools.cancelled,
      byName: Object.fromEntries(Object.entries(phase2Tools.byName).map(([name, value]) => [name, { calls: value.calls, succeeded: value.succeeded, failed: value.failed, resultChars: value.resultChars }])),
      recoveryCalls: phase2Tools.recoveryCalls,
      recoveredChars: phase2Tools.recoveredChars,
      knowledgeSearchHits: phase2Tools.knowledgeSearchHits,
      knowledgeBrowseItems: phase2Tools.knowledgeBrowseItems,
      toolErrors: phase2Tools.errors,
    });
    return {
      outcome: {
        status: qaFinal.status,
        error: qaFinal.error ?? null,
        text: answerText,
        executionMs: Date.now() - phase1Started,
        phase1Ms,
        phase2Ms,
        runId: qaRun.id,
        phase1RunId: phase1.id,
        phase1Status: phase1Final.status,
        phase1Error: phase1Final.error ?? null,
        phase1Text,
        modelCalls: calls.filter(call => call.kind === 'model').length,
        toolCalls: calls.filter(call => call.kind === 'tool').length,
        phase2Mode: state.phase2Mode,
        phase2: {
          mode: state.phase2Mode,
          card: describeCard(phase2Card),
          inputChars: phase2InputText.length,
          inheritedMessages: inherited.length,
          phase2InputChars: phase2InputText.length,
          tools: phase2Tools,
          recoveryReads: phase2Tools.recoveryCalls,
          recoveredChars: phase2Tools.recoveredChars,
          toolErrors: phase2Tools.errors,
          knowledgeSeed,
          controls: {
            compactionMode: phase2ControlsTelemetry.mode,
            compactionFrozen: phase2ControlsTelemetry.frozen,
            window: phase2ControlsTelemetry.window,
            toolBudget: phase2ControlsTelemetry.toolBudget,
            toolBudgetApplied: phase2ControlsTelemetry.toolBudgetApplied,
            restored: phase2ControlsTelemetry.restored,
            compactionEvents: phase2ControlsTelemetry.compactionEvents,
            compactionEventCount: phase2ControlsTelemetry.compactionEventCount,
            summaryInstalled: phase2ControlsTelemetry.summaryInstalled,
            freezeViolated: phase2ControlsTelemetry.freezeViolated,
          },
        },
      },
      compaction: collectCompaction(app, phase1, qaRun, arm),
    };
  } finally {
    try {
      if (app) await app.shutdown();
    } finally {
      delete process.env.KODO_REAL_TASK_RELAY_KEY;
    }
  }
}

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
    const markerRow = markers[index];
    if (segments.has(markerRow.id)) continue;
    const end = index + 1 < markers.length ? markers[index + 1].start : lines.length;
    const paragraph = [markerRow.rest, ...lines.slice(markerRow.start + 1, end)].join('\n').trim();
    segments.set(markerRow.id, paragraph);
  }
  return segments;
}

function scoreAnswers(text) {
  const segments = parseAnswerSegments(text);
  const questions = QUESTIONS.map(original => {
    const question = questionForRun(original);
    const answer = segments.get(question.id) ?? '';
    const normalized = answer.replace(/\s+/g, ' ').trim();
    const unknown = /^unknown\b/i.test(normalized);
    const checks = question.expected.map(source => ({ source, passed: new RegExp(source).test(normalized) }));
    const pass = Boolean(normalized) && !unknown && checks.every(check => check.passed);
    return { id: question.id, category: question.category, prompt: question.prompt, answer, pass, checks, missing: checks.filter(check => !check.passed).map(check => check.source) };
  });
  const summarize = list => ({ passed: list.filter(question => question.pass).length, total: list.length, rate: list.length ? Number((list.filter(question => question.pass).length / list.length).toFixed(4)) : null });
  const overall = summarize(questions);
  const byCategory = Object.fromEntries(CATEGORY_ORDER.map(category => [category, summarize(questions.filter(question => question.category === category))]));
  return { questions, passed: overall.passed, total: overall.total, rate: overall.rate, byCategory };
}

async function trialExecution(arm, repeat, seedMessages) {
  const id = `${arm.name}--r${repeat}`;
  const directory = path.join(state.root, id);
  const workspace = path.join(directory, 'workspace');
  await mkdir(directory);
  await mkdir(workspace);
  await writeFile(path.join(directory, 'trace.jsonl'), '');
  const wireDirectory = path.join(directory, 'wire');
  await mkdir(wireDirectory);
  const relay = await createBudgetRelay({ directory: wireDirectory, upstream: state.upstream, key: state.secret, model: state.model, maxContextChars: Number.MAX_SAFE_INTEGER, maxOutputTokens: LIMITS.output, unrestricted: true });
  let execution;
  const started = Date.now();
  try {
    execution = await runHarness(arm, workspace, directory, relay.baseURL, seedMessages);
  } catch (error) {
    execution = {
      outcome: {
        status: 'failed', error: error.message, text: '', executionMs: Date.now() - started, runId: null, modelCalls: 0, toolCalls: 0,
        phase2Mode: state.phase2Mode,
        phase2: { mode: state.phase2Mode, card: describeCard(phase2CardForMode()), inputChars: 0, inheritedMessages: 0, tools: emptyToolStats(), knowledgeSeed: null, failedPhase: 'harness' },
      },
      compaction: failedCompaction(arm, 'trial failed before inspection'),
    };
  } finally {
    await relay.close();
  }
  const wireStats = globalThis.structuredClone(relay.stats);
  const usage = usageScorecard(wireStats);
  const scored = scoreAnswers(execution.outcome.text);
  const compaction = execution.compaction;
  const correctFactIds = scored.questions.filter(question => question.pass && DEEP_FACT_IDS.has(question.id)).map(question => question.id);
  const phase2 = execution.outcome.phase2 ?? {
    mode: state.phase2Mode,
    card: describeCard(phase2CardForMode()),
    inputChars: 0,
    inheritedMessages: 0,
    tools: emptyToolStats(),
    knowledgeSeed: null,
    controls: null,
  };
  const phase2Plan = phase2ControlPlan();
  const phase2Controls = phase2.controls ?? null;
  const phase2Events = compaction.phase2?.events ?? zeroCompactionEvents();
  const phase2EventCount = Object.values(phase2Events).reduce((total, value) => total + value, 0);
  const phase2SummaryInstalled = phase2Events['context.summary.installed'] ?? 0;
  const phase2InstalledSummary = compaction.phase2InstalledSummary ?? null;
  const installedSummaryCoverage = compaction.installedSummaryCoverage ?? null;
  const phase2CompactionFrozen = phase2Controls?.compactionFrozen ?? phase2Plan.frozen;
  const phase2ToolBudgetExhausted = /TOOL_BUDGET/.test(String(execution.outcome.error ?? ''));
  const row = {
    id,
    arm: arm.name,
    strategy: arm.strategy,
    workInputTokens: arm.workInputTokens,
    repeat,
    workspace,
    directory: path.relative(state.root, directory),
    status: execution.outcome.status,
    error: execution.outcome.error ?? null,
    phase1Status: execution.outcome.phase1Status ?? null,
    phase2Status: execution.outcome.status,
    phase1Error: execution.outcome.phase1Error ?? null,
    answerText: execution.outcome.text,
    phase1Text: execution.outcome.phase1Text ?? '',
    answers: scored.questions,
    accuracy: { passed: scored.passed, total: scored.total, rate: scored.rate, byCategory: scored.byCategory },
    usage,
    requests: wireStats.requests,
    phase1Requests: compaction.phase1.modelCalls,
    phase2Requests: compaction.phase2.modelCalls,
    compaction,
    factFlow: {
      ...compaction.factFlow,
      correctFactIds,
      rates: {
        summaryRequest: Number((compaction.factFlow.summaryRequestFactIds.length / DEEP_FACT_IDS.size).toFixed(4)),
        installedSummary: Number((compaction.factFlow.installedSummaryFactIds.length / DEEP_FACT_IDS.size).toFixed(4)),
        retainedProjection: Number((compaction.factFlow.retainedProjectionFactIds.length / DEEP_FACT_IDS.size).toFixed(4)),
        closedBookCorrect: Number((correctFactIds.length / DEEP_FACT_IDS.size).toFixed(4)),
      },
    },
    phase2Mode: state.phase2Mode,
    phase2,
    phase2CompactionMode: phase2Plan.mode,
    phase2CompactionFrozen,
    phase2Window: phase2Controls?.window ?? {
      before: phase2Plan.window.before,
      expected: phase2Plan.window.phase2,
      applied: phase2Plan.window.phase2,
      raisedForFreeze: phase2Plan.window.raisedForFreeze,
    },
    phase2ToolBudget: phase2Controls?.toolBudget ?? phase2Plan.toolBudget,
    phase2ToolBudgetApplied: phase2Controls?.toolBudgetApplied ?? phase2Plan.toolBudgetApplied,
    phase2ToolBudgetExhausted,
    phase2CompactionEvents: phase2Events,
    phase2CompactionEventCount: phase2EventCount,
    phase2FreezeViolated: phase2CompactionFrozen && phase2EventCount > 0,
    phase2SummaryInstalled,
    phase2SummaryCoverage: phase2InstalledSummary?.coverage ?? null,
    phase2SummaryCoverageNote: phase2InstalledSummary ? phase2InstalledSummary.coverageNote : (phase2CompactionFrozen ? 'not expected under phase-2 freeze' : 'no phase-2 summary installed'),
    summaryCoverage: installedSummaryCoverage?.coverage ?? null,
    summaryCoverageNote: installedSummaryCoverage ? installedSummaryCoverage.coverageNote : 'no summary installed',
    recoveryReads: phase2.tools?.recoveryCalls ?? 0,
    recoveredChars: phase2.tools?.recoveredChars ?? 0,
    toolErrors: phase2.tools?.errors ?? [],
    phase1Ms: execution.outcome.phase1Ms ?? null,
    phase2Ms: execution.outcome.phase2Ms ?? null,
    executionMs: execution.outcome.executionMs ?? Date.now() - started,
    createdAt: new Date().toISOString(),
  };
  await writeJson(path.join(directory, 'result.json'), row);
  await writeFile(path.join(directory, 'answer.txt'), `${redact(execution.outcome.text)}\n`);
  await writeJson(path.join(directory, 'outcome.json'), { ...execution.outcome, delivery: execution.outcome.delivery ?? null });
  appendLine(state.eventsPath, {
    event: 'trial',
    id,
    arm: row.arm,
    strategy: row.strategy,
    workInputTokens: row.workInputTokens,
    repeat,
    status: row.status,
    phase1Status: row.phase1Status,
    phase2Status: row.phase2Status,
    accuracy: { passed: row.accuracy.passed, total: row.accuracy.total, rate: row.accuracy.rate },
    requests: row.requests,
    phase1Requests: row.phase1Requests,
    phase2Requests: row.phase2Requests,
    usage: { input: usage.input, output: usage.output, estimatedCny: usage.estimatedCny },
    phase1CompactionEvents: compaction.phase1.events,
    phase2CompactionEvents: phase2Events,
    compactionEvents: compaction.events,
    phase2CompactionFrozen,
    phase2CompactionEventCount: phase2EventCount,
    phase2FreezeViolated: row.phase2FreezeViolated,
    phase2SummaryInstalled,
    phase2Window: row.phase2Window,
    phase2ToolBudget: row.phase2ToolBudget,
    phase2ToolBudgetExhausted,
    summaryCoverage: row.summaryCoverage,
    summaryCoverageNote: row.summaryCoverageNote,
    phase2SummaryCoverage: row.phase2SummaryCoverage,
    phase2SummaryCoverageNote: row.phase2SummaryCoverageNote,
    summaryModelCalls: compaction.summaryModelCalls,
    phase1SummaryModelCalls: compaction.phase1.summaryModelCalls,
    phase2SummaryModelCalls: compaction.phase2.summaryModelCalls,
    hiddenObservations: compaction.inspection?.hiddenObservations ?? null,
    phase1HiddenObservations: compaction.phase1Inspection?.hiddenObservations ?? null,
    peakInput: compaction.inspection?.usage?.peakInput ?? null,
    estimatedPeakInput: compaction.inspection?.usage?.estimatedPeakInput ?? null,
    phase2Mode: state.phase2Mode,
    phase2ToolCalls: phase2.tools?.total ?? 0,
    phase2ToolCallsByName: phase2.tools?.byName ?? {},
    phase2ToolFailures: phase2.tools?.failed ?? 0,
    phase2RecoveryReads: phase2.tools?.recoveryCalls ?? 0,
    phase2RecoveredChars: phase2.tools?.recoveredChars ?? 0,
    phase2KnowledgeSearchHits: phase2.tools?.knowledgeSearchHits ?? 0,
    phase2KnowledgeBrowseItems: phase2.tools?.knowledgeBrowseItems ?? 0,
    phase2ToolErrors: phase2.tools?.errors ?? [],
    knowledgeSeedEntries: phase2.knowledgeSeed?.entries ?? 0,
    executionMs: row.executionMs,
    error: row.error,
  });
  return row;
}

function summarizeChecks(checks) {
  const passed = checks.filter(check => check.pass).length;
  return { passed, total: checks.length, rate: checks.length ? Number((passed / checks.length).toFixed(4)) : null };
}

function summarizeRows(rows) {
  const phase2Plan = phase2ControlPlan();
  const armSummaries = state.arms.map(arm => {
    const armRows = rows.filter(row => row.arm === arm.name);
    const attempts = armRows.length;
    const checks = armRows.flatMap(row => row.answers);
    const sum = selector => armRows.reduce((total, row) => total + (selector(row) ?? 0), 0);
    const countPerType = selector => Object.fromEntries(COMPACTION_EVENT_TYPES.map(type => [type, sum(row => selector(row)?.[type] ?? 0)]));
    const phase1InstalledRows = armRows.filter(row => (row.compaction?.phase1?.events?.['context.summary.installed'] ?? 0) > 0);
    const phase2InstalledRows = armRows.filter(row => (row.compaction?.phase2?.events?.['context.summary.installed'] ?? 0) > 0);
    const phase2RecompactionRows = armRows.filter(row => (row.phase2CompactionEventCount ?? 0) > 0);
    const phase1CoverageRows = armRows.filter(row => row.summaryCoverage);
    const phase2CoverageRows = armRows.filter(row => row.phase2SummaryCoverage);
    const rates = armRows.map(row => row.accuracy?.rate).filter(value => typeof value === 'number');
    return {
      arm: arm.name,
      strategy: arm.strategy,
      workInputTokens: arm.workInputTokens,
      attempts,
      completed: armRows.filter(row => row.status === 'completed').length,
      failed: armRows.filter(row => row.status !== 'completed').length,
      accuracy: {
        overall: summarizeChecks(checks),
        meanTrialRate: mean(rates),
        byCategory: Object.fromEntries(CATEGORY_ORDER.map(category => [category, summarizeChecks(checks.filter(check => check.category === category))])),
      },
      perQuestion: QUESTIONS.map(question => ({ id: question.id, category: question.category, ...summarizeChecks(checks.filter(check => check.id === question.id)) })),
      tokens: {
        requests: sum(row => row.usage?.requests),
        input: sum(row => row.usage?.input),
        output: sum(row => row.usage?.output),
        total: sum(row => row.usage?.total),
        cached: sum(row => row.usage?.cached),
        estimatedCny: { low: sum(row => row.usage?.estimatedCny?.low), high: sum(row => row.usage?.estimatedCny?.high), complete: armRows.every(row => row.usage?.usageComplete !== false) },
      },
      compaction: {
        events: countPerType(row => row.compaction?.events),
        phase1Events: countPerType(row => row.compaction?.phase1?.events),
        phase2Events: countPerType(row => row.compaction?.phase2?.events),
        trialsWithCompaction: armRows.filter(row => Object.values(row.compaction?.events ?? {}).some(value => value > 0)).length,
        trialsWithInstalledSummary: phase1InstalledRows.length,
        trialsWithInstalledSummaryPhase2: phase2InstalledRows.length,
        summaryModelCalls: sum(row => row.compaction?.summaryModelCalls),
        phase1SummaryModelCalls: sum(row => row.compaction?.phase1?.summaryModelCalls),
        phase2SummaryModelCalls: sum(row => row.compaction?.phase2?.summaryModelCalls),
        maxHiddenObservations: Math.max(0, ...armRows.map(row => row.compaction?.inspection?.hiddenObservations ?? 0)),
        meanHiddenObservations: mean(armRows.map(row => row.compaction?.inspection?.hiddenObservations ?? 0)),
        phase1MaxHiddenObservations: Math.max(0, ...armRows.map(row => row.compaction?.phase1Inspection?.hiddenObservations ?? 0)),
        maxPeakInput: Math.max(0, ...armRows.map(row => row.compaction?.inspection?.usage?.peakInput ?? 0)),
        meanEstimatedPeakInput: mean(armRows.map(row => row.compaction?.inspection?.usage?.estimatedPeakInput ?? 0)),
        phase1MaxPeakInput: Math.max(0, ...armRows.map(row => row.compaction?.phase1Inspection?.usage?.peakInput ?? 0)),
        phase1MeanEstimatedPeakInput: mean(armRows.map(row => row.compaction?.phase1Inspection?.usage?.estimatedPeakInput ?? 0)),
        phase2RecompactionTrials: phase2RecompactionRows.length,
        phase2RecompactionEvents: sum(row => row.phase2CompactionEventCount ?? 0),
        phase2SummaryInstalledCount: sum(row => row.phase2SummaryInstalled ?? 0),
        phase2FreezeViolations: armRows.filter(row => row.phase2FreezeViolated).length,
        coverage: {
          source: 'context.summary.installed',
          phase1: aggregateSummaryCoverage(phase1CoverageRows.map(row => row.summaryCoverage)),
          phase2: aggregateSummaryCoverage(phase2CoverageRows.map(row => row.phase2SummaryCoverage)),
          pendingNote: COVERAGE_PENDING_NOTE,
        },
      },
      factFlow: {
        denominatorPerTrial: DEEP_FACT_IDS.size,
        trials: armRows.map(row => ({ id: row.id, ...row.factFlow })),
        meanRates: Object.fromEntries(['summaryRequest', 'installedSummary', 'retainedProjection', 'closedBookCorrect'].map(key => [key, mean(armRows.map(row => row.factFlow?.rates?.[key]).filter(value => typeof value === 'number'))])),
      },
      accuracyWithInstalledSummary: phase1InstalledRows.length ? summarizeChecks(phase1InstalledRows.flatMap(row => row.answers)) : null,
      phase2: {
        mode: state.phase2Mode,
        toolCalls: sum(row => row.phase2?.tools?.total ?? 0),
        succeededToolCalls: sum(row => row.phase2?.tools?.succeeded ?? 0),
        failedToolCalls: sum(row => row.phase2?.tools?.failed ?? 0),
        cancelledToolCalls: sum(row => row.phase2?.tools?.cancelled ?? 0),
        toolCallsByName: mergePhase2ToolCounts(armRows),
        recoveryReads: sum(row => row.phase2?.tools?.recoveryCalls ?? 0),
        recoveredChars: sum(row => row.phase2?.tools?.recoveredChars ?? 0),
        knowledgeSearchHits: sum(row => row.phase2?.tools?.knowledgeSearchHits ?? 0),
        knowledgeBrowseItems: sum(row => row.phase2?.tools?.knowledgeBrowseItems ?? 0),
        toolErrors: armRows.flatMap(row => row.phase2?.tools?.errors ?? []),
        seededEntries: Math.max(0, ...armRows.map(row => row.phase2?.knowledgeSeed?.entries ?? 0)),
        seededFacts: Math.max(0, ...armRows.map(row => row.phase2?.knowledgeSeed?.facts ?? 0)),
        trialsWithToolCalls: armRows.filter(row => (row.phase2?.tools?.total ?? 0) > 0).length,
        compactionMode: phase2Plan.mode,
        compactionFrozen: phase2Plan.frozen,
        recompactionTrials: phase2RecompactionRows.length,
        recompactionEventCount: sum(row => row.phase2CompactionEventCount ?? 0),
        summaryInstalledCount: sum(row => row.phase2SummaryInstalled ?? 0),
        freezeViolations: armRows.filter(row => row.phase2FreezeViolated).length,
        window: phase2Plan.window,
        toolBudget: phase2Plan.toolBudget,
        toolBudgetApplied: phase2Plan.toolBudgetApplied,
        toolBudgetExhaustedTrials: armRows.filter(row => row.phase2ToolBudgetExhausted).length,
        summaryCoverage: aggregateSummaryCoverage(phase2CoverageRows.map(row => row.phase2SummaryCoverage)),
      },
      durationMs: { mean: mean(armRows.map(row => row.executionMs)), total: sum(row => row.executionMs), phase1Mean: mean(armRows.map(row => row.phase1Ms)), phase2Mean: mean(armRows.map(row => row.phase2Ms)) },
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    phase2Mode: state.phase2Mode,
    phase2Compaction: state.phase2Compaction,
    phase2ToolBudget: phase2Plan.toolBudget,
    phase2CatalogSource: phase2Plan.catalogSource,
    phase2Controls: phase2Plan,
    coverageTelemetry: { source: 'context.summary.installed', pendingNote: COVERAGE_PENDING_NOTE },
    attempts: rows.length,
    questions: QUESTIONS.map(question => { const effective = phase2Question(question); return { id: question.id, category: question.category, prompt: effective.prompt, expected: effective.expected }; }),
    arms: armSummaries,
    caveats: [
      state.phase2Mode === 'closed'
        ? '两阶段设计：phase-1 只包含真实 file.read 证据与早期用户约束，问答指令/20 题只在 phase-2 的 submitInput 输入中出现；因此 phase-1 的摘要模型不会再看到题目并直接答题。'
        : `两阶段设计：phase-1 只包含真实 file.read 证据与早期用户约束，问答指令/20 题只在 phase-2 的 ${state.phase2Mode} 模式输入中出现；因此 phase-1 的摘要模型不会再看到题目并直接答题。`,
      state.phase2Mode === 'closed'
        ? 'phase-2 继承（closed）：产品 follow-up 路径只携带用户约束与归档指针（不含工具投影），所以脚本在 submitInput 之后显式把 phase-1 终态投影写入 qaRun.contextRef，并以 step=1 跳过 step-0 的 follow-up 重算；qaRun 的 inspection 才是被评分的“保留上下文”。'
        : `phase-2 输入（${state.phase2Mode}）：phase-2 使用 phase-1 终态投影重建上下文，并换成 ${describeCard(phase2CardForMode()).id} 运行卡（tools=${JSON.stringify([...phase2CardForMode().tools])}）。open 模式沿用 follow-up 血缘以便 history.read 授权；knowledge 模式使用独立 session（不能 fallback 到 history.read）并预先在 trial workspace 写入 5 个知识目录条目。`,
      'summary/hybrid 只有在 phase-1 摘要实际安装后才压缩；摘要失败/跳过时保留原投影（summary 策略即全量上下文），因此需同时看 trialsWithInstalledSummary 与 accuracyWithInstalledSummary。',
      'mask 与 hybrid@65536 在这批 seed 上可能保留相同投影：既有实现总是保留最后一个非 pinned 完整轮次，且遮罩后估算已低于 64k 工作预算，不再触发二级摘要。',
      state.phase2Mode === 'closed'
        ? phase2CompactionFrozen()
          ? '预期模型请求数/每次 trial（freeze）：off、mask、hybrid@65536 = phase-1 主调用 1 + phase-2 主调用 1 = 2；summary@16384、summary@65536、hybrid（16384）= phase-1（摘要 + 主调用，摘要失败通常也仍发主调用）2 + phase-2 1 = 3。freeze 下 phase-2 不再触发压缩/摘要，phase2Events 应为 0。'
          : '预期模型请求数/每次 trial（allow）：off、mask、hybrid@65536 = phase-1 主调用 1 + phase-2 主调用 1 = 2；summary@16384、summary@65536、hybrid（16384）= phase-1（摘要 + 主调用，摘要失败通常也仍发主调用）2 + phase-2 1 = 3。allow 下若 phase-1 摘要失败，hybrid 在 phase-2 仍可能再次尝试摘要（phase2Events 可见，会额外增加请求）。'
        : phase2CompactionFrozen()
          ? '预期模型请求数/每次 trial（freeze）：off、mask、hybrid@65536 = phase-1 主调用 1 + phase-2 主调用 1（每次工具轮再 +1）；summary@16384、summary@65536、hybrid（16384）= phase-1（摘要 + 主调用，摘要失败通常也仍发主调用）2 + phase-2 主调用 1（每次工具轮再 +1）。freeze 下 phase-2 不再触发压缩/摘要，phase2Events 应为 0。'
          : '预期模型请求数/每次 trial（allow）：off、mask、hybrid@65536 = phase-1 主调用 1 + phase-2 主调用 1（每次工具轮再 +1）；summary@16384、summary@65536、hybrid（16384）= phase-1（摘要 + 主调用，摘要失败通常也仍发主调用）2 + phase-2 主调用 1（每次工具轮再 +1）。allow 下若 phase-1 摘要失败，hybrid 在 phase-2 仍可能再次尝试摘要（phase2Events 可见，会额外增加请求）。',
      'large preset 下 off 由旧版硬容量裁剪兜底（phase-1 即 context.compacted/hard/omittedMessages>0）；summary:65536 的摘要请求容量接近窗口上限时可能只能覆盖部分历史或安装失败，这属真实行为，按 phase1Events 与 trialsWithInstalledSummary 解读。',
      'deep preset 把每题答案锚点埋在 18000–22000 字符真实文件页的中部（目标深度按题号 0.25→0.75），19 页等距分布；off 的 1600/640/256 字符头尾摘录理论上取不到中段事实，若 off 仍高应检查其保留的完整近期轮次是否恰好包含某事实页。deep 下 Q1/Q3/Q5/Q8 的 expected 增加了源码拼写备选（65_536/16_384/60_000/two folder levels），原备选保留，评分只放宽不收紧。Q4 的摘要输出预算内容上限已按当前源码 min(8192, 8%×H, output) 收紧为 8192（历史 4096 上限已在大上下文真实实验后上调；旧 expected 与源码冲突，已移除）。',
      phase2CompactionFrozen()
        ? 'phase-2 压缩控制（freeze，默认）：phase-2 开始前临时禁用 coordinator.compaction 并把 phase-2 session 窗口提升到模型声明的 1,000,000 context（同时提升持久化的 modelBudgetCeilings，避免 runBudget 仍按旧窗口钳制），phase-2 结束后恢复预算与策略。因此 phase2CompactionEvents 应全为 0、phase2SummaryInstalled 应为 0，准确率衡量的是“单次 phase-1 压缩后的投影保留”，不会被 phase-2 二次摘要污染；若 phase2Events 非 0 则 phase2FreezeViolated=true，该 trial 的保留率测量不可信。'
        : 'phase-2 压缩控制（allow）：保持真实产品行为，phase-2 仍可能再次压缩/安装摘要；phase2CompactionEvents、phase2SummaryInstalled 与 phase2RecompactionTrials 用于把“二次压缩”与准确率一起解读。',
      phase2ToolsEnabled()
        ? `phase-2 工具预算：open/knowledge 模式 phase-2 session budget.maxToolCalls = ${phase2Plan.toolBudget === null ? 'null（--phase2-max-tool-calls 0，表示不限）' : phase2Plan.toolBudget}；超限按现有产品行为以 TOOL_BUDGET 结束该 run，防止工具循环耗尽会话 TIME_BUDGET。phase2ToolBudgetExhausted 标记该 trial 是否撞到上限。`
        : 'phase-2 工具预算：closed 模式 phase-2 card 无工具，不设置 tool budget。',
      '摘要覆盖率遥测：脚本从 context.summary.installed 事件读取 coverage.plannedMessages/coveredMessages/uncoveredMessages（覆盖“拟折叠/实际总结/只归档隐藏”的归因）；旧证据缺字段时保持 null，不用其它字段猜测。deep preset 另按 KF 标记记录进入摘要请求、进入安装摘要、保留投影可见及闭卷答对四段转化。',
      ...(state.phase2Mode === 'knowledge' ? [
        `knowledge 模式的知识目录来源：${CATALOG_SOURCE}——条目由脚本用真实 file.read 证据手工种子并落库，是“读取正控制”，不代表生产目录构建质量。`,
      ] : []),
      ...(state.phase2Mode === 'open' ? [
        'open 模式记录 history.read/history.search 的调用次数、成功/失败、恢复读取字符数与工具错误（phase2.tools）；评分只要求答案含 KF 标记与事实值，因此工具是否真的被使用、恢复多少原文、每次 trial 的 phase-2 usage/耗时都需要与准确率一起解读。',
      ] : []),
      ...(state.phase2Mode === 'knowledge' ? [
        'knowledge 模式的目录条目来自 trial workspace 中的 fact 文件：先创建 exploration owner run、执行真实 file.read 并 putCall，再 knowledge.prepare/persist；条目覆盖 19 个 KF 事实（5 条，Q19 约束也入库）。phase-2 运行使用独立 session，因此 history.read 不能回读 phase-1 投影；准确率衡量“目录检索”路径，phase2.tools 记录 browse/search/read 调用与命中。',
      ] : []),
      state.phase2Mode === 'closed'
        ? '准确率只衡量保留上下文的闭卷回忆，不代表压缩的完整交付质量或成本收益；样本量小（repeats ≤ 3），仅作描述性对比。'
        : `准确率衡量 ${state.phase2Mode} 模式下保留上下文 + 允许的恢复/检索路径的综合效果，不代表压缩的完整交付质量或成本收益；样本量小（repeats ≤ 3），仅作描述性对比。`,
    ],
  };
}

function mergePhase2ToolCounts(rows) {
  const merged = {};
  for (const row of rows) for (const [name, value] of Object.entries(row.phase2?.tools?.byName ?? {})) {
    const target = merged[name] ?? { calls: 0, succeeded: 0, failed: 0, cancelled: 0, resultChars: 0 };
    target.calls += value.calls ?? 0;
    target.succeeded += value.succeeded ?? 0;
    target.failed += value.failed ?? 0;
    target.cancelled += value.cancelled ?? 0;
    target.resultChars += value.resultChars ?? 0;
    merged[name] = target;
  }
  return merged;
}

async function writeRootOutputs(rows) {
  const summary = summarizeRows(rows);
  const includeAnswers = state.includeAnswers;
  const results = rows.map(row => ({
    ...row,
    answerText: includeAnswers ? row.answerText : undefined,
    phase1Text: includeAnswers ? row.phase1Text : undefined,
    answers: row.answers.map(answer => ({ id: answer.id, category: answer.category, pass: answer.pass, checks: answer.checks, ...(includeAnswers ? { answer: answer.answer } : {}) })),
  }));
  await writeJson(path.join(state.root, 'results.json'), {
    evaluationVersion: EVALUATION_VERSION,
    createdAt: state.createdAt,
    phase2Mode: state.phase2Mode,
    phase2Compaction: state.phase2Compaction,
    phase2ToolBudget: phase2ControlPlan().toolBudget,
    phase2CatalogSource: phase2ControlPlan().catalogSource,
    model: state.model,
    provider: state.provider,
    upstream: state.upstream ?? null,
    sourceHash: state.sourceHash,
    seedPreset: state.seedPreset,
    seedTargetTokens: state.seedTargetTokens,
    seedTokens: state.seed?.contentTokens ?? null,
    seedRounds: state.seed?.pageCount ?? null,
    windowTokens: state.windowTokens,
    factDistribution: state.seed?.factDistribution ?? null,
    factPages: state.seed?.factDistribution?.rows ?? null,
    deepChecks: state.seed?.deepChecks ?? null,
    arms: state.arms.map(describeArm),
    results,
    summary,
  });
  await writeJson(path.join(state.root, 'summary.json'), summary);
}

async function writeManifest(seed, coverage, dryRunRows, wiring, phase2Controls) {
  const phase2Plan = phase2Controls ?? phase2ControlPlan();
  const phase2Common = {
    compactionMode: phase2Plan.mode,
    compactionFrozen: phase2Plan.frozen,
    sessionWindow: phase2Plan.window,
    toolBudget: phase2Plan.toolBudget,
    toolBudgetApplied: phase2Plan.toolBudgetApplied,
    catalogSource: phase2Plan.catalogSource,
    catalogSourceNote: phase2Plan.catalogSource ? '知识目录由脚本用真实 file.read 证据手工种子并落库（读取正控制），不代表生产目录构建质量。' : null,
  };
  const manifest = {
    evaluationVersion: EVALUATION_VERSION,
    mode: state.runMode ? 'run' : 'dry-run',
    createdAt: state.createdAt,
    phase2Mode: state.phase2Mode,
    phase2Compaction: phase2Plan.mode,
    phase2CompactionFrozen: phase2Plan.frozen,
    phase2ToolBudget: phase2Plan.toolBudget,
    phase2CatalogSource: phase2Plan.catalogSource,
    model: state.model,
    provider: state.provider,
    upstream: state.upstream ?? null,
    sourceHash: state.sourceHash,
    seedPreset: state.seedPreset,
    seedTargetTokens: state.seedTargetTokens,
    seedTokens: seed.contentTokens,
    seedRounds: seed.pageCount,
    windowTokens: state.windowTokens,
    outputTokens: budgetForWindow().maxOutputTokens,
    factDistribution: seed.factDistribution,
    factPages: seed.factDistribution.rows,
    deepChecks: seed.deepChecks ?? null,
    seed: {
      phase: 'phase-1（压缩）：真实文件证据 + 早期用户约束，不含问答指令/问题',
      preset: state.seedPreset,
      targetTokens: state.seedTargetTokens,
      pages: seed.pages.map(page => ({ path: page.path, offset: page.offset, end: page.end, total: page.total, chars: page.chars, tokens: page.tokens, kind: page.kind, questionId: page.questionId ?? null, anchor: page.anchor ?? null, anchorDepth: page.anchorDepth ?? null, hash: page.hash })),
      rounds: seed.pageCount,
      contentChars: seed.contentChars,
      contentTokens: seed.contentTokens,
      factTokens: seed.factTokens,
      fillerPageCount: seed.fillerPageCount ?? 0,
      fillerPageChars: seed.fillerPageChars ?? null,
      factDistribution: seed.factDistribution,
      deepChecks: seed.deepChecks ?? null,
      constraint: CONSTRAINT_TEXT,
      questionSheetIncluded: false,
    },
    phases: {
      phase1: { objective: PHASE1_OBJECTIVE, description: '只做压缩/摘要安装；app.run(phase1.id) 触发 prepareContext。' },
      phase2: state.phase2Mode === 'closed' ? {
        description: 'app.submitInput(phase1.id, QA_TEXT, { mode: "follow_up" }) 创建后续运行，再 app.run(qaRun.id)；QA_TEXT 含 20 题闭卷指令，仅此处出现。',
        inheritance: 'follow-up 产品路径只携带约束与归档指针，脚本显式把 phase-1 终态投影写入 qaRun.contextRef（step=1 跳过 step-0 重算）后再执行。',
        questionSheet: closedBookInput(),
        ...phase2Common,
      } : {
        mode: state.phase2Mode,
        card: describeCard(phase2CardForMode()),
        ...phase2Common,
        description: state.phase2Mode === 'open'
          ? 'open-book：沿用 phase-1 的 follow-up 血缘（history.read 仅沿 predecessor chain 授权），但运行卡换成允许 history.read/history.search 的卡；上下文 = phase-2 卡的方法/目标头 + phase-1 终态投影（去掉 phase-1 身份头）+ 开卷 QA 指令。'
          : 'knowledge-catalog：在 trial workspace 中先按 tests/knowledge.test.ts 的管线写入 5 个知识目录条目（exploration owner run → 真实 file.read → putCall → knowledge.prepare/persist），再由独立 session 的 phase-2 运行（无法 fallback 到 history.read）读取投影 + QA 指令，允许 knowledge.browse/search/read。',
        inheritance: state.phase2Mode === 'open'
          ? 'qaRun = app.submitInput(phase1.id, QA_TEXT, { mode: "follow_up" }) 后更新 card/toolBindings；contextRef = initialContext(open card) + phase-1 终态投影（过滤 phase-1 host/method/objective 头）+ QA_TEXT；step=1 跳过 step-0 follow-up 重算。'
          : 'qaRun = app.createRun({ objective: PHASE2_OBJECTIVES.knowledge, workspace, permissions:["read"], card: knowledge card })（独立 session，防止 history.read 回读 phase-1 投影）；contextRef = initialContext(knowledge card) + phase-1 终态投影（过滤 phase-1 身份头）+ QA_TEXT；知识条目在同一 Application/workspace 中先落库。',
        questionSheet: phase2InputForMode(),
        readPointers: state.phase2Mode === 'open' ? 'phase-1 投影中的 archive 快照标记（Context archive）、contextHidden 观察的 read.args、摘要 sources 均带 history.read 的 ref/offset/limit 指针；QA 指令要求优先按这些指针恢复原文。' : null,
        knowledgeCatalog: state.phase2Mode === 'knowledge' ? (state.knowledgeCatalog ?? buildKnowledgeCatalog()).map(entry => ({
          id: entry.id,
          title: entry.title,
          objective: entry.objective,
          summary: entry.summary,
          facts: entry.facts.map(fact => ({ questionId: fact.questionId, marker: fact.marker, text: fact.text })),
          contentChars: entry.content.length,
          evidencePath: `knowledge/${entry.id}.md`,
        })) : null,
      },
    },
    questions: QUESTIONS.map(question => { const effective = phase2Question(question); return { id: question.id, category: question.category, prompt: effective.prompt, expected: effective.expected }; }),
    arms: state.arms.map(describeArm),
    workTokens: state.workTokens,
    repeats: state.repeats,
    limits: { model: LIMITS, budget: budgetForWindow(), maxDurationMs: MAX_DURATION_MS },
    design: {
      purpose: state.phase2Mode === 'closed'
        ? '两阶段测量压缩后项目上下文认知保持：phase-1 只压缩真实项目证据，phase-2 才闭卷问答；工具不可用、禁止重读，只能依据保留投影作答。'
        : `两阶段测量压缩后项目上下文认知保持，并对照 --phase2-mode ${state.phase2Mode} 的恢复/检索路径：phase-1 压缩与 closed 完全一致；phase-2 允许 ${state.phase2Mode === 'open' ? '按投影中的 read 指针用 history.read/history.search 重读被压缩原文' : '用 knowledge.browse/search/read 检索项目知识目录'}，以检验“目录/指针保留知识、原文可追溯”的代价与收益。`,
      separation: '问答指令/20 题不进入 phase-1 上下文，避免摘要模型直接答题（v1 的 SUMMARY_INVALID/MODEL_INCOMPLETE 根因）。',
      presets: { standard: '10 页固定事实页、窗口 1M（旧版默认）', large: '真实仓库 filler 补到 --seed-tokens，10 页事实页按页序号等距插入，窗口 --window-tokens', deep: '每题一个 18000–22000 字符真实文件页，答案锚点深埋页面中部（目标深度按题号 0.25→0.75 均匀变化），19 个事实页等距分布；用于检验旧版硬容量头尾摘录是否丢失中部事实' },
      arms: { off: '不传 compaction，复现旧版硬容量裁剪全量基线', mask: '成批隐藏旧工具正文并留下读取指针', summary: '有界模型任务摘要', hybrid: '先隐藏旧观察，仍超工作预算再摘要' },
      pairing: state.phase2Mode === 'closed'
        ? '所有 arm 使用同一 model、同一 phase-1 seed 内容、同一 card（tools 为空）、同一输出限制；每 trial 独立 data dir，串行执行。'
        : `所有 arm 使用同一 model、同一 phase-1 seed 内容、同一 phase-1 card；phase-2 统一换成 ${describeCard(phase2CardForMode()).id}（tools=${JSON.stringify([...phase2CardForMode().tools])}）并按同一 QA 指令作答；每 trial 独立 data dir，串行执行。`,
      scoring: state.phase2Mode === 'closed'
        ? '按 Q<id> 抽取 phase-2 答案段落；每题所有 expected 正则命中才算通过；UNKNOWN 与缺失均记失败。'
        : '按 Q<id> 抽取 phase-2 答案段落；每题所有 expected 正则命中才算通过；UNKNOWN 与缺失均记失败。所有 phase2 mode 的 expected 完全相同，工具使用只影响能否取回事实。',
      sampleSize: 'repeats 默认 2；探索性描述统计，不声称统计显著性，也不作为默认启用依据。',
    },
    accounting: {
      rates: historicRates,
      tokens: '以 relay 记录的上游 usage 为准；usage 缺失时保留估算并标记，不当作账单。',
      cost: '估算费用基于历史公开默认组费率，非供应商发票。',
    },
    host: { platform: process.platform, release: os.release(), node: process.version, cpu: os.cpus()[0]?.model ?? null },
    dryRun: { factCoverage: coverage, arms: dryRunRows, phase2Controls: phase2Plan, ...(wiring ? { phase2Wiring: wiring } : {}) },
  };
  await writeJson(path.join(state.root, 'manifest.json'), manifest);
}

async function main(values) {
  if (values.run && values['dry-run']) throw new Error('--run and --dry-run are mutually exclusive');
  state.runMode = Boolean(values.run);
  state.includeAnswers = Boolean(values['include-answers']);
  state.createdAt = new Date().toISOString();
  state.model = values.model;
  if (state.model !== FROZEN_MODEL) throw new Error(`This frozen experiment describes ${FROZEN_MODEL} capacities only; pass --model ${FROZEN_MODEL}`);
  state.provider = typeof values.provider === 'string' ? values.provider.trim() : '';
  if (!state.provider) throw new Error('--provider must be nonempty');
  state.repeats = Number(values.repeats);
  if (!Number.isSafeInteger(state.repeats) || state.repeats < 1 || state.repeats > 3) throw new Error('--repeats must be an integer 1..3');
  state.workTokens = Number(values['work-tokens']);
  if (!Number.isSafeInteger(state.workTokens) || state.workTokens < MIN_WORK_TOKENS || state.workTokens > MAX_WORK_TOKENS) throw new Error(`--work-tokens must be an integer ${MIN_WORK_TOKENS}..${MAX_WORK_TOKENS}`);
  state.seedPreset = values['seed-preset'];
  if (!SEED_PRESETS.includes(state.seedPreset)) throw new Error(`--seed-preset must be one of ${SEED_PRESETS.join(', ')}`);
  if (state.seedPreset !== 'standard') {
    state.seedTargetTokens = values['seed-tokens'] === undefined ? LARGE_DEFAULT_SEED_TOKENS : Number(values['seed-tokens']);
    if (!Number.isSafeInteger(state.seedTargetTokens) || state.seedTargetTokens < 10_000 || state.seedTargetTokens > 10_000_000) throw new Error('--seed-tokens must be an integer 10000..10000000');
  } else {
    if (values['seed-tokens'] !== undefined) throw new Error('--seed-tokens is only supported with --seed-preset large or deep');
    state.seedTargetTokens = null;
  }
  if (values['window-tokens'] === undefined) {
    state.windowTokens = state.seedPreset === 'standard' ? LIMITS.context : LARGE_DEFAULT_WINDOW_TOKENS;
  } else {
    state.windowTokens = Number(values['window-tokens']);
    if (!Number.isSafeInteger(state.windowTokens) || state.windowTokens < 4_096 || state.windowTokens >= LIMITS.context) throw new Error(`--window-tokens must be an integer 4096..${LIMITS.context - 1} (the model declaration stays ${LIMITS.context})`);
  }
  state.arms = parseArms(values.arms, state.workTokens);
  state.phase2Mode = values['phase2-mode'];
  if (!PHASE2_MODES.includes(state.phase2Mode)) throw new Error(`--phase2-mode must be one of ${PHASE2_MODES.join(', ')}`);
  state.phase2Compaction = values['phase2-compaction'];
  if (!PHASE2_COMPACTION_MODES.includes(state.phase2Compaction)) throw new Error(`--phase2-compaction must be one of ${PHASE2_COMPACTION_MODES.join(', ')}`);
  const phase2MaxToolCalls = Number(values['phase2-max-tool-calls']);
  if (!Number.isSafeInteger(phase2MaxToolCalls) || phase2MaxToolCalls < 0 || phase2MaxToolCalls > MAX_PHASE2_TOOL_CALLS) throw new Error(`--phase2-max-tool-calls must be an integer 0..${MAX_PHASE2_TOOL_CALLS} (0 means unlimited)`);
  state.phase2MaxToolCalls = phase2MaxToolCalls === 0 ? null : phase2MaxToolCalls;
  if (state.phase2Mode === 'knowledge' && state.seedPreset !== 'deep') throw new Error('--phase2-mode knowledge requires --seed-preset deep: the 5-entry catalog is defined over the 19 deep-preset KF facts');
  if (state.phase2Mode === 'open' && state.seedPreset === 'standard') throw new Error('--phase2-mode open requires --seed-preset deep or large so phase 1 compresses into archives the model can recover');
  if (state.phase2Mode === 'knowledge') {
    state.knowledgeCatalog = buildKnowledgeCatalog();
    const catalogCheck = checkKnowledgeCatalog(state.knowledgeCatalog);
    if (!catalogCheck.passed) throw new Error(`knowledge catalog wiring failed:\n- ${catalogCheck.problems.join('\n- ')}`);
  }
  const requestedRoot = values.root ?? path.join(REPOSITORY, '.kodo', `compaction-qa-retention-${state.runMode ? 'run' : 'dry'}-${Date.now()}`);
  state.root = path.resolve(requestedRoot);
  if (existsSync(state.root)) throw new Error('Use a fresh --root directory; previous evidence is never overwritten');
  await mkdir(state.root, { recursive: true });
  state.eventsPath = path.join(state.root, 'events.jsonl');
  await writeFile(state.eventsPath, '');
  emit({ event: 'qa-retention.preparing', root: state.root, mode: state.runMode ? 'run' : 'dry-run', model: state.model, provider: state.provider, arms: state.arms.map(describeArm), repeats: state.repeats, workTokens: state.workTokens, seedPreset: state.seedPreset, seedTargetTokens: state.seedTargetTokens, windowTokens: state.windowTokens, outputTokens: budgetForWindow().maxOutputTokens, phase2Compaction: state.phase2Compaction, phase2MaxToolCalls: state.phase2MaxToolCalls, ...(phase2ModeEnabled() ? { phase2Mode: state.phase2Mode, phase2CatalogSource: phase2ControlPlan().catalogSource } : {}) });
  const seed = await loadSeed();
  state.seed = seed;
  emit({ event: 'seed.loaded', phase: 'phase-1', seedPreset: state.seedPreset, rounds: seed.pageCount, contentChars: seed.contentChars, contentTokens: seed.contentTokens, windowTokens: state.windowTokens, factDistribution: seed.factDistribution.rows, questionSheetIncluded: false });
  appendLine(state.eventsPath, { event: 'seed.loaded', phase: 'phase-1', seedPreset: state.seedPreset, rounds: seed.pageCount, contentChars: seed.contentChars, contentTokens: seed.contentTokens, windowTokens: state.windowTokens, questionSheetIncluded: false, factDistribution: seed.factDistribution, pages: seed.pages.map(page => ({ path: page.path, offset: page.offset, end: page.end, chars: page.chars, kind: page.kind, questionId: page.questionId ?? null, anchorDepth: page.anchorDepth ?? null, hash: page.hash })) });
  const coverage = checkFactCoverage(seed.evidenceText);
  for (const row of coverage) appendLine(state.eventsPath, { event: 'dry-run.fact', question: row.id, category: row.category, passed: row.passed, checks: row.checks });
  const dryRunRows = [];
  for (const arm of state.arms) {
    const row = await simulateArm(arm, seed.messages);
    dryRunRows.push(row);
    emit({ event: 'dry-run.arm', ...row });
    appendLine(state.eventsPath, { event: 'dry-run.arm', ...row });
  }
  const wiring = phase2ModeEnabled() ? await checkPhase2Wiring(seed, dryRunRows) : null;
  const controlsCheck = await checkPhase2ControlMechanics();
  printReport(seed, coverage, dryRunRows, wiring, controlsCheck);
  state.sourceHash = sha256(JSON.stringify({ seedPreset: state.seedPreset, windowTokens: state.windowTokens, content: seed.contentHash, questions: QUESTIONS.map(question => ({ id: question.id, expected: question.expected })) }));
  const distributionCheck = checkFactDistribution(seed.factDistribution);
  await writeJson(path.join(state.root, 'dry-run.json'), {
    createdAt: state.createdAt,
    phase2Mode: state.phase2Mode,
    phase2Controls: controlsCheck,
    seedPreset: state.seedPreset,
    seedTargetTokens: state.seedTargetTokens,
    seedTokens: seed.contentTokens,
    seedRounds: seed.pageCount,
    windowTokens: state.windowTokens,
    outputTokens: budgetForWindow().maxOutputTokens,
    factDistribution: seed.factDistribution,
    factDistributionCheck: distributionCheck,
    factPages: seed.factDistribution.rows,
    deepChecks: seed.deepChecks ?? null,
    seed: {
      preset: state.seedPreset,
      targetTokens: state.seedTargetTokens,
      pages: seed.pages.map(page => ({ path: page.path, offset: page.offset, end: page.end, total: page.total, chars: page.chars, tokens: page.tokens, kind: page.kind, questionId: page.questionId ?? null, anchorDepth: page.anchorDepth ?? null, hash: page.hash })),
      contentChars: seed.contentChars,
      contentTokens: seed.contentTokens,
      factTokens: seed.factTokens,
      fillerPageCount: seed.fillerPageCount ?? 0,
      fillerPageChars: seed.fillerPageChars ?? null,
      distribution: seed.factDistribution,
    },
    factCoverage: coverage,
    arms: dryRunRows,
    ...(wiring ? { phase2Wiring: wiring } : {}),
  });
  const missing = coverage.filter(row => !row.passed);
  if (missing.length) {
    const detail = missing.map(row => `Q${row.id}: ${row.checks.filter(check => !check.present).map(check => check.source).join(' | ')}`).join('; ');
    throw new Error(`seed text is missing expected facts: ${detail}`);
  }
  assertDryRun(dryRunRows, seed);
  if (wiring && !wiring.passed) throw new Error(`phase-2 ${wiring.mode} static wiring check failed:\n- ${wiring.problems.join('\n- ')}`);
  if (!controlsCheck.passed) throw new Error(`phase-2 compaction control probe failed:\n- ${controlsCheck.problems.join('\n- ')}`);
  emit({ event: 'dry-run.complete', root: state.root, seedPreset: state.seedPreset, seedRounds: seed.pageCount, seedTokens: seed.contentTokens, windowTokens: state.windowTokens, seedInputTokens: Math.min(...dryRunRows.map(row => row.originalInputTokens)), factCoveragePassed: coverage.length, phase2Compaction: controlsCheck.mode, phase2CompactionFrozen: controlsCheck.frozen, phase2ToolBudget: controlsCheck.toolBudget, phase2CatalogSource: controlsCheck.catalogSource, phase2ControlsPassed: controlsCheck.passed, phase2Window: controlsCheck.window, factDistribution: { min: distributionCheck.minFraction, max: distributionCheck.maxFraction, maxGap: distributionCheck.maxGap, passed: distributionCheck.passed }, factPages: seed.factDistribution.rows, deepChecks: seed.deepChecks ? { passed: seed.deepChecks.passed, matched: seed.deepChecks.rows.filter(row => row.expectedMatched).length, total: seed.deepChecks.rows.length, minDepth: seed.deepChecks.minDepth, maxDepth: seed.deepChecks.maxDepth } : null, off: dryRunRows.find(row => !row.strategy) ? { buildStrategy: dryRunRows.find(row => !row.strategy).buildStrategy, omittedMessages: dryRunRows.find(row => !row.strategy).omittedMessages, archivedRef: dryRunRows.find(row => !row.strategy).archivedRef } : null, arms: dryRunRows.map(row => ({ arm: row.arm, originalInputTokens: row.originalInputTokens, builtInputTokens: row.estimatedInputTokens, buildStrategy: row.buildStrategy, masked: row.masked, omittedMessages: row.omittedMessages, summaryPlan: Boolean(row.summaryPlan), computedWorkInputTokens: row.computedWorkInputTokens, targetTokens: row.targetTokens })), ...(wiring ? { phase2Mode: wiring.mode, phase2Wiring: { passed: wiring.passed, card: wiring.card, tools: wiring.expectedTools, knowledgeAvailable: wiring.knowledgeAvailable, knowledgeEntries: wiring.knowledgeEntries, seededEntries: wiring.seededEntries, knowledgeFacts: wiring.knowledgeFacts, knowledgeExpectedFacts: wiring.knowledgeExpectedFacts, knowledgeQuestions: wiring.knowledgeQuestions, knowledgeExpectedQuestions: wiring.knowledgeExpectedQuestions, phase1ArchiveAvailable: wiring.phase1ArchiveAvailable, problems: wiring.problems } } : {}) });
  if (state.runMode) {
    const credentials = await resolveRelayCredentials(state.provider, values['provider-config']);
    state.secret = credentials.key;
    state.upstream = credentials.upstream;
  }
  await writeManifest(seed, coverage, dryRunRows, wiring, controlsCheck);
  if (!state.runMode) return;
  appendLine(state.eventsPath, { event: 'matrix.started', root: state.root, arms: state.arms.map(describeArm), repeats: state.repeats, model: state.model, provider: state.provider, upstream: state.upstream, ...(phase2ModeEnabled() ? { phase2Mode: state.phase2Mode } : {}) });
  const rows = [];
  const totalTrials = state.repeats * state.arms.length;
  let trialIndex = 0;
  for (let repeat = 1; repeat <= state.repeats; repeat++) {
    const order = repeat % 2 === 1 ? state.arms : [...state.arms].reverse();
    for (const arm of order) {
      trialIndex++;
      emit({ event: 'trial.started', index: trialIndex, total: totalTrials, arm: arm.name, strategy: arm.strategy, workInputTokens: arm.workInputTokens, repeat });
      const row = await trialExecution(arm, repeat, seed.messages);
      rows.push(row);
      await writeRootOutputs(rows);
      emit({
        event: 'trial.finished',
        index: trialIndex,
        total: totalTrials,
        id: row.id,
        arm: row.arm,
        strategy: row.strategy,
        workInputTokens: row.workInputTokens,
        repeat,
        status: row.status,
        error: row.error,
        phase1Status: row.phase1Status,
        phase2Status: row.phase2Status,
        accuracy: { passed: row.accuracy.passed, total: row.accuracy.total, rate: row.accuracy.rate },
        summaryInstalled: (row.compaction.phase1.events['context.summary.installed'] ?? 0) > 0,
        requests: row.requests,
        phase1Requests: row.phase1Requests,
        phase2Requests: row.phase2Requests,
        usage: { input: row.usage.input, output: row.usage.output, estimatedCny: row.usage.estimatedCny },
        phase1CompactionEvents: row.compaction.phase1.events,
        phase2CompactionEvents: row.phase2CompactionEvents,
        phase2CompactionFrozen: row.phase2CompactionFrozen,
        phase2CompactionEventCount: row.phase2CompactionEventCount,
        phase2FreezeViolated: row.phase2FreezeViolated,
        phase2SummaryInstalled: row.phase2SummaryInstalled,
        phase2Window: row.phase2Window,
        phase2ToolBudget: row.phase2ToolBudget,
        phase2ToolBudgetExhausted: row.phase2ToolBudgetExhausted,
        summaryCoverage: row.summaryCoverage,
        summaryCoverageNote: row.summaryCoverageNote,
        phase2SummaryCoverage: row.phase2SummaryCoverage,
        phase2SummaryCoverageNote: row.phase2SummaryCoverageNote,
        compactionEvents: row.compaction.events,
        hiddenObservations: row.compaction.inspection?.hiddenObservations ?? null,
        phase1HiddenObservations: row.compaction.phase1Inspection?.hiddenObservations ?? null,
        peakInput: row.compaction.inspection?.usage?.peakInput ?? null,
        estimatedPeakInput: row.compaction.inspection?.usage?.estimatedPeakInput ?? null,
        phase1Ms: row.phase1Ms,
        phase2Ms: row.phase2Ms,
        executionMs: row.executionMs,
        ...(phase2ModeEnabled() ? {
          phase2Mode: row.phase2Mode,
          phase2ToolCalls: row.phase2?.tools?.total ?? 0,
          phase2ToolCallsByName: row.phase2?.tools?.byName ?? {},
          phase2ToolErrors: row.phase2?.tools?.errors ?? [],
          recoveryReads: row.recoveryReads,
          recoveredChars: row.recoveredChars,
          knowledgeSeedEntries: row.phase2?.knowledgeSeed?.entries ?? 0,
        } : {}),
      });
    }
  }
  const summary = summarizeRows(rows);
  appendLine(state.eventsPath, { event: 'matrix.finished', root: state.root, attempts: rows.length, phase2Compaction: summary.phase2Compaction, phase2ToolBudget: summary.phase2ToolBudget, phase2CatalogSource: summary.phase2CatalogSource, arms: summary.arms.map(arm => ({ arm: arm.arm, attempts: arm.attempts, accuracy: arm.accuracy.overall, tokens: arm.tokens, compaction: arm.compaction, phase2: arm.phase2 })), ...(phase2ModeEnabled() ? { phase2Mode: state.phase2Mode } : {}) });
  emit({ event: 'matrix.finished', root: state.root, attempts: rows.length, phase2Compaction: summary.phase2Compaction, phase2CompactionFrozen: summary.phase2Controls?.frozen ?? null, phase2ToolBudget: summary.phase2ToolBudget, phase2CatalogSource: summary.phase2CatalogSource, arms: summary.arms.map(arm => ({ arm: arm.arm, accuracy: arm.accuracy.overall, meanTrialRate: arm.accuracy.meanTrialRate, byCategory: arm.accuracy.byCategory, tokens: arm.tokens, compaction: arm.compaction, trialsWithInstalledSummary: arm.compaction.trialsWithInstalledSummary })), ...(phase2ModeEnabled() ? { phase2Mode: state.phase2Mode, phase2: summary.arms.map(arm => ({ arm: arm.arm, ...arm.phase2 })) } : {}) });
  if (rows.some(row => row.status !== 'completed')) process.exitCode = 1;
}

try {
  const { values } = parseArgs({ options: CLI_OPTIONS });
  await main(values);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
