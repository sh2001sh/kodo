// Evaluation-infrastructure errors. A GoldenError means the evaluation setup is
// wrong (unknown check kind, invalid case/rubric schema, broken grading assets).
// It must abort the run with a non-zero exit instead of being recorded as a
// sample failure, per docs/kodo-golden-eval-design-20261103.md §7.

export class GoldenError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'GoldenError';
    this.code = code;
  }
}

export const isGoldenError = error => error instanceof GoldenError || error?.name === 'GoldenError';
