// Cross-case negative-control regression for the 5 data/report golden cases.
//
// Located under data-01-stats-chart/verify/ for convenience but exercises all
// five data/report samples. Read-only: imports the real scoring engine
// (scripts/golden/score.mjs), the real case loader (cases.mjs) and the
// protected snapshot helper (scripts/comparison/v3-eval-ledger.mjs), mirrors
// scripts/golden/run.mjs (protected snapshot -> grading restore/stage ->
// commands -> evaluateRubric) and stages everything in OS temp dirs.
//
// Usage (from anywhere):
//   node eval/golden/cases/data-01-stats-chart/verify/negative-controls.mjs
//
// "reference" must pass; every other scenario must fail. Exit code 0 == OK.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES_ROOT = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..');

const importModule = specifier => import(pathToFileURL(path.join(REPO_ROOT, specifier)).href);
let engine;
try {
  engine = await importModule('scripts/golden/score.mjs');
} catch (error) {
  console.error('cannot import scripts/golden/score.mjs — run this from the Kodo repo checkout');
  throw error;
}
const { collectRequirements, compareProtected, evaluateRubric } = engine;
const { loadCase } = await importModule('scripts/golden/cases.mjs');
const { protectedSnapshot } = await importModule('scripts/comparison/v3-eval-ledger.mjs');

const readText = file => fs.readFileSync(file, 'utf8');
const writeText = (file, text) => fs.writeFileSync(file, text, 'utf8');
const replaceAllPairs = (text, pairs) => {
  const placeholders = pairs.map((_, index) => `\u0000PH${index}\u0000`);
  let output = text;
  pairs.forEach(([from], index) => {
    output = output.split(from).join(placeholders[index]);
  });
  pairs.forEach(([, to], index) => {
    output = output.split(placeholders[index]).join(to);
  });
  return output;
};

function walk(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
}

