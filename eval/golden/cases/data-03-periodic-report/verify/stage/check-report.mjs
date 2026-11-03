// Held-out acceptance check for data-03-periodic-report.
// Staged by the runner to workspace/_verify/ after the model run and executed
// with cwd = workspace root. Not visible to the model during the run.
//
// Fails when the Markdown tables do not bind each month/category label to its
// expected total (catches swapped month labels and wrong figures) or when the
// MoM column does not match the expected percentages.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const problems = [];

const readText = relative => {
  const target = path.join(root, ...relative.split('/'));
  return fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : null;
};

const splitRow = line =>
  line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.replace(/[`*]/gu, '').trim());
const isSeparator = cells => cells.every(cell => /^:?-{2,}:?$/u.test(cell.replace(/\s/gu, '')));

function parseTables(text) {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const tables = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trim().startsWith('|')) {
      index += 1;
      continue;
    }
    const block = [];
    let cursor = index;
    while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
      block.push(lines[cursor]);
      cursor += 1;
    }
    if (block.length >= 2) {
      const headers = splitRow(block[0]);
      if (isSeparator(splitRow(block[1]))) {
        const rows = block
          .slice(2)
          .map(splitRow)
          .filter(row => row.some(cell => cell !== ''));
        tables.push({ headers, rows });
      }
    }
    index = cursor;
  }
  return tables;
}

const normalize = cell => String(cell ?? '').replace(/[`*\s]/gu, '').trim();

const report = readText('deliverables/monthly-report.md');
if (report === null) {
  problems.push('missing deliverables/monthly-report.md');
} else {
  const tables = parseTables(report);

  const expectedMonths = new Map([
    ['2026-07', { total: '114325.16', mom: '—' }],
    ['2026-08', { total: '110368.29', mom: '-3.46%' }],
    ['2026-09', { total: '97463.51', mom: '-11.69%' }],
  ]);
  const monthTable = tables.find(
    table =>
      table.headers.some(header => normalize(header) === '月份') &&
      table.headers.some(header => normalize(header) === '合计'),
  );
  if (!monthTable) {
    problems.push('monthly-report.md has no table whose headers include 月份 and 合计');
  } else {
    const monthIndex = monthTable.headers.findIndex(header => normalize(header) === '月份');
    const totalIndex = monthTable.headers.findIndex(header => normalize(header) === '合计');
    const momIndex = monthTable.headers.findIndex(header => normalize(header) === '环比');
    for (const [month, expected] of expectedMonths) {
      const row = monthTable.rows.find(cells => normalize(cells[monthIndex]).includes(month));
      if (!row) {
        problems.push(`month table has no row for ${month}`);
        continue;
      }
      const total = normalize(row[totalIndex]);
      if (total !== expected.total) {
        problems.push(`month ${month}: 合计 is "${total}", expected "${expected.total}" (label must bind to its value)`);
      }
      if (momIndex >= 0) {
        const mom = normalize(row[momIndex]);
        if (mom !== normalize(expected.mom)) {
          problems.push(`month ${month}: 环比 is "${mom}", expected "${expected.mom}"`);
        }
      }
    }
  }

  const expectedCategories = new Map([
    ['办公用品', '96274.26'],
    ['差旅', '63106.90'],
    ['技术服务', '75320.31'],
    ['市场推广', '54236.13'],
    ['其他', '33219.36'],
  ]);
  const categoryTable = tables.find(
    table =>
      table.headers.some(header => normalize(header) === '类别') &&
      table.headers.some(header => normalize(header) === '合计'),
  );
  if (!categoryTable) {
    problems.push('monthly-report.md has no table whose headers include 类别 and 合计');
  } else {
    const categoryIndex = categoryTable.headers.findIndex(header => normalize(header) === '类别');
    const totalIndex = categoryTable.headers.findIndex(header => normalize(header) === '合计');
    for (const [category, expectedTotal] of expectedCategories) {
      const row = categoryTable.rows.find(cells => normalize(cells[categoryIndex]).includes(category));
      if (!row) {
        problems.push(`category table has no row for ${category}`);
        continue;
      }
      const total = normalize(row[totalIndex]);
      if (total !== expectedTotal) {
        problems.push(`category ${category}: 合计 is "${total}", expected "${expectedTotal}"`);
      }
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check-report: OK (month and category tables bind labels to values)');
