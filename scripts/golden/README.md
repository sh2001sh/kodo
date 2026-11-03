# Golden evaluation engine (`scripts/golden/`)

Implementation of the Kodo golden-evaluation contract in
[`docs/kodo-golden-eval-design-20261103.md`](../../docs/kodo-golden-eval-design-20261103.md).
The engine runs the 10 golden samples (`eval/golden/cases/**`) through the real
`Application` with the default configuration, records per-request wire evidence,
scores each run against its `rubric.json`, and writes a matrix summary with
pass rates, token/cost/wall/cache metrics, repeated-read baselines and polluted
cells.

Files:

| file | role |
|---|---|
| `run.mjs` | CLI entry + orchestration (matrix, relay, grading pipeline, report/progress/summary, `--rescore`). Imports `dist/` lazily. |
| `compare.mjs` | Baseline vs candidate comparison and stage-1 gate: pass-rate/mean deltas, cell flips, new rule violations, data completeness. Pure analysis + a small CLI. |
| `score.mjs` | Pure scoring engine: every check kind in contract §4.1, rules/checks/human semantics, `grading`-aware protected comparison. No I/O. |
| `metrics.mjs` | Pure metrics aggregation: per-run §6 fields and `summary.json` means/pass rates/re-read baseline. |
| `pollution.mjs` | Pure §7 wire-pollution analysis (request/response model identity, usage, HTTP status). |
| `workspace.mjs` | Workspace seeding helper: creates `case.deliverableDir` in every run workspace. |
| `cases.mjs` | Case discovery, `case.json`/`rubric.json` validation, matrix plan (repeat-major, optional seeded shuffle). |
| `errors.mjs` | `GoldenError`: evaluation-infrastructure errors (non-zero exit, never a sample failure). |
| `test-fixtures/` | Minimal offline fixtures used by `--dry` self-tests and the README examples. |

## Quick start

```powershell
# Offline plumbing run: scripted provider, no network, no API key.
node scripts/golden/run.mjs --dry

# Offline run of selected cases / custom cases root (engine self-test).
node scripts/golden/run.mjs --dry --cases coding-01-statemachine,data-01-stats-chart --repeat 1
node scripts/golden/run.mjs --dry --cases-dir scripts/golden/test-fixtures/cases --repeat 2 --concurrency 2

# Paid baseline (the only mode that spends money). Real key only reaches the
# per-cell loopback relay; it never enters the Kodo process environment.
node scripts/golden/run.mjs --run --provider-config test_api.json --provider codego1 `
  --model deepseek-v4.1-flash --repeat 3 --concurrency 4
node scripts/golden/run.mjs --run --provider-config test_api.json --prices 0.28,0.028,0.42 --repeat 3

# Recompute scores after filling in human verdicts.
node scripts/golden/run.mjs --rescore .kodo/golden/<stamp>
```

Defaults: all cases under `eval/golden/cases`, `--repeat 3`, `--concurrency 4`,
model `deepseek-v4.1-flash`, provider key `codego1`, output
`.kodo/golden/<stamp>/` (must be new or empty; there is no implicit resume).

`node scripts/golden/run.mjs --help` prints the option table.

## Output layout

```
.kodo/golden/<stamp>/
  registration.json        # build/code digests, case digests, model, prices, plan, settings
  progress.json            # rewritten before/after every cell; crash leaves state=running
  runs/<case-id>/r<repeat>/
    workspace/             # post-run workspace (after grading restore/stage)
    state/                 # fresh Kodo data directory
    wire/                  # relay request-N.json, response-N.sse, relay.json
    report.json            # status, score, metrics, pollution, grading, protections, evidence
    human.json             # OPTIONAL: human check verdicts, e.g. {"H1": true}
  summary.json             # matrix state, pass rates, means, repeated-read baseline, polluted cells
