# Release history

| Field | Value |
| --- | --- |
| Status | append-only |
| Owner | report tooling team |
| Audience | release engineers and reviewers |
| Last updated | 2026-07-14 |

This changelog covers the renderer pipeline release train and its supporting modules. It is a historical record, not a behavior specification: the requirements and the legacy contract are the normative documents, and this file must never be used to infer the current frozen values.

## Conventions

- Entries are append-only; a correction is a new entry, not an edit of the old one.
- Patch releases must be backwards compatible for callers.
- Any change to a documented behavior requires a minor or major version and a requirements change first.
- The frozen legacy exports are not versioned by this changelog and never change in a patch or minor release.

## Entries

| Version | Date | Summary | Area | Type |
| --- | --- | --- | --- | --- |
| 0.4.0 | 2025-06-18 | Introduced the renderer pipeline and stable row-buffer API | renderer | added |
| 0.4.1 | 2025-06-27 | Fixed UTF-8 slicing in the truncation engine | pager | changed |
| 0.4.2 | 2025-07-09 | Hardened spool checksum verification | legacy | fixed |
| 0.5.0 | 2025-07-30 | Added theme resolution and config reload | tooling | docs |
| 0.5.1 | 2025-08-12 | Fixed an off-by-one in footer placement on the final page | renderer | added |
| 0.5.2 | 2025-08-21 | Reduced startup time by loading templates lazily | pager | changed |
| 0.6.0 | 2025-09-03 | Added locale-aware grouping and precision formatting | legacy | fixed |
| 0.6.1 | 2025-09-15 | Fixed a cache key collision for parameterized templates | tooling | docs |
| 0.6.2 | 2025-09-26 | Improved backpressure handling for slow destinations | renderer | added |
| 0.7.0 | 2025-10-07 | Split layout computation from row rendering | pager | changed |
| 0.7.1 | 2025-10-14 | Fixed column measurement for full-width glyphs | legacy | fixed |
| 0.7.2 | 2025-10-22 | Added redaction filter and column-level policies | tooling | docs |
| 0.8.0 | 2025-11-04 | Introduced the spool writer and reader | renderer | added |
| 0.8.1 | 2025-11-18 | Fixed spool expiry sweep on startup | pager | changed |
| 0.8.2 | 2025-12-02 | Improved error codes for configuration parsing | legacy | fixed |
| 0.9.0 | 2025-12-16 | Added worker mode behind a feature flag | tooling | docs |
| 0.9.1 | 2026-01-08 | Fixed a worker restart loop on malformed templates | renderer | added |
| 0.9.2 | 2026-01-20 | Reduced memory pressure in the row buffer | pager | changed |
| 0.9.3 | 2026-02-03 | Added the checksum mismatch error family | legacy | fixed |
| 0.10.0 | 2026-02-17 | Stabilized the error taxonomy | tooling | docs |
| 0.10.1 | 2026-03-02 | Fixed a locale fallback regression | renderer | added |
| 0.10.2 | 2026-03-19 | Documented the report assembler contract | pager | changed |
| 0.11.0 | 2026-04-06 | Added precision rounding modes | legacy | fixed |
| 0.11.1 | 2026-04-21 | Fixed timestamp formatting across DST boundaries | tooling | docs |
| 0.11.2 | 2026-05-05 | Improved redaction performance for wide tables | renderer | added |
| 0.12.0 | 2026-05-19 | Introduced the immutable config snapshot | pager | changed |
| 0.12.1 | 2026-06-02 | Fixed config reload races under worker mode | legacy | fixed |
| 0.12.2 | 2026-06-16 | Reduced spool read amplification | tooling | docs |
| 0.13.0 | 2026-06-30 | Added the layout cache and width memoization | renderer | added |
| 0.13.1 | 2026-07-14 | Fixed cache invalidation for theme overrides | pager | changed |

## Known issues

- The layout cache can serve a stale width for custom glyphs until the cache entry expires; a reload clears it.
- Worker mode still logs one deprecation notice per restart on some terminal encodings.
- The spool expiry sweep may run once per hour even when the spool is disabled; this is harmless but noisy.
- The documentation cross-reference appendix is generated from the changelog and can lag one release behind.

## Release checklist

1. Acceptance passes in a clean checkout with no network access.
2. The changelog entry is reviewed by the owning team.
3. No protected file changed without an approved contract change.
4. The migration notes are updated when a caller-visible behavior changes.
5. The release tag matches the version in the changelog.
6. The release note links to the requirements document for behavior details.

Support engineers should cite the version and date of the relevant entry rather than quoting the summary out of context. Two entries can describe the same area in opposite directions across a major release.


## Appendix: additional decision records

### ADR-010: Keep theme resolution side-effect free

| Status | Date |
| --- | --- |
| accepted | 2026-01-10 |

**Context.** header-encoder had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** A small amount of extra documentation.


### ADR-003: Read frozen limits from the legacy module

| Status | Date |
| --- | --- |
| superseded | 2026-02-11 |

**Context.** width-measurer had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Clearer rollback boundaries.


### ADR-008: Reject unknown configuration keys

| Status | Date |
| --- | --- |
| proposed | 2026-03-12 |

**Context.** schema-validator had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Reviews take slightly longer but catch more.


### ADR-001: Render rows through a single buffer

| Status | Date |
| --- | --- |
| accepted | 2026-04-13 |

**Context.** checksum-verifier had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Fewer surprises in production.


### ADR-006: Version the configuration schema

| Status | Date |
| --- | --- |
| accepted | 2026-05-14 |

**Context.** layout-engine had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** A small amount of extra documentation.


### ADR-011: Run rendering in workers only when enabled

| Status | Date |
| --- | --- |
| superseded | 2026-06-15 |

**Context.** grouping-splitter had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Clearer rollback boundaries.


### ADR-004: Prefer configuration snapshots over live reads

| Status | Date |
| --- | --- |
| proposed | 2026-07-16 |

**Context.** config-loader had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Reviews take slightly longer but catch more.


### ADR-009: Use structured error codes

| Status | Date |
| --- | --- |
| accepted | 2026-08-17 |

**Context.** cli-entry had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Fewer surprises in production.


