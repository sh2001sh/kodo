// Self-check for sub-01-parallel-vendor-review: the reference deliverables pass
// the held-out checker and every trap mutation fails it.
//   node eval/golden/cases/sub-01-parallel-vendor-review/verify/negative-controls.mjs
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const verifyDir = import.meta.dirname;
const reference = name => readFileSync(path.join(verifyDir, 'reference', name), 'utf8');
const swapRow = (vendor, from, to) => text => text.split('\n').map(line => (line.includes(vendor) && line.startsWith('|') ? line.replace(from, to) : line)).join('\n');

const MUTATIONS = [
  ['xingheng voided first quote', { comparison: swapRow('星衡科技（', '| 116 |', '| 128 |') }],
  ['lanqiao without upkeep', { comparison: swapRow('蓝桥数智（', '134（98 + 三年运维 36）', '98') }],
  ['yuanfan first phase only', { comparison: swapRow('远帆信息（', '18（一期 10 + 二期 8）', '10') }],
  ['cloudway domestic residency', { comparison: swapRow('云途 Cloudway（', '主存储在新加坡（境外），广州仅缓存', '境内（广州）') }],
  ['cloudway marked as meeting all', { comparison: swapRow('云途 Cloudway（', '否（数据驻留不满足）', '是') }],
  ['xingheng marked as failing', { comparison: swapRow('星衡科技（', '| 是 |', '| 否（周期） |') }],
  ['recommends lanqiao', { comparison: text => text.replace('推荐星衡科技：它是', '推荐蓝桥数智：它是') }],
  ['recommends bold cloudway', { comparison: text => text.replace('推荐星衡科技：它是', '推荐**云途 Cloudway**：它是') }],
  ['explains exclusions but recommends nobody', { comparison: text => text.replace('推荐星衡科技：它是', '按“任一项不满足即不予推荐”排除蓝桥数智：它是').replace(/星衡/gu, '某家') }],
  ['duplicate vendor row', { comparison: text => text.replace('| 远帆信息（', '| 星衡科技备选 | 116 | 14 | 99.95% | 境内 | 是 |\n| 远帆信息（') }],
  ['review drops a vendor section', { review: text => text.replace(/## 远帆信息[\s\S]*?(?=## 云途)/u, '') }],
  ['review without quotes', { review: text => text.replace(/“[^”]*”/gu, '原文') }],
  ['nested review section without verdict', { review: text => text.replace('## 蓝桥数智\n', '## 蓝桥数智\n\n### 总价\n').replace(/(## 蓝桥数智[\s\S]*?)(?=## 远帆)/u, section => section.replaceAll('一致', '相符')) }],
];

function check(comparison, review) {
  const root = mkdtempSync(path.join(tmpdir(), 'sub01-'));
  try {
    mkdirSync(path.join(root, 'deliverables'));
    mkdirSync(path.join(root, '_verify'));
    cpSync(path.join(verifyDir, 'stage', 'check-review.mjs'), path.join(root, '_verify', 'check-review.mjs'));
    writeFileSync(path.join(root, 'deliverables', 'comparison.md'), comparison);
    writeFileSync(path.join(root, 'deliverables', 'review.md'), review);
    const result = spawnSync(process.execPath, ['_verify/check-review.mjs'], { cwd: root, encoding: 'utf8' });
    return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let failures = 0;
const base = check(reference('comparison.md'), reference('review.md'));
console.log(`${base.ok ? 'PASS' : 'FAIL'} reference deliverables pass${base.ok ? '' : `: ${base.output}`}`);
if (!base.ok) failures++;
for (const [name, mutation] of MUTATIONS) {
  const comparison = (mutation.comparison ?? (text => text))(reference('comparison.md'));
  const review = (mutation.review ?? (text => text))(reference('review.md'));
  const result = check(comparison, review);
  console.log(`${result.ok ? 'FAIL' : 'PASS'} ${name} is rejected${result.ok ? ' (checker accepted it)' : ''}`);
  if (result.ok) failures++;
}
process.exitCode = failures ? 1 : 0;
