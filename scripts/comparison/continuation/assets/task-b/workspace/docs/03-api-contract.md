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


## Appendix: test case catalogue

These cases document the expected coverage of the renderer pipeline. They are illustrative for reviewers; the executable authority for this workspace is the acceptance script described in the testing guide.

| Case | Layer | Checks | Evidence |
| --- | --- | --- | --- |
| `narrow column` | diagnostic | columns never shrink below the configured minimum; the check is deterministic and never reaches the network. | rendered snapshot |
| `header repeated` | acceptance | a repeated header appears on every emitted page; the check is deterministic and never reaches the network. | exit code |
| `footer once` | integration | the footer appears only on the final page; the check is deterministic and never reaches the network. | structured log line |
| `utf8 content` | unit | multi-byte content is never split mid-codepoint; the check is deterministic and never reaches the network. | assertion output |
| `ansi passthrough` | diagnostic | valid ANSI sequences survive rendering; the check is deterministic and never reaches the network. | rendered snapshot |
| `ansi stripped` | acceptance | disallowed ANSI sequences are stripped; the check is deterministic and never reaches the network. | exit code |
| `theme override` | integration | per-report theme overrides the global theme; the check is deterministic and never reaches the network. | structured log line |
| `locale fallback` | unit | an unknown locale falls back to the default locale; the check is deterministic and never reaches the network. | assertion output |
| `precision rounding` | diagnostic | fractional digits use half-up rounding; the check is deterministic and never reaches the network. | rendered snapshot |
| `grouping thin space` | acceptance | grouping uses the locale separator; the check is deterministic and never reaches the network. | exit code |
| `timezone conversion` | integration | timestamps are converted to the report timezone; the check is deterministic and never reaches the network. | structured log line |
| `long title` | unit | an overlong title is wrapped, not truncated silently; the check is deterministic and never reaches the network. | assertion output |
| `empty title` | diagnostic | an empty title omits the title block; the check is deterministic and never reaches the network. | rendered snapshot |
| `wide border` | acceptance | the border spans the full rendered width; the check is deterministic and never reaches the network. | exit code |
| `custom glyphs` | integration | custom border glyphs are applied consistently; the check is deterministic and never reaches the network. | structured log line |
| `spool spill` | unit | a large report spills to the configured spool directory; the check is deterministic and never reaches the network. | assertion output |
| `spool recovery` | diagnostic | a truncated spool file is reported, not rendered; the check is deterministic and never reaches the network. | rendered snapshot |
| `cache warm` | acceptance | a warm cache avoids template disk reads; the check is deterministic and never reaches the network. | exit code |
| `cache expiry` | integration | an expired entry is not served; the check is deterministic and never reaches the network. | structured log line |
| `config reload` | unit | a reload preserves the previous config on parse failure; the check is deterministic and never reaches the network. | assertion output |
| `signal interrupt` | diagnostic | an interrupt flushes the current page before exit; the check is deterministic and never reaches the network. | rendered snapshot |

