import { readFileSync } from 'node:fs';

// held-out 验收脚本（lit-04）：逐条核验 5 条导师意见的机械可验证部分。
// 评分引擎在 stage 阶段把它复制到运行工作区的 _verify/ 下，cwd 为工作区根目录。
const TARGET = 'deliverables/revised.md';
const HEADINGS = [
  '## 摘要',
  '## 1 引言',
  '## 2 方法',
  '## 3 实验',
  '## 4 讨论',
  '## 5 局限与未来工作',
  '## 6 结论'
];
const MIN_ABSTRACT_HAN = 60;
const MAX_ABSTRACT_HAN = 180;
const MIN_LIMIT_BULLETS = 3;
const MIN_LIMIT_HAN = 100;

const errors = [];
const han = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;

let text;
try {
  text = readFileSync(TARGET, 'utf8');
} catch (err) {
  console.error(`[FAIL] 无法读取 ${TARGET}: ${err.message}`);
  process.exit(1);
}
const lines = text.split(/\r?\n/);

// 意见 4：章节顺序 —— 7 个标题必须存在，且按给定顺序出现
const positions = HEADINGS.map((h) => text.indexOf(h));
HEADINGS.forEach((h, i) => {
  if (positions[i] < 0) errors.push(`缺少章节标题：${h}`);
});
if (positions.every((p) => p >= 0)) {
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] <= positions[i - 1]) {
      errors.push(`章节顺序错误：${HEADINGS[i]} 应出现在 ${HEADINGS[i - 1]} 之后`);
    }
  }
}

// 按二级标题切分小节
function sectionBody(heading) {
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return null;
  let body = '';
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) break;
    body += lines[i] + '\n';
  }
  return body;
}

// 意见 5：摘要压缩到 180 个汉字以内
const abstract = sectionBody('## 摘要');
const abstractHan = abstract === null ? -1 : han(abstract);
if (abstract === null) {
  errors.push('缺少「## 摘要」小节');
} else if (abstractHan < MIN_ABSTRACT_HAN || abstractHan > MAX_ABSTRACT_HAN) {
  errors.push(`摘要汉字数 ${abstractHan} 不在要求区间 [${MIN_ABSTRACT_HAN}, ${MAX_ABSTRACT_HAN}]`);
}

// 意见 1：局限与未来工作小节 ≥3 条无序列表项
const limits = sectionBody('## 5 局限与未来工作');
let bulletCount = 0;
if (limits === null) {
  errors.push('缺少「## 5 局限与未来工作」小节');
} else {
  bulletCount = limits.split(/\r?\n/).filter((l) => /^\s*-\s+\S/.test(l)).length;
  if (bulletCount < MIN_LIMIT_BULLETS) {
    errors.push(`局限小节只有 ${bulletCount} 条以「- 」开头的列表项，要求至少 ${MIN_LIMIT_BULLETS} 条`);
  }
  const limitHan = han(limits);
  if (limitHan < MIN_LIMIT_HAN) {
    errors.push(`局限小节正文只有 ${limitHan} 个汉字，要求至少 ${MIN_LIMIT_HAN} 个`);
  }
}

// 意见 2：结论必须修正（引用准确率更高、ROUGE-L 略低），且全文不得出现原过度声称
const conclusion = sectionBody('## 6 结论');
if (conclusion === null) {
  errors.push('缺少「## 6 结论」小节');
} else {
  if (!conclusion.includes('引用准确率')) errors.push('结论未写明引用准确率');
  if (!conclusion.includes('ROUGE-L')) errors.push('结论未写明 ROUGE-L');
  if (!/(略低|低于)/.test(conclusion)) errors.push('结论未写明 ROUGE-L 略低/低于');
}
if (/(全面优于|显著优于)/.test(text)) errors.push('正文仍出现「全面优于」或「显著优于」');

// 意见 3：引言与讨论中各引用一次 paper-2 的真实路径
const intro = sectionBody('## 1 引言');
const discussion = sectionBody('## 4 讨论');
if (intro === null || !intro.includes('materials/paper-2-iterwrite.md')) {
  errors.push('引言缺少对 materials/paper-2-iterwrite.md 的引用');
}
if (discussion === null || !discussion.includes('materials/paper-2-iterwrite.md')) {
  errors.push('讨论缺少对 materials/paper-2-iterwrite.md 的引用');
}

if (errors.length > 0) {
  for (const e of errors) console.error(`[FAIL] ${e}`);
  process.exit(1);
}
console.log(`[PASS] 章节顺序正确；摘要 ${abstractHan} 汉字（<=${MAX_ABSTRACT_HAN}）；局限小节 ${bulletCount} 条列表项；结论已按要求修正；引言与讨论均引用 paper-2`);