```

`report.json` keeps the evidence needed by `--rescore` (`scoring.finalText`,
`scoring.protectedResults`, `scoring.commandResults`), so filling `human.json`
does not require rerunning the model.

## case.json schema (§3, §3.1)

```jsonc
{
  "schemaVersion": 1,
  "id": "lit-01-comparison-table",          // must equal the directory name
  "category": "literature",                  // literature | data | report | coding
  "title": "...",
  "objective": "self-contained task prompt",
  "limits": {
    "contextTokens": 1048576, "outputTokens": 393216, "maxOutputTokens": 16384,
    "maxModelCalls": 100, "maxTokens": 3000000, "maxToolCalls": 300, "maxDurationMs": 2700000
  },
  "permissions": ["read", "write", "exec"],
  "deliverableDir": "deliverables",
  "smoke": { "minModelCalls": 1, "minToolCalls": 1, "requireEventPrefixes": [] },
  "materialsGlobs": ["materials/**/*"],
  "grading": {                                // OPTIONAL (§3.1)
    "restore": ["tests", "conftest.py"],      // overwrite with the case workspace copy
    "stage": [{ "from": "verify/stage", "to": "_verify" }]   // copy held-out assets in
  },
  "notes": "authoring notes; never enters the model context"
}
```

Limits map to `createRun.budget`: `contextTokens → maxContextTokens`,
`outputTokens → binding.limits.output`, `maxOutputTokens → maxOutputTokens`,
plus `maxModelCalls/maxTokens/maxToolCalls/maxDurationMs`. The relay enforces the
per-request call/token budget independently, and the binding advertises the
model's real context/output capability. Missing limit fields fall back to the
defaults above.

## rubric.json schema (§4)

```jsonc
{
  "schemaVersion": 1,
  "passThreshold": 0.9,
  "rules":   [ { "id": "R1", "kind": "citation-sources", "params": { ... } } ],
  "checks":  [ { "id": "C1", "kind": "file-contains", "weight": 2, "params": { ... } } ]
}
```

- `rules` are hard constraints: any failure makes the run fail
  (`violations`) regardless of score. Rules get no weight and may use any kind
  except `human`.
- `checks` are weighted: `score = Σ(passed weight) / Σ(evaluated weight)`.
- `human` checks read `runs/<case-id>/r<n>/human.json` (`{"H1": true}`). A missing
  verdict is excluded from the denominator and sets `humanPending=true`; after
  filling the file run `--rescore` to settle scores and pass rates.
- `passed = violations.length === 0 && score !== null && score >= passThreshold`
  (a run whose every check is still human-pending never passes).
- Unknown kinds, malformed params, duplicate ids or invalid regexes are
  `GoldenError`s: the matrix aborts non-zero instead of recording a sample
  failure. Fix the engine, not the case.

### Check kinds (implemented semantics)

Paths are workspace-relative; `*` matches within one segment, `**` spans
segments, `?` one character.

| kind | params | semantics |
|---|---|---|
| `file-exists` | `path`, `minBytes?` | exact path, or at least one glob match, with `size >= minBytes` (default 1: non-empty) |
| `file-contains` | `path`, `all?`, `any?`, `none?` | literal, case-sensitive `includes`; `all` all present, `any` at least one, `none` none present |
| `final-contains` | `all?`, `any?`, `none?` | same on the main run's final reply (empty reply fails) |
| `final-regex` | `patterns[]` (string or `{pattern, flags}`) | every pattern must match the final reply; invalid regex = evaluation error |
| `csv-columns` | `path`, `required[]` | header cells trimmed; every required column present |
| `csv-rows` | `path`, `minRows`, `maxRows?` | data rows (header excluded, blank rows skipped) within range |
| `csv-cell` | `path`, `where{col:value}`, `expect{col:value}`, `tolerance?` | first row matching all `where` (trimmed string equality); with `tolerance` numeric compare `|a-b| <= tolerance`, otherwise trimmed string equality |
| `markdown-table` | `path`, `requiredHeaders[]`, `minRows` | one table whose normalized headers (no `*`/backticks, trimmed, lowercase, whitespace collapsed) contain all required headers, and whose data rows `>= minRows` |
| `json-values` | `path`, `expect{path: value}` | dot paths (`a.b.0.c`) resolved and deeply compared |
| `citation-sources` | `path`, `allowedRoots[]`, `requireExcerpt?` | every explicit `<allowedRoot>/<path>` reference in the deliverable must exist; with `requireExcerpt`, each quoted single-line snippet (`“…”`/`"…"`, ≥10 characters after trim) must appear verbatim in some source file under the roots (whitespace-collapsed fallback) |
| `protected-unchanged` | `paths[]` | compares the post-run workspace with the case workspace for the same paths (recursive): any added/removed/modified file is a violation. Computed **before** `restore`/`stage` replace the model's evidence. |
| `command` | `program`, `args[]`, `cwd?`, `expectExit`, `timeoutMs?` | runs after restore/stage in the post-run workspace with `spawnSync(..., {shell:false})`; `args` are passed verbatim; `node` falls back to the runner's own Node when PATH lacks it; exit code must equal `expectExit` (default 0) |
| `artifact-count` | `dir`, `glob`, `min` | files under `dir` whose relative path matches `glob` must number `>= min` |
| `human` | `question` | manual verdict from `human.json` |

Commands run in declaration order (`rules` first, then `checks`), so a producer
command can feed later file checks. After the model run the engine therefore:
1. computes `protected-unchanged` comparisons against the seeded workspace,
2. applies `grading.restore` (copy case-workspace paths over the run workspace),
3. applies `grading.stage` (copy `case/<from>/` to `<workspace>/<to>/`); a case
   with a `verify/` directory but no explicit `stage` gets `verify → workspace/verify`
   staged implicitly,
4. executes `command` checks,
5. evaluates the remaining checks.
`GOLDEN_CASE_DIR` and `GOLDEN_VERIFY_DIR` are exported to command environments.

## Run semantics (§5, §7)

- Each cell gets a **fresh** `state/` and a copy of `case/workspace/`; cells never
  share state, workspace or relay. After the copy the runner creates
  `case.deliverableDir` (e.g. `deliverables/`) when it is missing — the task prompt
  points the model at that directory and git cannot track empty directories.
  `--concurrency` cells run in parallel, each with its own loopback budget relay.
- `Application` is constructed exactly as `new Application(stateDir, provider,
  undefined, {})` (default `compact-v2` profile, default cards/compaction); the
  model binding is `{protocol:'chat-completions', model, baseURL: relay.baseURL,
  apiKeyEnv:'KODO_GOLDEN_RELAY_KEY', limits:{context,output}}`.
- The first cell of the plan is the smoke gate (§7): it must reach
  `smoke.minModelCalls`, `smoke.minToolCalls` and every
  `smoke.requireEventPrefixes` count; otherwise the matrix stops with
  `SMOKE_ABORT`.
- Whole-matrix stops: `SMOKE_ABORT`, `RELAY_REJECTED` (relay budget/refusal),
  `PROTECTED_VIOLATION`, `USAGE_UNRECONCILED` (usage missing beyond excused
  client aborts), `PROVIDER_FAILURES` (two consecutive cells whose run ended on
  provider failures), `SIGINT` (`INTERRUPTED`). A stopped matrix is recorded as
  `stop` in `progress.json`/`summary.json`; it never silently turns into a pass.
- Polluted runs (§7) keep their quality verdict in `passRate` but are excluded
  from cost/token/cache means. Pollution reasons are recorded per relay request
  in `report.pollution.reasons`: response `model` ≠ request `model`,
  `metering=unknown` without a client abort, HTTP status ≠ 200, missing
  request/response wire files, or a measured 200 response with no model field.

## Metrics and summary (§6)

Per run (`report.metrics`): `modelCalls/measuredCalls/unknownCalls`,
`inputTokens/outputTokens/totalTokens`, `cacheRead/cacheWrite/uncachedInput`,
`cacheReadShare = cacheRead/inputTokens`, `wallMs` (session first-to-last event),
`relayRequests/relayRejected`, `providerFailures`, `fileReadCalls/rereads` for
`main` and `child`, `childRereadOfMain` (share of a child's distinct read paths
that the main run had already read before that child started; `null` without
children), `usageComplete` and `cost` (`{basis:'tokens', value}` by default,
`{basis:'price', ...}` with `--prices`).

`summary.json` adds: per-case and per-category `passRate`; `meanTokens`,
`meanCost`, `meanWallMs`, `meanCacheReadShare` over `usageComplete && !polluted`
runs only (`null` when there is no eligible sample — the sample count is
`eligibleRuns`); `repeatedReadBaseline` (main/child reread rates and the child
`childRereadOfMain` numerator/denominator); `pollutedCells`; `humanPendingCells`;
`matrixState` (`complete`/`incomplete`/`invalid` from the registered plan); and
`stop`.

`humanPendingCells` lists runs whose human checks are still unanswered;
`overall.humanPendingRuns` counts them. They still have a provisional `passed`
value (per the contract formula with pending checks excluded) but the settled
verdict needs `human.json` + `--rescore`. Example:

```powershell
# 1. Inspect the run.
Get-Content .kodo/golden/<stamp>/runs/coding-01-statemachine/r1/report.json
# 2. Fill human verdicts (ids are rubric check ids).
'{"H1": true}' | Set-Content .kodo/golden/<stamp>/runs/coding-01-statemachine/r1/human.json -Encoding utf8
# 3. Rescore every report + summary without touching the model again.
node scripts/golden/run.mjs --rescore .kodo/golden/<stamp>
```

## Baseline comparison (stage-1 gate)

```powershell
node scripts/golden/compare.mjs --baseline .kodo/golden/baseline-<stamp> `
  --candidate .kodo/golden/<rerun> [--out comparison.json] [--json] [--fail-on-gate]
```

