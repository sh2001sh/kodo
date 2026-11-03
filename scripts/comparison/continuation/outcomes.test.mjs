import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyContinuationOutcome } from './outcomes.mjs';

const complete = (overrides = {}) => classifyContinuationOutcome({
  runStatus: 'completed', notRun: false, stopped: false,
  stateReadable: true, verifyRecorded: true, protectedRecorded: true, finalDeliveryRecorded: true,
  verifyPassed: true, protectedOk: true, finalDeliveryPresent: true,
  deterministicFailures: 0, installs: 2, expectedMinCompactions: 2, continuedAfterInstall: true,
  ...overrides,
});

test('separates task quality from a deterministic mechanism failure', () => {
  assert.deepEqual(complete({ deterministicFailures: 1 }), {
    runStatus: 'completed', qualityStatus: 'pass', mechanismStatus: 'fail', exposureStatus: 'sufficient', protocolStatus: 'stopped', evidenceIssues: [],
  });
});

test('marks a stopped unrun task as not observed', () => {
  assert.deepEqual(complete({ notRun: true, stopped: true }), {
    runStatus: 'not_run', qualityStatus: 'not_observed', mechanismStatus: 'not_observed', exposureStatus: 'not_observed', protocolStatus: 'stopped', evidenceIssues: [],
  });
});

test('distinguishes one install from the two-install exposure target', () => {
  assert.deepEqual(complete({ installs: 1 }).qualityStatus, 'pass');
  assert.deepEqual(complete({ installs: 1 }).mechanismStatus, 'pass');
  assert.deepEqual(complete({ installs: 1 }).exposureStatus, 'insufficient');
  assert.deepEqual(complete({ installs: 2 }).exposureStatus, 'sufficient');
});

test('does not call an installed summary a task success without final delivery', () => {
  const result = complete({ finalDeliveryPresent: false });
  assert.equal(result.mechanismStatus, 'pass');
  assert.equal(result.qualityStatus, 'fail');
  assert.equal(result.protocolStatus, 'fail');
});

test('records protection, verification and evidence failures without conflating them', () => {
  assert.equal(complete({ protectedOk: false }).qualityStatus, 'fail');
  assert.equal(complete({ verifyPassed: false }).qualityStatus, 'fail');
  const missing = complete({ verifyRecorded: false });
  assert.equal(missing.qualityStatus, 'not_observed');
  assert.deepEqual(missing.evidenceIssues, ['verification']);
});

test('does not convert imported unknown evidence into pass', () => {
  const result = complete({ stateReadable: false, verifyRecorded: false, protectedRecorded: false, finalDeliveryRecorded: false });
  assert.equal(result.qualityStatus, 'not_observed');
  assert.equal(result.mechanismStatus, 'not_observed');
  assert.equal(result.exposureStatus, 'not_observed');
  assert.notEqual(result.protocolStatus, 'pass');
});
