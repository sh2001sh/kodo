export { freezeCase, caseDigest, canonicalJson } from './schema.js';
export type { CaseDefinition, CaseAssertion, CaseFile, FrozenCase } from './schema.js';
export { CaseRunStore } from './store.js';
export type { CaseTarget, CaseConditions, CaseRun, CaseRunList, AssertionEvidence } from './store.js';
export { runCase, compareCaseRuns } from './runner.js';
export type { RunCaseOptions, CaseCommand, CaseExecutionInput, CaseExecutionResult, CaseComparison } from './runner.js';
