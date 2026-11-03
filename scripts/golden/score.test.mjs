import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buffer } from 'node:buffer';
import { GoldenError } from './errors.mjs';
import {
  CHECK_KINDS, collectRequirements, compareProtected, evaluateRubric, extractCitedPaths,
  extractQuotedExcerpts, globToRegExp, matchGlob, parseCsv, parseMarkdownTables, validateRubric,
} from './score.mjs';

const makeReader = files => ({
  readFile: file => (file in files ? files[file] : null),
  listFiles: () => Object.keys(files).sort(),
  statFile: file => (file in files ? { size: Buffer.byteLength(files[file], 'utf8') } : null),
});

const evaluate = (rubric, files, extra = {}) => evaluateRubric({
  rubric,
  ...makeReader(files),
  finalText: extra.finalText ?? '',
  human: extra.human ?? {},
  protectedResults: extra.protectedResults ?? {},
  commandResults: extra.commandResults ?? {},
});

const check = (id, kind, params, weight = 1) => ({ id, kind, weight, params });
const rule = (id, kind, params) => ({ id, kind, params });

const REFERENCE_FILES = {
  'materials/paper-a.md': '# AlphaNet\nAlphaNet reports Accuracy of 91.4 in the held-out split.\nWe train for 24 hours on a single node.\n',
  'materials/notes.md': 'supplementary notes for the survey\n',
  'deliverables/brief.md': [
    '# Brief',
    '',
    'AlphaNet reports Accuracy of 91.4 on the held-out split.',
    'Source: materials/paper-a.md, materials/notes.md.',
    'The authors state: "We train for 24 hours on a single node."',
    'Conclusion: AlphaNet is the more accurate method.',
  ].join('\n'),
  'deliverables/table.csv': 'region,total_sales,mean_sales\nNorth,100,50\nSouth,84.7,42.35\n',
  'deliverables/table.md': '| Region | Total Sales |\n| --- | --- |\n| North | 100 |\n| South | 84.7 |\n',
  'deliverables/data.json': JSON.stringify({ tests: { alpha: true, beta: false }, summary: { rows: [1, 2, 3], name: 'golden' } }),
};
const REFERENCE_FINAL = 'Task complete: AlphaNet is more accurate. Summary written to deliverables/brief.md.';

function referenceRubric() {
  return {
    schemaVersion: 1,
    passThreshold: 0.9,
    rules: [
      rule('R1', 'citation-sources', { path: 'deliverables/brief.md', allowedRoots: ['materials'], requireExcerpt: true }),
      rule('R2', 'protected-unchanged', { paths: ['materials'] }),
    ],
    checks: [
      check('C01', 'file-exists', { path: 'deliverables/brief.md', minBytes: 80 }),
      check('C02', 'file-contains', { path: 'deliverables/brief.md', all: ['AlphaNet', 'Accuracy'], any: ['91.4', '92'], none: ['Lorem ipsum'] }),
      check('C03', 'final-contains', { all: ['complete'], none: ['failed'] }),
      check('C04', 'final-regex', { patterns: [{ pattern: 'alpha\\s*net', flags: 'i' }, 'deliverables/brief\\.md'] }),
      check('C05', 'csv-columns', { path: 'deliverables/table.csv', required: ['region', 'total_sales'] }),
      check('C06', 'csv-rows', { path: 'deliverables/table.csv', minRows: 2, maxRows: 3 }),
      check('C07', 'csv-cell', { path: 'deliverables/table.csv', where: { region: 'South' }, expect: { total_sales: 84.7, mean_sales: 42.35 }, tolerance: 0.001 }),
      check('C08', 'markdown-table', { path: 'deliverables/table.md', requiredHeaders: ['Region', 'Total Sales'], minRows: 2 }),
      check('C09', 'json-values', { path: 'deliverables/data.json', expect: { 'tests.alpha': true, 'summary.rows.2': 3, 'summary.name': 'golden' } }),
      check('C10', 'artifact-count', { dir: 'deliverables', glob: '*.md', min: 1 }),
    ],
  };
}

