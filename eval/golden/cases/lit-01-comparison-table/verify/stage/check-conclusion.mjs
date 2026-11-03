import { readFileSync } from 'node:fs';

// held-out 验收脚本：lit-01 的“综合结论”小节必须包含不少于 300 个汉字。
// 评分引擎在 stage 阶段把它复制到运行工作区的 _verify/ 下，cwd 为工作区根目录。
const TARGET = 'deliverables/comparison.md';
const HEADING = '## 综合结论';
const MIN_HAN = 300;

let text;
try {
  text = readFileSync(TARGET, 'utf8');
} catch (err) {
  console.error(`[FAIL] 无法读取 ${TARGET}: ${err.message}`);
  process.exit(1);
}

const start = text.indexOf(HEADING);
if (start < 0) {
  console.error(`[FAIL] 未找到小节标题「${HEADING}」`);
  process.exit(1);
}
const afterHeading = text.slice(start + HEADING.length);
const nextHeadingOffset = afterHeading.search(/\r?\n##\s/);
const body = nextHeadingOffset >= 0 ? afterHeading.slice(0, nextHeadingOffset) : afterHeading;
const hanCount = (body.match(/[\u4e00-\u9fff]/g) || []).length;

if (hanCount < MIN_HAN) {
  console.error(`[FAIL] 「综合结论」正文只有 ${hanCount} 个汉字，要求不少于 ${MIN_HAN} 个`);
  process.exit(1);
}

console.log(`[PASS] 「综合结论」正文汉字数 = ${hanCount}（要求 >= ${MIN_HAN}）`);
