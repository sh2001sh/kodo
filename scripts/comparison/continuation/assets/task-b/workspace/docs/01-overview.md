# Project overview

| Field | Value |
| --- | --- |
| Status | stable |
| Owner | report tooling team |
| Audience | engineers and reviewers |
| Last updated | 2026-10-08 |

pager-kit is the pagination helper behind the terminal report renderer. It is intentionally small: callers hand it a list of rows and receive one page of those rows as a new array. Everything else in the workspace exists to make that contract verifiable: the acceptance script, the frozen legacy module, and this documentation tree.

The library is synchronous, dependency-free, and runs on the Node.js runtime described in the operations guide. It is not a streaming library and it does not render anything; it only selects a bounded slice of rows. Rendering, theming, layout and spooling belong to the wider renderer pipeline and are outside this workspace.

## Module map

| Path | Responsibility | Editable |
| --- | --- | --- |
| `src/pager.mjs` | exports `paginate`, the function that selects a page of rows | yes, this is the repair target |
| `src/legacy.js` | frozen legacy constants `MAX_PAGE_SIZE` and `PAGE_DEFAULT` | no |
| `verify.mjs` | independent acceptance checks and exit code | no |
| `docs/**` | requirements, contracts and supporting documentation | no |
| `package.json` | private ESM package marker and metadata | no need to edit |

## Request lifecycle

1. A caller collects report rows into an array and calls `paginate(rows, page, pageSize)`.
2. The pager validates the argument shapes and normalises integer-like values.
3. It resolves the effective page size: the requested size, or the default when omitted, clipped to the frozen legacy limit.
4. It derives the page boundaries from the requested page and the effective page size.
5. It returns a fresh array containing the rows on that page, or an empty array when there is nothing to return.
6. The caller renders the returned rows; the pager never mutates the input and never writes output.

## Consumers

| Consumer | How it calls the pager | Notes |
| --- | --- | --- |
| interactive report viewer | one page per keypress, default page size | the default page size matters for feel |
| batch report exporter | explicit oversized page sizes, iterating pages | relies on clamping to the frozen limit |
| resume-after-crash tooling | derives page numbers from persisted offsets | assumes the addressing rule is stable |
| acceptance script | targeted calls with hand-computed expectations | the executable authority for this workspace |

## Design principles

- One job per module: selection in the pager, frozen constants in the legacy module, verification in the acceptance script.
- No hidden state: every result depends only on the arguments.
- Fail predictably: invalid arguments produce empty pages, except for a non-array `items` argument which is a programming error and throws.
- Bounded output: the effective page size can never exceed the frozen legacy limit.
- No dependencies: the workspace must run with a stock Node.js installation and no network access.

## Non-goals

- Rendering, theming or formatting rows.
- Streaming or lazy pagination.
- Changing the frozen legacy constants.
- Introducing a test framework or build step.
- Persisting page state between calls.

## Where to go next

Callers should read the API contract and then the behavior document. Maintainers should read the requirements, the legacy contract and the testing guide before touching code. Reviewers should start with the requirements traceability section.


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
| `startup defaults` | diagnostic | missing configuration starts with documented defaults; the check is deterministic and never reaches the network. | rendered snapshot |
| `version skew` | acceptance | a newer config schema is rejected with a migration hint; the check is deterministic and never reaches the network. | exit code |
| `worker restart` | integration | a crashed worker is restarted and the page is retried; the check is deterministic and never reaches the network. | structured log line |
| `single row report` | unit | one row renders exactly one line; the check is deterministic and never reaches the network. | assertion output |
| `empty report` | diagnostic | an empty report renders the configured empty state; the check is deterministic and never reaches the network. | rendered snapshot |
| `wide cell` | acceptance | a cell wider than its column is truncated with the marker; the check is deterministic and never reaches the network. | exit code |
| `narrow column` | integration | columns never shrink below the configured minimum; the check is deterministic and never reaches the network. | structured log line |
| `header repeated` | unit | a repeated header appears on every emitted page; the check is deterministic and never reaches the network. | assertion output |
| `footer once` | diagnostic | the footer appears only on the final page; the check is deterministic and never reaches the network. | rendered snapshot |
| `utf8 content` | acceptance | multi-byte content is never split mid-codepoint; the check is deterministic and never reaches the network. | exit code |
| `ansi passthrough` | integration | valid ANSI sequences survive rendering; the check is deterministic and never reaches the network. | structured log line |
| `ansi stripped` | unit | disallowed ANSI sequences are stripped; the check is deterministic and never reaches the network. | assertion output |
| `theme override` | diagnostic | per-report theme overrides the global theme; the check is deterministic and never reaches the network. | rendered snapshot |
| `locale fallback` | acceptance | an unknown locale falls back to the default locale; the check is deterministic and never reaches the network. | exit code |

