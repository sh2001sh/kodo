import assert from 'node:assert/strict';
import test from 'node:test';
import { applyIsolationReview, companionTypeExportOnly, regressionPassed } from './real-audit.mjs';

test('colored successful output is accepted while failures and absent new tests are rejected', () => {
  const colored = { regression: { code: 0, stdout: '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m34 passed\u001b[39m (34)' } };
  assert.equal(regressionPassed(colored, 'pagination', false), true);
  assert.equal(regressionPassed(colored, 'package-versions', false), false);
  assert.equal(regressionPassed(colored, 'package-versions', true), true);
  assert.equal(regressionPassed({ regression: { ...colored.regression, code: 1 } }, 'pagination', true), false);
  assert.equal(regressionPassed({ regression: { code: 0, stdout: 'No tests found' } }, 'pagination', true), false);
});

test('related type exports are accepted, runtime changes and unknown types are rejected', () => {
  const before = "export const x = 1;\nexport type { Status } from '../packages/registry.js';\n";
  const after = before.replace('{ Status }', '{ Status, PackageVersion }');
  assert.equal(companionTypeExportOnly(before, after, 'export interface PackageVersion {version:string}'), true);
  assert.equal(companionTypeExportOnly(before.replaceAll('\n', '\r\n'), after, 'export interface PackageVersion {}'), true);
  assert.equal(companionTypeExportOnly(before, after.replace('x = 1', 'x = 2'), 'export interface PackageVersion {}'), false);
  assert.equal(companionTypeExportOnly(before, after, ''), false);
  assert.equal(companionTypeExportOnly(before, before, 'export interface PackageVersion {}'), false);
});

test('source contamination disqualifies success without hiding artifact quality or resources', () => {
  const row = { id: 'example', executionMs: 30000, usage: { input: 100 }, acceptance: { passed: true, score: 100, criteria: [{ name: 'behavior', passed: true }] } };
  const invalid = applyIsolationReview(row, { passed: false });
  assert.equal(invalid.acceptance.passed, false);
  assert.equal(invalid.acceptance.score, 100);
  assert.equal(invalid.artifactAcceptance.passed, true);
  assert.equal(invalid.executionMs, row.executionMs);
  assert.deepEqual(invalid.usage, row.usage);
  assert.equal(row.acceptance.criteria.length, 1);
  assert.equal(applyIsolationReview(row, { passed: true }).acceptance.passed, true);
  const failed = { ...row, acceptance: { ...row.acceptance, passed: false, criteria: [{ name: 'delivery', passed: false }] } };
  assert.equal(applyIsolationReview(failed, { passed: true }).acceptance.passed, false);
  assert.throws(() => applyIsolationReview(row, undefined), /not been reviewed/);
});
