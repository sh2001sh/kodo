# Minimal real-continuation check (pre-registered protocol)

> **Frozen for the v2.1 registration only (2026-10-24).** Compaction v3 replaced the
> structured JSON summarizer. These runners (`compaction-continuation`,
> `continuation-audit`, `continuation-trigger-analysis`, `compaction-contract-replay`,
> `compaction-third-party`) import v2.1 modules that no longer exist in `dist`. They
> are kept unchanged as the record of the v2.1 registration. New v3 experiments use a
> newly registered runner.

Status: **pre-registered, never executed against a paid model.** The assets and the
protocol below are frozen before any real run so that the outcome cannot be
reinterpreted after the fact. This directory contains only zero-model-cost
material: no provider client, no network calls, no model credentials.

Upstream design: [architecture review, §9B](../../../docs/context-compaction-architecture-review.md#b-再做极小的真实续做检查)
and [projection contract v2](../../../docs/context-compaction-contract.md).

## 1. What this check is and is not

This is the minimal continuation check required by §9B: two small coding-repair
tasks that trigger natural compactions while the agent reads project
documentation, then require the agent to continue working and deliver a fixed
workspace.

It is **not** a semantic-quality experiment and **not** a cost-benefit
experiment. Passing both tasks only justifies moving to a larger paired study.
Nothing here may be reported as "summarization works", "summarization loses
information", a reliability rate, or a token/cost saving. There is no baseline
arm, no randomization and no statistical unit beyond the two tasks themselves.

## 2. Fixtures

Declared in [`fixtures.mjs`](fixtures.mjs); asserted by
[`self-check.mjs`](self-check.mjs).

| Field | Task A | Task B |
| --- | --- | --- |
| `id` | `task-a` | `task-b` |
| Docs read in the dry run | 9 | 15 |
| Docs size (Kodo estimate) | 21,668 tokens (registered range 20,000–28,000) | 40,607 tokens (registered range 38,000–50,000) |
| `workInputTokens` | 16,384 | 16,384 |
| `expectedMinCompactions` | 1 | 2 |
| Project | buggy `paginate()` ESM mini project | same project, six extra docs |
| Seeded acceptance | `node verify.mjs` exits 1 with `FAIL:` lines | same |
| Extra defect | — | the final partial page also drops its last row |

Both tasks use the same mini project contract. Task A documents it with eight
normative/supporting documents; task B adds six further documents (FAQ,
architecture decisions, observability, migration, security, performance) so
that reading the same tree in order crosses 16,384 estimated tokens twice. Task
B's extra source defect (a page window that ends one row early) is covered by
the same acceptance checks and gives the post-compaction agent a second repair
step.

The frozen legacy constraint used to probe retention is documented early (it is
the second file read) in `docs/legacy-contract.md`: `MAX_PAGE_SIZE` must remain
**37**, `PAGE_DEFAULT` must remain **10**, and `src/legacy.js` must not be
modified. It is deliberately absent from the objective text so that the run
observes whether the constraint survives the fold instead of echoing a prompt.

## 3. Seeded workspace and copy rules

* Each task owns a standalone ESM mini project under
  `assets/<task-id>/workspace/**`.
* `fixture.assetsDir` is the absolute path of that workspace directory (derived
  from `import.meta.url`, never hard-coded).
* Before every run, the runner creates a **fresh empty workspace directory** and
  calls `seedWorkspace(fixture, workspaceDir)`. The helper copies the entire
  asset tree into the workspace (creating directories) and returns
  `{ protectedFiles }`, the sorted, POSIX-style relative path of every protected
  file expanded recursively.
* The assets tree is never mutated; every run starts from a fresh copy.
* `verifyCommand` is `['node', 'verify.mjs']` and must run with the workspace as
  the working directory. There is no install step and no network access.
* The dry-run read plan is `fixture.dryRunReadFiles`, consumed strictly in
  order through `dryRunFileName(fixture, index)`. Reads are workspace-relative.

### Protected files

`fixture.protected` is `['verify.mjs', 'docs', 'src/legacy.js']`; the seed helper
expands it to:

```text
src/legacy.js
docs/README.md
docs/legacy-contract.md
docs/01-overview.md
... every other docs/ file ...
verify.mjs
```

The runner hashes each protected file with SHA-256 over its raw bytes before the
run and re-hashes after the run. Acceptance requires the two maps to be
identical **by relative path and hash**; extra files inside a protected
directory are a failure too (they change the expanded list), as are missing
files or any byte-level difference.

## 4. Acceptance criteria

A task is accepted only if **all four** hold:

1. the run completed — the runner process finished within its budget and the
   agent run reached a terminal status (no crash, no unfinished tool loop);
2. `node verify.mjs` exits with code **0** in the post-run workspace;
3. every protected file hash is **unchanged** from the seeded state and the
   protected file set itself is unchanged;
4. the compaction evidence is structurally sound: in the dry run,
   `context.summary.installed` count is **>= `expectedMinCompactions`**, and no
   deterministic summary failure code appears (`SUMMARY_STRUCTURE`,
   `SUMMARY_BUDGET`, `SUMMARY_SOURCE`, `SUMMARY_INJECTION_BUDGET`,
   `SUMMARY_INSTALL`, `SUMMARY_PARSE`, `SUMMARY_MESSAGE`, `SUMMARY_NO_GAIN`).

For the real (paid) run, criterion 4 is recorded rather than judged by the
minimum alone: any install count is reported, and the run is stopped per §5 if
it is zero or a deterministic failure appears. A real run that produces the
expected installs but fails acceptance is reported as a failure, not softened
into a partial success.

## 5. Real-run stop rule

The paid run is a single pre-registered attempt per task; there are no retries
to obtain a more favourable sample.

* Start with task A only.
* **Stop the paid session and record the reason, without rerunning**, if any of
  the following occurs: a deterministic summary failure code from §4 appears;
  `context.summary.installed` is 0; the run budget is exhausted before a
  terminal status; or a transport/model error prevents a clean run.
* Task B starts only after task A's run completed and its structural evidence
  was written. If task A failed as above, task B is not started.
* A failed attempt is preserved as-is in the output directory. Patching the
  fixture, raising budgets or rerunning to "get the install" invalidates the
  pre-registration.

## 6. Dry run vs paid run

Both modes exercise the real application and the real `summarizeContext` install
path. Only the model is different.

**Dry run (zero cost, no network).** A scripted provider replaces the model:

1. For each normal loop step, it emits one `file.read` tool call for the next
   entry of `fixture.dryRunReadFiles` (workspace-relative path, one file per
   call), in order.
2. When a summary-purpose request arrives (the compaction path's own model
   call), it returns a minimal valid seven-key summary JSON that cites the first
   `[S<n>]` label present in the provided summary input text. No model is
   called; this response is deterministic.
3. When the read plan is exhausted, it emits a final assistant answer and the
   run ends.

The dry run's job is to prove that this documentation tree, read in this order
under `workInputTokens: 16384`, actually triggers the registered minimum number
of natural compactions and that the runner can observe the install events. It
does **not** fix the code — the scripted agent performs no repair, so the seeded
`node verify.mjs` failure is expected and recorded; dry-run acceptance therefore
does not require criterion 2. It must not be cited as evidence that a model can
complete the task.

**Paid run (Lead-executed only).** A provider route is supplied through the
existing budget relay; the real model receives `fixture.objective`, the
workspace and the tool permissions read/write/exec with
`file.read`, `file.list`, `file.search`, `file.apply_patch`, `file.patch`,
`shell.exec`, `history.read`, `history.search`. This mode is the only evidence
used for continuation, and it is still only a two-task screen.

## 7. Exact dry-run read order

Task A (`docs/README.md` first; the frozen legacy constraint is the second
document, so it sits in the first fold):

```text
docs/README.md
docs/legacy-contract.md
docs/01-overview.md
docs/02-requirements.md
docs/03-api-contract.md
docs/04-behavior.md
docs/05-testing.md
docs/06-operations.md
docs/07-changelog.md
```

Task B: the same nine documents in the same order, then:

```text
docs/08-faq.md
docs/09-architecture-decisions.md
docs/10-observability.md
docs/11-migration.md
docs/12-security.md
docs/13-performance.md
```

The single authoritative source of this order is `dryRunReadFiles` in
[`fixtures.mjs`](fixtures.mjs); `dryRunFileName(fixture, index)` returns the
index-th entry and throws outside the valid range. `self-check.mjs` verifies
that every listed path exists in the seeded workspace.

## 8. Recorded evidence

For each task the runner writes a task directory containing at least: the run
report, the event trace, the verify command result (stdout, stderr, exit code),
the seed and post-run protected hash maps, and read-only counts from the state
store (summary started/installed/failed/skipped/truncated, context.compacted,
marker and budget token values, model and tool call counts, usage totals, final
answer text). Protected hashes and the verify result are authoritative for
acceptance; install counts are structural evidence; nothing else is scored.

## 9. Pre-registered interpretation limits

* Task A is designed to trigger one natural compaction, but
  `expectedMinCompactions` is a floor. If a correct configuration installs more
  than once, the run is accepted and the extra installs are recorded.
* Task B is expected to install at least twice. More installs are acceptable and
  recorded; fewer than two indicates the fixture, budget or read plan is not
  producing the intended history, not a model-quality result.
* If the real agent does not read the documentation in the planned order (or
  skips it), the install count may stay below the registered minimum. That is a
  behaviour observation for the follow-up study; it is reported, never patched
  after the fact.
* Retention is probed only through behaviour: task B's objective asks the
  delivery summary to name the frozen legacy limit the pager now uses, and the
  acceptance checks independently enforce the frozen value. Whether the summary
  names it is recorded as an observation, not a pass/fail criterion.
* Two tasks cannot support a reliability or non-inferiority claim. Two passes
  only justify a larger paired study (§9C).

## 10. Reproducing the zero-cost checks

```bash
node scripts/comparison/continuation/self-check.mjs
node scripts/comparison/compaction-continuation.mjs --dry-run --task both
```

`self-check.mjs` seeds both fixtures into the OS temp directory, asserts the
seeded acceptance failure, the protected-file expansion, the documentation token
totals and the presence of every dry-run read target, and then repairs a
throwaway copy to prove that the acceptance script can reach exit code 0. It
makes no model or network call and changes nothing outside the temp directory.

## 11. Interface

```js
import { fixtures, seedWorkspace, dryRunFileName } from './fixtures.mjs';

// fixtures: [{ id, title, objective, workInputTokens, expectedMinCompactions,
//              assetsDir, dryRunReadFiles, verifyCommand, protected }]
// seedWorkspace(fixture, workspaceDir) -> { protectedFiles: string[] }
// dryRunFileName(fixture, index) -> string
```