Both inputs are completed golden run directories (`summary.json` +
`runs/<case>/r<N>/report.json`); a `summary.json` path is also accepted. A matrix
that is still running (only `progress.json`), a missing directory or a malformed
summary is a `GoldenError` with a non-zero exit — partial evidence is never
compared silently.

The Markdown summary is printed; the JSON report is written to `--out` (default
`.kodo/golden/compare-<stamp>.json`). `--json` prints exactly one JSON document to
stdout (the path goes to stderr) for machine consumption. Exit codes: `0` report
produced; `2` with `--fail-on-gate` unless the gate status is `passed`
(inconclusive counts as not passed); `1` input/format error.

**Gate (§8 stage 1).** The gate status is one of `passed`, `failed`,
`undetermined`, `inconclusive`:

1. `passRateNotBelow`: per case, the candidate's passed count must be `>=` the
   baseline's (3 runs per case, equal allowed), and the overall count must not drop.
2. `noNewRuleViolations`: no new `(cell key, rule id)` violation instance; rule
   ids that never appeared for a case in the baseline are listed separately.
3. `costRegression` / `wallRegression`: mean cost and mean `wallMs` may regress at
   most `+10%` (`candidate <= baseline * 1.10`). Means only include cells with
   `usageComplete && !polluted`; `eligibleRuns` is the denominator. A baseline
   mean of `0`/`null` makes the criterion `undetermined` — never a pass. A cost
   basis mismatch (`tokens` vs `price`) makes the cost criterion undetermined.

