const runStatuses = new Set(['completed', 'failed', 'interrupted', 'not_run']);

const observedRunStatus = value => runStatuses.has(value) ? value : 'failed';

/**
 * Keep task quality, summary mechanism, registered exposure and protocol result
 * independent. Missing evidence is not silently converted to either pass or fail.
 */
export function classifyContinuationOutcome(input) {
  const runStatus = input.notRun ? 'not_run' : observedRunStatus(input.runStatus);
  if (runStatus === 'not_run') {
    return {
      runStatus,
      qualityStatus: 'not_observed',
      mechanismStatus: 'not_observed',
      exposureStatus: 'not_observed',
      protocolStatus: input.stopped ? 'stopped' : 'incomplete',
      evidenceIssues: [],
    };
  }

  const evidenceIssues = [];
  if (!input.stateReadable) evidenceIssues.push('state-database');
  if (!input.verifyRecorded) evidenceIssues.push('verification');
  if (!input.protectedRecorded) evidenceIssues.push('protected-hashes');
  if (!input.finalDeliveryRecorded) evidenceIssues.push('final-delivery');
  const evidenceComplete = evidenceIssues.length === 0;

  let qualityStatus = 'not_observed';
  if (evidenceComplete) {
    qualityStatus = runStatus === 'completed' && input.verifyPassed && input.protectedOk && input.finalDeliveryPresent ? 'pass' : 'fail';
  }

  let mechanismStatus = 'not_observed';
  if (input.stateReadable) {
    mechanismStatus = input.deterministicFailures === 0 && input.installs >= 1 ? 'pass' : 'fail';
  }

  let exposureStatus = 'not_observed';
  if (input.stateReadable) {
    exposureStatus = input.installs >= input.expectedMinCompactions && input.continuedAfterInstall ? 'sufficient' : 'insufficient';
  }

  let protocolStatus = 'incomplete';
  if (input.stopped || mechanismStatus === 'fail') protocolStatus = 'stopped';
  else if (qualityStatus === 'fail') protocolStatus = 'fail';
  else if (qualityStatus === 'pass' && mechanismStatus === 'pass' && exposureStatus === 'sufficient') protocolStatus = 'pass';

  return { runStatus, qualityStatus, mechanismStatus, exposureStatus, protocolStatus, evidenceIssues };
}