test('a reference solution passes every implemented check kind with score 1', () => {
  const result = evaluate(referenceRubric(), REFERENCE_FILES, {
    finalText: REFERENCE_FINAL,
    protectedResults: { R2: compareProtected({ files: { 'materials/paper-a.md': 'aaa' }, missing: [] }, { files: { 'materials/paper-a.md': 'aaa' }, missing: [] }) },
  });
  assert.equal(result.passed, true);
  assert.equal(result.score, 1);
  assert.equal(result.humanPending, false);
  assert.deepEqual(result.violations, []);
  assert.equal(result.counts.failed, 0);
  assert.equal(result.checks.length, 10);
  assert.equal(result.rules.length, 2);
});

test('an empty output fails the same rubric instead of passing vacuously', () => {
  const result = evaluate(referenceRubric(), { 'materials/paper-a.md': REFERENCE_FILES['materials/paper-a.md'] }, {
    finalText: '',
    protectedResults: { R2: { ok: true, added: [], removed: [], modified: [], seedMissing: [], runMissing: [] } },
  });
  assert.equal(result.passed, false);
  assert.equal(result.score, 0);
  assert.ok(result.checks.every(entry => entry.status === 'failed'));
  assert.ok(result.violations.length >= 1, 'citation-sources fails when the deliverable is missing');
});

test('unknown check kinds are evaluation errors, not sample failures', () => {
  assert.throws(
    () => validateRubric({ schemaVersion: 1, passThreshold: 0.9, checks: [{ id: 'X', kind: 'gpu-vibes', params: {} }], rules: [] }),
    error => error instanceof GoldenError && error.code === 'RUBRIC_UNKNOWN_KIND' && /gpu-vibes/u.test(error.message),
  );
  assert.throws(
    () => evaluateRubric({ rubric: { schemaVersion: 1, passThreshold: 0.9, checks: [{ id: 'X', kind: 'nope' }], rules: [] }, ...makeReader({}) }),
    error => error instanceof GoldenError && error.code === 'RUBRIC_UNKNOWN_KIND',
  );
  assert.ok(CHECK_KINDS.includes('csv-cell') && CHECK_KINDS.includes('human'));
});

test('a rule violation fails the run no matter how high the weighted score is', () => {
  const rubric = {
    schemaVersion: 1,
    passThreshold: 0.1,
    rules: [rule('R1', 'final-contains', { none: ['fabricated'] })],
    checks: [check('C1', 'final-contains', { all: ['complete'] })],
  };
  const result = evaluate(rubric, {}, { finalText: 'complete, but a fabricated citation appears' });
  assert.equal(result.score, 1);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].id, 'R1');
  assert.equal(result.passed, false);
});

test('human checks are excluded from the denominator until answered, then weighted normally', () => {
  const rubric = {
    schemaVersion: 1,
    passThreshold: 0.5,
    rules: [],
    checks: [check('C1', 'file-exists', { path: 'out.txt' }, 1), check('H1', 'human', { question: 'ok?' }, 99)],
  };
  const files = { 'out.txt': 'done' };
  const pending = evaluate(rubric, files);
  assert.equal(pending.humanPending, true);
  assert.equal(pending.score, 1);
  assert.equal(pending.passed, true);
  const failed = evaluate(rubric, files, { human: { H1: false } });
  assert.equal(failed.humanPending, false);
  assert.equal(failed.score, 1 / 100);
  assert.equal(failed.passed, false);
});

test('weighted score divides passed weight by evaluated weight', () => {
  const rubric = {
    schemaVersion: 1, passThreshold: 0.5, rules: [],
    checks: [check('A', 'file-exists', { path: 'present.txt' }, 1), check('B', 'file-exists', { path: 'missing.txt' }, 3)],
  };
  const result = evaluate(rubric, { 'present.txt': 'x' });
  assert.equal(result.passedWeight, 1);
  assert.equal(result.evaluatedWeight, 4);
  assert.equal(result.score, 0.25);
});

