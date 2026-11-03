# Ky totalTimeout v2 results

This document covers registrations `ky-total-timeout-v2-r1` and `ky-total-timeout-v2-r2`. The v1 results (r1–r4) are in [ky-total-timeout-results.md](ky-total-timeout-results.md) and are not changed here.

Model `deepseek-v4.1-flash` via `codego1`, 65,536-token context, 8,192 output tokens, per trial 80 model calls and 2,000,000 tokens. Order `A1 D1 B1 C1 C2 B2 D2 A2`; the matrix stops after block 1 when none of the four trials delivers.

## Fixes between v1-r4 and v2-r1

- Windows sandbox Node preload (`src/sandbox/windows/node-compat.cjs`): patched `os.userInfo` and `realpath`, and piped or IPC children now fail at once with `KODO_SANDBOX_PIPE_UNSUPPORTED` instead of hanging until the tool timeout. In r4 such a hang produced the UNKNOWN_WRITE that stopped the matrix.
- `launcher.cs` labels workspace ACLs through `RawAcl`, so non-canonical DACLs no longer break sandbox cleanup.
- `src/runtime/response-repair.ts`: tool calls whose provider wire name (`file_search`) has no reverse mapping are restored to the logical name (`file.search`), so a hidden read is rejected as a read with `FINALIZATION_TOOL` instead of being recorded as an unknown write. Tool calls in a `toolChoice: 'none'` reply are dropped and the text is judged.
- The eval runs a native sandbox preflight (`preflight.mjs`) of every command the objective advertises. The objective lists only those commands (tsc build, tsc typecheck, `xo source`, the dist import smoke) and states that ava regressions run on the host at acceptance.
- `distribution` and `node_modules/.cache` are writable; a model command's UNKNOWN_WRITE is a failed trial, while sandbox cleanup failures and shutdown errors stay fatal.

Verification before the paid run: `npm run check` clean, full vitest suite passing, eval unit tests 8/8, sandbox preflight passing.

## v2-r1 result

Stop rule `BLOCK_1_NO_COMPLETE_DELIVERIES` after C1. Spend: 265 requests, 7,324,404 tokens.

| Trial | Arm | Checks | Calls | Tokens | Uncached input | Output | Tools | Agent time | Ending |
|---|---|---|---|---|---|---|---|---|---|
| A1 | solo, no compaction | 4/14 | 52 | 1,953,689 | 213,224 | 22,065 | 72 | 293 s | MODEL_BUDGET: no output capacity |
| D1 | delegation + summary | 4/14 | 80 | 1,866,055 | 320,622 | 34,649 | 90 | 411 s | MODEL_BUDGET: calls exhausted; 4 summaries |
| B1 | delegation, no compaction | 0/14 | 53 | 1,961,243 | 173,431 | 22,436 | 76 | 287 s | MODEL_BUDGET: no output capacity; broken build |
| C1 | solo + summary | 4/14 | 80 | 1,543,417 | 311,345 | 53,448 | 101 | 469 s | MODEL_BUDGET: calls exhausted; 7 summaries |

The 4/14 checks are the unchanged-baseline checks. B1 scored 0 because its only write, a `file.patch` at step 52 during finalization, referenced `totalTimeout` on `InternalOptions` without declaring it (TS2339), so the build failed.

### What the v2 fixes changed

- No UNKNOWN_WRITE, no SANDBOX_CLEANUP and no protected-file change in any trial.
- `model.response_repaired` mapped `file_search` to `file.search` in A1 and B1, and the call failed as a read. The r4 A1 failure mode did not recur.
- No trial called `process.exec`, so the piped-child change was not exercised by a model.

### New dominant failure: reading without writing

A1, D1 and C1 made no file writes at all. Every trial spent its budget on `file.read`:

| Trial | file.read calls | Repeat reads (same path and range) | Reads of source/core/Ky.ts |
|---|---|---|---|
| A1 | 57 | 40 | 18 (17 distinct ranges) |
| D1 | 81 | 73 | 67 (48 distinct ranges) |
| B1 | 53 | 38 | 15, plus 15 of test/hooks.ts |
| C1 | 89 | 77 | 65 |

