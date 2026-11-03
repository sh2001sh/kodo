// Natural knowledge deposition harness (C6). Instead of hand-seeding project
// facts into the context, this script uses Kodo's real exploration pipeline:
// the host dispatches exploration.plan questions, real child runs read the
// repository with native file.read, the host automatically persists the child
// findings as candidate project knowledge, and an independent QA run must
// answer unknown KF questions using ONLY knowledge.browse/search/read.
//
// Dry-run never touches the network: it statically validates the design and
// then drives the same product pipeline with a deterministic scripted Provider
// to prove persistence, tool-card enforcement and scoring. --run (executed by
// the Lead) uses the loopback relay and a real model. The credential is never
// printed, never written to disk and only lives in this parent process.
import { appendFileSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import console from 'node:console';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { URL } from 'node:url';
import ts from 'typescript';
import { Application } from '../../dist/application/index.js';
import { createBudgetRelay } from './relay.mjs';
import { usageScorecard } from './real-scorecard.mjs';

const EVALUATION_VERSION = 'knowledge-deposition-v1';
const FROZEN_MODEL = 'deepseek-v4.1-flash';
const DEFAULT_PROVIDER_CONFIG = 'C:/Users/admin/.config/opencode/opencode.json';
const DEFAULT_PROVIDER = 'codego1';
const DEFAULT_REPEATS = 1;
const RELAY_KEY_ENV = 'KODO_KNOWLEDGE_RELAY_KEY';
const LIMITS = Object.freeze({ context: 1_000_000, output: 393_216 });
const MAX_DURATION_MS = 600_000;
const QA_TOOL_BUDGET = 12;
const REPOSITORY = path.resolve(import.meta.dirname, '..', '..');
const EXPLORATION_BATCH_SIZE = 4; // exploration.plan schema allows at most four questions

const CLI_OPTIONS = {
  root: { type: 'string' },
  'provider-config': { type: 'string', default: DEFAULT_PROVIDER_CONFIG },
  provider: { type: 'string', default: DEFAULT_PROVIDER },
  model: { type: 'string', default: FROZEN_MODEL },
  repeats: { type: 'string', default: String(DEFAULT_REPEATS) },
  'no-catalog-control': { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  run: { type: 'boolean', default: false },
  'include-answers': { type: 'boolean', default: false },
};

// ---------------------------------------------------------------------------
// KF facts: the ground truth, split over five host-dispatched exploration
// questions. Build prompts require the child to label each observed fact with
// its KF id inside claim text; those claims become the persisted knowledge that
// the QA run must later find. No KF fact is ever injected into a QA context.
// ---------------------------------------------------------------------------
const KF_FACTS = [
  { id: 1, category: '预算与阈值', description: '默认 workInputTokens 工作预算是 65536 token。', expected: ['65536|65,536|65_536'] },
  { id: 2, category: '预算与阈值', description: '压缩目标 targetTokens 是工作预算的 70%。', expected: ['70\\s*%|0\\.7'] },
  { id: 3, category: '预算与阈值', description: '近期原文预算的固定上限是 16384 token。', expected: ['16,?384|16_384'] },
  { id: 4, category: '预算与阈值', description: '摘要输出预算的内容固定上限是 8192 token。', expected: ['8192|8,192'] },
  { id: 5, category: '预算与阈值', description: '摘要请求超时 60 秒，输出预算低于 128 token 时跳过。', expected: ['(60\\s*秒|60s|60,?000|60_000)', '128'] },
  { id: 6, category: 'API 与存储', description: 'CLI 用 --compaction 启用压缩，策略为 mask、summary、hybrid。', expected: ['--compaction', 'mask', 'summary', 'hybrid'] },
  { id: 7, category: 'API 与存储', description: 'knowledge_nodes 主键 PRIMARY KEY(project_id,id)，同项目 UNIQUE(project_id,knowledge_id)。', expected: ['project_id\\s*,\\s*id|PRIMARY KEY\\s*\\(\\s*project_id\\s*,\\s*id\\s*\\)', 'project_id\\s*,\\s*knowledge_id|UNIQUE\\s*\\(\\s*project_id\\s*,\\s*knowledge_id\\s*\\)'] },
  { id: 8, category: 'API 与存储', description: '知识目录最多两层分类，根目录不计深度。', expected: ['(两|二|2)\\s*层|two folder levels'] },
  { id: 9, category: 'API 与存储', description: '当前存储 PRAGMA user_version = 5。', expected: ['user_version[^\\n]{0,20}5|user_version\\s*=\\s*5'] },
  { id: 10, category: '设计与取舍', description: 'RAPTOR 首版不采用递归聚类与向量索引，避免失效与写入成本。', expected: ['((不|未)(被)?(首版)?采用|没有采用|不引入|未引入)', '(递归|聚类|向量)'] },
  { id: 11, category: '设计与取舍', description: '从 PageIndex 借鉴结构指路、原文作证的接口。', expected: ['结构', '(原文|正文)'] },
  { id: 12, category: '设计与取舍', description: '知识目录整理项目知识，任务摘要用于继续当前任务。', expected: ['项目知识', '(当前任务|当前工作)'] },
  { id: 13, category: '设计与取舍', description: '旧观察隐藏后仍超过 H 才启动二级任务摘要。', expected: ['(超过|超出|高于)[^\\n]{0,12}(工作预算|软预算|预算|H)|超预算|(仍|依然|还)[^\\n]{0,8}超', '摘要|总结'] },
  { id: 14, category: '预算与阈值', description: '新的压缩策略默认关闭，启用时 64k 是可复现实验起点、未验收。', expected: ['默认关闭|默认不启用|不默认启用|off by default', '64k|65536|65,536|65_536', '实验起点|可复现实验|实验参数|未验证|未验收|C4[^\n]{0,12}(未|不)'], rejected: ['未启用时[^\n]{0,32}(隐藏|工作软预算|64k|65536|65,536|65_536)'] },
  { id: 15, category: '设计与取舍', description: 'SummaryEnvelope.sources 记录来源的准确读取入口。', expected: ['读取入口|read|来源引用|引用'] },
];
const KF_FACT_INDEX = new Map(KF_FACTS.map(fact => [fact.id, fact]));

const BUILD_QUESTIONS = [
  {
    id: 'kf-budget-thresholds',
    kfIds: [1, 2, 3, 4, 5],
    question: 'Inspect src/runtime/context.ts and src/runtime/compaction.ts. Report the exact compression budget and threshold constants as source observations. Label every observed fact with its required KF id in the claim text, exactly like "KF-1: <fact>". Required ids and facts: KF-1 default workInputTokens, KF-2 targetTokens ratio, KF-3 recent-message cap, KF-4 summary output cap, KF-5 summary timeout and minimum summary tokens.',
    inputs: ['src/runtime/context.ts', 'src/runtime/compaction.ts'],
    read_scope: ['src/runtime/context.ts', 'src/runtime/compaction.ts'],
    consumer: 'Closed-book QA over project compression knowledge',
    deliverable: 'Candidate knowledge with KF-labeled source claims',
    reason: 'Budget constants are only available from the runtime source files',
  },
  {
    id: 'kf-cli-switches',
    kfIds: [6, 14],
    question: 'Inspect README.md. Report the CLI switch that enables experimental compaction and the three strategy names as KF-6. As KF-14, report both that compaction is default-off and that 64k/65536 is only the default work soft budget when compaction is enabled, a reproducible experiment starting point whose real-task benefit is not accepted. Label facts exactly like "KF-6: <fact>" and "KF-14: <fact>".',
    inputs: ['README.md'],
    read_scope: ['README.md'],
    consumer: 'Closed-book QA over CLI knowledge',
    deliverable: 'Candidate knowledge with KF-labeled source claims',
    reason: 'CLI switches are documented in the README',
  },
  {
    id: 'kf-storage-catalog',
    kfIds: [7, 8, 9],
    question: 'Inspect src/storage/index.ts and src/knowledge/index.ts. Report the knowledge_nodes primary key and unique constraint, the maximum folder depth, and the current PRAGMA user_version. Label facts with KF-7, KF-8, KF-9 exactly like "KF-7: <fact>".',
    inputs: ['src/storage/index.ts', 'src/knowledge/index.ts'],
    read_scope: ['src/storage/index.ts', 'src/knowledge/index.ts'],
    consumer: 'Closed-book QA over storage and catalog knowledge',
    deliverable: 'Candidate knowledge with KF-labeled source claims',
    reason: 'Schema and depth validation live in storage and knowledge code',
  },
  {
    id: 'kf-design-tradeoffs',
    kfIds: [10, 11, 12, 13, 15],
    question: 'Inspect docs/context-compaction.md. Report why RAPTOR is not adopted, what PageIndex contributes, how the knowledge catalog differs from the task summary, when a second-level summary triggers, and what SummaryEnvelope.sources is for. Label facts with KF-10, KF-11, KF-12, KF-13, KF-15 exactly like "KF-10: <fact>".',
    inputs: ['docs/context-compaction.md'],
    read_scope: ['docs/context-compaction.md'],
    consumer: 'Closed-book QA over design tradeoff knowledge',
    deliverable: 'Candidate knowledge with KF-labeled source claims',
    reason: 'Design rationale is documented in the compaction design document',
  },
  {
    id: 'kf-retrieval-limits',
    kfIds: [16, 17],
    question: 'Inspect src/runtime/history.ts and src/knowledge/tools.ts. Report the history.search page limit and scan-character cap, and the knowledge tools available for retrieval (browse/search/read). Label facts with KF-16 and KF-17 exactly like "KF-16: <fact>".',
    inputs: ['src/runtime/history.ts', 'src/knowledge/tools.ts'],
    read_scope: ['src/runtime/history.ts', 'src/knowledge/tools.ts'],
    consumer: 'Closed-book QA over retrieval knowledge',
    deliverable: 'Candidate knowledge with KF-labeled source claims',
    reason: 'Retrieval limits are coded in history.ts and knowledge/tools.ts',
  },
];
// KF-16/17 above are internal labels for retrieval facts; the human-facing QA
// question set below maps every QA id to a persisted KF fact from KF_FACTS.
const BUILD_KF_ALIASES = { 16: 'retrieval-page', 17: 'retrieval-scan' };

const QA_QUESTIONS = KF_FACTS.map(fact => ({
  id: fact.id,
  category: fact.category,
  kfId: fact.id,
  prompt: `根据知识目录中标注为 KF-${fact.id} 的项目事实回答：${kfGoal(fact.id)}`,
  expected: [`KF-${fact.id}\\b`, ...fact.expected],
  rejected: fact.rejected ?? [],
}));

function kfGoal(kfId) {
  const goals = {
    1: '默认工作上下文预算 workInputTokens 是多少 token？',
    2: '压缩目标 targetTokens 是工作预算的百分之多少？',
    3: '近期原文预算的固定上限是多少 token？',
    4: '任务摘要输出预算的固定上限是多少 token？',
    5: '摘要请求超时多少秒、输出预算低于多少 token 跳过？',
    6: 'CLI 启用压缩的参数是什么？三种策略叫什么？',
    7: 'knowledge_nodes 的主键与同项目唯一约束是什么？',
    8: '知识目录最多几层分类？',
    9: '当前 PRAGMA user_version 是多少？',
    10: 'RAPTOR 是否被首版采用？原因涉及哪类做法？',
    11: '从 PageIndex 借鉴的核心思路是什么？',
    12: '知识目录与任务摘要各自的分工是什么？',
    13: '二级任务摘要的触发条件是什么？',
    14: '新的压缩策略默认是否启用？64k 的定位是什么？',
    15: 'SummaryEnvelope.sources 的用途是什么？',
  };
  return goals[kfId];
}

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }
const mean = values => {
  const numbers = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  return numbers.length ? Number((numbers.reduce((total, value) => total + value, 0) / numbers.length).toFixed(4)) : null;
};
const state = {
  runMode: false,
  model: FROZEN_MODEL,
  provider: DEFAULT_PROVIDER,
  upstream: null,
  secret: null,
  createdAt: null,
  root: null,
  eventsPath: null,
  repeats: DEFAULT_REPEATS,
  includeAnswers: false,
  control: false,
};
const redact = text => state.secret ? String(text).replaceAll(state.secret, '[redacted]') : String(text);
const writeJson = (file, value) => writeFile(file, `${redact(JSON.stringify(value, null, 2))}\n`);
const appendLine = (file, value) => appendFileSync(file, `${redact(typeof value === 'string' ? value : JSON.stringify(value))}\n`);
const emit = value => console.log(JSON.stringify(value));

// ---------------------------------------------------------------------------
// Static design validation (no model, no relay, no credential)
// ---------------------------------------------------------------------------
function validateDesign() {
  const problems = [];
  const seen = new Set();
  for (const fact of KF_FACTS) {
    if (seen.has(fact.id)) problems.push(`duplicate KF id ${fact.id}`);
    seen.add(fact.id);
    if (!fact.expected.every(source => new RegExp(source).test(fact.description))) problems.push(`KF-${fact.id} description does not hit its expected value regexes`);
  }
  const covered = new Set();
  for (const question of BUILD_QUESTIONS) {
    if (!question.read_scope?.length) problems.push(`${question.id}: empty read_scope`);
    for (const relative of question.read_scope ?? []) if (!existsSync(path.join(REPOSITORY, relative))) problems.push(`${question.id}: read_scope file missing ${relative}`);
    for (const kfId of question.kfIds) covered.add(kfId);
  }
  for (const fact of KF_FACTS) if (!covered.has(fact.id)) problems.push(`KF-${fact.id} is not covered by any exploration question`);
  for (const fact of KF_FACTS) if (!BUILD_QUESTIONS.some(question => question.question.includes(`KF-${fact.id}`))) problems.push(`KF-${fact.id} label is missing from every build question prompt`);
  const batches = [];
  for (let index = 0; index < BUILD_QUESTIONS.length; index += EXPLORATION_BATCH_SIZE) batches.push(BUILD_QUESTIONS.slice(index, index + EXPLORATION_BATCH_SIZE));
  const plan = batches.map((batch, index) => ({
    batch_id: `build-batch-${index + 1}`,
    decision_version: 0,
    questions: batch.map(question => ({
      id: question.id, question: question.question, inputs: question.inputs, consumer: question.consumer,
      deliverable: question.deliverable, execution: 'child', reason: question.reason, read_scope: question.read_scope,
    })),
  }));
  const qaCard = qaCardDefinition();
  if (qaCard.tools.join(',') !== 'knowledge.browse,knowledge.search,knowledge.read') problems.push('QA card must expose exactly knowledge.browse/search/read');
  return { problems, batches: plan, coveredKfIds: [...covered].sort((a, b) => a - b) };
}

function qaCardDefinition() {
  return {
    id: 'knowledge-deposition-qa', version: '1.0.0', name: 'Knowledge catalog closed-book QA',
    prompt: '闭卷问答：只能使用 knowledge.browse/search/read 查询项目知识目录；答案必须包含对应 KF 标记与事实值。',
    digest: sha256('knowledge-deposition-qa-card-v1'),
    tools: ['knowledge.browse', 'knowledge.search', 'knowledge.read'],
  };
}
const CONTROL_CARD = { id: 'knowledge-deposition-control', version: '1.0.0', name: 'No-catalog closed-book control', prompt: '闭卷问答：没有知识目录工具，无法确定时写 UNKNOWN。', digest: sha256('knowledge-deposition-control-card-v1'), tools: [] };

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
function buildBatchRequest(batch, decisionVersion = 0) {
  return { batch_id: batch.batch_id, decision_version: decisionVersion, questions: batch.questions };
}
function qaInput() {
  const lines = [
    '【闭卷知识问答】你只能使用 knowledge.browse / knowledge.search / knowledge.read 查询项目知识目录；禁止任何其它工具、重新读取文件或猜测。',
    '先 browse 或 search 找到候选条目，再 read 条目正文（claims/summary），答案必须来自知识条目里标注为 KF-<id> 的事实。',
    '如果知识目录中不存在对应 KF 标记或事实，写 UNKNOWN，不要用常识补答。',
    '每题单独一行，以 "Q<id>: KF-<id>，" 开头，只写从允许证据中读取的答案；无法确定时写 UNKNOWN。',
    '',
    ...QA_QUESTIONS.map(question => `Q${question.id}: ${question.prompt}`),
  ];
  return lines.join('\n');
}
function controlInput() {
  const lines = [
    '【无目录闭卷对照】当前没有项目知识目录工具，无法读取项目知识；无法确定时写 UNKNOWN。',
    '每题单独一行，以 "Q<id>: KF-<id>，" 开头，只写答案本身；无法确定时写 UNKNOWN。',
    '',
    ...QA_QUESTIONS.map(question => `Q${question.id}: ${question.prompt}`),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Scripted provider for --dry-run: drives the real product pipeline without any
// network call so persistence, tool-card enforcement and scoring can be verified.
// ---------------------------------------------------------------------------
function runIdFrom(request) {
  const match = /Run ID: ([^. ]+)\./u.exec(request.messages[0]?.content ?? '');
  return match?.[1];
}
function toolCall(name, args, id) {
  return { message: { role: 'assistant', content: null, tool_calls: [{ id: id ?? name, name, arguments: JSON.stringify(args) }] }, finishReason: 'tool_calls', usage: { input: 10, output: 5 } };
}
function answer(content) {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: { input: 10, output: 5 } };
}
function scriptedProvider(app) {
  return {
    async complete(request) {
      const runId = runIdFrom(request);
      const run = app.store.run(runId);
      if (run.parentId) {
        const buildQuestion = BUILD_QUESTIONS.find(question => question.question === run.objective);
        if (!buildQuestion) throw new Error(`scripted provider: unknown child objective ${run.objective}`);
        if (run.step === 0) return toolCall('file.read', { path: buildQuestion.read_scope[0] }, `read-${run.id}`);
        if (run.step === 1) return toolCall('inspect_run', { run_id: run.id }, `inspect-${run.id}`);
        const evidence = app.store.calls(run.id).filter(call => call.name === 'file.read' && call.status === 'succeeded').map(call => call.id);
        if (!evidence.length) throw new Error('scripted provider: child produced no file.read evidence');
        const claims = buildQuestion.kfIds.flatMap(kfId => {
          const fact = KF_FACT_INDEX.get(kfId);
          if (fact) return [{ text: `KF-${fact.id}: ${fact.description}`, basis: 'source_observation', evidence_ids: [evidence[0]] }];
          return [{ text: `KF-${kfId}: ${BUILD_KF_ALIASES[kfId]} retrieval limit observed in source.`, basis: 'source_observation', evidence_ids: [evidence[0]] }];
        });
        return answer(JSON.stringify({ question_id: run.exploration.questionId, summary: `KF facts observed: ${claims.map(claim => claim.text.split('：')[0]).join(', ')}`, claims, hypotheses: [], open_questions: [] }));
      }
      const tools = new Set(request.tools.map(tool => tool.name));
      if (tools.has('knowledge.search')) {
        if (run.step === 0) return toolCall('knowledge.browse', {}, `browse-${run.id}`);
        if (run.step === 1) {
          const browse = request.messages.findLast(message => message.role === 'tool' && typeof message.content === 'string');
          const page = JSON.parse(browse?.content ?? '{"items":[]}');
          const entry = page.items?.[0];
          if (!entry) throw new Error('scripted provider: no knowledge entries to read');
          return toolCall('knowledge.read', { id: entry.knowledgeId ?? entry.id, revision: entry.knowledge?.revision ?? 1 }, `read-knowledge-${run.id}`);
        }
        return answer(QA_QUESTIONS.map(question => {
          const fact = KF_FACT_INDEX.get(question.kfId);
          return `Q${question.id}: KF-${question.kfId}，${fact ? fact.description : 'retrieved fact'}`;
        }).join('\n'));
      }
      if (request.tools.length === 0) {
        return answer(QA_QUESTIONS.map(question => `Q${question.id}: UNKNOWN`).join('\n'));
      }
      throw new Error(`scripted provider: unexpected tool set ${[...tools].join(',')}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared execution
// ---------------------------------------------------------------------------
function bindingFor(baseURL) {
  return { protocol: 'chat-completions', model: state.model, baseURL, apiKeyEnv: RELAY_KEY_ENV, limits: LIMITS };
}
function budgetFor(extra = {}) {
  return { maxTokens: null, maxModelCalls: null, maxToolCalls: null, maxDurationMs: MAX_DURATION_MS, maxContextTokens: LIMITS.context, maxOutputTokens: LIMITS.output, maxContextChars: null, ...extra };
}
function mainObjective() {
  return '建立项目知识目录：用探索问题读取源码并沉淀可复用事实。只读，不修改任何文件。';
}
function childStatus(app, runId) {
  const run = app.store.run(runId);
  const calls = app.store.calls(runId);
  return { runId, questionId: run.exploration?.questionId ?? null, status: run.status, error: run.error ?? null, permissions: run.permissions ?? [], cardTools: run.card.tools, modelCalls: calls.filter(call => call.kind === 'model').length, toolCalls: calls.filter(call => call.kind === 'tool').length, readCalls: calls.filter(call => call.kind === 'tool' && call.name === 'file.read').length };
}
function persistedKnowledge(app, mainRunId) {
  const items = app.coordinator.knowledge.search(mainRunId, { limit: 5 }).items;
  const entries = [];
  for (const item of items) {
    const rows = app.store.knowledge.refsByRevision(item.id, item.revision);
    const body = rows.length ? app.store.readBlob(rows[0]) : null;
    const texts = body ? [...(body.claims ?? []).map(claim => claim.text), body.summary ?? ''] : [];
    entries.push({ id: item.id, revision: item.revision, freshness: item.freshness, confirmation: item.confirmation, summary: item.summary, claims: body?.claims?.map(claim => claim.text) ?? [], kfHits: KF_FACTS.filter(fact => texts.some(text => new RegExp(`KF-${fact.id}\\b`).test(text))).map(fact => fact.id) });
  }
  return entries;
}
function knowledgeRowCount(app) {
  return app.store.knowledge.counts().versions;
}
function parseAnswerSegments(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const marker = /^\s*(?:[-*•]\s*)?(?:\*\*)?Q\s*(\d+)\s*(?:\*\*)?\s*[:：.)、）]\s*(.*)$/i;
  const found = [];
  for (let index = 0; index < lines.length; index++) {
    const match = marker.exec(lines[index]);
    if (match) found.push({ id: Number(match[1]), start: index, rest: match[2] });
  }
  const segments = new Map();
  for (let index = 0; index < found.length; index++) {
    const row = found[index];
    if (segments.has(row.id)) continue;
    const end = index + 1 < found.length ? found[index + 1].start : lines.length;
    segments.set(row.id, [row.rest, ...lines.slice(row.start + 1, end)].join('\n').trim());
  }
  return segments;
}
function scoreAnswers(text) {
  const segments = parseAnswerSegments(text);
  const questions = QA_QUESTIONS.map(question => {
    const answerText = segments.get(question.id) ?? '';
    const normalized = answerText.replace(/\s+/g, ' ').trim();
    const unknown = /^unknown\b/i.test(normalized);
    const checks = question.expected.map(source => ({ source, passed: new RegExp(source, 'i').test(normalized) }));
    const rejections = question.rejected.map(source => ({ source, matched: new RegExp(source, 'i').test(normalized) }));
    const pass = Boolean(normalized) && !unknown && checks.every(check => check.passed) && rejections.every(check => !check.matched);
    return { id: question.id, kfId: question.kfId, category: question.category, answer: answerText, pass, checks, rejections };
  });
  const passed = questions.filter(question => question.pass).length;
  const categories = [...new Set(QA_QUESTIONS.map(question => question.category))];
  return {
    questions,
    passed,
    total: questions.length,
    rate: questions.length ? Number((passed / questions.length).toFixed(4)) : null,
    byCategory: Object.fromEntries(categories.map(category => {
      const rows = questions.filter(question => question.category === category);
      return [category, { passed: rows.filter(row => row.pass).length, total: rows.length }];
    })),
  };
}
function usageFor(stats) {
  return usageScorecard(globalThis.structuredClone(stats));
}

async function runBuildPhase(app, mainRun, executeChild) {
  const events = [];
  const trace = (type, data) => events.push({ type, time: Date.now(), ...data });
  const mailbox = app.coordinator.mailbox;
  const children = [];
  const batches = [];
  for (let index = 0; index < BUILD_QUESTIONS.length; index += EXPLORATION_BATCH_SIZE) batches.push(BUILD_QUESTIONS.slice(index, index + EXPLORATION_BATCH_SIZE));
  for (const [index, batch] of batches.entries()) {
    const args = buildBatchRequest({
      batch_id: `build-batch-${index + 1}`,
      questions: batch.map(question => ({ id: question.id, question: question.question, inputs: question.inputs, consumer: question.consumer, deliverable: question.deliverable, execution: 'child', reason: question.reason, read_scope: question.read_scope })),
    }, app.store.run(mainRun.id).decisionVersion ?? 0);
    const validated = mailbox.validate(mainRun, 'exploration.plan', JSON.stringify(args));
    const output = mailbox.execute(mainRun, `build-batch-${index + 1}`, 'exploration.plan', validated);
    for (const item of output.questions) if (item.run_id) {
      const child = app.store.run(item.run_id);
      children.push(child);
      trace('build.child.queued', { questionId: item.question_id, runId: item.run_id, permissions: child.permissions, cardTools: child.card.tools });
    }
  }
  const started = Date.now();
  for (const child of children) {
    let ended;
    try { ended = await executeChild(child); } catch (error) { ended = { status: 'failed', error: error.message }; }
    trace('build.child.finished', { ...childStatus(app, child.id), endedStatus: ended.status, error: ended.error ?? null });
  }
  const entries = persistedKnowledge(app, mainRun.id);
  const entryCount = knowledgeRowCount(app);
  const kfHitIds = [...new Set(entries.flatMap(entry => entry.kfHits))].sort((a, b) => a - b);
  trace('build.knowledge.persisted', { entryCount, entries: entries.map(entry => ({ id: entry.id, revision: entry.revision, kfHits: entry.kfHits })), kfHitIds });
  return { events, children: children.map(child => childStatus(app, child.id)), entries, entryCount, kfHitIds, elapsedMs: Date.now() - started };
}

async function runQaPhase(app, { qaBinding, qaText }) {
  const events = [];
  const trace = (type, data) => events.push({ type, time: Date.now(), ...data });
  const qa = app.createRun({ objective: qaText, workspace: REPOSITORY, binding: qaBinding, permissions: ['read'], card: qaCardDefinition(), budget: budgetFor({ maxToolCalls: QA_TOOL_BUDGET }) });
  const started = Date.now();
  let qaFinal;
  try { qaFinal = await app.run(qa.id); } catch (error) { qaFinal = { status: 'failed', error: error.message, resultRef: undefined }; }
  const qaTextResult = resultText(app, qaFinal);
  const toolCalls = app.store.calls(qa.id).filter(call => call.kind === 'tool').length;
  trace('qa.finished', { runId: qa.id, status: qaFinal.status, error: qaFinal.error ?? null, textChars: qaTextResult.length, executionMs: Date.now() - started, toolCalls });
  return { events, qa: { runId: qa.id, status: qaFinal.status, error: qaFinal.error ?? null, answerText: qaTextResult, accuracy: scoreAnswers(qaTextResult), toolCalls }, elapsedMs: Date.now() - started };
}

async function runControlPhase(app, { controlBinding }) {
  const started = Date.now();
  const controlRun = app.createRun({ objective: controlInput(), workspace: REPOSITORY, binding: controlBinding, permissions: ['read'], card: CONTROL_CARD, budget: budgetFor({ maxToolCalls: null }) });
  try { await app.run(controlRun.id); } catch { /* status recorded below */ }
  const stored = app.store.run(controlRun.id);
  const answerText = resultText(app, stored);
  const control = { runId: controlRun.id, status: stored.status, answerText, accuracy: scoreAnswers(answerText) };
  return { events: [{ type: 'control.finished', time: Date.now(), runId: controlRun.id, accuracy: control.accuracy.rate }], control, elapsedMs: Date.now() - started };
}
function resultText(app, run) {
  try { return run?.resultRef ? String(app.store.readBlob(run.resultRef).text ?? '') : ''; } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Dry-run: static validation + scripted pipeline in a throwaway state directory
// ---------------------------------------------------------------------------
async function dryRun(root) {
  emit({ event: 'dry-run.preparing', root });
  const design = validateDesign();
  const coverage = KF_FACTS.map(fact => {
    const checks = fact.expected.map(source => ({ source, passed: new RegExp(source, 'i').test(fact.description) }));
    return { kfId: fact.id, checks, passed: checks.every(check => check.passed) };
  });
  const missing = coverage.filter(row => !row.passed);
  if (missing.length) throw new Error(`KF facts do not hit expected: ${missing.map(row => row.kfId).join(',')}`);
  if (design.problems.length) throw new Error(`design validation failed:\n- ${design.problems.join('\n- ')}`);
  const directory = path.join(root, 'dry-run', 'state');
  await mkdir(directory, { recursive: true });
  let app = null;
  let build;
  let qa;
  try {
    const provider = { complete: (request, signal) => scriptedProvider(app).complete(request, signal) };
    app = new Application(directory, provider, undefined, { exploration: true });
    const mainRun = app.createRun({ objective: mainObjective(), workspace: REPOSITORY, binding: bindingFor('http://127.0.0.1:1/v1'), permissions: ['read'], budget: budgetFor({ maxChildren: 8 }) });
    build = await runBuildPhase(app, mainRun, child => app.coordinator.wake(child.id));
    qa = await runQaPhase(app, { qaBinding: bindingFor('http://127.0.0.1:1/v1'), qaText: qaInput() });
    if (state.control) {
      const control = await runControlPhase(app, { controlBinding: bindingFor('http://127.0.0.1:1/v1') });
      qa.control = control.control;
      qa.events.push(...control.events);
    }
  } finally {
    if (app) await app.shutdown();
  }
  const pipeline = { ...build, ...qa, events: [...build.events, ...qa.events] };
  const persisted = pipeline.entryCount;
  const qaAccuracy = pipeline.qa.accuracy.rate;
  const controlAccuracy = pipeline.control?.accuracy.rate ?? null;
  const invalidQ14Text = QA_QUESTIONS.map(question => {
    if (question.id === 14) return 'Q14: KF-14，新的压缩策略默认关闭；未启用时会按 64k 工作软预算隐藏旧工具正文；这只是实验起点。';
    const fact = KF_FACT_INDEX.get(question.kfId);
    return `Q${question.id}: KF-${question.kfId}，${fact ? fact.description : 'retrieved fact'}`;
  }).join('\n');
  const invalidQ14Score = scoreAnswers(invalidQ14Text);
  const invalidQ14Rejected = invalidQ14Score.questions.find(question => question.id === 14)?.pass === false;
  const problems = [];
  if (persisted !== BUILD_QUESTIONS.length) problems.push(`expected ${BUILD_QUESTIONS.length} persisted knowledge entries, got ${persisted}`);
  if (pipeline.entries.length !== BUILD_QUESTIONS.length) problems.push(`knowledge search returned ${pipeline.entries.length} entries`);
  if (qaAccuracy !== 1) problems.push(`scripted QA accuracy ${qaAccuracy} != 1`);
  if (state.control && controlAccuracy !== 0) problems.push(`scripted control accuracy ${controlAccuracy} != 0`);
  if (!invalidQ14Rejected) problems.push('invalid Q14 wording was not rejected');
  if (pipeline.children.some(child => child.status !== 'completed')) problems.push('a build child did not complete');
  if (pipeline.children.some(child => (child.permissions ?? []).includes('write') || (child.permissions ?? []).includes('exec'))) problems.push('a build child received write/exec permission');
  if (pipeline.children.some(child => (child.cardTools ?? []).some(name => !['file.read', 'file.list', 'file.search', 'image.read'].includes(name)))) problems.push('a build child card exposed non-native tools');
  if (problems.length) throw new Error(`dry-run pipeline assertions failed:\n- ${problems.join('\n- ')}`);
  const report = {
    createdAt: state.createdAt,
    design: { buildQuestions: BUILD_QUESTIONS.map(question => ({ id: question.id, kfIds: question.kfIds, read_scope: question.read_scope })), batches: design.batches.map(batch => ({ batch_id: batch.batch_id, questionIds: batch.questions.map(question => question.id) })), coveredKfIds: design.coveredKfIds, qaCard: qaCardDefinition() },
    kfCoverage: coverage,
    pipeline: { entries: pipeline.entries, entryCount: pipeline.entryCount, kfHitIds: pipeline.kfHitIds, childRuns: pipeline.children, qa: { status: pipeline.qa.status, accuracy: pipeline.qa.accuracy, answerText: pipeline.qa.answerText, toolCalls: pipeline.qa.toolCalls }, control: pipeline.control ? { status: pipeline.control.status, accuracy: pipeline.control.accuracy } : null, scoringChecks: { invalidQ14Rejected } },
  };
  await writeJson(path.join(root, 'dry-run.json'), report);
  emit({ event: 'dry-run.complete', persistedEntries: persisted, kfHitIds: pipeline.kfHitIds, kfHitRate: Number((pipeline.kfHitIds.length / KF_FACTS.length).toFixed(4)), qaAccuracy, controlAccuracy, invalidQ14Rejected, childRuns: pipeline.children.map(child => ({ questionId: child.questionId, status: child.status, readCalls: child.readCalls, cardTools: child.cardTools })) });
  return { design, coverage, pipeline, events: { persistedEntries: persisted, kfHitIds: pipeline.kfHitIds, qaAccuracy, controlAccuracy } };
}

// ---------------------------------------------------------------------------
// Real run
// ---------------------------------------------------------------------------
async function resolveRelayCredentials(provider, providerConfigPath) {
  let key = process.env.KODO_API_KEY ?? process.env.OPENAI_API_KEY;
  let upstream = process.env.KODO_BASE_URL;
  const absolute = path.resolve(providerConfigPath);
  let text;
  try { text = await readFile(absolute, 'utf8'); } catch (error) { throw new Error(`Cannot read --provider-config for provider ${provider} (${error.code ?? 'read error'}); environment variables remain supported`, { cause: error }); }
  const parsed = ts.parseConfigFileTextToJson(absolute, text);
  if (parsed.error) throw new Error(`Cannot parse --provider-config for provider ${provider}`);
  const options = parsed.config?.provider?.[provider]?.options;
  key ??= options?.apiKey;
  upstream ??= options?.baseURL;
  if (typeof key !== 'string' || !key || typeof upstream !== 'string' || !upstream) throw new Error('Configure the provider through environment variables or --provider-config; never pass a key on the command line');
  let endpoint;
  try { endpoint = new URL(upstream); } catch { throw new Error('Provider URL is not a valid absolute URL'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Provider URL must be plain HTTP(S) without credentials or query parameters');
  return { key, upstream };
}

async function runRepeat(repeatIndex) {
  const id = `repeat-${repeatIndex}`;
  const directory = path.join(state.root, id);
  const wireDirectory = path.join(directory, 'wire');
  await mkdir(directory, { recursive: true });
  await mkdir(wireDirectory, { recursive: true });
  await mkdir(path.join(wireDirectory, 'build'), { recursive: true });
  await mkdir(path.join(wireDirectory, 'qa'), { recursive: true });
  await mkdir(path.join(wireDirectory, 'control'), { recursive: true });
  const eventsPath = path.join(directory, 'trace.jsonl');
  await writeFile(eventsPath, '');
  const trace = (type, data) => appendLine(eventsPath, { type, time: new Date().toISOString(), repeatId: id, ...data });
  process.env[RELAY_KEY_ENV] = 'fixture-relay-key';
  const started = Date.now();
  let app = null;
  try {
    app = new Application(path.join(directory, 'state'), undefined, undefined, { exploration: true });
    const buildRelay = await createBudgetRelay({ directory: path.join(wireDirectory, 'build'), upstream: state.upstream, key: state.secret, model: state.model, maxContextChars: Number.MAX_SAFE_INTEGER, maxOutputTokens: LIMITS.output, unrestricted: true });
    let build;
    try {
      const mainRun = app.createRun({ objective: mainObjective(), workspace: REPOSITORY, binding: bindingFor(buildRelay.baseURL), permissions: ['read'], budget: budgetFor({ maxChildren: 8 }) });
      trace('build.main.created', { runId: mainRun.id });
      build = await runBuildPhase(app, mainRun, child => app.coordinator.wake(child.id));
    } finally {
      await buildRelay.close();
    }
    for (const event of build.events) trace(event.type, event);
    const buildStats = globalThis.structuredClone(buildRelay.stats);
    const buildElapsed = Date.now() - started;
    const qaRelay = await createBudgetRelay({ directory: path.join(wireDirectory, 'qa'), upstream: state.upstream, key: state.secret, model: state.model, maxContextChars: Number.MAX_SAFE_INTEGER, maxOutputTokens: LIMITS.output, unrestricted: true });
    let qa;
    try {
      qa = await runQaPhase(app, { qaBinding: bindingFor(qaRelay.baseURL), qaText: qaInput() });
    } finally {
      await qaRelay.close();
    }
    for (const event of qa.events) trace(event.type, event);
    const qaStats = globalThis.structuredClone(qaRelay.stats);
    let control = null;
    let controlStats = null;
    if (state.control) {
      const controlRelay = await createBudgetRelay({ directory: path.join(wireDirectory, 'control'), upstream: state.upstream, key: state.secret, model: state.model, maxContextChars: Number.MAX_SAFE_INTEGER, maxOutputTokens: LIMITS.output, unrestricted: true });
      try {
        control = await runControlPhase(app, { controlBinding: bindingFor(controlRelay.baseURL) });
      } finally {
        await controlRelay.close();
      }
      for (const event of control.events) trace(event.type, event);
      controlStats = globalThis.structuredClone(controlRelay.stats);
    }
    const row = {
      id, repeat: repeatIndex, status: 'completed',
      build: {
        entryCount: build.entryCount,
        entries: build.entries,
        kfHitIds: build.kfHitIds,
        kfHitRate: Number((build.kfHitIds.length / KF_FACTS.length).toFixed(4)),
        childRuns: build.children,
        requests: buildStats.requests,
        modelCalls: build.children.reduce((total, child) => total + child.modelCalls, 0),
        usage: usageFor(buildStats),
        calls: buildStats.calls.map(call => ({ index: call.index, contextChars: call.contextChars, usage: call.usage ?? null, httpStatus: call.httpStatus ?? null })),
        elapsedMs: buildElapsed,
      },
      qa: { runId: qa.qa.runId, status: qa.qa.status, error: qa.qa.error, accuracy: qa.qa.accuracy, toolCalls: qa.qa.toolCalls, requests: qaStats.requests, usage: usageFor(qaStats), elapsedMs: qa.elapsedMs },
      control: control ? { runId: control.control.runId, status: control.control.status, accuracy: control.control.accuracy, requests: controlStats.requests, usage: usageFor(controlStats), elapsedMs: control.elapsedMs } : null,
      executionMs: Date.now() - started,
      createdAt: new Date().toISOString(),
    };
    await writeJson(path.join(directory, 'result.json'), row);
    await writeFile(path.join(directory, 'qa-answer.txt'), `${redact(qa.qa.answerText)}\n`);
    if (control) await writeFile(path.join(directory, 'control-answer.txt'), `${redact(control.control.answerText)}\n`);
    appendLine(state.eventsPath, { event: 'repeat.finished', id, status: row.status, entryCount: row.build.entryCount, kfHitIds: row.build.kfHitIds, buildRequests: row.build.requests, qaRequests: row.qa.requests, controlRequests: row.control?.requests ?? 0, qaAccuracy: row.qa.accuracy.rate, controlAccuracy: row.control?.accuracy.rate ?? null, executionMs: row.executionMs });
    return row;
  } finally {
    delete process.env[RELAY_KEY_ENV];
    if (app) await app.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
function summarize(rows) {
  const buildUsage = rows.map(row => row.build.usage);
  const qaUsage = rows.map(row => row.qa.usage);
  const controlUsage = rows.flatMap(row => row.control?.usage ? [row.control.usage] : []);
  const totals = usage => ({
    requests: usage.reduce((total, item) => total + item.requests, 0),
    input: usage.reduce((total, item) => total + item.input, 0),
    output: usage.reduce((total, item) => total + item.output, 0),
    total: usage.reduce((total, item) => total + item.total, 0),
    estimatedCny: {
      low: usage.reduce((total, item) => total + item.estimatedCny.low, 0),
      high: usage.reduce((total, item) => total + item.estimatedCny.high, 0),
      complete: usage.every(item => item.usageComplete),
    },
  });
  const qaQuestions = QA_QUESTIONS.map(question => {
    const checks = rows.flatMap(row => row.qa.accuracy.questions.filter(item => item.id === question.id));
    return { id: question.id, kfId: question.kfId, category: question.category, passed: checks.filter(item => item.pass).length, total: checks.length };
  });
  return {
    repeats: rows.length,
    build: {
      meanEntryCount: mean(rows.map(row => row.build.entryCount)),
      meanKfHitRate: mean(rows.map(row => row.build.kfHitRate)),
      kfHitIds: [...new Set(rows.flatMap(row => row.build.kfHitIds))].sort((a, b) => a - b),
      childRuns: rows.reduce((total, row) => total + row.build.childRuns.length, 0),
      tokens: totals(buildUsage),
    },
    qa: {
      meanAccuracy: mean(rows.map(row => row.qa.accuracy.rate)),
      questions: qaQuestions,
      tokens: totals(qaUsage),
      toolCalls: rows.reduce((total, row) => total + (row.qa.toolCalls ?? 0), 0),
    },
    control: rows.some(row => row.control) ? { meanAccuracy: mean(rows.filter(row => row.control).map(row => row.control.accuracy.rate)), tokens: totals(controlUsage) } : null,
    caveats: [
      '建库条目来自真实探索子 run 的候选知识（confirmation=candidate），不是人工预置答案；QA 只允许 knowledge.browse/search/read。',
      '探索计划每批最多 4 个问题（exploration.plan schema maxItems=4），5 个问题分 2 批派发。',
      'KF 标记必须由子 run 的 claims 文本自然写入并持久化；若模型未按指示标注，QA 会因缺少 KF 标记而失败——这是被测现象，不是 harness bug。',
      'dry-run 使用脚本化 Provider 驱动真实产品管线（无网络、无密钥），只验证持久化/工具卡/评分管线；真实准确率由 --run 决定。',
    ],
  };
}
async function writeOutputs(rows) {
  const summary = summarize(rows);
  const results = rows.map(row => ({ ...row, qa: { ...row.qa, answerText: state.includeAnswers ? row.qa.answerText : undefined }, control: row.control ? { ...row.control, answerText: state.includeAnswers ? row.control.answerText : undefined } : null }));
  await writeJson(path.join(state.root, 'results.json'), { evaluationVersion: EVALUATION_VERSION, createdAt: state.createdAt, model: state.model, provider: state.provider, upstream: state.upstream ?? null, repeats: state.repeats, control: state.control, facts: KF_FACTS, buildQuestions: BUILD_QUESTIONS, qaQuestions: QA_QUESTIONS, results, summary });
  await writeJson(path.join(state.root, 'summary.json'), summary);
}

async function main(values) {
  if (values.run && values['dry-run']) throw new Error('--run and --dry-run are mutually exclusive');
  state.runMode = Boolean(values.run);
  state.includeAnswers = Boolean(values['include-answers']);
  state.control = Boolean(values['no-catalog-control']);
  state.createdAt = new Date().toISOString();
  state.model = values.model;
  if (state.model !== FROZEN_MODEL) throw new Error(`This frozen experiment describes ${FROZEN_MODEL} capacities only; pass --model ${FROZEN_MODEL}`);
  state.provider = typeof values.provider === 'string' ? values.provider.trim() : '';
  if (!state.provider) throw new Error('--provider must be nonempty');
  state.repeats = Number(values.repeats);
  if (!Number.isSafeInteger(state.repeats) || state.repeats < 1 || state.repeats > 3) throw new Error('--repeats must be an integer 1..3');
  state.root = path.resolve(values.root ?? path.join(REPOSITORY, '.kodo', `knowledge-deposition-${state.runMode ? 'run' : 'dry'}-${Date.now()}`));
  if (existsSync(state.root)) throw new Error('Use a fresh --root directory; previous evidence is never overwritten');
  await mkdir(state.root, { recursive: true });
  state.eventsPath = path.join(state.root, 'events.jsonl');
  await writeFile(state.eventsPath, '');
  emit({ event: 'knowledge-deposition.preparing', root: state.root, mode: state.runMode ? 'run' : 'dry-run', model: state.model, provider: state.provider, repeats: state.repeats, control: state.control });
  const designReport = await dryRun(state.root);
  const manifest = {
    evaluationVersion: EVALUATION_VERSION, mode: state.runMode ? 'run' : 'dry-run', createdAt: state.createdAt,
    model: state.model, provider: state.provider, upstream: state.upstream ?? null,
    workspace: REPOSITORY, repeats: state.repeats, control: state.control,
    limits: { model: LIMITS, qaToolBudget: QA_TOOL_BUDGET, maxDurationMs: MAX_DURATION_MS },
    facts: KF_FACTS,
    buildQuestions: BUILD_QUESTIONS.map(question => ({ id: question.id, kfIds: question.kfIds, question: question.question, read_scope: question.read_scope })),
    qaQuestions: QA_QUESTIONS.map(question => ({ id: question.id, kfId: question.kfId, category: question.category, prompt: question.prompt, expected: question.expected, rejected: question.rejected })),
    design: {
      build: 'host dispatches exploration.plan via coordinator.mailbox.execute (max 4 questions per batch), children use only native file.read in read_scope, host auto-persists findings as candidate knowledge',
      qa: 'independent run in the same workspace with knowledge.browse/search/read only, tool budget 12, closed-book KF questions',
      control: 'optional no-catalog run with an empty tool card',
      accounting: 'build, catalog QA, and no-catalog control relay usage recorded separately per repeat; rates are historic estimates, not billing',
    },
    dryRun: designReport.events,
  };
  await writeJson(path.join(state.root, 'manifest.json'), manifest);
  if (!state.runMode) return;
  const credentials = await resolveRelayCredentials(state.provider, values['provider-config']);
  state.secret = credentials.key;
  state.upstream = credentials.upstream;
  manifest.upstream = state.upstream;
  await writeJson(path.join(state.root, 'manifest.json'), manifest);
  const rows = [];
  for (let repeat = 1; repeat <= state.repeats; repeat++) {
    emit({ event: 'repeat.started', repeat, total: state.repeats });
    const row = await runRepeat(repeat);
    rows.push(row);
    await writeOutputs(rows);
    emit({ event: 'repeat.finished', repeat, entryCount: row.build.entryCount, kfHitIds: row.build.kfHitIds, buildRequests: row.build.requests, qaAccuracy: row.qa.accuracy.rate, controlAccuracy: row.control?.accuracy.rate ?? null, executionMs: row.executionMs });
  }
  emit({ event: 'matrix.finished', root: state.root, repeats: rows.length, summary: summarize(rows) });
}

try {
  const { values } = parseArgs({ options: CLI_OPTIONS });
  await main(values);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
