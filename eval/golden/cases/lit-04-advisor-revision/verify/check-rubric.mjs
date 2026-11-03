#!/usr/bin/env node
/**
 * 黄金样例 rubric 自检脚本（文献类，通用版）。
 *
 * 目的：在评分引擎 scripts/golden/score.mjs 尚在开发时，用一份**独立实现**的等价校验逻辑，
 * 证明本样例满足两条自检要求：
 *   A. verify/reference/ 下的参考交付物 100% 通过 rubric 的全部机械检查（rules 无违规）；
 *   B. 空输出（只有种子工作区、没有交付物）不能通过。
 * 另外若 rubric 含 protected-unchanged 规则，会追加一条篡改受保护文件的负例。
 *
 * 用法：node verify/check-rubric.mjs
 * 退出码：0 = 自检全部通过；1 = 自检失败或样例本身不合法。
 * 约束：不 import scripts/golden（评分引擎尚在开发），只依赖 Node 标准库。
 */
import {
  readFileSync, existsSync, statSync, mkdtempSync, cpSync, rmSync, readdirSync, writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASE_DIR = resolve(__dirname, '..');
const SEED_DIR = join(CASE_DIR, 'workspace');
const VERIFY_DIR = join(CASE_DIR, 'verify');
const REFERENCE_DIR = join(VERIFY_DIR, 'reference');

const LIMIT_DEFAULTS = {
  contextTokens: 1048576,
  outputTokens: 393216,
  maxOutputTokens: 16384,
  maxModelCalls: 100,
  maxTokens: 3000000,
  maxToolCalls: 300,
  maxDurationMs: 2700000
};
const CHECK_KINDS = new Set([
  'file-exists', 'file-contains', 'final-contains', 'final-regex', 'csv-columns',
  'csv-rows', 'csv-cell', 'markdown-table', 'json-values', 'citation-sources',
  'protected-unchanged', 'command', 'artifact-count', 'human'
]);

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
const failures = [];
function fail(msg) { failures.push(msg); console.error(`[SELF-CHECK FAIL] ${msg}`); }
function assert(cond, msg) { if (!cond) fail(msg); return cond; }

function readJson(absPath) {
  const raw = readFileSync(absPath);
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    throw new Error(`${absPath} 带 UTF-8 BOM，应为无 BOM UTF-8`);
  }
  return JSON.parse(raw.toString('utf8'));
}
function readText(root, rel) {
  return readFileSync(join(root, rel.replaceAll('/', sepOf())), 'utf8');
}
function sepOf() { return process.platform === 'win32' ? '\\' : '/'; }
function toPosix(p) { return p.replaceAll('\\', '/'); }
function sha256(buffer) { return createHash('sha256').update(buffer).digest('hex'); }

function walkFiles(root, rel = '') {
  const out = [];
  const abs = rel ? join(root, rel.replaceAll('/', sepOf())) : root;
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) return [toPosix(rel)];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(root, childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
}

function globToRegex(glob) {
  // 支持 **（跨层）与 *（同层），其余字符字面匹配。
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; }
      else re += '[^/]*';
    } else if ('\\^$+.()|{}[]'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell.endsWith('\r') ? cell.slice(0, -1) : cell);
      rows.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

function parseMarkdownTables(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  let current = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      if (!current) { current = { rows: [] }; tables.push(current); }
      current.rows.push(cells);
    } else {
      current = null;
    }
  }
  return tables.filter((t) => t.rows.length > 0).map((t) => {
    const header = t.rows[0];
    const separator = t.rows.length > 1 && t.rows[1].every((c) => /^:?-{2,}:?$/.test(c.trim()));
    const body = t.rows.slice(separator ? 2 : 1).filter((r) => r.some((c) => c.trim() !== ''));
    return { header, body };
  });
}