D1 alternated between Ky.ts ranges 88+60 and 148+80 eleven times (steps 47–67), then re-read the file in 100-line chunks. Summary checkpoints and compaction drop earlier read content, which makes re-reading look necessary to the model.

For comparison, r4 A1 began writing at step 41, made 6 file writes and 4 `process.exec` calls, and reached 12/14 delivery-adjacent checks. Each cell has n=1 and the model is stochastic, so the regression cannot be attributed to one change. The most likely contributor is the objective now telling the model not to run ava, which removes the test feedback loop the r4 trial used to move from reading to editing.

## Kernel causes found in v2-r1

1. **Finalization without a deliverable never ends.** In finalization, `file.read` remained allowed. The tool-free final request (`finalResponseOnly`) requires a saved write, so a run with nothing saved kept reading until MODEL_BUDGET instead of saving or reporting.
2. **Alternating re-reads were invisible.** The stall check only fires on three consecutive identical calls with identical results; D1's A-B-A-B pattern never triggered it.
3. **Finalization started early on cached tokens.** A1 entered finalization at call 46 with 34 calls left (286,905 tokens remaining against a 256,180 reserve), although only 213,224 of its 1.95M input tokens were uncached. The reserve counts cached input at full price. This is left unchanged in v2-r2 because the session token budget is an explicit host ceiling over total tokens; making it cache-aware is a budget-semantics change that needs its own registration.

## v2-r2: progress guard

Kernel changes (`src/runtime/progress-guard.ts`, wired into `coordinator.ts`; tests in `tests/progress-guard.test.ts`):

- `finalizationWriteOnly`: once a finalizing run has used two finalization requests and still has no saved write, only write tools are offered and accepted (no reads, no `process.exec`). The kernel state says so explicitly.
- `repeatedReads`: reading the same path, range and file hash three times anywhere in the run adds a progress notice and a `tool.reread_warning` event. This covers alternating patterns the consecutive stall check misses.

The objective, scope and budgets match v2-r1. Verification: `npm run check` clean, vitest 88 files / 1121 passed / 8 skipped, eval tests 8/8, dry-run sandbox preflight passed.

Result: stop `BLOCK_1_NO_COMPLETE_DELIVERIES` after C1. Spend: 266 requests, 7,226,051 tokens.

| Trial | Checks | Calls | Tokens | Uncached input | Output | Agent time | Writes | Commands | Ending |
|---|---|---|---|---|---|---|---|---|---|
| A1 | 4/14 | 54 | 1,946,721 | 281,607 | 31,450 | 361 s | 2 (steps 50–51) | 0 | MODEL_BUDGET: no output capacity |
| D1 | 0/14 | 80 | 1,766,932 | 404,506 | 66,554 | 544 s | 2 (step 67) | 1 rejected | MODEL_BUDGET: calls exhausted; 6 summaries |
| B1 | 12/14 | 52 | 1,889,512 | 227,063 | 19,569 | 425 s | 3 (steps 40–43) | 3 passed, 2 rejected | DELIVERY_FAILED: empty final reply |
| C1 | 4/14 | 80 | 1,622,886 | 328,907 | 34,075 | 471 s | 0 | 1 passed | MODEL_BUDGET: calls exhausted; 4 summaries |

Compared with v2-r1, three of four trials wrote code (v2-r1: one), and B1 implemented the feature. Its build, typecheck, `xo source` and dist import all passed (T01–T11, T13). Per trial:

- **A1.** Finalization started at call 47 with 33 calls left. The write-only limit triggered at step 49 and rejected two `file.read` calls. The model then tried to create `DELIVERY.md` with `expectedHash: null`, but the seed already contains an empty `DELIVERY.md`, so the save failed with FILE_CONFLICT. To learn the hash it made a no-op `file.patch` (oldText equal to newText). The two tool-free final requests returned empty text.
- **D1.** Reread warnings fired three times (steps 37, 38, 46). It wrote `options.ts` and `Ky.ts` in one step, but missed the `KyOptionsRegistry` entry in `source/core/constants.ts`, so the build failed with TS2741. Its typecheck was rejected because finalization had already started, so the error was never seen.
- **B1.** Finalization started at call 46 with 34 calls left (295,840 tokens remaining against a 253,660 reserve), right after its checks passed. It never wrote tests, readme or `DELIVERY.md`. All three tool-free final-response requests returned `content: null`; the reasoning shows the model still trying to call `file_read`. T12 failed: eight host ava total-timeout tests failed. T14 failed: no docs, tests, delivery file or reply.
- **C1.** 97 reads, 70 of them of `Ky.ts`, but only 5 exact repeats. The model shifted the range on almost every re-read, so the exact detector fired only once. It made no write at all.

