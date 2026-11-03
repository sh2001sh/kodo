# API contract

| Field | Value |
| --- | --- |
| Status | stable |
| Owner | report tooling team |
| Audience | callers |
| Last updated | 2026-10-10 |

The pager exposes exactly one function. The signature below is normative; additional exports are not part of the contract and MUST NOT be added for the repair.

## Signature

```js
paginate(items, page, pageSize) -> Item[]
```

## Parameters

| Parameter | Required | Accepted values | Notes |
| --- | --- | --- | --- |
| `items` | yes | an array | must not be mutated; may contain any value |
| `page` | no | integer or integer string | the page to return; the addressing rule is defined in [the behavior document](04-behavior.md) |
| `pageSize` | no | integer or integer string | defaults to `PAGE_DEFAULT`; values above `MAX_PAGE_SIZE` clamp to the frozen limit |

`items` is a plain array. `page` and `pageSize` are integer-like: a JavaScript integer number or a decimal integer string. Values such as `'2'` are accepted and behave exactly like `2`. Values such as `2.5`, `'two'`, `null` and `NaN` are invalid.

## Argument handling

- Integer numbers and integer strings are normalised before any arithmetic; the result is identical for both forms.
- A non-array `items` argument throws `TypeError`. That is the only error path.
- An invalid `page` returns an empty array.
- An invalid `pageSize` returns an empty array.
- An omitted or `undefined` `pageSize` is not invalid: it means "use `PAGE_DEFAULT`".
- An omitted `page` is not invalid: it means the first page, as defined in [the behavior document](04-behavior.md).

## Return value

- Always a fresh array; never `null`, never `undefined`, never the input array itself.
- The array contains the selected rows in input order, without gaps.
- An empty or out-of-range request returns `[]`.
- A final partial page contains every remaining row, including the last row of the input.

## Examples

```js
import { paginate } from './src/pager.mjs';

const rows = Array.from({ length: 100 }, (_, index) => index + 1);
paginate(rows, 1);          // first page, default size from legacy
paginate(rows, 1, '10');    // same as above; integer string accepted
paginate(rows, 1, 1000);    // clamped to the frozen limit, not an error
```

For worked tables that show several pages of the same report, read [the behavior document](04-behavior.md). This API document only fixes the call shape.

## Limits and bounds

The effective page size is the requested page size  - ?or `PAGE_DEFAULT` when omitted  - ?clipped to `MAX_PAGE_SIZE` from the frozen legacy module. Both constants are defined in [the legacy contract](legacy-contract.md); the pager must import them rather than redefine them. An oversized request is a normal request for a full page, not an error condition.

## Error handling

| Condition | Behavior | Caller action |
| --- | --- | --- |
| `items` is not an array | throws `TypeError` | fix the call site; this is a programming error |
| `page` invalid | returns `[]` | treat the request as having no rows |
| `pageSize` invalid | returns `[]` | treat the request as having no rows |
| page beyond the last page | returns `[]` | stop iterating |

## Compatibility policy

- Additive behavior changes need a minor version and a changelog entry.
- Anything that changes the return shape, argument coercion or the addressing rule needs a major version and a migration note.
- The frozen legacy limits never change in a patch or minor release.
- Removing or renaming `paginate` is not currently planned.

## Caller responsibilities

- Pass an array of rows; the pager does not validate element types.
- Handle the empty-array result as "no rows" rather than as an error.
- Do not catch `TypeError` from this function to paper over a bad call site.
- Do not rely on catching an error for oversized page sizes; clamp is the contract.


## Appendix: extended operations runbook

1. Schedule the post-incident review within five working days

2. Enable debug logging for the renderer component only

3. Run one focused acceptance check with the minimal fixture

4. Add a regression test for the reproduced scenario

5. Inspect the spool directory for expired or corrupt files

6. Confirm the locale package matches the pinned version

7. If rolling back, restore the previous configuration snapshot first

8. Confirm the reported symptom reproduces with the current release tag

9. Reproduce with the layout cache disabled to rule out stale memoization

10. Record the observed row-buffer high-water mark

11. Update the runbook with anything that was missing

12. Verify the checksum of the most recent spool file

13. Review recent configuration reloads for rejected keys

14. Notify the report owners listed in the service catalogue



## Appendix: extended operations runbook

1. Reproduce with the layout cache disabled to rule out stale memoization

2. Record the observed row-buffer high-water mark

3. Update the runbook with anything that was missing

4. Verify the checksum of the most recent spool file

5. Review recent configuration reloads for rejected keys

6. Notify the report owners listed in the service catalogue

7. Capture the configuration snapshot and the render request fingerprint

8. Check whether worker mode is enabled for the affected tenant



## Appendix: component inventory

The component inventory is maintained by the platform team. New components must register a health signal and an owner before they can ship in a release.

| Component | Lifecycle | Owner | Budget |
| --- | --- | --- | --- |
| `retry-policy` | Runs startup. | platform team | Bounded by the render budget. |
| `flush-scheduler` | Runs startup. | renderer team | Bounded by the layout budget. |
| `signal-handler` | Runs startup. | infrastructure | Bounded by the config budget. |
| `cli-entry` | Runs startup. | report tooling | Bounded by the spool budget. |
| `report-assembler` | Runs startup. | platform team | Bounded by the render budget. |

