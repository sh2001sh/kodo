// Held-out acceptance check for report-02-meeting-minutes.
// Staged by the runner to workspace/_verify/ after the model run and executed
// with cwd = workspace root. Not visible to the model during the run.
//
// Fails when:
//   - the todo table does not bind each owner to the correct 截止日期
//     (catches swapping owners/dates between rows);
//   - the 决定 section lists fewer than 3 decision items;
//   - there is no verbatim quoted excerpt (>= 10 chars) from the materials.
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

const minutes = readText('deliverables/minutes.md');
if (minutes === null) {
  problems.push('missing deliverables/minutes.md');
} else {
  // 1) owner -> deadline mapping inside the todo table.
  const expected = new Map([
    ['张伟', '2026-11-06'],
    ['陈曦', '2026-11-10'],
    ['刘洋', '2026-11-13'],
    ['王琳', '2026-11-17'],
    ['林可', '2026-11-20'],
  ]);
  const todoTable = parseTables(minutes).find(
    table =>
      table.headers.some(header => normalize(header) === '负责人') &&
      table.headers.some(header => normalize(header) === '截止日期'),
  );
  let mappedRows = 0;
  if (!todoTable) {
    problems.push('minutes.md has no todo table whose headers include 负责人 and 截止日期');
  } else {
    const ownerIndex = todoTable.headers.findIndex(header => normalize(header) === '负责人');
    const dateIndex = todoTable.headers.findIndex(header => normalize(header) === '截止日期');
    const itemIndex = todoTable.headers.findIndex(header => normalize(header) === '事项');
    for (const [owner, deadline] of expected) {
      const row = todoTable.rows.find(cells => normalize(cells[ownerIndex]).includes(owner));
      if (!row) {
        problems.push(`todo table has no row for owner ${owner}`);
        continue;
      }
      const actual = normalize(row[dateIndex]);
      if (actual !== deadline) {
        problems.push(`owner ${owner}: 截止日期 is "${actual}", expected "${deadline}" (owner/date must stay paired)`);
        continue;
      }
      if (itemIndex >= 0 && normalize(row[itemIndex]) === '') {
        problems.push(`owner ${owner}: 事项 column is empty`);
        continue;
      }
      mappedRows += 1;
    }
  }

  // 2) the 决定 section must list at least 3 items.
  const lines = minutes.replace(/\r\n?/gu, '\n').split('\n');
  let decisionHeading = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (/^#{1,6}\s/u.test(line) && /决定/u.test(line)) {
      decisionHeading = index;
      break;
    }
  }
  let decisionCount = 0;
  if (decisionHeading < 0) {
    problems.push('minutes.md has no heading containing 决定');
  } else {
    for (let index = decisionHeading + 1; index < lines.length; index++) {
      const line = lines[index].trim();
      if (/^#{1,6}\s/u.test(line)) break;
      if (/^(?:\d+[.、)]|[-*+])\s+\S/u.test(line) && normalize(line).length >= 8) decisionCount += 1;
    }
    if (decisionCount < 3) {
      problems.push(`minutes.md lists ${decisionCount} item(s) under the 决定 heading, needs >= 3`);
    }
  }

  // 3) at least one verbatim quoted excerpt (>= 10 chars) from materials.
  const materialsDir = path.join(root, 'materials');
  const materialTexts = (fs.existsSync(materialsDir) ? walk(materialsDir) : []).map(file =>
    fs.readFileSync(file, 'utf8'),
  );
  const quotes = [];
  for (const match of minutes.matchAll(/“([^”\n]+)”/gu)) quotes.push(match[1].trim());
  for (const match of minutes.matchAll(/"([^"\n]+)"/gu)) quotes.push(match[1].trim());
  const excerpts = quotes.filter(excerpt => excerpt.length >= 10);
  if (!excerpts.length) {
    problems.push('minutes.md has no quoted excerpt of >= 10 characters');
  }
  for (const excerpt of excerpts) {
    const found = materialTexts.some(text => text.includes(excerpt) || collapse(text).includes(collapse(excerpt)));
    if (!found) problems.push(`quoted excerpt not found verbatim in materials: ${excerpt.slice(0, 40)}`);
  }

  console.log(JSON.stringify({ mappedRows, decisionCount, excerpts: excerpts.length }));
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check-minutes: OK (owner/deadline pairing, decision count and quotes verified)');