The gate is **inconclusive** (and `gate.blockedBy` lists the reasons) whenever the
comparison is not a valid conclusion: either matrix not `complete`/has missing,
duplicated or unexpected cells, different plans, a stopped matrix, missing
`report.json` files, polluted cells, human-pending cells, cells with incomplete
usage, or incomparable cost bases. In that case the tool says explicitly that the
comparison cannot be used as a stage-1 gate conclusion — it never reports a
silent pass.

JSON report fields: `baseline`/`candidate` (dir, mode, model, matrixState,
costBasis, stop, plan), `completeness` (conclusive, blocker reasons, matrix,
cell-set/plan diffs, polluted/human-pending/usage-incomplete/missing-report
lists), `gate` (status, passed, conclusive, summary, `triggered`,
`undetermined`, `blockedBy`, `criteria`, limits), `overall` (baseline/candidate/
delta), `categories`, `cases` (per case: baseline/candidate aggregates incl.
`eligibleRuns`/`humanPendingRuns` and §6 means, delta, `passRateNotBelow`,
verdict), `flips` (per cell key `PASSED→FAILED` / `FAILED→PASSED`, plus byCase),
`violations` (added/removed instances, byCase, case-level new/removed rule ids),
`means` (eligibility rule, both sides, deltas), and `notes`.

