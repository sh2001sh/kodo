import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPlan, loadCase, loadCases, validateCase } from './cases.mjs';

const fixtureRoot = path.join(import.meta.dirname, 'test-fixtures/cases');

const minimalCase = (overrides = {}) => ({
  schemaVersion: 1,
  id: 'demo-case',
  category: 'report',
  title: 'Demo',
  objective: 'Do the task.',
  limits: {},
  permissions: ['read'],
  deliverableDir: 'deliverables',
  smoke: {},
  materialsGlobs: ['materials/**/*'],
  ...overrides,
});

test('validateCase fills limit/smoke defaults and normalizes grading paths', () => {
  const parsed = validateCase(minimalCase({ grading: { restore: ['./tests/'], stage: [{ from: 'verify/stage', to: '_verify' }] } }), { dirName: 'demo-case' });
  assert.equal(parsed.limits.contextTokens, 1_048_576);
  assert.equal(parsed.limits.maxDurationMs, 2_700_000);
  assert.deepEqual(parsed.smoke, { minModelCalls: 1, minToolCalls: 1, requireEventPrefixes: [] });
  assert.deepEqual(parsed.grading.restore, ['tests']);
  assert.deepEqual(parsed.grading.stage, [{ from: 'verify/stage', to: '_verify' }]);
  assert.equal(parsed.deliverableDir, 'deliverables');
});

test('validateCase rejects schema and path violations with GoldenError codes', () => {
  assert.throws(() => validateCase(minimalCase({ id: 'wrong-dir' }), { dirName: 'demo-case' }), /must match its directory name/u);
  assert.throws(() => validateCase(minimalCase({ category: 'mars' })), /category must be one of/u);
  assert.throws(() => validateCase(minimalCase({ objective: '' })), /objective/u);
  assert.throws(() => validateCase(minimalCase({ limits: { maxOutputTokens: 4_000_000 } })), /must not exceed/u);
  assert.throws(() => validateCase(minimalCase({ grading: { restore: ['../escape'] } })), /must not escape/u);
  assert.throws(() => validateCase(minimalCase({ permissions: ['admin'] })), /permissions/u);
  assert.throws(() => validateCase(null), /must be an object/u);
});

test('loadCases reads both self-test fixtures with normalized rubrics', () => {
  const cases = loadCases(fixtureRoot);
  assert.deepEqual(cases.map(item => item.id), ['fixture-coding-tiny', 'fixture-lit-tiny']);
  const coding = cases[0];
  assert.equal(coding.caseData.category, 'coding');
  assert.equal(coding.rubric.passThreshold, 0.7);
  assert.deepEqual(coding.caseData.grading.restore, ['tests']);
  assert.ok(cases[1].rubric.rules.some(rule => rule.kind === 'citation-sources'));
});

test('loadCase rejects unknown check kinds and a missing rubric before a cell starts', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-golden-cases-'));
  try {
    const directory = path.join(root, 'made-up-case');
    cpSync(path.join(fixtureRoot, 'fixture-lit-tiny'), directory, { recursive: true });
    const caseData = JSON.parse(readFileSync(path.join(directory, 'case.json'), 'utf8'));
    caseData.id = 'made-up-case';
    delete caseData.grading;
    writeFileSync(path.join(directory, 'case.json'), JSON.stringify(caseData));
    const rubric = JSON.parse(readFileSync(path.join(directory, 'rubric.json'), 'utf8'));
    rubric.checks.push({ id: 'CX', kind: 'quantum', params: {} });
    writeFileSync(path.join(directory, 'rubric.json'), JSON.stringify(rubric));
    assert.throws(() => loadCase(directory), /RUBRIC_UNKNOWN_KIND|unknown check kind/u);
    rmSync(path.join(directory, 'rubric.json'));
    assert.throws(() => loadCase(directory), /has no rubric\.json/u);
    const emptyRoot = path.join(root, 'no-cases');
    mkdirSync(emptyRoot);
    writeFileSync(path.join(emptyRoot, 'README.md'), 'no case here');
    assert.throws(() => loadCases(emptyRoot), /no case directories/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('buildPlan is repeat-major and the seeded shuffle is deterministic', () => {
  const cases = loadCases(fixtureRoot);
  const plan = buildPlan(cases, { repeats: 2 });
  assert.deepEqual(plan.map(entry => entry.key), [
    'fixture-coding-tiny:r1', 'fixture-lit-tiny:r1',
    'fixture-coding-tiny:r2', 'fixture-lit-tiny:r2',
  ]);
  assert.equal(plan[0].case.id, 'fixture-coding-tiny');
  assert.equal(plan[3].repeat, 2);
  const seededA = buildPlan(cases, { repeats: 3, seed: 7 }).map(entry => entry.key);
  const seededB = buildPlan(cases, { repeats: 3, seed: 7 }).map(entry => entry.key);
  assert.deepEqual(seededA, seededB);
  assert.equal(seededA.length, 6);
  assert.equal(new Set(seededA).size, 6);
  assert.throws(() => buildPlan(cases, { repeats: 0 }), /repeats must be a positive integer/u);
  assert.throws(() => buildPlan(cases, { repeats: 1, seed: 1.5 }), /seed must be an integer/u);
});