test('file-exists supports globs and minBytes', () => {
  const rubric = {
    schemaVersion: 1, passThreshold: 1, rules: [],
    checks: [check('A', 'file-exists', { path: 'reports/*.md', minBytes: 5 })],
  };
  assert.equal(evaluate(rubric, { 'reports/one.md': 'long enough' }).passed, true);
  assert.equal(evaluate(rubric, { 'reports/one.md': 'x' }).passed, false);
  assert.equal(evaluate(rubric, { 'reports/sub/two.md': 'long enough' }).passed, false);
  assert.equal(evaluate(rubric, { 'reports/sub/two.md': 'long enough' }).checks[0].reasons[0], 'no file matches reports/*.md');
});

test('csv checks handle quoting, ranges and numeric tolerance', () => {
  const files = { 'data/out.csv': '\uFEFFregion,value,note\n"North, west",84.7,"say ""hi"""\nSouth,90,ok\n' };
  const columns = evaluate({ schemaVersion: 1, checks: [check('A', 'csv-columns', { path: 'data/out.csv', required: ['region', 'value', 'note'] })], rules: [] }, files);
  assert.equal(columns.passed, true);
  const rows = evaluate({ schemaVersion: 1, checks: [check('A', 'csv-rows', { path: 'data/out.csv', minRows: 3 })], rules: [] }, files);
  assert.equal(rows.passed, false);
  const cell = evaluate({ schemaVersion: 1, checks: [check('A', 'csv-cell', { path: 'data/out.csv', where: { region: 'North, west' }, expect: { value: 84.7 }, tolerance: 0.001 })], rules: [] }, files);
  assert.equal(cell.passed, true);
  const quoted = evaluate({ schemaVersion: 1, checks: [check('A', 'csv-cell', { path: 'data/out.csv', where: { region: 'North, west' }, expect: { note: 'say "hi"' } })], rules: [] }, files);
  assert.equal(quoted.passed, true);
  const strict = evaluate({ schemaVersion: 1, checks: [check('A', 'csv-cell', { path: 'data/out.csv', where: { region: 'South' }, expect: { value: '90.0' } })], rules: [] }, files);
  assert.equal(strict.passed, false);
  const toleranceMiss = evaluate({ schemaVersion: 1, checks: [check('A', 'csv-cell', { path: 'data/out.csv', where: { region: 'South' }, expect: { value: 91 }, tolerance: 0.5 })], rules: [] }, files);
  assert.equal(toleranceMiss.passed, false);
});

test('markdown-table normalizes headers and requires the row count', () => {
  const files = { 'out/report.md': 'intro\n\n| **Method** | `Accuracy` |\n|:--|--:|\n| A | 91 |\n| B | 88 |\n\ntail\n' };
  const tables = parseMarkdownTables(files['out/report.md']);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].headers, ['method', 'accuracy']);
  const pass = evaluate({ schemaVersion: 1, checks: [check('A', 'markdown-table', { path: 'out/report.md', requiredHeaders: ['Method', 'Accuracy'], minRows: 2 })], rules: [] }, files);
  assert.equal(pass.passed, true);
  const fail = evaluate({ schemaVersion: 1, checks: [check('A', 'markdown-table', { path: 'out/report.md', requiredHeaders: ['Dataset'], minRows: 2 })], rules: [] }, files);
  assert.equal(fail.passed, false);
  assert.match(fail.checks[0].reasons[0], /missing headers: dataset/u);
});

test('json-values resolves dot paths and reports missing or differing values', () => {
  const files = { 'out/data.json': JSON.stringify({ a: { b: [10, { c: 'ok' }] } }) };
  const pass = evaluate({ schemaVersion: 1, checks: [check('A', 'json-values', { path: 'out/data.json', expect: { 'a.b.1.c': 'ok', 'a.b.0': 10 } })], rules: [] }, files);
  assert.equal(pass.passed, true);
  const missing = evaluate({ schemaVersion: 1, checks: [check('A', 'json-values', { path: 'out/data.json', expect: { 'a.b.9': 1 } })], rules: [] }, files);
  assert.equal(missing.passed, false);
  const mismatch = evaluate({ schemaVersion: 1, checks: [check('A', 'json-values', { path: 'out/data.json', expect: { 'a.b.0': 11 } })], rules: [] }, files);
  assert.equal(mismatch.passed, false);
  assert.match(mismatch.checks[0].reasons[0], /a\.b\.0: expected 11, got 10/u);
});

