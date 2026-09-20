# Productivity-review noise cleanup proposal (DRAFT 2026-09-18)

**Status:** DRAFT. No ticket has been closed or modified.

## 1. What the 32 tickets are

The 32 tickets in scope are machine-generated "Review productivity for ..." issues originating from `server/src/services/productivity-review.ts` in the Paperclip repository (checkout at `/home/hermes/com-15465-paperclip`).

The generation logic is anchored at `productivity-review.ts:37`, which defines:

```typescript
TERMINAL_RUN_STATUSES = ["succeeded","interrupted","failed","cancelled","timed_out"]
```

This constant drives the detection of "terminal" runs that trigger the review workflow.

## 2. Root cause: four defects

### Defect 1: Streak loop counts non-productive terminal runs
Lines 37 and the streak loop at lines 494-500 count every terminal run without an issue comment, including `failed`, `cancelled`, and `timed_out` runs that crashed before doing work. The generated body claims "10 consecutive COMPLETED runs" while its Latest Runs list shows all failed and cost is 0 cents.

### Defect 2 (reinstated 2026-09-20, COM-15742): `countIssueRunsSince` had no status filter
`countIssueRunsSince` had no status filter, so crash loops tripped the `high_churn` threshold (10 runs/1h, 30/6h). This was first judged "a real churn signal" and left alone (PR #21). The 24h readout after PR #21 showed the cost: review tickets 10 before vs 9 after deploy; `no_comment_streak` fell 8 to 0 but `high_churn` rose 2 to 8 and `long_active_duration` 0 to 1; 928 of the newest 1000 heartbeat runs were `failed` and none of the post-deploy reviews were genuine. Failed runs are already reported by fleet dispatch, so a failing agent produced review tickets on top of failures. Fixed: see section 8.

### Defect 3: No per-agent cap on creation
The creation cap is per source issue (`originId`, max 1 per 24h) with no per-agent cap. One broken executor fans out one review per assigned issue.

### Defect 4: Continuation hold blocks real work
`isProductivityReviewContinuationHoldActive` returns `held:true` for soft-stop triggers, so a false review blocks continuation of the real source work.

**Why tests never caught it:** `productivity-review-service.test.ts` `insertRuns` hardcodes status `"succeeded"`, so the test suite never exercises the `failed`/`timed_out` paths.

## 3. Live evidence

Read from `GET /api/heartbeat-runs/<id>`:

| Run ID Prefix | Source Ticket | Status | Error | Lifetime | UsageJson |
|---|---|---|---|---|---|
| `0ec03afe` | COM-15570 | failed | "Qwen failed exit=1" | 8s | null |
| `3d36f547` | COM-15551 | failed | "Codex exit 1" | 4s | null |
| `4437f55f` | COM-15308 | timed_out | terminal since 2026-09-12 | — | — |
| `e460ecad` | (contrast) | succeeded | — | — | — |

## 4. Cleanup proposal: four buckets

### A. Source issue already done (13)

COM-15461, COM-15546, COM-15527, COM-15528, COM-15372, COM-15256, COM-15540, COM-15538, COM-15530, COM-15526, COM-15523, COM-15520, COM-15484

**Reason:** Reviewed work finished.

### B. Evidence is executor-crash runs, source still open (13)

COM-15476, COM-15475, COM-15474, COM-15570, COM-15569, COM-15462, COM-15551, COM-15545, COM-15541, COM-15531, COM-15522, COM-15521, COM-15519

**Reason:** False positives from defect 1. The real signal is executor health, already owned by COM-15533 and COM-15498. Only 2 of 13 confirmed by direct run readback; re-read each via `/api/heartbeat-runs/<id>` before acting.

### C. `long_active_duration` on stale execution lock (5)

COM-15368, COM-15365, COM-15442, COM-15539, COM-15487

**Reason:** Measures `now` minus `issue.startedAt` with zero active runs. This is a stuck lock, not an unproductive agent.

### D. Silent-run detector, different origin kind (1)

COM-15308; run `4437f55f` timed_out and terminal since 2026-09-12.

**Explicit statement:** No ticket falls in the genuine-signal bucket (succeeded runs, no comment, source open).

## 5. Volume

`pc ls --query "Review productivity for" --limit 2000` returns **799** review issues:

- 495 done
- 255 cancelled
- 49 open (lower bound)

## 6. The fix

Implemented (local commit only, not pushed, not deployed) via new module `server/src/services/productivity-review-run-classification.ts` (branch `slice/noise-20260918`):

1. `PRODUCTIVE_TERMINAL_RUN_STATUSES = ["succeeded"]`; `interrupted`, `failed`, `cancelled`, `timed_out` are unproductive (crashed or killed runs); `TERMINAL_RUN_STATUSES` is derived from the two subsets.
2. The no-comment streak counts only succeeded runs. A run-created comment ends the streak whatever the run status (comment check runs first); a silent non-productive run is skipped, not a break.
3. (Superseded by section 8.) `countIssueRunsSince` (high_churn) was left unfiltered in PR #21; it now counts succeeded runs only.
4. Trigger wording "completed" becomes "succeeded" (now accurate, since only succeeded runs count).
5. The unproductive-run count is shown in the Evidence block.

**Deferred:**
- Per-agent fan-out cap
- Continuation-hold semantics
- Silent-active-run detector in `recovery/service.ts:2208`
- Executor repair

## 7. NOT DONE / NOT VERIFIED

- No ticket closed or modified.
- Checkout not verified to match deployed Paperclip.
- Nothing pushed.
- Wiring in productivity-review.ts and the new DB-backed cases in productivity-review-service.test.ts were NOT type-checked and NOT run (no embedded-Postgres environment in this checkout); only the pure-helper tests were run.
- Fork diverges from upstream `paperclipai/paperclip`.

## 8. high_churn counts only succeeded runs (COM-15742)

- `countIssueRunsSince` filters `heartbeatRuns.status` with `PRODUCTIVE_TERMINAL_RUN_STATUSES` (the same classification helper the no-comment streak uses). failed, cancelled, timed_out and interrupted runs no longer count toward the 10/1h or 30/6h run thresholds.
- Unchanged: the assignee run-linked comment counts (a comment is counted whatever the status of the run that created it), the `terminal`, `active` and unproductive-terminal evidence counters, thresholds, and trigger priority.
- Review ticket evidence now reads "Succeeded runs in rolling windows: N/1h, N/6h" and the trigger reason says "succeeded runs".
- Tests: 10 succeeded runs in 1h still create a `high_churn` review (negative control); 10 timed_out, 30 failed in 6h, and 6 succeeded + 20 failed in 1h do not; 9 succeeded is below threshold; 30 succeeded in 6h creates one; assignee comments on failed runs still count.
- `long_active_duration` is deliberately NOT changed here. It measures `now - issue.startedAt` and is driven by stale execution locks (bucket C), not by run statuses, so a status filter cannot fix it. It needs its own change (stale-lock handling) and is left as is.