function normalizeHeader(cell) {
  return cell.replace(/[*`]/g, '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// 检查类型实现（对齐 docs §4.1 与评分引擎约定语义）
// ---------------------------------------------------------------------------
function runCheck(check, root) {
  const { kind, params = {} } = check;
  try {
    switch (kind) {
      case 'file-exists': {
        const pattern = params.path;
        const minBytes = params.minBytes ?? 1;
        const fileList = walkFiles(root);
        const re = globToRegex(pattern);
        const matched = fileList.filter((f) => re.test(f));
        const sized = matched.filter((f) => statSync(join(root, f.replaceAll('/', sepOf()))).size >= minBytes);
        return sized.length > 0
          ? { ok: true, detail: `${sized.join(', ')} 存在且 >= ${minBytes}B` }
          : { ok: false, detail: `未找到满足 ${pattern} 且 >= ${minBytes}B 的文件（匹配 ${matched.length} 个）` };
      }
      case 'file-contains': {
        const text = readText(root, params.path);
        for (const needle of params.all ?? []) {
          if (!text.includes(needle)) return { ok: false, detail: `${params.path} 缺少必需文本：${JSON.stringify(needle)}` };
        }
        if ((params.any ?? []).length > 0 && !params.any.some((n) => text.includes(n))) {
          return { ok: false, detail: `${params.path} 未包含 any 中任一项：${JSON.stringify(params.any)}` };
        }
        for (const needle of params.none ?? []) {
          if (text.includes(needle)) return { ok: false, detail: `${params.path} 不应包含：${JSON.stringify(needle)}` };
        }
        return { ok: true, detail: '包含关系满足' };
      }
      case 'markdown-table': {
        const text = readText(root, params.path);
        const required = (params.requiredHeaders ?? []).map(normalizeHeader);
        const minRows = params.minRows ?? 1;
        for (const table of parseMarkdownTables(text)) {
          const headers = table.header.map(normalizeHeader);
          if (required.every((h) => headers.includes(h)) && table.body.length >= minRows) {
            return { ok: true, detail: `表头齐全，数据行 ${table.body.length} >= ${minRows}` };
          }
        }
        return { ok: false, detail: `未找到同时满足 requiredHeaders 与 minRows=${minRows} 的表格` };
      }
      case 'csv-columns': {
        const rows = parseCsv(readText(root, params.path));
        const header = (rows[0] ?? []).map((c) => c.trim());
        const missing = (params.required ?? []).filter((r) => !header.includes(r.trim()));
        return missing.length === 0
          ? { ok: true, detail: `表头齐全：${header.join(',')}` }
          : { ok: false, detail: `缺少列：${missing.join(',')}（实际表头：${header.join(',')}）` };
      }
      case 'csv-rows': {
        const rows = parseCsv(readText(root, params.path));
        const dataRows = rows.slice(1).filter((r) => r.some((c) => c.trim() !== '')).length;
        const okMin = dataRows >= (params.minRows ?? 0);
        const okMax = params.maxRows === undefined || dataRows <= params.maxRows;
        return { ok: okMin && okMax, detail: `数据行 ${dataRows}（要求 ${params.minRows ?? 0}..${params.maxRows ?? '∞'}）` };
      }
      case 'csv-cell': {
        const rows = parseCsv(readText(root, params.path));
        const header = (rows[0] ?? []).map((c) => c.trim());
        const where = params.where ?? {};
        const expected = params.expect ?? {};
        const tolerance = params.tolerance;
        const whereEntries = Object.entries(where);
        const row = rows.slice(1).find((r) =>
          whereEntries.every(([col, val]) => {
            const idx = header.indexOf(col);
            return idx >= 0 && (r[idx] ?? '').trim() === String(val).trim();
          })
        );
        if (!row) return { ok: false, detail: `找不到 where=${JSON.stringify(where)} 的数据行` };
        for (const [col, expRaw] of Object.entries(expected)) {
          const idx = header.indexOf(col);
          if (idx < 0) return { ok: false, detail: `列不存在：${col}` };
          const actualRaw = (row[idx] ?? '').trim();
          const exp = expRaw;
          const bothNumeric = actualRaw !== '' && !Number.isNaN(Number(actualRaw)) && !Number.isNaN(Number(exp));
          let pass;
          if (bothNumeric && tolerance !== undefined) pass = Math.abs(Number(actualRaw) - Number(exp)) <= tolerance;
          else if (typeof exp === 'number') pass = Number(actualRaw) === exp;
          else pass = actualRaw === String(exp).trim();
          if (!pass) return { ok: false, detail: `列 ${col} 期望 ${JSON.stringify(exp)} 实际 ${JSON.stringify(actualRaw)}` };
        }
        return { ok: true, detail: `命中 where=${JSON.stringify(where)} 且 expect 一致` };
      }
      case 'citation-sources': {
        const text = readText(root, params.path);
        const allowedRoots = params.allowedRoots ?? [];
        const referenced = new Set();
        for (const rootName of allowedRoots) {
          const re = new RegExp(`${rootName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/][^\\s"'\`()（）\\[\\]【】「」《》，。；：、<>]+`, 'g');
          for (const m of text.matchAll(re)) {
            referenced.add(toPosix(m[0]).replace(/[.,;:)\]}]+$/, ''));
          }
        }
        for (const refPath of referenced) {
          if (!existsSync(join(root, refPath.replaceAll('/', sepOf())))) {
            return { ok: false, detail: `引用的来源不存在：${refPath}` };
          }
        }
        if (params.requireExcerpt) {
          const sources = [];
          for (const rootName of allowedRoots) {
            for (const rel of walkFiles(root, rootName)) {
              try { sources.push(readText(root, rel)); } catch { /* 二进制/非 UTF-8 文件跳过 */ }
            }
          }
          const excerpts = [];
          for (const m of text.matchAll(/“([^”\n]{2,})”/g)) excerpts.push(m[1]);
          for (const m of text.matchAll(/"([^"\n]{2,})"/g)) excerpts.push(m[1]);
          for (const raw of excerpts) {
            const excerpt = raw.trim();
            if ([...excerpt].length < 10) continue;
            if (!sources.some((s) => s.includes(excerpt))) {
              return { ok: false, detail: `引号片段无法在 allowedRoots 来源中逐字找到：${JSON.stringify(excerpt)}` };
            }
          }
        }
        return { ok: true, detail: `引用路径 ${referenced.size} 个均存在${params.requireExcerpt ? '，引号片段均可逐字核对' : ''}` };
      }
      case 'protected-unchanged': {
        const diffs = [];
        for (const relPath of params.paths ?? []) {
          const seedFiles = walkFiles(SEED_DIR, relPath);
          const runFiles = walkFiles(root, relPath);
          const seedMap = new Map(seedFiles.map((f) => [f, sha256(readFileSync(join(SEED_DIR, f.replaceAll('/', sepOf()))))]));
          const runMap = new Map(runFiles.map((f) => [f, sha256(readFileSync(join(root, f.replaceAll('/', sepOf()))))]));
          for (const [f, digest] of seedMap) {
            if (!runMap.has(f)) diffs.push(`缺失 ${f}`);
            else if (runMap.get(f) !== digest) diffs.push(`被修改 ${f}`);
          }
          for (const f of runMap.keys()) if (!seedMap.has(f)) diffs.push(`新增 ${f}`);
        }
        return diffs.length === 0
          ? { ok: true, detail: '受保护路径与样例种子一致' }
          : { ok: false, detail: `受保护路径发生变化：${diffs.slice(0, 5).join('; ')}` };
      }
      case 'command': {
        const program = params.program;
        const args = params.args ?? [];
        const cwd = params.cwd ? join(root, params.cwd.replaceAll('/', sepOf())) : root;
        const realProgram = program === 'node' ? process.execPath : program;
        const result = spawnSync(realProgram, args, {
          cwd,
          shell: false,
          timeout: params.timeoutMs ?? 60000,
          encoding: 'utf8',
          env: { ...process.env, GOLDEN_VERIFY_DIR: VERIFY_DIR }
        });
        const ok = result.status === params.expectExit;
        const head = `${(result.stdout ?? '').trim()}\n${(result.stderr ?? '').trim()}`.trim().slice(0, 500);
        return { ok, detail: `exit=${result.status} 期望=${params.expectExit}${head ? ` 输出：${head}` : ''}` };
      }
      case 'artifact-count': {
        const dir = params.dir ?? '.';
        const re = globToRegex(params.glob ?? '*');
        const count = walkFiles(root, dir).filter((f) => re.test(f.slice(dir === '.' ? 0 : dir.length + 1))).length;
        return { ok: count >= params.min, detail: `产物数 ${count}（要求 >= ${params.min}）` };
      }
      case 'json-values': {
        const data = JSON.parse(readText(root, params.path));
        for (const [dotPath, expected] of Object.entries(params.expect ?? {})) {
          let cur = data;
          for (const key of dotPath.split('.')) cur = cur?.[key];
          if (JSON.stringify(cur) !== JSON.stringify(expected)) {
            return { ok: false, detail: `${dotPath} 期望 ${JSON.stringify(expected)} 实际 ${JSON.stringify(cur)}` };
          }
        }
        return { ok: true, detail: 'JSON 关键值一致' };
      }
      case 'final-contains':
      case 'final-regex':
      case 'human':
        return { ok: null, detail: '跳过（本自检脚本不处理该 kind，参考解评估时记为 pending）' };
      default:
        throw new Error(`未实现的检查类型：${kind}`);
    }
  } catch (err) {
    return { ok: false, detail: `执行异常：${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// rubric 评估（等价于契约 §4 判定）
// ---------------------------------------------------------------------------
function evaluate(rubric, root) {
  const results = [];
  let humanPending = false;
  for (const check of rubric.checks) {
    if (check.kind === 'human') {
      humanPending = true;
      results.push({ ...check, ok: null });
      continue;
    }
    const res = runCheck(check, root);
    results.push({ ...check, ok: res.ok, detail: res.detail });
  }
  const violations = [];
  for (const rule of rubric.rules) {
    const res = runCheck(rule, root);
    if (!res.ok) violations.push({ id: rule.id, kind: rule.kind, detail: res.detail });
  }
  const scorable = results.filter((r) => r.ok !== null);
  const totalWeight = scorable.reduce((s, r) => s + (r.weight ?? 1), 0);
  const passedWeight = scorable.filter((r) => r.ok).reduce((s, r) => s + (r.weight ?? 1), 0);
  const score = totalWeight > 0 ? passedWeight / totalWeight : null;
  const passed = violations.length === 0 && score !== null && score >= rubric.passThreshold;
  return { results, violations, score, passed, humanPending };
}

// ---------------------------------------------------------------------------
// 工作区模拟：种子 + 参考解 + grading（restore/stage）
// ---------------------------------------------------------------------------
function applyGrading(root, caseJson) {
  const grading = caseJson.grading ?? {};
  for (const p of grading.restore ?? []) {
    const src = join(SEED_DIR, p.replaceAll('/', sepOf()));
    if (existsSync(src)) cpSync(src, join(root, p.replaceAll('/', sepOf())), { recursive: true, force: true });
  }
  for (const st of grading.stage ?? []) {
    const src = join(CASE_DIR, st.from.replaceAll('/', sepOf()));
    if (!existsSync(src)) throw new Error(`grading.stage 源不存在：${st.from}`);
    cpSync(src, join(root, st.to.replaceAll('/', sepOf())), { recursive: true, force: true });
  }
}

function makeRunWorkspace({ withReference }) {
  const tmp = mkdtempSync(join(tmpdir(), 'golden-lit-selfcheck-'));
  cpSync(SEED_DIR, tmp, { recursive: true });
  if (withReference) cpSync(REFERENCE_DIR, tmp, { recursive: true });
  applyGrading(tmp, CASE_JSON);
  return tmp;
}

function printEvaluation(title, evaluation, root) {
  console.log(`\n=== ${title}（workspace=${root}）===`);
  for (const r of evaluation.results) {
    if (r.ok === null) {
      console.log(`  [check] ${r.id.padEnd(4)} ${r.kind.padEnd(14)} w=${r.weight ?? 1} PENDING（人工项，不计入分母）`);
    } else {
      console.log(`  [check] ${r.id.padEnd(4)} ${r.kind.padEnd(14)} w=${r.weight ?? 1} ${r.ok ? 'PASS' : 'FAIL'}  ${r.detail}`);
    }
  }
  for (const rule of RUBRIC.rules) {
    const v = evaluation.violations.find((x) => x.id === rule.id);
    console.log(`  [rule ] ${rule.id.padEnd(4)} ${rule.kind.padEnd(14)} ${v ? 'VIOLATION' : 'PASS'}${v ? `  ${v.detail}` : ''}`);
  }
  console.log(`  score=${evaluation.score === null ? 'null' : evaluation.score.toFixed(3)} passed=${evaluation.passed} humanPending=${evaluation.humanPending}`);
}

function cleanup(tmp) {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const CASE_JSON = readJson(join(CASE_DIR, 'case.json'));
const RUBRIC = readJson(join(CASE_DIR, 'rubric.json'));
const caseIdFromDir = CASE_DIR.split(/[\\/]/).filter(Boolean).pop();

console.log('#'.repeat(78));
console.log(`# 黄金样例自检：${CASE_JSON.id}`);
console.log(`# 工作目录：${CASE_DIR}`);
console.log(`# 说明：本脚本独立实现 docs §4 的检查语义，不 import scripts/golden。`);
console.log('#'.repeat(78));

// --- 1. 元数据校验 ---------------------------------------------------------
console.log('\n--- 1. case.json / rubric.json 合法性 ---');
assert(CASE_JSON.schemaVersion === 1, 'case.json schemaVersion 必须为 1');
assert(CASE_JSON.id === caseIdFromDir, `case.json id（${CASE_JSON.id}）必须与目录名（${caseIdFromDir}）一致`);
assert(CASE_JSON.category === 'literature', 'category 必须为 literature');
assert(typeof CASE_JSON.title === 'string' && CASE_JSON.title.length > 0, 'title 缺失');
assert(typeof CASE_JSON.objective === 'string', 'objective 缺失');
assert(CASE_JSON.objective.includes('materials/'), 'objective 必须指明材料在 materials/ 下');
assert(CASE_JSON.objective.includes('deliverables/'), 'objective 必须指明交付物路径在 deliverables/ 下');
assert(JSON.stringify(CASE_JSON.limits) === JSON.stringify(LIMIT_DEFAULTS), 'limits 必须与契约 §3 默认值完全一致');
assert(JSON.stringify(CASE_JSON.permissions) === JSON.stringify(['read', 'write', 'exec']), 'permissions 必须为 ["read","write","exec"]');
assert(CASE_JSON.deliverableDir === 'deliverables', 'deliverableDir 必须为 deliverables');
assert(Array.isArray(CASE_JSON.materialsGlobs) && CASE_JSON.materialsGlobs.length > 0, 'materialsGlobs 缺失');
assert(CASE_JSON.smoke && CASE_JSON.smoke.minModelCalls >= 1 && CASE_JSON.smoke.minToolCalls >= 1, 'smoke 配置不完整');
assert(typeof CASE_JSON.notes === 'string' && CASE_JSON.notes.length > 0, 'notes 缺失');
const grading = CASE_JSON.grading ?? {};
for (const p of grading.restore ?? []) {
  assert(existsSync(join(SEED_DIR, p.replaceAll('/', sepOf()))), `grading.restore 路径在 workspace 中不存在：${p}`);
}
for (const st of grading.stage ?? []) {
  assert(existsSync(join(CASE_DIR, st.from.replaceAll('/', sepOf()))), `grading.stage 源不存在：${st.from}`);
}
assert(RUBRIC.schemaVersion === 1, 'rubric.json schemaVersion 必须为 1');
assert(typeof RUBRIC.passThreshold === 'number' && RUBRIC.passThreshold > 0 && RUBRIC.passThreshold <= 1, 'passThreshold 非法');
assert(Array.isArray(RUBRIC.checks) && RUBRIC.checks.length > 0, 'checks 为空');
assert(Array.isArray(RUBRIC.rules), 'rules 必须是数组');
const ids = new Set();
let hasHuman = false;
for (const c of RUBRIC.checks) {
  assert(typeof c.id === 'string' && c.id.length > 0, 'check.id 缺失');
  assert(!ids.has(c.id), `check.id 重复：${c.id}`);
  ids.add(c.id);
  assert(CHECK_KINDS.has(c.kind), `未知 check kind：${c.kind}`);
  assert(typeof c.weight === 'number' && c.weight > 0, `check ${c.id} 权重非法`);
  if (c.kind === 'human') hasHuman = true;
}
for (const r of RUBRIC.rules) {
  assert(typeof r.id === 'string' && r.id.length > 0, 'rule.id 缺失');
  assert(!ids.has(r.id), `id 重复：${r.id}`);
  ids.add(r.id);
  assert(CHECK_KINDS.has(r.kind), `未知 rule kind：${r.kind}`);
  assert(r.kind !== 'human', 'rules 中不允许 human');
}
for (const cfg of [...RUBRIC.checks, ...RUBRIC.rules]) {
  const params = cfg.params ?? {};
  for (const key of ['path']) {
    if (params[key]) assert(!params[key].startsWith('/') && !params[key].includes('..'), `${cfg.id}.params.${key} 必须是工作区相对路径`);
  }
}
assert(!hasHuman || RUBRIC.checks.some((c) => c.kind !== 'human'), '不能只有 human 项');
console.log('  元数据校验通过。');

// --- 2. 材料统计与编码校验 ------------------------------------------------
console.log('\n--- 2. workspace/materials 统计 ---');
const materialFiles = walkFiles(SEED_DIR, 'materials');
assert(materialFiles.length > 0, 'materials/ 下没有材料文件');
let totalBytes = 0;
for (const rel of materialFiles) {
  const abs = join(SEED_DIR, rel.replaceAll('/', sepOf()));
  const raw = readFileSync(abs);
  totalBytes += raw.length;
  assert(!(raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf), `${rel} 带 UTF-8 BOM`);
  try { new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { fail(`${rel} 不是合法 UTF-8`); }
}
for (const rel of materialFiles) {
  const size = statSync(join(SEED_DIR, rel.replaceAll('/', sepOf()))).size;
  console.log(`  ${rel.padEnd(44)} ${String(size).padStart(7)} bytes`);
}
console.log(`  材料数=${materialFiles.length}，总字节=${totalBytes}`);
assert(totalBytes <= 300 * 1024, '单 case materials 总字节必须 <= 300KB');

// --- 3. 参考解：必须 100% 通过 -------------------------------------------
console.log('\n--- 3. 负例/正例评估 ---');
const refRoot = makeRunWorkspace({ withReference: true });
const refEval = evaluate(RUBRIC, refRoot);
printEvaluation('参考解（verify/reference）', refEval, refRoot);
const failedChecks = refEval.results.filter((r) => r.ok === false);
assert(refEval.violations.length === 0, `参考解触发 rule 违规：${JSON.stringify(refEval.violations)}`);
assert(failedChecks.length === 0, `参考解未通过机械检查：${failedChecks.map((r) => r.id).join(',')}`);
assert(refEval.score === 1, `参考解机械检查得分应为 1.0，实际 ${refEval.score}`);
assert(refEval.passed === true, '参考解应判定 passed=true');
assert(refEval.humanPending === hasHuman, 'humanPending 标记异常');
cleanup(refRoot);

const emptyRoot = makeRunWorkspace({ withReference: false });
const emptyEval = evaluate(RUBRIC, emptyRoot);
printEvaluation('空输出（只有种子工作区）', emptyEval, emptyRoot);
assert(emptyEval.passed === false, '空输出必须判定 passed=false');
assert(emptyEval.violations.length > 0 || emptyEval.results.some((r) => r.ok === false), '空输出应至少有一项检查失败或违规');
cleanup(emptyRoot);

const protectedRules = RUBRIC.rules.filter((r) => r.kind === 'protected-unchanged');
if (protectedRules.length > 0) {
  const tamperRoot = makeRunWorkspace({ withReference: true });
  const firstPath = protectedRules[0].params.paths[0];
  const firstFile = walkFiles(SEED_DIR, firstPath)[0];
  const tamperAbs = join(tamperRoot, firstFile.replaceAll('/', sepOf()));
  writeFileSync(tamperAbs, readFileSync(tamperAbs, 'utf8') + '\n这行是自检脚本追加的篡改内容。', 'utf8');
  const tamperEval = evaluate(RUBRIC, tamperRoot);
  printEvaluation('受保护文件被篡改（负例）', tamperEval, tamperRoot);
  assert(tamperEval.violations.some((v) => protectedRules.some((r) => r.id === v.id)), '篡改受保护文件必须触发 protected-unchanged 违规');
  assert(tamperEval.passed === false, '篡改受保护文件必须判定 passed=false');
  cleanup(tamperRoot);
}

// --- 4. 结论 --------------------------------------------------------------
console.log('\n' + '='.repeat(78));
if (failures.length === 0) {
  console.log(`SELF-CHECK PASS：${CASE_JSON.id} 参考解 100% 通过 rubric（${RUBRIC.checks.filter((c) => c.kind !== 'human').length} 项机械检查 + ${RUBRIC.rules.length} 条规则），空输出不通过${protectedRules.length > 0 ? '，篡改受保护文件触发违规' : ''}。`);
  process.exit(0);
} else {
  console.log(`SELF-CHECK FAIL：${failures.length} 项断言失败：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