function executeCommand(params, workspace, caseDir) {
  const cwd = params.cwd ? path.join(workspace, params.cwd) : workspace;
  const args = params.args ?? [];
  const environment = { ...process.env, GOLDEN_CASE_DIR: caseDir, GOLDEN_VERIFY_DIR: path.join(caseDir, 'verify') };
  const spawn = program =>
    spawnSync(program, args, { cwd, encoding: 'utf8', timeout: params.timeoutMs ?? 600000, shell: false, env: environment });
  let result = spawn(params.program);
  if ((params.program === 'node' || params.program === 'node.exe') && result.error?.code === 'ENOENT') {
    result = spawn(process.execPath);
  }
  return {
    exitCode: Number.isSafeInteger(result.status) ? result.status : null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

function makeIO(root) {
  return {
    readFile: rel => {
      const target = path.join(root, ...rel.split('/'));
      return fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : null;
    },
    listFiles: () => walk(root).map(file => path.relative(root, file).split(path.sep).join('/')),
    statFile: rel => {
      const target = path.join(root, ...rel.split('/'));
      return fs.existsSync(target) && fs.statSync(target).isFile() ? { size: fs.statSync(target).size } : null;
    },
  };
}

function stage(caseDir, { withReference, mutate }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodo-negative-'));
  fs.cpSync(path.join(caseDir, 'workspace'), root, { recursive: true });
  if (withReference) fs.cpSync(path.join(caseDir, 'verify', 'reference'), root, { recursive: true });
  if (mutate) mutate(root);
  return root;
}

function evaluate(caseItem, root) {
  const { caseData, rubric } = caseItem;
  const workspaceDir = path.join(caseItem.caseDir, 'workspace');
  const requirements = collectRequirements(rubric);
  const protectedResults = {};
  for (const requirement of requirements.protectedChecks) {
    protectedResults[requirement.id] = compareProtected(
      protectedSnapshot(workspaceDir, requirement.paths),
      protectedSnapshot(root, requirement.paths),
    );
  }
  for (const relative of caseData.grading?.restore ?? []) {
    const target = path.join(root, relative);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(workspaceDir, relative), target, { recursive: true });
  }
  const stages = caseData.grading?.stage?.length
    ? caseData.grading.stage
    : fs.existsSync(path.join(caseItem.caseDir, 'verify'))
      ? [{ from: 'verify', to: 'verify' }]
      : [];
  for (const entry of stages) {
    const target = path.join(root, entry.to);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(path.join(caseItem.caseDir, entry.from), target, { recursive: true });
  }
  const commandResults = {};
  for (const requirement of requirements.commands) {
    commandResults[requirement.id] = executeCommand(requirement.params, root, caseItem.caseDir);
  }
  const report = evaluateRubric({ rubric, caseData, protectedResults, commandResults, ...makeIO(root) });
  fs.rmSync(root, { recursive: true, force: true });
  return report;
}

const tamperMaterials = root => {
  const first = walk(path.join(root, 'materials'))[0];
  fs.appendFileSync(first, '\nTampered by negative control\n');
};

const swapValuesInCsv = (file, column, firstWhere, secondWhere, whereColumn) => {
  const lines = readText(file).split(/\r?\n/u);
  const header = lines[0].split(',');
  const columnIndex = header.indexOf(column);
  const whereIndex = header.indexOf(whereColumn);
  const firstLine = lines.findIndex((line, index) => index > 0 && line.split(',')[whereIndex] === firstWhere);
  const secondLine = lines.findIndex((line, index) => index > 0 && line.split(',')[whereIndex] === secondWhere);
  const firstCells = lines[firstLine].split(',');
  const secondCells = lines[secondLine].split(',');
  [firstCells[columnIndex], secondCells[columnIndex]] = [secondCells[columnIndex], firstCells[columnIndex]];
  lines[firstLine] = firstCells.join(',');
  lines[secondLine] = secondCells.join(',');
  writeText(file, lines.join('\n'));
};

const SCENARIOS = [
  {
    caseId: 'data-01-stats-chart',
    scenarios: [
      { name: 'reference', withReference: true },
      { name: 'materials-tampered (P0-2)', withReference: true, mutate: tamperMaterials },
      { name: 'empty', withReference: false },
      {
        name: 'two-regions-total-swapped (P0-1)',
        withReference: true,
        mutate: root => swapValuesInCsv(path.join(root, 'deliverables', 'summary.csv'), 'total_sales', '华东', '华北', 'region'),
      },
      {
        name: 'chart-png-appended-text (P1-1)',
        withReference: true,
        mutate: root => fs.appendFileSync(path.join(root, 'deliverables', 'chart.png'), '\nthis is not a png'),
      },
      {
        name: 'report-missing-top-region (P1-2)',
        withReference: true,
        mutate: root => {
          const file = path.join(root, 'deliverables', 'report.md');
          writeText(file, readText(file).split('华东').join('南部'));
        },
      },
      {
        name: 'report-too-long (P1-2)',
        withReference: true,
        mutate: root => fs.appendFileSync(path.join(root, 'deliverables', 'report.md'), `\n${'结论补充。'.repeat(200)}`),
      },
    ],
  },
  {
    caseId: 'data-02-clean-merge',
    scenarios: [
      { name: 'reference', withReference: true },
      { name: 'materials-tampered (P0-2)', withReference: true, mutate: tamperMaterials },
      { name: 'empty', withReference: false },
      {
        name: 'merged-274-rows (P0-1)',
        withReference: true,
        mutate: root => {
          const file = path.join(root, 'deliverables', 'merged.csv');
          const lines = readText(file).split(/\r?\n/u).filter(line => line !== '');
          lines.splice(lines.length - 1, 1);
          writeText(file, `${lines.join('\n')}\n`);
        },
      },
      {
        name: 'quality-a-b-labels-swapped (P1-3)',
        withReference: true,
        mutate: root => {
          const file = path.join(root, 'deliverables', 'data-quality.md');
          writeText(file, replaceAllPairs(readText(file), [
            ['| 8 |', '| 12 |'],
            ['| 12 |', '| 8 |'],
            ['剔除 8 行', '剔除 12 行'],
            ['其余 12 行', '其余 8 行'],
          ]));
        },
      },
    ],
  },
  {
    caseId: 'data-03-periodic-report',
    scenarios: [
      { name: 'reference', withReference: true },
      { name: 'materials-tampered (P0-2)', withReference: true, mutate: tamperMaterials },
      { name: 'empty', withReference: false },
      {
        name: 'month-labels-swapped (P1-4)',
        withReference: true,
        mutate: root => {
          const file = path.join(root, 'deliverables', 'monthly-report.md');
          writeText(file, replaceAllPairs(readText(file), [
            ['| 2026-07 |', '| 2026-09 |'],
            ['| 2026-09 |', '| 2026-07 |'],
          ]));
        },
      },
      {
        name: 'max-category-wrong (P0-1)',
        withReference: true,
        mutate: root => {
          const file = path.join(root, 'deliverables', 'monthly-report.md');
          writeText(file, readText(file).split('办公用品').join('其他'));
        },
      },
    ],
  },
  {
    caseId: 'report-01-multi-source-summary',
    scenarios: [
      { name: 'reference', withReference: true },
      { name: 'materials-tampered (P0-2)', withReference: true, mutate: tamperMaterials },
      { name: 'empty', withReference: false },
      {
        name: 'first-last-values-swapped (P1-6)',
        withReference: true,
        mutate: root => {
          const file = path.join(root, 'deliverables', 'summary.md');
          writeText(file, replaceAllPairs(readText(file), [
            ['首周为 52.4%', '首周为 68.4%'],
            ['末周为 68.4%', '末周为 52.4%'],
            ['首周为 3.86', '首周为 4.42'],
            ['末周为 4.42', '末周为 3.86'],
          ]));
        },
      },
      {
        name: 'all-quotes-removed (P1-7)',
        withReference: true,
        mutate: root => {
          const file = path.join(root, 'deliverables', 'summary.md');
          writeText(file, readText(file).replace(/“[^”\n]+”/gu, ''));
        },
      },
      {
        name: 'one-citation-removed (M03)',
        withReference: true,
        mutate: root => {
          const file = path.join(root, 'deliverables', 'summary.md');
          writeText(file, readText(file).split('materials/interview-02.md').join('materials/interview-03.md'));
        },
      },
    ],
  },
  {
    caseId: 'report-02-meeting-minutes',
    scenarios: [
      { name: 'reference', withReference: true },
      { name: 'materials-tampered (P0-2)', withReference: true, mutate: tamperMaterials },
      { name: 'empty', withReference: false },
      {
        name: 'owner-dates-swapped (P1-8)',
        withReference: true,
        mutate: root => {
          const file = path.join(root, 'deliverables', 'minutes.md');
          writeText(file, replaceAllPairs(readText(file), [
            ['2026-11-06', '2026-11-10'],
            ['2026-11-10', '2026-11-06'],
          ]));
        },
      },
      {
        name: 'decisions-deleted (P1-9)',
        withReference: true,
        mutate: root => {
          const file = path.join(root, 'deliverables', 'minutes.md');
          const output = [];
          let inDecisionSection = false;
          for (const line of readText(file).split(/\r?\n/u)) {
            if (/^#{1,6}\s/u.test(line)) inDecisionSection = line.includes('决定');
            if (inDecisionSection && /^\d+\.\s/u.test(line.trim())) continue;
            output.push(line);
          }
          writeText(file, output.join('\n'));
        },
      },
    ],
  },
];

let failures = 0;
for (const group of SCENARIOS) {
  const caseItem = loadCase(path.join(CASES_ROOT, group.caseId));
  console.log(`\n## ${group.caseId}`);
  for (const scenario of group.scenarios) {
    const report = evaluate(caseItem, stage(caseItem.caseDir, scenario));
    const failedChecks = report.checks.filter(check => check.status === 'failed').map(check => check.id);
    const violations = report.violations.map(violation => violation.id);
    const expected = scenario.name === 'reference';
    const ok = report.passed === expected;
    if (!ok) failures += 1;
    const score = report.score === null ? 'null' : report.score.toFixed(4);
    console.log(
      `${ok ? 'OK  ' : 'BAD '} ${scenario.name.padEnd(38)} passed=${String(report.passed).padEnd(5)} ` +
        `score=${score} failedChecks=[${failedChecks.join(',')}] violations=[${violations.join(',')}]`,
    );
  }
}

console.log(failures === 0 ? '\nNEGATIVE-CONTROL OK' : `\nNEGATIVE-CONTROL FAILED (${failures} unexpected result(s))`);
process.exit(failures === 0 ? 0 : 1);
