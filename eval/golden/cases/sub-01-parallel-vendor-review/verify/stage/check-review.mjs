// Held-out acceptance check for sub-01-parallel-vendor-review.
// Staged by the runner to workspace/_verify/ after the model run and executed
// with cwd = workspace root. Not visible to the model during the run.
//
// Fails when:
//   - comparison.md has no table with the required headers, or a vendor is
//     missing or appears twice;
//   - a vendor's total / delivery weeks / SLA / residency disagrees with the
//     final terms (catches the voided first quote 128, B's 98 without upkeep,
//     C's 10 + 8 phases, D's Singapore primary storage);
//   - the "meets all hard requirements" cell is not 是 for 星衡 and 否 for the rest;
//   - the 推荐 section does not recommend 星衡 or recommends another vendor;
//   - review.md lacks a section per vendor with a verdict and a quoted excerpt.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const problems = [];

const readText = relative => {
  const target = path.join(root, ...relative.split('/'));
  return fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8').replace(/\r\n?/gu, '\n') : null;
};

const splitRow = line =>
  line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.replace(/[`*]/gu, '').trim());
const isSeparator = cells => cells.every(cell => /^:?-{2,}:?$/u.test(cell.replace(/\s/gu, '')));

function parseTables(text) {
  const lines = text.split('\n');
  const tables = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim().startsWith('|')) continue;
    const block = [];
    let cursor = index;
    while (cursor < lines.length && lines[cursor].trim().startsWith('|')) block.push(lines[cursor++]);
    if (block.length >= 2 && isSeparator(splitRow(block[1]))) tables.push({ headers: splitRow(block[0]), rows: block.slice(2).map(splitRow) });
    index = cursor;
  }
  return tables;
}

const VENDORS = [
  { key: 'xingheng', names: ['星衡'], totals: ['116'], weeks: '14', sla: '99.95', residency: /境内|杭州|北京/u, meets: true },
  { key: 'lanqiao', names: ['蓝桥'], totals: ['134'], weeks: '12', sla: '99.9', residency: /境内|上海/u, meets: false },
  { key: 'yuanfan', names: ['远帆'], totals: ['109'], weeks: '18', sla: '99.9', residency: /境内|深圳/u, meets: false },
  { key: 'cloudway', names: ['云途', 'Cloudway'], totals: ['102'], weeks: '15', sla: '99.99', residency: /新加坡|境外/u, meets: false },
];
const HEADERS = ['供应商', '含三年运维总价（万元）', '交付周期（周）', 'SLA', '数据驻留', '是否满足全部硬性要求'];
const normalize = value => value.replace(/\s+/gu, '').replace(/\(/gu, '（').replace(/\)/gu, '）');
const numbersIn = cell => cell.match(/\d+(?:\.\d+)?/gu) ?? [];

const comparison = readText('deliverables/comparison.md');
if (comparison === null) problems.push('deliverables/comparison.md is missing');
else {
  const table = parseTables(comparison).find(candidate => HEADERS.every(header => candidate.headers.map(normalize).includes(normalize(header))));
  if (!table) problems.push(`comparison.md has no table with headers ${HEADERS.join(' | ')}`);
  else {
    const column = header => table.headers.map(normalize).indexOf(normalize(header));
    const [vendorCol, totalCol, weeksCol, slaCol, residencyCol, meetsCol] = HEADERS.map(column);
    for (const vendor of VENDORS) {
      const rows = table.rows.filter(row => vendor.names.some(name => (row[vendorCol] ?? '').includes(name)));
      if (rows.length !== 1) { problems.push(`${vendor.key}: expected exactly one table row, found ${rows.length}`); continue; }
      const row = rows[0];
      const totals = numbersIn(row[totalCol] ?? '');
      if (!vendor.totals.some(total => totals.includes(total))) problems.push(`${vendor.key}: total cell "${row[totalCol]}" lacks ${vendor.totals.join('/')}`);
      if (vendor.key === 'xingheng' && totals.includes('128') && !totals.includes('116')) problems.push('xingheng: uses the voided first-round quote 128');
      const weeks = numbersIn(row[weeksCol] ?? '');
      if (!weeks.includes(vendor.weeks)) problems.push(`${vendor.key}: delivery cell "${row[weeksCol]}" lacks ${vendor.weeks}`);
      if (!numbersIn(row[slaCol] ?? '').includes(vendor.sla)) problems.push(`${vendor.key}: SLA cell "${row[slaCol]}" lacks ${vendor.sla}`);
      if (!vendor.residency.test(row[residencyCol] ?? '')) problems.push(`${vendor.key}: residency cell "${row[residencyCol]}" does not match ${vendor.residency}`);
      if (vendor.key === 'cloudway' && /^境内/u.test(row[residencyCol] ?? '')) problems.push('cloudway: residency cell claims domestic storage');
      const meets = (row[meetsCol] ?? '').trim();
      if (vendor.meets ? !meets.startsWith('是') : !meets.startsWith('否')) problems.push(`${vendor.key}: meets-all cell "${meets}" should start with ${vendor.meets ? '是' : '否'}`);
    }
  }
  const recommendation = comparison.split(/^##\s*推荐\s*$/mu)[1];
  if (recommendation === undefined) problems.push('comparison.md has no "## 推荐" section');
  else {
    const section = recommendation.split(/^##\s/mu)[0];
    if (!section.includes('星衡')) problems.push('推荐 section does not recommend 星衡科技');
    if (/推荐[^。\n]{0,12}(蓝桥|远帆|云途|Cloudway)/u.test(section)) problems.push('推荐 section recommends a vendor that fails a hard requirement');
  }
}

const review = readText('deliverables/review.md');
if (review === null) problems.push('deliverables/review.md is missing');
else {
  const headings = [...review.matchAll(/^#{2,4}\s.*$/gmu)].map(match => ({ title: match[0], index: match.index }));
  for (const vendor of VENDORS) {
    const heading = headings.find(entry => vendor.names.some(name => entry.title.includes(name)));
    if (!heading) { problems.push(`review.md has no section heading for ${vendor.key}`); continue; }
    const next = headings.find(entry => entry.index > heading.index);
    const body = review.slice(heading.index, next ? next.index : review.length);
    if (!/一致/u.test(body)) problems.push(`review.md section for ${vendor.key} has no 一致/不一致 verdict`);
    const quotes = [...body.matchAll(/“([^”\n]{10,})”/gu)];
    if (!quotes.length) problems.push(`review.md section for ${vendor.key} quotes no source sentence`);
    if (!/materials\/[\w.-]+\.md/u.test(body)) problems.push(`review.md section for ${vendor.key} names no materials/ source path`);
  }
}

if (problems.length) {
  for (const problem of problems) console.error(`FAIL ${problem}`);
  process.exit(1);
}
console.log('OK comparison.md and review.md match the final vendor terms');
