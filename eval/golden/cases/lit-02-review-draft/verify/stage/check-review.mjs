import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// held-out 验收脚本（lit-02）：篇幅、二级章节、研究空白小节、标题真实性。
// 评分引擎在 stage 阶段把它复制到运行工作区的 _verify/ 下，cwd 为工作区根目录。
const TARGET = 'deliverables/review.md';
const MIN_HAN = 800;
const MAX_HAN = 1200;
const MIN_GAP_HAN = 150;

const errors = [];
const han = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

function walkMaterialFiles(root, rel = '') {
  const out = [];
  const abs = rel ? join(root, rel) : root;
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkMaterialFiles(root, childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out;
}

let text;
try {
  text = readFileSync(TARGET, 'utf8');
} catch (err) {
  console.error(`[FAIL] 无法读取 ${TARGET}: ${err.message}`);
  process.exit(1);
}
const lines = text.split(/\r?\n/);

// 1) 正文字数（不含 Markdown 标题行）
const bodyHan = han(lines.filter((l) => !/^\s*#{1,6}\s/.test(l)).join('\n'));
if (bodyHan < MIN_HAN || bodyHan > MAX_HAN) {
  errors.push(`正文汉字数 ${bodyHan} 不在要求区间 [${MIN_HAN}, ${MAX_HAN}]`);
}

// 2) 至少 4 个二级小节
const h2 = lines.filter((l) => /^##\s+\S/.test(l));
if (h2.length < 4) errors.push(`二级小节只有 ${h2.length} 个，要求至少 4 个`);

// 3) 标题含“研究空白”的二级小节，正文不少于 150 汉字
let gapIndex = -1;
let gapHan = 0;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^##\s+(.*)$/);
  if (m && m[1].includes('研究空白')) { gapIndex = i; break; }
}
if (gapIndex < 0) {
  errors.push('缺少标题中包含“研究空白”的二级小节');
} else {
  let gapBody = '';
  for (let i = gapIndex + 1; i < lines.length; i++) {
    if (/^\s*#{1,6}\s/.test(lines[i])) break;
    gapBody += lines[i] + '\n';
  }
  gapHan = han(gapBody);
  if (gapHan < MIN_GAP_HAN) errors.push(`“研究空白”小节正文只有 ${gapHan} 个汉字，要求 >= ${MIN_GAP_HAN}`);
}

// 4) 标题真实性：文中所有《…》标题必须逐字出现在 materials/ 某份材料中
const materialTexts = [];
for (const rel of walkMaterialFiles('.', 'materials')) {
  try { materialTexts.push(readFileSync(rel, 'utf8')); } catch { /* 跳过非 UTF-8 文件 */ }
}
const titles = [...text.matchAll(/《([^》\n]{2,80})》/g)].map((m) => m[1]);
for (const title of titles) {
  if (!materialTexts.some((src) => src.includes(title))) {
    errors.push(`疑似编造标题：《${title}》在 materials/ 中找不到逐字匹配`);
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`[FAIL] ${e}`);
  process.exit(1);
}
console.log(`[PASS] 正文汉字数=${bodyHan}（要求 ${MIN_HAN}–${MAX_HAN}）；二级小节=${h2.length}；研究空白小节=${gapHan} 汉字；《》标题 ${titles.length} 个均可在 materials 中逐字核对`);
