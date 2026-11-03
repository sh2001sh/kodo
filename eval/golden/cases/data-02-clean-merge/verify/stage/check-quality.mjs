// Held-out acceptance check for data-02-clean-merge.
// Staged by the runner to workspace/_verify/ after the model run and executed
// with cwd = workspace root. Not visible to the model during the run.
//
// Fails when:
//   - deliverables/merged.csv is missing, lacks a column, has != 275 data rows,
//     or has duplicate order_id values;
//   - deliverables/data-quality.md does not bind each required count (320 / 8 / 12 /
//     25 / 275) to its reason: if a 项目/行数 table exists its cells must be bound
//     exactly (catches swapping the A/B/C labels); otherwise each label and its
//     count must share a line.
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const problems = [];
const EXPECTED_ROWS = 275;
const COLUMNS = [
  'order_id',
  'order_date',
  'customer_id',
  'customer_name',
  'product_id',
  'product_name',
  'category',
  'quantity',
  'unit_price',
  'total_amount',
];
const BINDINGS = [
  { label: '原始行数 320', pattern: /原始/u, count: 320 },
  { label: 'order_id 为空剔除 8', pattern: /order_id.*空|空.*order_id|缺失.*order_id|order_id.*缺失/u, count: 8 },
  { label: 'order_id 重复移除 12', pattern: /重复|去重/u, count: 12 },
  { label: '无效外键剔除 25', pattern: /外键|关联/u, count: 25 },
  { label: '最终行数 275', pattern: /最终|合并后/u, count: 275 },
];

const readText = relative => {
  const target = path.join(root, ...relative.split('/'));
  return fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : null;
};

const splitRow = line =>
  line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.replace(/[`*]/gu, '').trim());
const isSeparator = cells => cells.every(cell => /^:?-{2,}:?$/u.test(cell.replace(/\s/gu, '')));
const normalize = cell => String(cell ?? '').replace(/[`*\s]/gu, '').trim();

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

// 1) merged.csv structure and exact row count.
const merged = readText('deliverables/merged.csv');
if (merged === null) {
  problems.push('missing deliverables/merged.csv');
} else {
  const lines = merged.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter(line => line.trim() !== '');
  const header = (lines[0] ?? '').split(',').map(cell => cell.trim());
  for (const column of COLUMNS) {
    if (!header.includes(column)) problems.push(`merged.csv missing column ${column}`);
  }
  const rows = lines.slice(1);
  if (rows.length !== EXPECTED_ROWS) {
    problems.push(`merged.csv has ${rows.length} data rows, expected ${EXPECTED_ROWS}`);
  }
  const ids = rows.map(row => row.split(',')[0]);
  if (new Set(ids).size !== ids.length) problems.push('merged.csv has duplicate order_id values');
}

// 2) data-quality.md count/label binding.
const quality = readText('deliverables/data-quality.md');
if (quality === null) {
  problems.push('missing deliverables/data-quality.md');
} else {
  const lines = quality.replace(/^\uFEFF/u, '').split(/\r?\n/u);
  const hasBoundCount = (labelPattern, count) => {
    const number = new RegExp(`(^|[^0-9])${count}([^0-9]|$)`, 'u');
    return lines.some(line => labelPattern.test(line) && number.test(line));
  };
  for (const binding of BINDINGS) {
    if (!hasBoundCount(binding.pattern, binding.count)) {
      problems.push(`data-quality.md does not bind "${binding.label}" (label and count must share a line)`);
    }
  }

  // Stronger binding for the overview table: | 项目 | 行数 | + count cells.
  const overview = parseTables(quality).find(
    table =>
      table.headers.some(header => normalize(header) === '项目') &&
      table.headers.some(header => normalize(header) === '行数'),
  );
  if (overview) {
    const labelIndex = overview.headers.findIndex(header => normalize(header) === '项目');
    const countIndex = overview.headers.findIndex(header => normalize(header) === '行数');
    for (const binding of BINDINGS) {
      const row = overview.rows.find(cells => binding.pattern.test(cells[labelIndex] ?? ''));
      if (!row) {
        problems.push(`data-quality.md overview table has no row matching "${binding.label}"`);
        continue;
      }
      const actual = normalize(row[countIndex]);
      if (actual !== String(binding.count)) {
        problems.push(
          `data-quality.md overview table: row "${binding.label}" has count "${actual}", expected "${binding.count}" (labels must bind to their own counts)`,
        );
      }
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check-quality: OK (275 rows, count/label bindings verified)');
