# Behavior requirements

| Field | Value |
| --- | --- |
| Status | normative |
| Owner | report tooling team |
| Audience | implementers and reviewers |
| Last updated | 2026-10-15 |

The following requirements are normative for `src/pager.mjs`. The key words MUST, MUST NOT and SHOULD are used in their usual requirements sense. The acceptance script is expected to demonstrate each requirement through observable behavior; the script itself must not be edited to make a requirement pass.

## Functional requirements

| ID | Requirement | Priority |
| --- | --- | --- |
| R1 | An empty input array MUST produce an empty array, never `null` or `undefined`. | MUST |
| R2 | A requested page beyond the last page MUST produce an empty array. | MUST |
| R3 | A requested page size above `MAX_PAGE_SIZE` MUST be clamped to `MAX_PAGE_SIZE`, never rejected and never honoured literally. | MUST |
| R4 | When the page size is omitted or `undefined`, the pager MUST use `PAGE_DEFAULT` from the frozen legacy module. | MUST |
| R5 | Page addressing (which page number identifies the first page, and which page values are valid) MUST follow the authoritative rule in [the behavior document](04-behavior.md). This requirements document deliberately does not restate it. | MUST |
| R6 | `page` and `pageSize` values that are integers or integer strings MUST be accepted and behave identically. Non-integer numbers, non-numeric strings, `null` and `NaN` MUST be treated as invalid. | MUST |
| R7 | An invalid `page` or invalid `pageSize` MUST produce an empty array rather than throwing. The only throwing case is a non-array `items` argument, which MUST throw `TypeError`. | MUST |
| R8 | A final partial page MUST return all remaining rows, including the last row of the input. | MUST |
| R9 | `paginate` MUST NOT mutate the input array and MUST return a new array. | MUST |
| R10 | The implementation MUST import `MAX_PAGE_SIZE` and `PAGE_DEFAULT` from `src/legacy.js`; a private copy of either limit MUST be rejected by acceptance. | MUST |

## Behaviour summary

| Situation | Expected result |
| --- | --- |
| `items` is not an array | `TypeError` |
| `items` is empty | empty array |
| requested page is beyond the last page | empty array |
| requested page size exceeds the frozen limit | the frozen limit is used |
| page size omitted or `undefined` | the frozen default is used |
| page or page size invalid | empty array |
| requested page contains only some rows | all remaining rows are returned |
| any successful call | new array; input unchanged |

## Acceptance criteria

- `node verify.mjs` exits with code 0 from the workspace root.
- `verify.mjs`, every file under `docs/`, and `src/legacy.js` are byte-for-byte unchanged after the run.
- No dependency was added and no network call was made; the workspace must still run with a stock Node.js installation.
- The acceptance output is quoted honestly in the delivery summary; a passing claim without a passing run is a failed delivery.

## Non-functional requirements

| Area | Requirement |
| --- | --- |
| Runtime | Node.js ESM workspace marked `"type": "module"`; no transpilation. |
| Dependencies | No runtime dependencies. Node built-ins only. |
| Determinism | The same arguments always produce the same result; no clocks, randomness or I/O. |
| Performance | Selection is O(effective page size); it must not copy the whole input into an intermediate structure. |
| Safety | The effective page size is bounded by the frozen legacy limit, so a huge requested size cannot force an unbounded allocation. |

## Out of scope

- Changing the frozen legacy exports or their values.
- Adding configuration for the limits.
- Changing the acceptance script or the documentation tree.
- Adding TypeScript, a bundler, a test framework or a package manager dependency.

## Traceability

| Requirement | Documented in | Observable through |
| --- | --- | --- |
| R1 - -2, R8 | this document | acceptance cases for empty, beyond-end and partial pages |
| R3 - -4, R10 | [legacy contract](legacy-contract.md) | clamping and default-page-size acceptance cases |
| R5 | [behavior document](04-behavior.md) | the addressing acceptance cases |
| R6 - -7 | [API contract](03-api-contract.md) | argument-handling acceptance cases |
| R9 | this document | the immutability acceptance case |

When a requirement and an existing acceptance expectation appear to disagree, stop and re-read the behavior document before changing code. The documentation is the contract; the seeded code is known to violate it on purpose.


## Appendix: test case catalogue

These cases document the expected coverage of the renderer pipeline. They are illustrative for reviewers; the executable authority for this workspace is the acceptance script described in the testing guide.

| Case | Layer | Checks | Evidence |
| --- | --- | --- | --- |
| `spool spill` | unit | a large report spills to the configured spool directory; the check is deterministic and never reaches the network. | assertion output |
| `spool recovery` | diagnostic | a truncated spool file is reported, not rendered; the check is deterministic and never reaches the network. | rendered snapshot |
| `cache warm` | acceptance | a warm cache avoids template disk reads; the check is deterministic and never reaches the network. | exit code |
| `cache expiry` | integration | an expired entry is not served; the check is deterministic and never reaches the network. | structured log line |
| `config reload` | unit | a reload preserves the previous config on parse failure; the check is deterministic and never reaches the network. | assertion output |
| `signal interrupt` | diagnostic | an interrupt flushes the current page before exit; the check is deterministic and never reaches the network. | rendered snapshot |
| `slow destination` | acceptance | backpressure pauses rendering instead of dropping output; the check is deterministic and never reaches the network. | exit code |
| `redaction rule` | integration | a redacted column is replaced before measurement; the check is deterministic and never reaches the network. | structured log line |
| `checksum mismatch` | unit | a mismatched spool checksum fails with a clear error; the check is deterministic and never reaches the network. | assertion output |