### Causes found in v2-r2

1. **Empty replies under `toolChoice: 'none'`.** The request has no tools, but the kernel-state message still lists finalization tools, and the model keeps planning tool calls in reasoning and produces no text. This cost B1 a 12/14 delivery.
2. **Stale-hash saves need a read that finalization no longer allows.** The FILE_CONFLICT error did not include the current hash.
3. **Range-shifting re-reads escape the exact re-read check** (C1, D1).
4. **Early finalization on cached tokens** (A1 and B1, both with 33–34 calls left) remains the largest structural loss: B1 stopped working right after its checks passed. Unchanged, for the reason given under v2-r1.

## v2-r3 changes

- Tool-free final-response requests append a runtime message: no tools are available, any tool call is discarded, and the reply must be visible text covering the changes, the commands actually run and their results, and what remains unverified.
- `file.apply_patch` and `file.patch` conflicts report the current hash (or `null (file absent)`) when the run has read permission. That value is already disclosable through `file.read`.
- `writeNudge`: a writable main run gets one progress notice after 30 successful read/list/search calls with no edit or command, and the event `progress.write_nudged` is recorded.

Verification: `npm run check` clean, vitest 88 files / 1123 passed / 8 skipped, eval tests 8/8, build manifest current.

## v2-r3 result

Stop rule `BLOCK_1_NO_COMPLETE_DELIVERIES` after C1. Spend: 210 requests, 6,106,656 tokens.

| Trial | Checks | Calls | Tokens | Uncached input | Output | Writes | Commands (time) | Finalization | Ending |
|---|---|---|---|---|---|---|---|---|---|
| A1 | 12/14 | 52 | 1,769,361 | 658,849 | 25,328 | 4 (steps 40–48: Ky.ts, options.ts, constants.ts, readme) | 2 passed (113 s) | call 48, 32 calls left | ACCEPTANCE_FAILED, visible final reply |
| D1 | 12/14 | 64 | 1,790,918 | 304,900 | 43,586 | 6 (steps 42–49) | 4, last tsc and xo passed (241 s) | call 60, 20 calls left | ACCEPTANCE_FAILED, final reply says delivery is unfinished |
| B1 | 12/14 | 48 | 1,835,009 | 217,901 | 37,460 | 8 source/readme patches, 1 scratch script | 7, tsc/xo/build and its own script passed (440 s) | call 44, 36 calls left | ACCEPTANCE_FAILED, visible final reply |
| C1 | 0/14 | 46 | 711,368 | 182,676 | 31,668 | 3 | 19 (1,246 s) | not reached | UNKNOWN_WRITE after the 25-minute session time budget ran out |

For the first time in v2, three trials implemented the feature: build, typecheck, dist import and runtime checks T01–T11 and T13 passed in A1, D1 and B1. None of them delivered.

### What the v2-r3 changes did

- **Final-response notice: works.** A1, D1 and B1 all ended with a visible `toolChoice: 'none'` reply (v2-r2 B1: three null replies). D1's reply states that tests, docs and `DELIVERY.md` are missing and that the last change was not checked again.
- **Write nudge: fired in all four trials** (`progress.write_nudged` at steps 15–21, 30–31 reads). The first write followed at steps 24–42. In v2-r1, three of four trials never wrote.
- **Conflict hash: not exercised.** No trial produced FILE_CONFLICT, because no trial tried to save `DELIVERY.md`.
- **Reread warnings** fired only in C1 (steps 24 and 26). C1 then read files through `process.exec` with `node -e` instead of `file.read`.

### Why A1, D1 and B1 failed acceptance

The failures are the same in all three:

- **T12:** 10 host ava tests fail, plus 2 pending after the ava timeout. The failing tests are existing seed tests that assert the old semantics, where `timeout` is a total budget. One example is `retryOnTimeout: true does not exceed total timeout budget` (`timeout: 500`, expects 1 request; actual 3–4). The task allows updating such tests, but no trial edited any file under `test/` (B1 only added a scratch `test/tmp-verify.mjs`).
- **T14:** no `totalTimeout` regression tests and an empty `DELIVERY.md`. D1 also did not document the option in the readme.

The work was cut off by finalization. Saving the source edits counts as a saved deliverable, so after three finalization requests the run must give its final reply. A1 and B1 spent most of those requests reading test files for the test update they never wrote. They entered finalization with 32 and 36 model calls left, but token budget was the actual limit. With a 2,000,000-token ceiling that counts cached input, each call cost about 35–40k tokens. That leaves room for about 50 calls, and the delivery reserve (about 260–300k tokens) is reached around call 44–48.

### C1: sandbox command latency and the time budget

Every sandboxed `process.exec` took 57–69 s, including trivial `node -e` file reads. The registration preflight shows the same cost (57–68 s per probe). Command time for the four trials was 113 s, 241 s, 440 s and 1,246 s. C1 used 20 commands, most of them to read file ranges. Its session active time reached 1,520,596 ms against `maxDurationMs` 1,500,000. The `TIME_BUDGET` abort landed during a `process.exec`. `process.exec` is a write-effect tool, so the kernel recorded it as `unknown`, and the eval scores that as a failed trial. The kernel behaved as designed. The cause is the fixed per-command sandbox cost. The most likely source is the launcher granting ACLs and labels per object over the readable workspace, which includes 16,305 dependency files. This has not been profiled yet.

### Causes found in v2-r3, in order of impact

1. **The token ceiling counts cached input.** Cache reads were 62–88% of input tokens (B1: 1,579,648 of 1,797,549). The 2M ceiling allows about 50 calls, too few for this task's read, implement, test and deliver cycle. A cache-aware ceiling or reserve, or a larger `maxTokens`, changes budget semantics and needs a new registration.
2. **The finalization window ends after one deliverable.** Once any edit is saved, three finalization requests force the final reply, even when tests and `DELIVERY.md` are still missing. A final-response gate that lists the objective's missing deliverables, and allows a few more write-only requests while some are missing, would target the T14 losses directly.
3. **The fixed cost per sandbox command is about 60 s on Windows.** It used 83% of C1's 25-minute budget and leads models to run fewer checks. Profile the launcher (ACL tree grants and label passes) before changing it.
4. **Reading through `node -e`.** After the reread warnings, C1 read files through `process.exec`, which bypasses the reread detector and pays the sandbox cost on every read.

## v2-r4 changes

Registration `ky-total-timeout-v2-r4`. The four v2-r3 causes were fixed in order:

1. **Windows sandbox per-command cost.** When no deny path is set, the launcher grants the readable tree with one inheritable ACE on the root instead of one per object. Preflight probes dropped from 57–68 s to 14–22 s each, including AppContainer setup.
2. **Deliverable gate.** The host declares `deliverables: ['DELIVERY.md', 'test/']` (a trailing `/` means a directory with at least one saved file). While any of them is unsaved, the final-response request is deferred by up to two extra write-only requests. The runtime state lists `missingDeliverables`.
3. **Cache-aware charging.** `Budget.cacheReadCostPercent` (0–100, default 100; CLI `--cache-read-cost-percent`) charges cache-read input at a percentage. The relay settles at the same percentage. This registration uses 10.
4. **Script reads.** Inline `node -e` and shell read scripts in `process.exec` count as investigation for the write nudge, and as unchanged re-reads (`<path> (via process.exec)`). Scripts that write still count as action.

Verification: `npm run check` clean, `npm run build` current, vitest 89 files / 1131 passed / 8 skipped, relay and eval tests 15/15, dry-run preflight passed.

## v2-r4 result

Stop rule `BLOCK_1_NO_COMPLETE_DELIVERIES` after C1, no interruptions. Spend: 320 requests, 2,202,796 charged tokens (cache reads at 10%).