## --dry mode

`--dry` uses an offline scripted provider that reads a probe file once and then
gives a fixed final answer. It exercises the whole pipeline (Application start,
cell isolation, grading restore/stage, command checks, scoring, pollution
analysis, progress/registration/summary) with no network and no credentials.
Scores are expected to be low — **dry runs prove plumbing, not quality**. The
scripted provider satisfies the default smoke gate (2 model calls, 1 successful
tool call), so a dry run that aborts with `SMOKE_ABORT` means the harness itself
broke.

## Self-test fixtures

`scripts/golden/test-fixtures/cases/` holds two tiny cases used only by the
engine self-tests (`--cases-dir scripts/golden/test-fixtures/cases`):
`fixture-lit-tiny` (file checks + citation-sources rule + human) and
`fixture-coding-tiny` (`grading.restore`/`stage`, `command` rule/check,
`json-values`, `protected-unchanged`, `human`). They are never part of the paid
golden matrix.

Unit tests: `node --test scripts/golden/*.test.mjs` (also
`npm run test:golden`); they cover reference-solution-pass / empty-output-fail,
every check kind, rules vs checks, human pending/rescore inputs, metric
aggregation, read-reread baselines, and pollution analysis.

## Known limitations

- `requireExcerpt` extracts `“…”`/`"…"` only (contract §4.2); full-width
  bracket quotes `「」`/`『』` are not treated as excerpts.
- `citation-sources` only checks explicit `<allowedRoot>/...` paths; bare file
  names are deliberately not treated as citations.
- `csv-cell` `where` matching is trimmed string equality (no numeric
  normalization); numeric tolerance applies only to `expect` when `tolerance` is
  set.
- Grading commands run with the host's `PATH` and whatever interpreters the
  machine has; a missing interpreter is recorded as a failed check (non-zero
  spawn/exit), not an infrastructure error.
- Re-read metrics compare event-sequence numbers of `tool.started` events; runs
  without events/children report `null` for `childRereadOfMain`.
- `--dry` still executes each case's `command` checks (against the seeded
  workspace), so a case with a heavy verification command will be slow even in
  dry mode.
- `meanCost` with `--prices` assumes one price table for all cases in a batch.
- `--rescore` reloads the current `eval/golden/cases/<id>/rubric.json`; if a rubric
  changes after a run, rescoring that old run fails loudly
  (`SCORE_UNPREPARED_CHECK`, e.g. a new `protected-unchanged` rule with no stored
  comparison) instead of silently rescoring against a different rubric. Rubrics
  are expected to stay frozen for a baseline/candidate pair.
- `compare.mjs` compares the recorded evidence; it never reruns cells. Any
  incompleteness on either side makes the gate inconclusive by design (see above),
  so a rerun that aborts (`SMOKE_ABORT`/`RELAY_REJECTED`/…) cannot be used as a
  stage-1 conclusion even if the finished cells look fine.
