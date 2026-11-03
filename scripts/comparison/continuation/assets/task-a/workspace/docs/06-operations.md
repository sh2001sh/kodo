# Operations guide

| Field | Value |
| --- | --- |
| Status | stable |
| Owner | platform team |
| Audience | on-call engineers |
| Last updated | 2026-10-05 |

This guide covers the runtime environment and the operational procedures around the renderer pipeline that consumes pager-kit. It is operational documentation, not a behavior contract: if it appears to disagree with the requirements or the legacy contract, those documents win and this guide should be corrected.

## Runtime matrix

| Runtime | Status | Notes |
| --- | --- | --- |
| Node.js 24 LTS | supported | the reference runtime for this workspace |
| Node.js 22 LTS | supported | same behavior on the acceptance script |
| Node.js 20 | best effort | works, but not part of the support matrix |
| Node.js 18 and older | unsupported | may lack ESM features the workspace assumes |
| Browsers | not supported | the pager is a server-side terminal tool |

## Ownership

| Area | Owner | Contact |
| --- | --- | --- |
| pager behavior and acceptance | report tooling team | support channel |
| frozen legacy module | platform team | change proposal required |
| renderer pipeline | renderer team | on-call rotation |
| spool storage | infrastructure | storage escalation path |

## Operational assumptions

- The workspace has no runtime configuration: behavior is fixed by source code and documentation.
- The reflection target must run with a stock Node.js installation and without network access.
- Acceptance is cheap, synchronous and deterministic; it is safe to run on every change.
- The pager is not hot-swapped in production; a fix ships through the normal release train.
- The frozen legacy values are part of the production contract; operational changes never alter them.

## Routine runbook

1. Reproduce the reported symptom with the current release and the recorded configuration snapshot.
2. Run the workspace acceptance command and capture the exit code plus the full output.
3. Compare the observed page boundaries against the behavior document before assuming a code defect.
4. Check whether the frozen legacy module is still byte-identical to the released version.
5. If the acceptance script fails, treat it as the source of truth for the required behavior.
6. Record the exact command, output and exit code in the incident or change ticket.
7. Escalate to the report tooling team when the requirements themselves are ambiguous.

## Incident severity

| Severity | Example | Response |
| --- | --- | --- |
| SEV-1 | reports render empty or duplicated rows in production | page the on-call engineer immediately |
| SEV-2 | acceptance fails on the release candidate | block the release; fix before shipping |
| SEV-3 | documentation contradicts observed behavior | fix in the next scheduled change |
| SEV-4 | cosmetic documentation issue | add to the documentation backlog |

## Release and rollback

- The release train runs acceptance in a clean checkout before publishing.
- A regression is rolled back by restoring the previous release; the frozen legacy module is never patched in place.
- After a rollback, re-run acceptance to prove the restored tree is healthy.
- Document the root cause and add an acceptance case that would have caught it.

## Escalation checklist

- Attach the full acceptance output, including `FAIL:` lines and the exit code.
- State whether protected files changed; hash mismatches invalidate the run.
- List the exact Node.js version and workspace revision.
- Describe the smallest input that reproduces the problem.


## Appendix: extended operations runbook

1. Run one focused acceptance check with the minimal fixture

2. Add a regression test for the reproduced scenario

3. Inspect the spool directory for expired or corrupt files

4. Confirm the locale package matches the pinned version

5. If rolling back, restore the previous configuration snapshot first

6. Confirm the reported symptom reproduces with the current release tag

7. Reproduce with the layout cache disabled to rule out stale memoization

8. Record the observed row-buffer high-water mark

9. Update the runbook with anything that was missing

10. Verify the checksum of the most recent spool file

11. Review recent configuration reloads for rejected keys

12. Notify the report owners listed in the service catalogue

13. Capture the configuration snapshot and the render request fingerprint

14. Check whether worker mode is enabled for the affected tenant

15. Attach the error code and correlation id to the incident

16. Close the incident only after the dashboard is green for one interval



## Appendix: documentation cross-reference

When two documents disagree, the requirements document wins for behavior and the legacy contract wins for frozen exports.

| Topic | Document | Scope |
| --- | --- | --- |
| Operations | `docs/06-operations.md` | Runtime matrix and runbook |
| Changelog | `docs/07-changelog.md` | Release history |
| Legacy contract | `docs/legacy-contract.md` | Frozen exports and limits |
| Renderer pipeline | `docs/01-overview.md` | Module map and request lifecycle |
| Requirements | `docs/02-requirements.md` | Normative behavior for the pager |
| API contract | `docs/03-api-contract.md` | Signature, argument handling and returns |
| Behavior | `docs/04-behavior.md` | Page addressing rules and examples |
| Testing | `docs/05-testing.md` | How acceptance is executed |



## Appendix: security control matrix

Controls are reviewed at least once per release cycle. A missing or failing control blocks the release until the owning team records a remediation plan.

| Control | Requirement | Applied at | Verification |
| --- | --- | --- | --- |
| SC-851 | Reject unknown configuration keys instead of ignoring them | incident response | automated |
| SC-862 | Never evaluate configuration values as code | configuration load | monitoring |
| SC-873 | Escape control characters in rendered cells | continuous | review |
| SC-884 | Strip disallowed ANSI sequences from untrusted input | release | automated |

