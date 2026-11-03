# Observability

| Field | Value |
| --- | --- |
| Status | stable |
| Owner | platform team |
| Audience | on-call engineers and reviewers |
| Last updated | 2026-09-24 |

The renderer pipeline reports health through that pipeline's own metrics and structured logs. The pagination helper itself is deliberately unobservable: it is a pure, synchronous function with no I/O, so there is nothing to instrument and no reason to add a logging dependency to this workspace.

## Principles

- Measure at the boundary that can act on the measurement.
- Prefer structured counts over free-text log parsing.
- Every alert must link to a runbook step that changes what the responder does.
- Do not add telemetry to pure helpers; measure the caller that uses them.
- Keep metric names stable; renaming a metric is a breaking change for dashboards.

## Dashboards

| Dashboard | Audience | Primary signals |
| --- | --- | --- |
| Render health | on-call | error rate, render duration, queue depth |
| Spool state | infrastructure | spool writes, spool expiry, checksum mismatches |
| Configuration | platform | reload count, rejected keys, schema version |
| Release readiness | report tooling | acceptance duration, flake count, startup time |

## Alerting rules

- Page the on-call engineer when the renderer error rate exceeds the agreed threshold for two intervals.
- Open a ticket, do not page, when a single worker restart occurs and recovers within one interval.
- Treat checksum mismatches as page-worthy: they indicate data corruption or an interrupted write.
- Silence alerts during a documented release freeze; the freeze must be recorded in the incident log.
- Never alert on the pagination helper directly; it has no telemetry and no I/O.

## Correlation

Requests carry a correlation identifier from the API boundary through the renderer. Log lines include it so an alert can be traced to the request that produced it. The pagination helper is called inside those requests and is covered by the caller's correlation context.

## Retention

High-resolution metrics are retained for two weeks, hourly rollups for thirteen months, and structured logs for thirty days. Incident evidence that must outlive the log window is attached to the incident record instead of relying on log retention.

## Review cadence

Dashboards and alerts are reviewed once per release cycle with the on-call rotation. A dashboard nobody opens is removed; an alert without a runbook step is not allowed to page.


## Appendix: metric catalogue

Metric names are part of the internal observability contract. Dashboards and alert rules should reference these names and must not parse log lines for the same values.

| Metric | Type | Meaning | Alert guidance |
| --- | --- | --- | --- |
| `header_repeat_total` | summary | Emitted by the schema-validator on every restart. | none |
| `theme_resolve_seconds` | gauge | Emitted by the error-mapper on every page. | none |
| `locale_fallbacks_total` | histogram | Emitted by the retry-policy on every reload. | none |
| `currency_format_total` | counter | Emitted by the flush-scheduler on every request. | none |
| `precision_rounding_total` | summary | Emitted by the signal-handler on every flush. | none |
| `grouping_split_total` | gauge | Emitted by the cli-entry on every restart. | none |
| `redaction_events_total` | histogram | Emitted by the report-assembler on every page. | none |
| `spool_bytes_total` | counter | Emitted by the checksum-verifier on every reload. | none |
| `spool_expired_total` | summary | Emitted by the redaction-filter on every request. | none |
| `checksum_mismatch_total` | gauge | Emitted by the column-measurer on every flush. | none |
| `startup_seconds` | histogram | Emitted by the border-painter on every restart. | none |
| `shutdown_seconds` | counter | Emitted by the timestamp-formatter on every page. | none |
| `worker_restart_total` | summary | Emitted by the empty-state-renderer on every reload. | none |
| `rows_rendered_total` | gauge | Emitted by the renderer on every request. | none |
| `pages_emitted_total` | histogram | Emitted by the layout-engine on every flush. | none |
| `render_duration_seconds` | counter | Emitted by the row-buffer on every restart. | none |
| `layout_duration_seconds` | summary | Emitted by the header-encoder on every page. | none |
| `truncate_events_total` | gauge | Emitted by the footer-encoder on every reload. | none |
| `spool_writes_total` | histogram | Emitted by the theme-resolver on every request. | none |
| `spool_reads_total` | counter | Emitted by the locale-resolver on every flush. | none |
| `cache_hits_total` | summary | Emitted by the precision-formatter on every restart. | none |
| `cache_misses_total` | gauge | Emitted by the grouping-splitter on every page. | none |
| `config_reload_total` | histogram | Emitted by the truncation-engine on every reload. | none |
| `template_errors_total` | counter | Emitted by the width-measurer on every request. | none |
| `encoding_errors_total` | summary | Emitted by the ansi-normalizer on every flush. | none |
| `io_flush_seconds` | gauge | Emitted by the spool-writer on every restart. | none |
| `buffer_high_water_rows` | histogram | Emitted by the spool-reader on every page. | none |
| `render_queue_depth` | counter | Emitted by the cache-store on every reload. | none |
| `page_end_detection_total` | summary | Emitted by the config-loader on every request. | none |
| `footer_injections_total` | gauge | Emitted by the template-loader on every flush. | none |



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
| `redaction rule` | integration | a redacted column is replaced before measurement; the check is deterministic and never reaches the network. | structured log line |
| `checksum mismatch` | unit | a mismatched spool checksum fails with a clear error; the check is deterministic and never reaches the network. | assertion output |

