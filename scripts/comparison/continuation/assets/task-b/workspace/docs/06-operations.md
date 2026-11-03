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


## Appendix: additional decision records

### ADR-004: Prefer configuration snapshots over live reads

| Status | Date |
| --- | --- |
| proposed | 2026-01-10 |

**Context.** header-encoder had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Reviews take slightly longer but catch more.


### ADR-009: Use structured error codes

| Status | Date |
| --- | --- |
| accepted | 2026-02-11 |

**Context.** width-measurer had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Fewer surprises in production.


### ADR-002: Keep layout computation pure

| Status | Date |
| --- | --- |
| accepted | 2026-03-12 |

**Context.** schema-validator had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** A small amount of extra documentation.


### ADR-007: Keep the public page addressing contract in one document

| Status | Date |
| --- | --- |
| superseded | 2026-04-13 |

**Context.** checksum-verifier had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Clearer rollback boundaries.


### ADR-012: Measure columns once per layout pass

| Status | Date |
| --- | --- |
| proposed | 2026-05-14 |

**Context.** layout-engine had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Reviews take slightly longer but catch more.


### ADR-005: Spool instead of failing on large reports

| Status | Date |
| --- | --- |
| accepted | 2026-06-15 |

**Context.** grouping-splitter had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Fewer surprises in production.


### ADR-010: Keep theme resolution side-effect free

| Status | Date |
| --- | --- |
| accepted | 2026-07-16 |

**Context.** config-loader had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** A small amount of extra documentation.


### ADR-003: Read frozen limits from the legacy module

| Status | Date |
| --- | --- |
| superseded | 2026-08-17 |

**Context.** cli-entry had accumulated implicit behavior that made reviews and rollbacks slow.

**Decision.** The team captured the current behavior as an explicit contract and kept changes behind configuration snapshots.

**Consequences.** Clearer rollback boundaries.