| Trial | Checks | Calls | Input | Cache read | Output | Charged | Wall | Writes | Commands | Ending |
|---|---|---|---|---|---|---|---|---|---|---|
| A1 | 12/14 | 80 | 3.04M | 2.75M | 48.8k | 616,904 | 562 s | 9 patches (incl. `test/tmp-check.mjs`) | 4 | ACCEPTANCE_FAILED |
| D1 | 12/14 | 80 | 1.46M | 1.12M | 51.8k | 501,960 | 554 s | 3 patches | 4 | ACCEPTANCE_FAILED |
| B1 | 12/14 | 80 | 3.15M | 2.85M | 45.3k | 624,004 | 537 s | 10 patches | 3 | ACCEPTANCE_FAILED |
| C1 | 0/14 | 80 | 1.31M | 1.00M | 53.6k | 459,928 | 474 s | 6 patches | 0 | ACCEPTANCE_FAILED, build fails |

All four trials completed inside the time budget. Every trial used all 80 model calls.

### What the v2-r4 changes did

- **Sandbox cost: fixed.** Wall time fell to 474–562 s per trial. In v2-r3, C1 alone spent 1,246 s in commands. No trial came near `maxDurationMs`, and there was no UNKNOWN_WRITE.
- **Cache-aware charging: works, and moved the limit.** Cache reads were 76–91% of input. Charged tokens were 460–624k per trial. At finalization, 1.48–1.58M tokens remained. The binding limit is now `maxModelCalls` (80): every `delivery.finalization_started` gives the reason `at most 4 model calls remain`.
- **Deliverable gate: did not help.** `DELIVERY.md` stayed at 0 bytes in all four trials. The gate only defers the final reply. It cannot add model calls past `maxModelCalls`, and it does not apply when one call remains. Finalization began with 4 calls left. The models spent them on reads and searches (several rejected with `FINALIZATION_TOOL`) or on source patches. A1's last write was a scratch `test/tmp-check.mjs`. It satisfies `test/`, but it is not a regression test. `missingDeliverables: ["DELIVERY.md"]` was visible in A1's last four requests and was not acted on.
- **Script-read detection: not exercised.** The models made 0–4 `process.exec` calls per trial (tsc, xo, scratch scripts) and no inline file reads. Reread warnings fired through `file.read` in D1 (`source/utils/timeout.ts`) and C1 (`source/core/Ky.ts`). The write nudge fired once in each trial at 30–31 reads (steps 15–18).

### Why the trials failed acceptance

- **A1, B1:** T12 has one failing regression test, `retry › totalTimeout: user cancellation stops further attempts`, with `TypeError: this[#options].retry.delay is not a function` at `source/core/Ky.ts:386`. A seed test sets `retry.delay` to a number, and the new delay path calls it without normalizing. At step 78 A1 changed `delay: 1000` to `delay: () => 1000` in its scratch `test/tmp-check.mjs` instead of fixing the source. T14: no `DELIVERY.md`. A1 has no real regression test.
- **D1:** T12 failed. T14 is missing readme documentation, regression tests and `DELIVERY.md`. D1 recorded 21 context compactions and 6 summary checkpoints over a three-patch delivery.
- **C1:** `tsc` fails with TS2375 at `Ky.ts:296`: `totalTimeout: number | undefined` cannot be assigned under `exactOptionalPropertyTypes`. C1 ran no commands, so it never saw the error.

### Causes found in v2-r4, in order of impact

1. **Delivery pressure is tied to the last 4 calls.** With tokens no longer binding, finalization starts only at `remainingModelCalls <= 4`, too late to write tests and `DELIVERY.md`. When declared deliverables are missing, the reserve should scale with them. For example, start write-only pressure at `4 + 2 × missing` calls, or inject the missing-deliverable notice into ordinary requests once a fixed share of calls is used.
2. **The call ceiling is now the budget.** At 80 calls and about 6–8k charged tokens per call, three quarters of the token budget is unused. The next registration should raise `maxModelCalls` (for example to 120) or tie it to the token ceiling.
3. **`file.read` on a missing path returns `INTERNAL: operation failed` with `notStarted: true`.** A1 hit it twice (`test/server.ts`, `source/core/normalize.ts`). The model cannot tell this from a harness fault. ENOENT should map to a clear not-found error.
4. **Scratch files count as test deliverables.** `test/` is satisfied by any saved file, including `tmp-*.mjs`. A pattern such as `test/*.ts`, or excluding scratch names, would match the acceptance check.

