// Held-out acceptance check for report-01-multi-source-summary.
// Staged by the runner to workspace/_verify/ after the model run and executed
// with cwd = workspace root. Not visible to the model during the run.
//
// Fails when:
//   - summary.md is missing or has fewer than 1200 Chinese characters;
//   - it does not cite all 4 materials/ sources (or cites a missing source);
//   - it has fewer than 2 verbatim quoted excerpts (>= 10 chars) from materials;
//   - the first/last week metric values are not bound to the right labels
//     (catches swapping 首周/末周 numbers).
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const problems = [];

const readText = relative => {
  const target = path.join(root, ...relative.split('/'));
  return fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : null;
};

const walk = directory =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap(entry =>
      entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)],
    );

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
const collapse = value => value.replace(/\s+/gu, ' ').trim();

const report = readText('deliverables/summary.md');
if (report === null) {
  problems.push('missing deliverables/summary.md');
} else {
  const cjk = (report.match(/[\u4e00-\u9fff]/gu) ?? []).length;
  if (cjk < 1200) problems.push(`summary.md has ${cjk} Chinese characters, needs >= 1200`);

  const materialsDir = path.join(root, 'materials');
  const materialFiles = fs.existsSync(materialsDir) ? walk(materialsDir) : [];
  const materialTexts = materialFiles.map(file => fs.readFileSync(file, 'utf8'));

  // All 4 sources must be cited; every cited materials/ path must exist.
  const cited = new Set(
    [...report.matchAll(/materials\/([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/gu)].map(match => `materials/${match[1]}`),
  );
  const requiredCitations = [
    'materials/project-brief.md',
    'materials/interview-01.md',
    'materials/interview-02.md',
    'materials/metrics.csv',
  ];
  for (const relative of requiredCitations) {
    if (!cited.has(relative)) problems.push(`summary.md does not cite ${relative} (only found: ${[...cited].join(', ') || 'none'})`);
  }
  for (const relative of cited) {
    if (!fs.existsSync(path.join(root, ...relative.split('/')))) problems.push(`cited source does not exist: ${relative}`);
  }

  // At least 2 verbatim quoted excerpts (>= 10 chars) from the materials.
  const quotes = [];
  for (const match of report.matchAll(/“([^”\n]+)”/gu)) quotes.push(match[1].trim());
  for (const match of report.matchAll(/"([^"\n]+)"/gu)) quotes.push(match[1].trim());
  const excerpts = quotes.filter(excerpt => excerpt.length >= 10);
  if (excerpts.length < 2) {
    problems.push(`summary.md has ${excerpts.length} quoted excerpt(s) of >= 10 characters, needs >= 2`);
  }
  for (const excerpt of excerpts) {
    const found = materialTexts.some(text => text.includes(excerpt) || collapse(text).includes(collapse(excerpt)));
    if (!found) problems.push(`quoted excerpt not found verbatim in materials: ${excerpt.slice(0, 40)}`);
  }

  // P0-3 material consistency: the 8 metrics weeks must sit inside the grazing
  // period stated by project-brief.md (2026-07 .. 2026-09), so the report can
  // quote a period that agrees with both materials.
  const metricsText = readText('materials/metrics.csv');
  if (metricsText === null) {
    problems.push('materials/metrics.csv is missing');
  } else {
    const rows = metricsText.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter(line => line.trim() !== '');
    const dataRows = rows.slice(1);
    if (dataRows.length !== 8) problems.push(`materials/metrics.csv has ${dataRows.length} data rows, expected 8`);
    for (const row of dataRows) {
      const weekStart = row.split(',')[1];
      if (!/^2026-(07|08|09)-\d{2}$/u.test(weekStart ?? '')) {
        problems.push(`materials/metrics.csv week_start ${weekStart} is outside the 2026-07..2026-09 grazing period stated in project-brief.md`);
      }
    }
  }

  // First/last week metric values must be bound to the correct labels.
  const labelDefinitions = [
    { group: 'first', pattern: /首周|第一周|第1周|期初|初期|起始/gu },
    { group: 'last', pattern: /末周|最后一周|第8周|第八周|期末/gu },
  ];
  const labelPositions = [];
  for (const { group, pattern } of labelDefinitions) {
    for (const match of report.matchAll(pattern)) {
      labelPositions.push({ group, start: match.index, end: match.index + match[0].length });
    }
  }
  const nearestLabelGroup = valueIndex => {
    let best = null;
    for (const label of labelPositions) {
      if (label.end <= valueIndex && (!best || label.end > best.end)) best = label;
    }
    return best && valueIndex - best.end <= 120 ? best.group : null;
  };

  const pairings = [
    { value: '52.4', group: 'first', pattern: /52\.4/gu },
    { value: '68.4', group: 'last', pattern: /68\.4/gu },
    { value: '3.86', group: 'first', pattern: /3\.86/gu },
    { value: '4.42', group: 'last', pattern: /4\.42/gu },
  ];
  // Table form (| 指标 | 首周 | 末周 |) is also accepted.
  const satisfiedByTable = new Set();
  for (const table of parseTables(report)) {
    const firstIndex = table.headers.findIndex(header => /首周|第一周|第1周/gu.test(normalize(header)));
    const lastIndex = table.headers.findIndex(header => /末周|最后一周|第8周/gu.test(normalize(header)));
    if (firstIndex < 0 || lastIndex < 0) continue;
    for (const row of table.rows) {
      const rowLabel = normalize(row[0]);
      const cell = columnIndex => normalize(row[columnIndex]);
      if (/拦截|deflection/iu.test(rowLabel)) {
        if (cell(firstIndex).includes('52.4')) satisfiedByTable.add('52.4');
        if (cell(lastIndex).includes('68.4')) satisfiedByTable.add('68.4');
      }
      if (/csat|满意度/iu.test(rowLabel)) {
        if (cell(firstIndex).includes('3.86')) satisfiedByTable.add('3.86');
        if (cell(lastIndex).includes('4.42')) satisfiedByTable.add('4.42');
      }
    }
  }
  for (const pairing of pairings) {
    if (satisfiedByTable.has(pairing.value)) continue;
    const occurrences = [...report.matchAll(pairing.pattern)].map(match => match.index);
    if (!occurrences.length) {
      problems.push(`summary.md is missing metrics value ${pairing.value}`);
      continue;
    }
    const correctlyLabelled = occurrences.some(index => nearestLabelGroup(index) === pairing.group);
    if (!correctlyLabelled) {
      const expectedLabel = pairing.group === 'first' ? '首周' : '末周';
      problems.push(`metrics value ${pairing.value} is not bound to ${expectedLabel} (nearest preceding label does not match)`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check-report: OK (length, citations, quotes and first/last week binding verified)');