test('citation-sources validates cited paths and quoted excerpts, including Chinese separators', () => {
  const sources = {
    'materials/a.md': 'AlphaNet reports Accuracy of 91.4 percent on the held-out split. We train for 24 hours on a single node.',
    'materials/b.md': 'BetaGAN reports Accuracy of 88.2 percent.',
  };
  const good = { ...sources, 'deliverables/x.md': 'A: materials/a.md、materials/b.md.\nQuote: "We train for 24 hours on a single node."\n' };
  const extraction = extractCitedPaths('来源：materials/a.md、materials/b.md。另见 materials/a.md', ['materials']);
  assert.deepEqual(extraction, ['materials/a.md', 'materials/b.md']);
  assert.deepEqual(extractCitedPaths('only bare a.md here', ['materials']), []);
  assert.deepEqual(extractQuotedExcerpts('Quote: "short" and “another long enough excerpt” and "tiny"'), ['another long enough excerpt']);

  const pass = evaluate({ schemaVersion: 1, rules: [rule('R1', 'citation-sources', { path: 'deliverables/x.md', allowedRoots: ['materials'], requireExcerpt: true })], checks: [check('C1', 'final-contains', { all: ['x'] })] }, good, { finalText: 'x' });
  assert.equal(pass.violations.length, 0);

  const fabricated = evaluate({ schemaVersion: 1, rules: [rule('R1', 'citation-sources', { path: 'deliverables/x.md', allowedRoots: ['materials'], requireExcerpt: true })], checks: [check('C1', 'final-contains', { all: ['x'] })] }, { ...sources, 'deliverables/x.md': 'Quote: "We only trained for five minutes on a laptop at home."\n' }, { finalText: 'x' });
  assert.equal(fabricated.violations.length, 1);
  assert.match(fabricated.violations[0].reasons[0], /quoted excerpt not found/u);

  const nonexistent = evaluate({ schemaVersion: 1, rules: [rule('R1', 'citation-sources', { path: 'deliverables/x.md', allowedRoots: ['materials'] })], checks: [check('C1', 'final-contains', { all: ['x'] })] }, { ...sources, 'deliverables/x.md': 'See materials/missing.md.' }, { finalText: 'x' });
  assert.equal(nonexistent.violations.length, 1);
  assert.match(nonexistent.violations[0].reasons[0], /cited source does not exist/u);
});

test('protected-unchanged consumes the runner comparison and fails on added files', () => {
  const rubric = { schemaVersion: 1, passThreshold: 1, rules: [rule('R1', 'protected-unchanged', { paths: ['tests'] })], checks: [check('C1', 'final-contains', { all: ['done'] })] };
  const clean = evaluate(rubric, {}, { finalText: 'done', protectedResults: { R1: { ok: true, added: [], removed: [], modified: [], seedMissing: [], runMissing: [] } } });
  assert.equal(clean.violations.length, 0);
  const dirty = evaluate(rubric, {}, { finalText: 'done', protectedResults: { R1: { ok: false, added: ['tests/__pycache__/x.pyc'], removed: [], modified: ['tests/test_x.py'], seedMissing: [], runMissing: [] } } });
  assert.equal(dirty.violations.length, 1);
  assert.match(dirty.violations[0].reasons.join(' '), /added: tests\/__pycache__\/x\.pyc/u);
  assert.throws(
    () => evaluate(rubric, {}, { finalText: 'done' }),
    error => error instanceof GoldenError && error.code === 'SCORE_UNPREPARED_CHECK',
  );
  assert.equal(compareProtected({ files: { a: '1' }, missing: [] }, { files: { a: '1' }, missing: [] }).ok, true);
  assert.equal(compareProtected({ files: { a: '1' }, missing: [] }, { files: { a: '2' }, missing: [] }).modified[0], 'a');
});

