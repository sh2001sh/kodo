# Architecture decision records

| Field | Value |
| --- | --- |
| Status | accepted decisions; append-only |
| Owner | report tooling team |
| Audience | maintainers |
| Last updated | 2026-10-02 |

Decision records explain why the workspace looks the way it does. They are historical context: when a decision record and the requirements disagree, the requirements win. Records that are superseded stay in the file with their original context so reviewers can see what was tried.

## ADR-001: Select rows in a dedicated helper

**Context.** Callers were slicing arrays inline, each with slightly different boundary handling. Reviews kept rediscovering the same off-by-one discussions.

**Decision.** All callers go through one exported pagination function. The function owns argument handling, defaults and limits.

**Consequences.** One place to fix and one place to verify; callers lose the freedom to invent their own semantics, which is the point.

## ADR-002: Keep the legacy constants in a frozen module

**Context.** The page-size limit and the default size were copied into several call sites and had started to drift.

**Decision.** The values live in one legacy module. Other modules import them and redefining them locally is treated as a defect.

**Consequences.** Consumers can rely on a stable value; changes require a coordinated migration and are outside the scope of a repair.

## ADR-003: Import frozen limits instead of duplicating them

**Context.** A local copy of the page-size limit in the pager had drifted away from the frozen value and silently changed the output size.

**Decision.** The pager imports the limits from the legacy module. Acceptance checks both the imported values and the static import.

**Consequences.** Any future drift is caught immediately; the pager cannot be compiled in isolation from the legacy module, which is acceptable for this workspace.

## ADR-004: Keep the acceptance script independent

**Context.** Test suites that import private helpers can accidentally verify the implementation against itself.

**Decision.** Acceptance imports only the public function and the frozen constants, computes expectations independently, and uses no test framework.

**Consequences.** The script is portable and readable; convenience helpers used internally by the implementation cannot be used in expectations.

## ADR-005: Fail predictably on invalid arguments

**Context.** Callers were unsure whether invalid pages should throw, clamp or return empty pages.

**Decision.** Invalid page and page-size values return an empty array; only a non-array items argument throws.

**Consequences.** Callers can treat an empty array as "nothing to show"; programming errors still fail loudly.

## ADR-006: Keep page addressing in exactly one document

**Context.** Page addressing rules had been restated in several places and the copies had already diverged.

**Decision.** One behavior document owns the addressing rule. Other documents link to it instead of restating it.

**Consequences.** Reviewers have one place to check; the risk of contradictory copies disappears.

## ADR-007: Treat the frozen module as uneditable

**Context.** Repairs repeatedly tried to adjust the page-size limit to make a test pass.

**Decision.** The legacy module is protected. Acceptance hashes it, and the repair must adapt to the frozen values.

**Consequences.** Fixes stay within the helper module; changing a published limit becomes an explicit, reviewable proposal.

## ADR-008: No dependencies in the workspace

**Context.** Small workspaces often accumulate test runners and formatting libraries that hide behavior.

**Decision.** Only Node built-ins are allowed. The acceptance script uses assertions from the standard library.

**Consequences.** The workspace installs instantly and runs offline; some conveniences are lost.

## Superseded decisions

Earlier proposals to make the page-size limit configurable, to return `null` for empty input, and to accept zero-based page numbers were all rejected. The rejection reasons are captured in the corresponding records above; in short, they either broke frozen callers, broke persisted state, or moved a boundary decision away from the module that owns it.

## How to propose a change

1. Describe the problem and the observed behavior with evidence.
2. State the decision and the alternatives that were considered.
3. List the consequences for callers, tests and the frozen module.
4. Request review from the owning team before changing behavior.
5. If accepted, add a new record and supersede the old one by reference.


## Appendix: structured log fields

Structured log lines are the fallback evidence source when a metric cannot answer an operational question. Fields marked required must appear on every line for the component.

| Field | Required | Population point |
| --- | --- | --- |
| `theme` | yes | Populated during request start by the column-measurer. |
| `cache_state` | no | Populated during request start by the border-painter. |
| `queue_depth` | yes | Populated during request start by the timestamp-formatter. |
| `destination` | yes | Populated during request start by the empty-state-renderer. |
| `correlation_id` | no | Populated during request start by the renderer. |
| `run_id` | yes | Populated during request start by the layout-engine. |
| `tenant_id` | yes | Populated during request start by the row-buffer. |
| `report_id` | no | Populated during request start by the header-encoder. |
| `config_snapshot` | yes | Populated during request start by the footer-encoder. |
| `component` | yes | Populated during request start by the theme-resolver. |
| `phase` | no | Populated during request start by the locale-resolver. |
| `rows_processed` | yes | Populated during request start by the precision-formatter. |
| `pages_emitted` | yes | Populated during request start by the grouping-splitter. |
| `duration_ms` | no | Populated during request start by the truncation-engine. |
| `error_code` | yes | Populated during request start by the width-measurer. |
| `retry_attempt` | yes | Populated during request start by the ansi-normalizer. |



## Appendix: further references

Pointers for readers who need more operational context than this workspace provides.

| Reference | Source | Use |
| --- | --- | --- |
| RB-I-1336 | release checklist | Supplementary reference for spool-writer operators. |
| RB-J-1349 | incident archive | Supplementary reference for spool-reader operators. |
| RB-K-1362 | on-call guide | Supplementary reference for cache-store operators. |
| RB-L-1375 | engineering handbook | Supplementary reference for config-loader operators. |
| RB-M-1388 | schema registry | Supplementary reference for template-loader operators. |

