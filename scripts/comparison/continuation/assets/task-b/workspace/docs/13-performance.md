# Performance

| Field | Value |
| --- | --- |
| Status | stable |
| Owner | report tooling team |
| Audience | implementers and reviewers |
| Last updated | 2026-09-12 |

The pager is a pure selection function. Its performance is dominated by the size of the returned page, not by the size of the input array, provided the implementation materialises only the requested window. The frozen page-size limit therefore doubles as a memory bound: no caller can force an arbitrarily large page.

## Complexity

| Operation | Cost | Notes |
| --- | --- | --- |
| validate arguments | O(1) | constant work per call |
| normalise integer-like values | O(1) | constant work per value |
| compute boundaries | O(1) | integer arithmetic |
| select rows | O(effective page size) | a slice of the requested window |
| materialise result | O(effective page size) | bounded by the frozen limit |

An implementation that copies or sorts the whole input would still pass a small benchmark but violates the intent of a pagination helper. Prefer a single slice of the requested window; never map, filter or sort the input inside `paginate`.

## Why the limit matters for memory

Without an effective cap, a caller that passes a very large page size can force the renderer to materialise a page proportional to the request. Clipping to the frozen limit keeps the returned array bounded and keeps rendering cost predictable. The clamp applies before slicing, so even a hostile or accidental request costs at most one bounded page.

## Performance budget

| Metric | Budget | Measured how |
| --- | --- | --- |
| selection time for a default-size page | under 1 ms on the reference runner | microbenchmark in the release pipeline |
| selection time for a full frozen-limit page | under 1 ms on the reference runner | microbenchmark in the release pipeline |
| additional allocation per call | one result array plus the selected rows | allocation counters in the profiler |
| input traversal | one pass, no retention beyond the result | profiler allocation timeline |

## Benchmark method

1. Generate rows once outside the measured loop.
2. Measure at least ten thousand calls and discard the warm-up.
3. Report the median and the 95th percentile, not the best run.
4. Record the Node.js version and runner class with the numbers.
5. Compare against the previous revision on the same machine.
6. Never benchmark with the acceptance script; it measures behavior, not speed.

## Profiling a regression

- Check whether the implementation traverses the whole input before slicing.
- Check whether the effective page size is accidentally the raw requested size rather than the clamped size.
- Check for repeated validation work inside a loop.
- Check for accidental array copies, spreads or sorting of the input.
- Add a regression case mirroring the observed access pattern before changing code.

## Non-goals

Streaming pagination, lazy cursor materialisation and parallel page assembly are explicitly out of scope for the helper. Callers that need them should build a streaming layer that uses the helper for its windowing semantics.


## Appendix: security control matrix

Controls are reviewed at least once per release cycle. A missing or failing control blocks the release until the owning team records a remediation plan.

| Control | Requirement | Applied at | Verification |
| --- | --- | --- | --- |
| SC-833 | Escape control characters in rendered cells | continuous | review |
| SC-844 | Strip disallowed ANSI sequences from untrusted input | release | automated |
| SC-855 | Apply redaction rules before measurement and rendering | every request | monitoring |
| SC-866 | Write spool files with restrictive permissions | incident response | review |
| SC-877 | Verify spool checksums before reading content | configuration load | automated |
| SC-888 | Limit row-buffer growth with an explicit high-water mark | continuous | monitoring |
| SC-899 | Close streams on every error path | release | review |
| SC-110 | Redact secrets from log lines | every request | automated |
| SC-121 | Pin and review template loaders | incident response | monitoring |
| SC-132 | Fail closed when a redaction rule is malformed | configuration load | review |
| SC-143 | Keep error messages free of raw input content | continuous | automated |
| SC-154 | Use constant-time comparison for checksums | release | monitoring |
| SC-165 | Require explicit opt-in for worker mode | every request | review |
| SC-176 | Record an audit line for configuration reloads | incident response | automated |
| SC-187 | Treat locale data as untrusted input | configuration load | monitoring |
| SC-198 | Bound retry loops with a maximum attempt count | continuous | review |
| SC-209 | Document the security contact in the README | release | automated |
| SC-220 | Validate every public argument before use | every request | monitoring |
| SC-231 | Reject unknown configuration keys instead of ignoring them | incident response | review |
| SC-242 | Never evaluate configuration values as code | configuration load | automated |



## Appendix: documentation cross-reference

When two documents disagree, the requirements document wins for behavior and the legacy contract wins for frozen exports.

| Topic | Document | Scope |
| --- | --- | --- |
| Behavior | `docs/04-behavior.md` | Page addressing rules and examples |
| Testing | `docs/05-testing.md` | How acceptance is executed |
| Operations | `docs/06-operations.md` | Runtime matrix and runbook |
| Changelog | `docs/07-changelog.md` | Release history |
| Legacy contract | `docs/legacy-contract.md` | Frozen exports and limits |
| Renderer pipeline | `docs/01-overview.md` | Module map and request lifecycle |
| Requirements | `docs/02-requirements.md` | Normative behavior for the pager |
| API contract | `docs/03-api-contract.md` | Signature, argument handling and returns |



## Appendix: security control matrix

Controls are reviewed at least once per release cycle. A missing or failing control blocks the release until the owning team records a remediation plan.

| Control | Requirement | Applied at | Verification |
| --- | --- | --- | --- |
| SC-341 | Pin and review template loaders | incident response | automated |
| SC-352 | Fail closed when a redaction rule is malformed | configuration load | monitoring |
| SC-363 | Keep error messages free of raw input content | continuous | review |
| SC-374 | Use constant-time comparison for checksums | release | automated |
| SC-385 | Require explicit opt-in for worker mode | every request | monitoring |
| SC-396 | Record an audit line for configuration reloads | incident response | review |
| SC-407 | Treat locale data as untrusted input | configuration load | automated |

