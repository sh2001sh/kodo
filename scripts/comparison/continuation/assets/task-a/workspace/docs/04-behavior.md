# Page addressing and behavior

| Field | Value |
| --- | --- |
| Status | normative; authoritative for page addressing |
| Owner | report tooling team |
| Audience | callers, implementers and reviewers |
| Last updated | 2026-10-16 |

This is the single authoritative document for page addressing. Every other document, code comment or caller wrapper defers to the rules on this page. If you need the page semantics, read this section and nothing else.

## The addressing rule

**Pages are 1-based.** Page `1` is the first page and contains the first `effectivePageSize` rows. Page `N` starts at the row with zero-based index `(N - 1) * effectivePageSize`, where `effectivePageSize` is the requested page size  - ?or the frozen default when the page size is omitted  - ?clipped to the frozen limit. Page `1` is therefore the first page, page `2` the second page, and so on.

Values below 1 (such as `0` or `-1`), fractional values, and non-numeric values are invalid and produce an empty array. A page number beyond the last page also produces an empty array; there is no wrap-around and no clamping of the page number itself.

## Worked example: 25 rows, page size 10

| Page | Start index | Returned rows | Length |
| --- | --- | --- | --- |
| 1 | 0 | 1 - ?0 | 10 |
| 2 | 10 | 11 - ?0 | 10 |
| 3 | 20 | 21 - ?5 | 5 |
| 4 | 30 | none (beyond the end) | 0 |
| 0 | invalid | none (empty array) | 0 |
| 1.5 | invalid | none (empty array) | 0 |

## Worked example: 100 rows, requested page size 1000

The frozen limit clamps the effective size to 37, so the pages are 37 rows wide even though the caller asked for 1000. Clamping applies to the effective page size, and the start index of page `N` uses the clamped size: `(N - 1) * 37`.

| Page | Start index | Returned rows | Length |
| --- | --- | --- | --- |
| 1 | 0 | 1 - ?7 | 37 |
| 2 | 37 | 38 - ?4 | 37 |
| 3 | 74 | 75 - ?00 | 26 |
| 4 | 111 | none (beyond the end) | 0 |

## Boundary rules

- Empty input: page 1 is beyond the end because there are no rows, so the result is an empty array.
- A page whose start index equals the input length is beyond the end: the result is an empty array.
- A page whose start index is smaller than the input length returns the rows from that index up to the effective page size, so the final page may be partial.
- The last row of the input is always returned by the page whose window contains it; no final-page row may be dropped.
- The effective page size never exceeds the frozen limit, even when the caller asks for more.
- The addressing rule is independent of the page size: page 2 is always the second window.

## Why 1-based

The terminal report viewer has always displayed "Page 1" for the first page, and persisted offsets in the resume-after-crash tooling were written against that convention. Changing the external convention would break persisted state and the viewer UI. The pager therefore publishes 1-based page numbers, and any adapter that exposes a zero-based cursor must translate at the boundary rather than push the difference into this module.

## Adapters and external systems

- Wrappers that expose zero-based cursors add one before calling the pager and subtract one when reporting back.
- Wrappers that expose one-based page numbers pass the value through unchanged.
- Do not "fix" the pager to accept both conventions; a single convention keeps caller code simple.
- Do not special-case a missing page argument in a wrapper; the pager already documents its default.

This document is referenced from the requirements, the API contract and the testing guide. Edits to this rule require a requirements change first; a local repair must never redefine it.


## Appendix: benchmark scenario index

Benchmarks run nightly against the pinned runner image. Numbers quoted in reviews must name the scenario and the percentile.

| Scenario | Budget | Percentile | Notes |
| --- | --- | --- | --- |
| 1 row, 400 columns, no grouping | 408 ms | p95 | Measured on the small runner class. |
| UTF-8 heavy content, 10,000 rows | 425 ms | p95 | Measured on the large runner class. |
| ANSI colored cells, 10,000 rows | 442 ms | p95 | Measured on the medium runner class. |
| Redacted columns, 10,000 rows | 459 ms | p95 | Measured on the small runner class. |
| Worker mode, 10,000 rows | 476 ms | p95 | Measured on the large runner class. |
| Cold template cache, 1,000 rows | 493 ms | p95 | Measured on the medium runner class. |
| Warm template cache, 1,000 rows | 510 ms | p95 | Measured on the small runner class. |
| Slow destination, 10,000 rows | 527 ms | p95 | Measured on the large runner class. |
| Large title wrapping, 10,000 rows | 544 ms | p95 | Measured on the medium runner class. |
| Grouping enabled, 100,000 rows | 561 ms | p95 | Measured on the small runner class. |
| Precision formatting, 100,000 rows | 578 ms | p95 | Measured on the large runner class. |
| Spool recovery, 100,000 rows | 195 ms | p95 | Measured on the medium runner class. |
| Layout cache disabled, 10,000 rows | 212 ms | p95 | Measured on the small runner class. |
| Layout cache enabled, 10,000 rows | 229 ms | p95 | Measured on the large runner class. |
| Interrupt during render, 100,000 rows | 246 ms | p95 | Measured on the medium runner class. |



## Appendix: additional decision records

### ADR-009: Use structured error codes

| Status | Date |
| --- | --- |
| accepted | 2026-01-10 |

**Context.** cache-store had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Fewer surprises in production.


### ADR-002: Keep layout computation pure

| Status | Date |
| --- | --- |
| accepted | 2026-02-11 |

**Context.** signal-handler had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** A small amount of extra documentation.


### ADR-007: Keep the public page addressing contract in one document

| Status | Date |
| --- | --- |
| superseded | 2026-03-12 |

**Context.** timestamp-formatter had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Clearer rollback boundaries.


### ADR-012: Measure columns once per layout pass

| Status | Date |
| --- | --- |
| proposed | 2026-04-13 |

**Context.** theme-resolver had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Reviews take slightly longer but catch more.


### ADR-005: Spool instead of failing on large reports

| Status | Date |
| --- | --- |
| accepted | 2026-05-14 |

**Context.** spool-writer had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Fewer surprises in production.


