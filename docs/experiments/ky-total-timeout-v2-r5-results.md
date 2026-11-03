# Ky totalTimeout v2-r5 results (design v3, first round)

Registration `ky-total-timeout-v2-r5`, output `.kodo/ky-total-timeout-paid-20261025-082702`. This is the first paid round under design v3. Earlier rounds (v1 r1–r4, v2-r1..r4) ran with budgets, finalization and delivery reserves, so v2-r5 is not a same-policy replicate of v2-r4 and its numbers are not compared head to head here.

## Setup

- Model `deepseek-v4.1-flash` via `codego1`, 65,536-token context, 8,192 output tokens per request (`max_completion_tokens`, set by the relay).
- No run caps: no maxTokens, maxModelCalls, maxToolCalls or maxDurationMs. A run ends on model completion, a real error, or the NO_PROGRESS breaker (handoff report).
- Arms C and D: `compaction: { strategy: 'summary', triggerRatio: 0.8 }`. Effective window E = 49,152, trigger 39,321, target 24,576, summary ≤ 8,192 tokens, delivery-state block pinned ahead of the summary text.
- Arms B and D expose delegation tools. Order `A1 D1 B1 C1 C2 B2 D2 A2`; no stop rule applies.
- Before the run: `npm run check` clean, `npm test` 1139 passed / 8 skipped, sandbox preflight passed.

The matrix is complete and valid (8/8 trials, no duplicates or mixed policies). Spend: 858 requests, 28,796,621 raw tokens; the relay's weighted total (cache reads at 10%) is 5,696,491. Prices are unknown, so only tokens are reported.

## Per trial

| Trial | Arm | Ending | Checks | Calls | Tokens | Uncached in | Output | Peak input | Tools | Rereads | Summaries | Compaction share | Wall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 | solo | MODEL_INCOMPLETE | 4/14 | 20 | 449,283 | 36,855 | 3,212 | 37,423 | 32 | 8 | 0 | – | 124 s |
| D1 | delegation + summary | completed, delivered | 14/14 | 205 | 6,715,412 | 712,116 | 119,520 | 42,761 | 251 | 133 | 8 | 4.25% | 1,496 s |
| B1 | delegation | completed | 12/14 | 84 | 3,365,775 | 234,373 | 54,154 | 53,773 | 111 | 42 | 0 | – | 740 s |
| C1 | summary | completed, delivered | 14/14 | 156 | 5,051,957 | 401,204 | 90,625 | 42,620 | 167 | 73 | 4 | 2.53% | 1,278 s |
| C2 | summary | completed, delivered | 14/14 | 131 | 4,162,132 | 416,042 | 73,386 | 42,156 | 169 | 85 | 3 | 2.43% | 955 s |
| B2 | delegation | completed | 12/14 | 98 | 3,935,057 | 276,131 | 64,302 | 53,796 | 133 | 50 | 0 | – | 842 s |
| D2 | delegation + summary | NO_PROGRESS handoff | 12/14 | 146 | 4,734,610 | 493,363 | 85,599 | 42,757 | 187 | 109 | 5 | 3.56% | 1,037 s |
| A2 | solo | MODEL_INCOMPLETE | 4/14 | 18 | 382,395 | 34,838 | 4,389 | 37,353 | 35 | 8 | 0 | – | 119 s |

## Per arm

| Arm | Delivered | Calls | Tokens | Uncached in | Output | Summaries | Agent time |
|---|---|---|---|---|---|---|---|
| A | 0/2 | 38 | 831,678 | 71,693 | 7,601 | 0 | 242 s |
| B | 0/2 | 182 | 7,300,832 | 510,504 | 118,456 | 0 | 1,581 s |
| C | 2/2 | 287 | 9,214,089 | 817,246 | 164,011 | 7 | 2,233 s |
| D | 1/2 | 351 | 11,450,022 | 1,205,479 | 205,119 | 13 | 2,533 s |

All three full deliveries came from the compaction arms. With n = 2 per arm this is a direction, not a significant effect.

## Findings

### Delegation was never used

All four B and D trials created 0 children (no explore, spawn or wait calls). In this round B is effectively A plus unused tools, and D is C plus unused tools. B−A and D−C differences cannot be attributed to delegation.

### A: reasoning used up the output cap

Both A trials ended early with `MODEL_INCOMPLETE`. The last response had `finish_reason: "length"` with `completion_tokens` 8,192:

- A1 call 20: 7,589 reasoning tokens on 39,465 prompt tokens.
- A2 call 18: 7,166 reasoning tokens on 38,278 prompt tokens.

The model spent the whole 8,192-token output on reasoning and produced no usable answer or tool call. Kodo treats a `length` stop as a real error, so the run ended. This is the only reason arm A lost. It is not a budget effect, since none exist in v3. B, C and D hit the same prompt sizes without this outcome, so it is stochastic.

Candidate follow-up (not implemented): treat a `length` stop with no tool calls as recoverable. Retry once with a continue nudge, or with a higher `max_completion_tokens` where the provider allows it. Only end the run if it repeats.

### B: completed without a green regression suite

Both B trials ended normally, but their ava regression failed on the host (T12, and T14 `actualRegression`):

- B1 broke an existing test: `retry › shouldRetry: works with TimeoutError` (`t.deepEqual(errorNames, ['TimeoutError'])`).
- B2's own new test failed: `retry › totalTimeout: caller cancellation stops further retries` expected `requestCount` 1, got 0.

The sandbox cannot run ava (piped children are refused), and both final replies said so. Neither agent could see these failures before stopping. B had no compaction, so its main input grew to about 53.8k. The C and D peaks stayed at about 42–43k, a few thousand above the 39,321 trigger, because compaction runs at the next turn boundary.

### D2: hash transcription loop tripped the breaker

D2 was editing `test/hooks.ts` when it stopped:

- Call 141: `file.patch` failed with `PATCH_MATCH`.
- Calls 142–146: five `file.patch` calls whose `expectedHash` had lost two hex characters (`…496efce3ba4…` became `…496ef3ba4…`, 62 characters). Each was rejected by the schema pattern as `TOOL_ARGUMENTS: arguments do not match the tool schema`.

Six failed-only responses in a row tripped NO_PROGRESS, which wrote a handoff report as designed. The workspace was left mid-edit, with three hooks/http-error tests failing on the host (12/14).

The breaker did what v3 intends: it stopped a loop that was not converging. The underlying problem is the error message. It does not say which field failed, so the model kept resending the same bad hash. Candidate follow-up (not implemented): name the failing field and pattern in `TOOL_ARGUMENTS` errors. For a malformed `expectedHash` on an existing file, include the current hash the way `FILE_CONFLICT` already does.

### Compaction behaviour

- C and D installed 3–8 summaries per trial (20 total). Compaction cost 2.4–4.3% of trial tokens.
- No overflow recovery fired.
- No `run.delivery_audit` events fired, and `deliveryIncomplete` is null in every trial. The only runtime event in the matrix is D2's `run.handoff`.
- Rereads are high in the compaction arms (73–133 per trial against 42–50 in B). Some of this is the expected cost of rereading after summaries replace raw tool results.

### Cost without caps

The successful trials ran 131–205 calls and 4.2–6.7 M tokens each, and nothing cut them short. Cache reads are about 90% of input (for example C1: 4.56 M of 4.96 M input). Uncached input per delivered trial is 0.40–0.71 M tokens.

## Limitations

- n = 2 per arm, one task, one model and provider.
- Delegation was not exercised, so this round says nothing about it.
- Prices are unknown; token totals only.
- Arm A's result comes from a provider-side output stop, not from the harness policy under test.
