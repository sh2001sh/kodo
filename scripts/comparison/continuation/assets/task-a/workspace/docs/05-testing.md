# Testing and acceptance

| Field | Value |
| --- | --- |
| Status | stable |
| Owner | report tooling team |
| Audience | implementers |
| Last updated | 2026-10-18 |

This workspace has one acceptance script. It is intentionally not a unit-test framework: it exercises the public function from the outside, compares observable results, prints one explicit line per check, and communicates the outcome through its exit code. Nothing about the repair is accepted until that script exits with code 0.

## Running acceptance

```bash
node verify.mjs
echo $?   # or: echo %ERRORLEVEL% on Windows
```

Run it from the workspace root so that its relative imports resolve. The script uses only Node built-ins, needs no installation step, and never reaches the network.

| Exit code | Meaning |
| --- | --- |
| 0 | every acceptance check passed; the repair is accepted |
| 1 | at least one check failed; the script printed explicit `FAIL:` lines |

## What the acceptance script checks conceptually

- The frozen legacy constants have the documented values and the pager imports the page limit from the frozen module.
- Empty input returns an empty array rather than `null` or `undefined`.
- A page beyond the last page returns an empty array.
- Requested page sizes above the frozen limit are clamped to the frozen limit, including on later pages.
- An omitted page size uses the frozen default, and an omitted page addresses the first page.
- Page addressing follows the authoritative rule in [the behavior document](04-behavior.md), including page boundaries, partial final pages and invalid page values.
- Integer strings behave like integers; fractional, non-numeric and other invalid values return empty arrays.
- The input array is not mutated and a fresh array is returned; a non-array argument throws `TypeError`.

The exact assertions are part of the protected acceptance script. Read the script if you want the precise calls and expected values; do not edit it. The list above is documentation, not a substitute for running it.

## Repair workflow

1. Read the documentation in order, starting with the index, the legacy contract and the requirements.
2. Run `node verify.mjs` in the seeded state and read every `FAIL:` line; each line names the expectation that is violated.
3. Open `src/pager.mjs` and compare its behavior against the requirements and the behavior document.
4. Make one focused change at a time in source files only, then re-run `node verify.mjs`.
5. Continue until the script prints `PASS:` and exits 0. Do not stop at the first green line; the final exit code is the verdict.
6. Re-run once more after the last edit to confirm there is no regression from an earlier fix.
7. Record the exact command and the final output for the delivery summary.

## Evidence rules

- Quote real output from a real run; never write "verified" without a recorded exit code of 0.
- Do not edit `verify.mjs`, `docs/**` or `src/legacy.js` to make a check pass.
- Do not add a dependency, a test framework or a build step to avoid the acceptance script.
- If a failure message is unclear, read the corresponding section of the requirements or behavior document before guessing.
- Keep the workspace runnable with a stock Node.js installation and no network access.

## Protected files

| Path | Reason |
| --- | --- |
| `verify.mjs` | the acceptance contract itself |
| `docs/**` | the normative documentation set |
| `src/legacy.js` | the frozen legacy exports, including the page-size limit |

Every protected file is hashed after the run and compared with its seeded hash. A byte-level difference fails the task even if the acceptance script exits 0.

## Local diagnostics

For a quicker loop you may run individual scenarios in a throwaway script, for example constructing an array and printing `paginate(rows, page, pageSize)` for a page boundary. Throwaway scripts must not modify the protected files and must not be required for acceptance. There is no watch mode, no test runner and no fixture server in this workspace.

## Continuous integration

The repository pipeline runs the acceptance script in a clean checkout with no network access. It treats any non-zero exit as a failure and keeps the captured stdout and stderr as the build evidence. A repair that passes locally must therefore pass in a clean workspace with no residual files.


## Appendix: documentation cross-reference

When two documents disagree, the requirements document wins for behavior and the legacy contract wins for frozen exports.

| Topic | Document | Scope |
| --- | --- | --- |
| Renderer pipeline | `docs/01-overview.md` | Module map and request lifecycle |
| Requirements | `docs/02-requirements.md` | Normative behavior for the pager |
| API contract | `docs/03-api-contract.md` | Signature, argument handling and returns |
| Behavior | `docs/04-behavior.md` | Page addressing rules and examples |
| Testing | `docs/05-testing.md` | How acceptance is executed |
| Operations | `docs/06-operations.md` | Runtime matrix and runbook |
| Changelog | `docs/07-changelog.md` | Release history |
| Legacy contract | `docs/legacy-contract.md` | Frozen exports and limits |



## Appendix: security control matrix

Controls are reviewed at least once per release cycle. A missing or failing control blocks the release until the owning team records a remediation plan.

| Control | Requirement | Applied at | Verification |
| --- | --- | --- | --- |
| SC-532 | Fail closed when a redaction rule is malformed | configuration load | monitoring |
| SC-543 | Keep error messages free of raw input content | continuous | review |
| SC-554 | Use constant-time comparison for checksums | release | automated |
| SC-565 | Require explicit opt-in for worker mode | every request | monitoring |
| SC-576 | Record an audit line for configuration reloads | incident response | review |

