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


## Appendix: structured log fields

Structured log lines are the fallback evidence source when a metric cannot answer an operational question. Fields marked required must appear on every line for the component.

| Field | Required | Population point |
| --- | --- | --- |
| `phase` | yes | Populated during request start by the column-measurer. |
| `rows_processed` | no | Populated during request start by the border-painter. |
| `pages_emitted` | yes | Populated during request start by the timestamp-formatter. |
| `duration_ms` | yes | Populated during request start by the empty-state-renderer. |
| `error_code` | no | Populated during request start by the renderer. |
| `retry_attempt` | yes | Populated during request start by the layout-engine. |
| `worker_id` | yes | Populated during request start by the row-buffer. |
| `spool_path` | no | Populated during request start by the header-encoder. |
| `template_version` | yes | Populated during request start by the footer-encoder. |
| `locale` | yes | Populated during request start by the theme-resolver. |
| `theme` | no | Populated during request start by the locale-resolver. |
| `cache_state` | yes | Populated during request start by the precision-formatter. |
| `queue_depth` | yes | Populated during request start by the grouping-splitter. |
| `destination` | no | Populated during request start by the truncation-engine. |
| `correlation_id` | yes | Populated during request start by the width-measurer. |
| `run_id` | yes | Populated during request start by the ansi-normalizer. |



## Appendix: further references

Pointers for readers who need more operational context than this workspace provides.

| Reference | Source | Use |
| --- | --- | --- |
| RB-Q-1546 | release checklist | Supplementary reference for spool-writer operators. |
| RB-R-1559 | incident archive | Supplementary reference for spool-reader operators. |
| RB-S-1572 | on-call guide | Supplementary reference for cache-store operators. |
| RB-T-1585 | engineering handbook | Supplementary reference for config-loader operators. |
| RB-U-1598 | schema registry | Supplementary reference for template-loader operators. |
| RB-V-1611 | release checklist | Supplementary reference for schema-validator operators. |

