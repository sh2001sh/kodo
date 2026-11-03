# Ky totalTimeout v2-r6 results (design v3 plus two fixes)

Registration `ky-total-timeout-v2-r6`, output `.kodo/ky-total-timeout-paid-20261025-110711`. Policy is v2-r5 (design v3: no caps, ratio-0.8 compaction for C/D, pinned delivery state, NO_PROGRESS handoff) plus the two fixes from the v2-r5 findings:

1. An output-limit stop (chat `finish_reason: length`, Anthropic `max_tokens`, Responses `max_output_tokens`) discards the response and retries the same request once with no delay (`model.retry` with `reason: output_limit`). A second output-limit stop on that request fails the run.
2. `TOOL_ARGUMENTS` errors name the tool, field and constraint. A malformed `expectedHash` on file.patch / apply_patch / rename / delete also returns the current file hash when the run may read it. rename/delete `FILE_CONFLICT` now includes the current hash, as patch already did.

Before the run: `npm run check` clean, `npm test` 1144 passed / 8 skipped, eval tests 8/8, sandbox preflight passed.

## The matrix stopped after six trials

The run stopped at B2 with `USAGE_UNRECONCILED`; D2 and A2 never started. The matrix is valid (no duplicates or mixed policies) but incomplete.

Cause: B2's main agent called `cancel_agent` on a child 4.5 s into that child's model request. The relay saw the client abort before any usage chunk (relay call 184, about 20k estimated input), marked the round `estimated`, and the stop rule "relay rejection or unreconciled usage" ended the matrix. This is a deliberate cancellation by the agent, not a provider or accounting fault, but the rule does not distinguish the two. B2's token total is therefore a lower bound (one request unmeasured, 22,030 tokens reserved).

Spend for the six trials: 897 requests, 30,417,220 raw tokens (lower bound); relay weighted total 6,807,324. Prices unknown.

## Per trial

| Trial | Arm | Ending | Checks | Calls | Tokens | Uncached in | Output | Peak input | Tools | Rereads | Summaries | Compaction share | Wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 | solo | completed | 12/14 | 93 | 3,659,308 | 251,199 | 52,077 | 53,459 | 132 | 67 | 0 | – | 693 s |
| D1 | delegation + summary | completed | 12/14 | 147 | 4,191,553 | 520,422 | 100,955 | 40,622 | 196 | 103 | 7 | 5.52% | 1,183 s |
| B1 | delegation | completed, delivered | 14/14 | 122 | 5,004,138 | 314,482 | 64,760 | 53,811 | 158 | 68 | 0 | – | 943 s |
| C1 | summary | completed, delivered | 14/14 | 162 | 4,896,820 | 410,316 | 104,040 | 42,448 | 180 | 69 | 5 | 3.14% | 1,287 s |
| C2 | summary | completed, delivered | 14/14 | 126 | 3,744,946 | 399,949 | 97,765 | 42,304 | 162 | 83 | 5 | 4.22% | 949 s |
| B2 | delegation | completed, delivered | 14/14 | 247 | ≥ 8,920,455 | 1,687,502 | 148,281 | 53,038 | 400 | 59 | 0 | – | 1,219 s |

Rereads are main-agent rereads. B2's calls and tools include its four children.

Same six trial keys in v2-r5: A1 4/14, D1 14/14, B1 12/14, C1 14/14, C2 14/14, B2 12/14 (3 delivered). In v2-r6: 4 delivered. With one trial per key this is not evidence of a policy effect.

## Did the fixes fire?

- Output-limit retry: no response stopped at the output limit in this round (0 `model.retry` events of any kind). A1 ran 93 calls to completion instead of dying at call 20, but that cannot be credited to the fix since the failure mode did not occur. Fix 1 is covered by unit tests only.
- Field-level `TOOL_ARGUMENTS`: two errors, both now name the constraint: A1 `file.read: /maxChars must be <= 32000`, B2 `wait_for_events: /timeout_ms must be <= 300000`. Each was corrected on the very next call. No malformed `expectedHash` occurred, so the hash hint was not exercised.
- `FILE_CONFLICT` with current hash: four occurrences (D1, B1, C1, B2), all on file.apply_patch, all carried the current hash, and in each case the next apply_patch succeeded.
- No NO_PROGRESS handoffs, overflow recoveries or delivery audits fired.

## Findings

### Delegation was used for the first time

B2 created four children (1 explore, 4 spawn, 2 waits, 1 inspect; first delegation at step 11) and cancelled one of them. It delivered 14/14 but was the most expensive trial: 247 calls, ≥ 8.9 M tokens, 1.69 M uncached input (about 4–5× the other delivered trials). B1, D1 again created no children.

### The two misses are host-regression failures the agent could not see

Both A1 and D1 failed only T12/T14 (`actualRegression`); the sandbox still cannot run ava.

- A1's own new test `http-error › totalTimeout bounds reading a never-ending error response body` expected `TimeoutError`, got `HTTPError`.
- D1 broke the existing `retry › shouldRetry: works with TimeoutError` (three TimeoutErrors instead of one, i.e. timeouts were retried). B1 broke the same test in v2-r5.

This is now the dominant failure mode across v2-r5 and v2-r6: 4 of the 5 non-delivered trials in the two rounds. The fixes in this round do not address it.

### Compaction

C/D installed 5–7 summaries per trial (17 total) at 3.1–5.5% of trial tokens. Main input peaked at about 40–42k in C/D against about 53–54k in A/B.

## Follow-ups (not implemented)

- Stop rule: a request aborted because the agent cancelled its own child should be recorded as unmeasured with its reservation counted, not stop the matrix. Rounds with delegation will keep hitting this.
- Regression visibility: let the agent run the task's ava suite (or a host-run check tool), since unseen regressions now cause most misses.
- Complete the matrix under a fresh id (v2-r7); v2-r6 trials are not resumed.

## Limitations

- Incomplete matrix: A and D have one trial each; n ≤ 2 elsewhere.
- Fix 1 and the expectedHash hint were not triggered in real runs.
- One task, one model and provider; prices unknown.