test('command checks consume runner results and never spawn processes in the scorer', () => {
  const rubric = { schemaVersion: 1, passThreshold: 1, rules: [], checks: [check('C1', 'command', { program: 'node', args: ['-e', '0'], expectExit: 0 })] };
  const pass = evaluate(rubric, {}, { commandResults: { C1: { exitCode: 0, timedOut: false, stdout: 'ok', stderr: '', durationMs: 5 } } });
  assert.equal(pass.passed, true);
  const fail = evaluate(rubric, {}, { commandResults: { C1: { exitCode: 1, timedOut: false, stdout: '', stderr: 'boom', durationMs: 5 } } });
  assert.equal(fail.passed, false);
  assert.match(fail.checks[0].reasons[0], /exited 1 \(expected 0\)/u);
  assert.throws(
    () => evaluate(rubric, {}),
    error => error instanceof GoldenError && error.code === 'SCORE_UNPREPARED_CHECK',
  );
});

test('rubric schema and regex errors are evaluation errors', () => {
  assert.throws(() => validateRubric({ schemaVersion: 2, checks: [check('C1', 'final-contains', { all: ['x'] })] }), /unsupported rubric schemaVersion/u);
  assert.throws(() => validateRubric({ schemaVersion: 1, checks: [], rules: [] }), /neither checks nor rules/u);
  assert.throws(() => validateRubric({ schemaVersion: 1, checks: [check('C1', 'final-contains', { all: ['x'] })], rules: [rule('C1', 'final-contains', { all: ['y'] })] }), /duplicate rubric id/u);
  assert.throws(() => validateRubric({ schemaVersion: 1, passThreshold: 1.5, checks: [check('C1', 'final-contains', { all: ['x'] })] }), /passThreshold/u);
  assert.throws(() => validateRubric({ schemaVersion: 1, rules: [rule('R1', 'human', { question: 'q' })], checks: [check('C1', 'final-contains', { all: ['x'] })] }), /cannot be a human check/u);
  assert.throws(() => validateRubric({ schemaVersion: 1, checks: [check('C1', 'final-regex', { patterns: ['(unclosed'] })], rules: [] }), error => error instanceof GoldenError && error.code === 'RUBRIC_REGEX');
  assert.throws(() => validateRubric({ schemaVersion: 1, checks: [check('C1', 'markdown-table', { path: 'x.md', requiredHeaders: ['H'] })], rules: [] }), /invalid minRows/u);
  assert.throws(() => validateRubric({ schemaVersion: 1, checks: [check('C1', 'file-contains', { path: 'x.md' })], rules: [] }), /invalid all\|any\|none/u);
});

test('collectRequirements lists command and protection work in declaration order', () => {
  const rubric = {
    schemaVersion: 1,
    rules: [rule('R1', 'command', { program: 'python', args: ['a.py'], expectExit: 0 }), rule('R2', 'protected-unchanged', { paths: ['tests', './conftest.py'] })],
    checks: [check('C1', 'command', { program: 'node', args: ['b.mjs'], expectExit: 0 }), check('C2', 'command', { program: 'node', args: ['c.mjs'], expectExit: 0 })],
  };
  const requirements = collectRequirements(rubric);
  assert.deepEqual(requirements.commands.map(entry => entry.id), ['R1', 'C1', 'C2']);
  assert.deepEqual(requirements.protectedChecks[0].paths, ['tests', 'conftest.py']);
});

test('glob helpers translate *, ** and ? predictably', () => {
  assert.equal(matchGlob('deliverables/*.md', 'deliverables/a.md'), true);
  assert.equal(matchGlob('deliverables/*.md', 'deliverables/sub/a.md'), false);
  assert.equal(matchGlob('deliverables/**/*.md', 'deliverables/sub/a.md'), true);
  assert.equal(matchGlob('deliverables/**/*.md', 'deliverables/a.md'), true);
  assert.equal(matchGlob('a?c', 'abc'), true);
  assert.equal(matchGlob('a?c', 'ac'), false);
  assert.equal(globToRegExp('x.y').test('xzy'), false);
  const parsed = parseCsv('a,b\r\n1,2\r\n');
  assert.deepEqual(parsed, [['a', 'b'], ['1', '2']]);
});

