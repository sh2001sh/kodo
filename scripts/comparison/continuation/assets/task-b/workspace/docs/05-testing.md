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


## Appendix: glossary

Shared vocabulary used by the renderer pipeline documentation.

| Term | Definition |
| --- | --- |
| **Locale** | The language and regional conventions used for formatting. |
| **Emit** | Writing a fully rendered page to the output stream. |
| **Worker** | A child process dedicated to rendering. |
| **Report row** | A single logical record rendered as one line of text. |
| **Ellipsis marker** | The marker appended to truncated content. |
| **Row buffer** | The in-memory queue of rows waiting to be rendered. |
| **Config layer** | A source of runtime configuration values. |
| **Empty state** | The placeholder shown for an empty report. |
| **Flush** | The act of handing buffered output to the destination stream. |
| **Footer** | The final block of a page. |
| **Redaction** | Replacing sensitive cell content before rendering. |
| **Spool expiry** | The age after which a spool file is removed. |
| **Gutter** | Blank space inserted between adjacent columns. |
| **Precision** | The number of fractional digits rendered for numbers. |
| **Backpressure** | The signal that a destination wants the producer to slow down. |
| **Supervisor** | The parent process that restarts workers. |
| **Page** | A contiguous slice of report rows emitted as one unit of output. |



## Appendix: test case catalogue

These cases document the expected coverage of the renderer pipeline. They are illustrative for reviewers; the executable authority for this workspace is the acceptance script described in the testing guide.

| Case | Layer | Checks | Evidence |
| --- | --- | --- | --- |
| `custom glyphs` | integration | custom border glyphs are applied consistently; the check is deterministic and never reaches the network. | structured log line |
| `spool spill` | unit | a large report spills to the configured spool directory; the check is deterministic and never reaches the network. | assertion output |
| `spool recovery` | diagnostic | a truncated spool file is reported, not rendered; the check is deterministic and never reaches the network. | rendered snapshot |
| `cache warm` | acceptance | a warm cache avoids template disk reads; the check is deterministic and never reaches the network. | exit code |
| `cache expiry` | integration | an expired entry is not served; the check is deterministic and never reaches the network. | structured log line |
| `config reload` | unit | a reload preserves the previous config on parse failure; the check is deterministic and never reaches the network. | assertion output |
| `signal interrupt` | diagnostic | an interrupt flushes the current page before exit; the check is deterministic and never reaches the network. | rendered snapshot |
| `slow destination` | acceptance | backpressure pauses rendering instead of dropping output; the check is deterministic and never reaches the network. | exit code |

