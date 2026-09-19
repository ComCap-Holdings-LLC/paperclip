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

### Defect 2: `countIssueRunsSince` lacks status filter
`countIssueRunsSince` at line 412 has no status filter, so crash loops also trip the `high_churn` threshold (10 runs/1h).

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

**Reason:** False positives from defects 1 and 2. The real signal is executor health, already owned by COM-15533 and COM-15498. Only 2 of 13 confirmed by direct run readback; re-read each via `/api/heartbeat-runs/<id>` before acting.

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

Implemented (local commit only, not pushed, not deployed, wiring not type-checked against the full repo: no node_modules in this checkout) via new module `server/src/services/productivity-review-run-classification.ts` (branch `slice/noise-20260918`, local commit only):

1. `PRODUCTIVE_TERMINAL_RUN_STATUSES = ["succeeded", "interrupted"]`
2. Streak counts only productive runs
3. `countIssueRunsSince` gains a status filter
4. Trigger wording "completed" becomes "succeeded"
5. `failed`/`timed_out` count stays in the Evidence block

**Deferred:**
- Per-agent fan-out cap
- Continuation-hold semantics
- Silent-active-run detector in `recovery/service.ts:2208`
- Executor repair

## 7. NOT DONE / NOT VERIFIED

- No ticket closed or modified.
- Checkout not verified to match deployed Paperclip.
- Nothing pushed.
- Wiring in productivity-review.ts was verified by a syntax-only transpile and by the 4 pure-helper tests; the existing DB-backed productivity-review-service.test.ts was NOT run.
- Fork diverges from upstream `paperclipai/paperclip`.
