# Security

| Field | Value |
| --- | --- |
| Status | stable |
| Owner | platform team |
| Audience | maintainers and reviewers |
| Last updated | 2026-10-01 |

The pagination helper has a small attack surface: it accepts an array and two page arguments and returns an array. Most security relevance lives in its callers, which render untrusted report content. This document records the threat model for the workspace and the controls that maintainers are expected to preserve.

## Threat model

| Threat | Surface | Control |
| --- | --- | --- |
| Oversized request forces a large allocation | a very large requested page size | clamp the effective page size to the frozen limit |
| Resource exhaustion through repeated calls | the caller loop | callers stop on an empty page; no retry loop on empty results |
| Prototype or type confusion through unusual arguments | the public function | validate the argument shapes and normalise integer-like values |
| Malicious pages edit protected files | the workspace | protected files are hashed after the run |
| Dependency supply chain | package metadata | no runtime dependencies are permitted in this workspace |

## Input validation rules

- A non-array `items` argument throws `TypeError`; the function never treats it as empty.
- Invalid page or page-size values return an empty array; they never fall back to a surprising default page.
- Integer strings are accepted because callers commonly pass values from command-line flags.
- Fractional and non-numeric values are rejected rather than truncated, so a typo cannot silently select a different page.
- The effective page size is bounded by the frozen limit before any slicing happens.

## Secret and data handling

- The pager does not log, render or persist rows; it only slices arrays.
- Callers are responsible for redacting sensitive cells before or after pagination.
- Acceptance output must not include report data; the workspace contains no secrets.
- Do not add environment-variable configuration to this workspace; behavior is fixed by source and documentation.

## Dependency policy

The workspace allows only Node built-ins. Adding a package for convenience requires a security review, a pinned version, a lockfile change and an explicit justification in the change description. For the repair task no dependency is needed or permitted.

## Reporting a vulnerability

Report suspected vulnerabilities through the security contact listed in the repository README, not in a public issue. Include the affected revision, a minimal reproduction and the observed impact. The platform team acknowledges reports within two working days and coordinates a disclosure window with the reporter.

## Control review

Security controls that apply to the surrounding pipeline are reviewed once per release cycle. The review block a release when a control has neither an owner nor recorded evidence.


## Appendix: documentation cross-reference

When two documents disagree, the requirements document wins for behavior and the legacy contract wins for frozen exports.

| Topic | Document | Scope |
| --- | --- | --- |
| Renderer pipeline | `docs/01-overview.md` | Module map and request lifecycle |
| Requirements | `docs/02-requirements.md` | Normative behavior for the pager |
| API contract | `docs/03-api-contract.md` | Signature, argument handling and returns |
| Behavior | `docs/04-behavior.md` | Page addressing rules and examples |
| Testing | `docs/05-testing.md` | How acceptance is executed |
| Operations | `docs/06-operations.md` | Runtime matrix and runbook |
| Changelog | `docs/07-changelog.md` | Release history |
| Legacy contract | `docs/legacy-contract.md` | Frozen exports and limits |



## Appendix: security control matrix

Controls are reviewed at least once per release cycle. A missing or failing control blocks the release until the owning team records a remediation plan.

| Control | Requirement | Applied at | Verification |
| --- | --- | --- | --- |
| SC-492 | Fail closed when a redaction rule is malformed | configuration load | monitoring |
| SC-503 | Keep error messages free of raw input content | continuous | review |
| SC-514 | Use constant-time comparison for checksums | release | automated |
| SC-525 | Require explicit opt-in for worker mode | every request | monitoring |
| SC-536 | Record an audit line for configuration reloads | incident response | review |
| SC-547 | Treat locale data as untrusted input | configuration load | automated |
| SC-558 | Bound retry loops with a maximum attempt count | continuous | monitoring |
| SC-569 | Document the security contact in the README | release | review |
| SC-580 | Validate every public argument before use | every request | automated |
| SC-591 | Reject unknown configuration keys instead of ignoring them | incident response | monitoring |
| SC-602 | Never evaluate configuration values as code | configuration load | review |
| SC-613 | Escape control characters in rendered cells | continuous | automated |
| SC-624 | Strip disallowed ANSI sequences from untrusted input | release | monitoring |
| SC-635 | Apply redaction rules before measurement and rendering | every request | review |
| SC-646 | Write spool files with restrictive permissions | incident response | automated |
| SC-657 | Verify spool checksums before reading content | configuration load | monitoring |
| SC-668 | Limit row-buffer growth with an explicit high-water mark | continuous | review |
| SC-679 | Close streams on every error path | release | automated |
| SC-690 | Redact secrets from log lines | every request | monitoring |
| SC-701 | Pin and review template loaders | incident response | review |



## Appendix: documentation cross-reference

When two documents disagree, the requirements document wins for behavior and the legacy contract wins for frozen exports.

| Topic | Document | Scope |
| --- | --- | --- |
| Testing | `docs/05-testing.md` | How acceptance is executed |
| Operations | `docs/06-operations.md` | Runtime matrix and runbook |
| Changelog | `docs/07-changelog.md` | Release history |
| Legacy contract | `docs/legacy-contract.md` | Frozen exports and limits |
| Renderer pipeline | `docs/01-overview.md` | Module map and request lifecycle |
| Requirements | `docs/02-requirements.md` | Normative behavior for the pager |
| API contract | `docs/03-api-contract.md` | Signature, argument handling and returns |
| Behavior | `docs/04-behavior.md` | Page addressing rules and examples |



## Appendix: security control matrix

Controls are reviewed at least once per release cycle. A missing or failing control blocks the release until the owning team records a remediation plan.

| Control | Requirement | Applied at | Verification |
| --- | --- | --- | --- |
| SC-800 | Validate every public argument before use | every request | review |
| SC-811 | Reject unknown configuration keys instead of ignoring them | incident response | automated |
| SC-822 | Never evaluate configuration values as code | configuration load | monitoring |

