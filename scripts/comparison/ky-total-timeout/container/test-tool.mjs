// Host tool that gives the agent public regression feedback. Tests run in the
// disposable container from run-tests.mjs against a read-only snapshot of the
// workspace, so the tool reads the workspace and never writes it.

import { PUBLIC_TESTS, runPublicTests } from './run-tests.mjs';

const feedbackChars = 6_000;

/** Bounded agent-facing view of a test run: counts, failing titles and the reporter tail. */
export function feedback(result) {
  const text = `${result.stdout}\n${result.stderr}`.trim();
  return {
    ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs,
    files: result.files, ...(result.match ? { match: result.match } : {}), summary: result.summary,
    output: text.length <= feedbackChars ? text : `[${text.length - feedbackChars} earlier characters omitted]\n${text.slice(-feedbackChars)}`,
  };
}

/** `timeoutMs` must stay below the run's tool timeout so the container is reaped first. */
export function testRunTool({ timeoutMs = 110_000 } = {}) {
  return {
    name: 'test.run', version: '1', permission: 'exec', effect: 'read',
    description: `Run the project's AVA tests on a snapshot of the current workspace in an isolated Linux container (loopback only, no external network) and return pass/fail counts, failing test titles and the reporter output tail. Without files it runs the public regression set ${PUBLIC_TESTS.join(', ')}. The snapshot is taken when the call starts; edit files first, then call again. Each call takes about 10-20 seconds and stops after ${Math.round(timeoutMs / 1000)} seconds.`,
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        files: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Test files under test/, for example ["test/retry.ts"]. Omit for the public regression set.' },
        match: { type: 'string', minLength: 1, maxLength: 200, description: 'Optional AVA --match title pattern, without quotes.' },
      },
    },
    async execute({ session, signal }, args) {
      return feedback(await runPublicTests({ workspace: session.workspace, files: args.files, match: args.match, timeoutMs, signal }));
    },
  };
}
