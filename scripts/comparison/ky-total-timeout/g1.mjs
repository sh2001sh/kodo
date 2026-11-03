import console from 'node:console';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { auditWorkspace } from './oracle.mjs';
import { seedWorkspace } from './fixture.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const research = path.join(repoRoot, '.kodo', 'research', 'ky-total-timeout');
const referenceTemplate = path.join(research, 'reference-template');
const dependencies = path.join(research, 'upstream', 'node_modules');
const root = path.join(research, 'g1-stability');
const finalText = 'Implemented totalTimeout and per-attempt timeout behavior, updated types, documentation, and tests. Verified with npm run build and the targeted AVA regression suite.';
const delivery = '# G1 delivery fixture\n\nImplemented per-attempt `timeout` and cross-retry `totalTimeout`, including retry delays and internal HTTP error parsing. Types, documentation, and regression tests are included.\n\nVerified with `npm run build` and targeted AVA tests.\n';

function replace(file, before, after) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes(before)) throw new Error(`mutation source not found in ${file}`);
  writeFileSync(file, original.replace(before, after), 'utf8');
}

const mutations = {
  reference() {},
  m1(workspace) {
    replace(path.join(workspace, 'source', 'core', 'Ky.ts'), `\t\tconst elapsed = this.#getCurrentTime() - this.#startTime;\n\t\treturn Math.max(0, this.#options.totalTimeout - elapsed);`, `\t\t// Mutant M1: reset the total budget on every check.\n\t\treturn this.#options.totalTimeout;`);
  },
  m2(workspace) {
    replace(path.join(workspace, 'source', 'core', 'Ky.ts'), `\t\t\t// If waiting would consume all remaining budget, time out without starting another request.\n\t\t\tif (retryDelay >= remainingTimeout) {\n\t\t\t\tawait delay(remainingTimeout, delayOptions);\n\t\t\t\tthrow new TimeoutError(this.request);\n\t\t\t}\n`, '\t\t\t// Mutant M2: do not bound retry waiting by the remaining total budget.\n');
  },
  m3(workspace) {
    replace(path.join(workspace, 'source', 'core', 'Ky.ts'), `\t#getErrorDataTimeout(): {timeout: number; totalTimeoutReachedOnTimeout: boolean} {\n\t\tconst errorDataTimeout = this.#options.timeout === false ? 10_000 : this.#options.timeout;\n\t\tconst remainingTotal = this.#getRemainingTotalTimeout();`, `\t#getErrorDataTimeout(): {timeout: number; totalTimeoutReachedOnTimeout: boolean} {\n\t\tconst errorDataTimeout = this.#options.timeout === false ? 10_000 : this.#options.timeout;\n\t\tconst remainingTotal = undefined; // Mutant M3: ignore the total budget while parsing error data.`);
  },
  m4(workspace) {
    replace(path.join(workspace, 'source', 'types', 'options.ts'), 'totalTimeout?: number | false;', 'totalTimeout?: any; // Mutant M4: public type is unconstrained.');
    const readme = path.join(workspace, 'readme.md');
    writeFileSync(readme, readFileSync(readme, 'utf8').replaceAll('totalTimeout', 'overall deadline'), 'utf8');
  },
};

async function runImplementation(name, mutate) {
  const workspace = path.join(root, name);
  rmSync(workspace, { recursive: true, force: true });
  seedWorkspace(referenceTemplate, dependencies, workspace);
  writeFileSync(path.join(workspace, 'DELIVERY.md'), delivery, 'utf8');
  mutate(workspace);
  const repeats = [];
  for (let repeat = 1; repeat <= 3; repeat++) {
    const audit = await auditWorkspace({ workspace, finalText });
    repeats.push({ repeat, passed: audit.passed, functionalPassed: audit.functionalPassed, checks: Object.fromEntries(Object.entries(audit.checks).map(([id, check]) => [id, check.passed])), buildExit: audit.build.exitCode, regressionExit: audit.regression.exitCode });
  }
  return { name, repeats, stable: repeats.every(result => result.passed === repeats[0].passed), expected: name === 'reference' ? 'pass' : 'fail', observed: repeats.every(result => result.passed) ? 'pass' : repeats.every(result => !result.passed) ? 'fail' : 'mixed' };
}

async function main() {
  mkdirSync(root, { recursive: true });
  const selected = process.argv.includes('--implementations') ? new Set((process.argv[process.argv.indexOf('--implementations') + 1] ?? '').split(',').filter(Boolean)) : null;
  const results = [];
  for (const [name, mutate] of Object.entries(mutations)) {
    if (selected && !selected.has(name)) continue;
    const result = await runImplementation(name, mutate);
    results.push(result);
    console.error(`${name}: ${result.observed} stable=${result.stable}`);
  }
  const requiredFailures = { m1: ['T03'], m2: ['T06'], m3: ['T08'], m4: ['T13', 'T14'] };
  const passed = results.every(result => result.stable && result.observed === result.expected
    && (result.name === 'reference'
      ? result.repeats.every(repeat => repeat.functionalPassed && repeat.buildExit === 0 && repeat.regressionExit === 0)
      : result.repeats.every(repeat => repeat.buildExit === 0 && requiredFailures[result.name].every(id => repeat.checks[id] === false))));
  const report = { id: 'ky-total-timeout-g1-v1', passed, node: process.version, results, createdAt: new Date().toISOString() };
  writeFileSync(path.join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 2; });
