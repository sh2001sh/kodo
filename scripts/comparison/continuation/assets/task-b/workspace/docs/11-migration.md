# Caller migration guide

| Field | Value |
| --- | --- |
| Status | stable |
| Owner | report tooling team |
| Audience | callers and integrators |
| Last updated | 2026-09-18 |

This guide is for callers moving from hand-written array slicing to the shared pagination helper. It describes the phases, the compatibility promises and the checklist. It does not redefine the page addressing rule or the frozen limits: those remain exactly as published in the behavior document and the legacy contract.

## Phases

1. Inventory call sites that slice report rows manually and record their current behavior.
2. Compare each call site against the requirements; note any that rely on behavior the helper does not promise.
3. Replace the manual slice with the helper call, translating any external convention at the boundary.
4. Run the caller's own tests and the workspace acceptance script.
5. Remove the now-unused manual boundary code in a separate review.
6. Update the caller documentation to link to the requirements instead of describing the pager locally.

## Compatibility promises

| Promise | Status |
| --- | --- |
| The public function and argument shape stay stable within a major version. | guaranteed |
| The effective page size never exceeds the frozen limit. | guaranteed |
| An empty or out-of-range request returns an empty array. | guaranteed |
| Page addressing follows the single authoritative rule. | guaranteed |
| The legacy module exports stay untouched. | guaranteed |
| Validation behavior for array elements is provided by the pager. | not promised |

## Boundary translation

If a caller exposes zero-based cursors to its own users, translate at that caller's boundary and keep the helper contract intact. Do not add a second convention to the pager for convenience, and do not special-case a missing argument in a wrapper: the helper already documents its default.

## Rollout checklist

- All call sites use the shared helper; no manual boundary arithmetic remains.
- Each migrated call site has a test for an empty report, a single-page report and a multi-page report.
- Acceptance passes in a clean checkout with no network access.
- Protected files are unchanged after the migration.
- Caller documentation links to the requirements instead of copying them.
- Rollback restores the previous implementation without touching the frozen module.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A caller silently relied on a zero-based convention | translate at the boundary and add a regression test |
| A caller passed an oversized page size and consumed the whole array | use the helper; the frozen limit bounds the allocation |
| Documentation drifts from the requirements | link to the authoritative documents instead of restating them |
| A migration changes behavior in an unrelated report | migrate one call site per review and compare snapshots |

## Getting help

The report tooling team reviews migrations and can provide a paired review for the first call site. Escalate ambiguity immediately; a wrong convention in a shared helper is expensive to reverse.


## Appendix: extended operations runbook

1. Inspect the template version reported by the config snapshot

2. Decide whether rollback or forward-fix is lower risk

3. Schedule the post-incident review within five working days

4. Enable debug logging for the renderer component only

5. Run one focused acceptance check with the minimal fixture

6. Add a regression test for the reproduced scenario

7. Inspect the spool directory for expired or corrupt files

8. Confirm the locale package matches the pinned version

9. If rolling back, restore the previous configuration snapshot first

10. Confirm the reported symptom reproduces with the current release tag

11. Reproduce with the layout cache disabled to rule out stale memoization

12. Record the observed row-buffer high-water mark

13. Update the runbook with anything that was missing

14. Verify the checksum of the most recent spool file

15. Review recent configuration reloads for rejected keys

16. Notify the report owners listed in the service catalogue

17. Capture the configuration snapshot and the render request fingerprint

18. Check whether worker mode is enabled for the affected tenant

19. Attach the error code and correlation id to the incident

20. Close the incident only after the dashboard is green for one interval

21. Compare the deployment digest against the approved release manifest

22. Check destination backpressure metrics for the report interval

23. Open a follow-up task for the root cause analysis

24. Check the dashboard for renderer error rate and queue depth



## Appendix: glossary

Shared vocabulary used by the renderer pipeline documentation.

| Term | Definition |
| --- | --- |
| **Truncation** | Shortening cell content that exceeds the column width. |
| **Header** | The first block of a page. |
| **Template** | A reusable skeleton for headers, footers or rows. |
| **Frame policy** | The rule that decides whether a border is drawn. |
| **Spool** | An on-disk buffer used when output does not fit in memory. |
| **Grouping** | Digit separators inserted for readability. |
| **High-water mark** | The maximum queue depth observed in a window. |
| **Checksum** | A digest used to verify spool integrity. |
| **Frame** | A horizontal border drawn around a page or a column group. |
| **Locale** | The language and regional conventions used for formatting. |
| **Emit** | Writing a fully rendered page to the output stream. |
| **Worker** | A child process dedicated to rendering. |
| **Report row** | A single logical record rendered as one line of text. |
| **Ellipsis marker** | The marker appended to truncated content. |
| **Row buffer** | The in-memory queue of rows waiting to be rendered. |



## Appendix: security control matrix

Controls are reviewed at least once per release cycle. A missing or failing control blocks the release until the owning team records a remediation plan.

| Control | Requirement | Applied at | Verification |
| --- | --- | --- | --- |
| SC-316 | Record an audit line for configuration reloads | incident response | automated |
| SC-327 | Treat locale data as untrusted input | configuration load | monitoring |
| SC-338 | Bound retry loops with a maximum attempt count | continuous | review |
| SC-349 | Document the security contact in the README | release | automated |
| SC-360 | Validate every public argument before use | every request | monitoring |
| SC-371 | Reject unknown configuration keys instead of ignoring them | incident response | review |
| SC-382 | Never evaluate configuration values as code | configuration load | automated |
| SC-393 | Escape control characters in rendered cells | continuous | monitoring |

