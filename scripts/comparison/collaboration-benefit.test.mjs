import assert from 'node:assert/strict';
import test from 'node:test';
import { assessDelivery } from './provider-benefit.mjs';

const verified = { status: 'completed', verification: { passed: true }, verificationEvidence: { passed: true }, finalText: 'Implemented both fixes. Build and tests passed.' };
test('completed run and passing code cannot hide an empty final delivery', () => {
  for (const finalText of ['', ' \n\t', null, undefined]) {
    const result = assessDelivery({ ...verified, finalText });
    assert.equal(result.passed, false);
    assert.equal(result.checks.finalResponsePresent, false);
  }
});
test('passing artifacts cannot hide a failed model run', () => {
  assert.equal(assessDelivery({ ...verified, status: 'failed' }).passed, false);
});
test('host validation cannot substitute for the main agent required verification', () => {
  assert.equal(assessDelivery({ ...verified, verificationEvidence: { passed: false } }).passed, false);
});
test('an agent summary and self tests cannot override failed independent acceptance', () => {
  assert.equal(assessDelivery({ ...verified, verification: { passed: false } }).passed, false);
});
test('complete verified delivery passes without constraining wording or summary length', () => {
  assert.equal(assessDelivery({ ...verified, finalText: '已实现并验证。' }).passed, true);
});