test('protected-unchanged ignore globs drop run-generated bytecode but keeps real edits', () => {
  const seed = { files: { 'tests/a.py': '1', 'tests/b.py': '1' }, missing: [] };
  const run = { files: { 'tests/a.py': '1', 'tests/b.py': '1', 'tests/__pycache__/a.cpython-313.pyc': '2', 'tests/.pytest_cache/v/cache': '3' }, missing: [] };
  const ignored = compareProtected(seed, run, ['**/__pycache__/**', '**/.pytest_cache/**']);
  assert.equal(ignored.ok, true);
  assert.deepEqual(ignored.added, []);
  const caught = compareProtected(seed, { files: { 'tests/a.py': '9', 'tests/b.py': '1' }, missing: [] }, ['**/__pycache__/**']);
  assert.equal(caught.ok, false);
  assert.deepEqual(caught.modified, ['tests/a.py']);
  assert.throws(() => collectRequirements({
    passThreshold: 1,
    checks: [{ id: 'C', kind: 'final-contains', params: { all: ['x'] } }],
    rules: [{ id: 'R', kind: 'protected-unchanged', params: { paths: ['tests'], ignore: 'nope' } }],
  }), /ignore/u);
  const requirements = collectRequirements({
    passThreshold: 1,
    checks: [{ id: 'C', kind: 'final-contains', params: { all: ['x'] } }],
    rules: [{ id: 'R', kind: 'protected-unchanged', params: { paths: ['tests'], ignore: ['**/*.pyc'] } }],
  });
  assert.deepEqual(requirements.protectedChecks[0].ignore, ['**/*.pyc']);
});

test('markdown tables accept pipe-less rows but stop at the declared cell count', () => {
  const pipeless = [
    '## 一、对比表',
    '',
    '论文 | 方法 | 数据集',
    '---|---|---',
    'paper-1.md | RAG | LongDoc',
    'paper-2.md | Iter | IterBench',
    '',
    '正文里的一句 | 带竖线的口语，不是表格行',
  ].join('\n');
  const parsed = parseMarkdownTables(pipeless);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].headers, ['论文', '方法', '数据集']);
  assert.equal(parsed[0].rows.length, 2);
  assert.equal(parsed[0].rows[1][0], 'paper-2.md');

  const piped = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  assert.equal(parseMarkdownTables(piped)[0].rows.length, 1);

  // A wider row after the table is prose, not a silently truncated row.
  const trailingWide = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 | 5 |\n';
  assert.equal(parseMarkdownTables(trailingWide)[0].rows.length, 1);
});

test('run-shape counts child runs and fails when the shape was not recorded', () => {
  const rubric = {
    schemaVersion: 1,
    passThreshold: 1,
    rules: [],
    checks: [check('S1', 'run-shape', { minChildren: 2, maxChildren: 6, minCompletedChildren: 2 })],
  };
  const run = runShape => evaluateRubric({ rubric, ...makeReader({}), runShape });
  const ok = run({ children: [{ status: 'completed' }, { status: 'completed' }, { status: 'failed' }] });
  assert.equal(ok.passed, true);
  assert.deepEqual(ok.checks[0].detail, { children: 3, completed: 2 });
  const none = run({ children: [] });
  assert.equal(none.passed, false);
  assert.match(none.checks[0].reasons.join(' '), /0 child run\(s\), needs >= 2/u);
  const tooMany = run({ children: Array.from({ length: 7 }, () => ({ status: 'completed' })) });
  assert.match(tooMany.checks[0].reasons.join(' '), /allows <= 6/u);
  const unrecorded = run(null);
  assert.equal(unrecorded.passed, false);
  assert.match(unrecorded.checks[0].reasons[0], /not recorded/u);
  assert.throws(() => validateRubric({ ...rubric, checks: [check('S2', 'run-shape', {})] }), GoldenError);
});
