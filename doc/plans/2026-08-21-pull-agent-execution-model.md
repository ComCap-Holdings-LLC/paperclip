# Pull-Mode Agent Execution: Data Model, API, and Scheduler Integration Design

Date: 2026-08-21

Status: Proposed. No dispatch/scheduler code changes are included in this design; see
"Implementation phasing" for what (if anything) is safe to land alongside this document.

## 1. Problem

Paperclip's `agents` table and heartbeat scheduler assume a single execution shape: Paperclip
decides an agent should run, queues a `heartbeat_runs` row, and `claimQueuedRun` (see
`server/src/services/heartbeat.ts:12472`) dispatches an adapter process that Paperclip itself
spawns or calls out to. Every `adapterType` in
`server/src/adapters/builtin-adapter-types.ts` — including the `*_gateway` types
(`hermes_gateway`, `openclaw_gateway`) that call an already-running remote API server — is still a
**push** model: Paperclip is the one deciding to invoke, even when it isn't the one managing the
remote process's lifecycle.

Some deployments now run **resident, self-scheduling seats** — a long-lived process (a Wren-style
seat, a VPS-resident CLI session) that pulls its own work, decides its own cadence, and reports its
liveness back to Paperclip out of band. The seat itself is not something Paperclip spawns per run
and is not something Paperclip should keep re-dispatching against on a timer, because there is
nothing for a dispatch to do — the seat already has its own loop. Today, the only way to represent
this in Paperclip is for an external bridge script to `PATCH` `agents.status` directly on an
interval, which:

- writes into the exact same `status` column the scheduler treats as authoritative for dispatch
  decisions (`evaluateAgentInvokability` / `getAgentWorkEligibility`,
  `packages/shared/src/agent-eligibility.ts`), with no way to distinguish "Paperclip observed this
  by running a heartbeat" from "an external bridge asserted this";
- has no TTL/expiry concept — a bridge that stops running (crashed seat, network partition, host
  down) leaves the agent's status frozen at whatever it last wrote, which reads as healthy
  indefinitely;
- has no source/evidence trail — nothing in the `agents` row today says *why* `status` is what it
  is, so a debugging session can't tell "this became `error` because a run failed" from "this
  became `error` because a bridge script wrote it."

This design adds a minimal, additive `executionModel` distinction to the `agents` table and a
first-class way to record *where a status update came from* and *what evidence backs it*, without
changing behavior for any existing agent.

## 2. Data model changes

### 2.1 `agents.execution_model`

```ts
executionModel: text("execution_model").notNull().default("dispatch"),
```

Values: `"dispatch"` (today's implicit behavior — Paperclip owns invocation) | `"pull"` (an
external process owns invocation; Paperclip only observes liveness). `text`, not a DB enum,
matching every other lifecycle column on this table (`status`, `adapterType`) — the codebase's
existing convention is enum-shaped values enforced in application code
(`packages/shared/src/agent-eligibility.ts`'s `Set<string>` allowlists), not at the schema layer.
Indexed alongside `status` since the scheduler's first read on every dispatch path will be
`(companyId, status, executionModel)` — see §4.

Default `"dispatch"` for every existing row (migration backfills nothing else; a `NOT NULL
DEFAULT` on `ALTER TABLE ADD COLUMN` needs no backfill pass in Postgres — the default applies to
existing rows at DDL time). This is the load-bearing property for "default-preserving": no
existing agent's dispatch behavior can change because a column it never asked for the value of is
now present with the value that already described its behavior.

### 2.2 Status provenance: `statusSource` + `statusEvidence`

Two more columns on `agents`, not a side table — a side table would need its own join on every
`GET /agents/:id` and every place `status` is read, and the value is 1:1 with the agent's current
status, not a history. (History, if wanted later, is a separate concern — see §7 — and the natural
place for it is `activity_log`/`logActivity`, which already exists and already carries
`agentId`/`action`/`details` for exactly this kind of point-in-time record.)

```ts
statusSource: text("status_source").notNull().default("dispatch_run"),
statusEvidence: jsonb("status_evidence").$type<Record<string, unknown>>().notNull().default({}),
```

Values for `statusSource`: `"dispatch_run"` (status was last set by Paperclip's own dispatch/claim
path — a `heartbeat_runs` transition, a pause/terminate action, an error from a claimed run) |
`"external_heartbeat"` (status was last set by a POST to the new liveness-lease endpoint, §3.2).
Default `"dispatch_run"` — again preserving exactly what's true today: every status write that
exists in the codebase right now is a dispatch-path write.

`statusEvidence` is a small structured blob, shape depends on `statusSource`:
- `dispatch_run`: `{ runId, heartbeatRunStatus, source }` — mirrors what `claimQueuedRun` and its
  siblings already know at the point they write `status`.
- `external_heartbeat`: `{ leaseId, reportedAt, ttlSeconds, sourceLabel }` — see §3.2.

This does not replace `pauseReason`/`errorReason`/`pausedAt` — those stay as-is; `statusEvidence`
is the generic "how do we know" complement to those specific "why" fields.

### 2.3 Reusing the `environment_leases` TTL pattern

`environment_leases` (`packages/db/src/schema/environment_leases.ts`) is the closest existing
precedent for "an external thing is alive until proven otherwise": `status`, `acquiredAt`,
`lastUsedAt`, `expiresAt`, `releasedAt`, `provider`, `providerLeaseId`. This design does not reuse
that table directly — an environment lease is scoped to `(environmentId,
executionWorkspaceId)`, is about compute-resource occupancy, and its `provider`/`providerLeaseId`
columns are about which cloud sandbox provider issued it, none of which fits an agent-liveness
lease. Instead it introduces a narrower, purpose-built table with the same *shape* of fields:

```ts
// packages/db/src/schema/agent_heartbeat_leases.ts
export const agentHeartbeatLeases = pgTable("agent_heartbeat_leases", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
  reportedStatus: text("reported_status").notNull(), // the status the external process is asserting
  ttlSeconds: integer("ttl_seconds").notNull().default(180),
  sourceLabel: text("source_label"), // free text: which bridge/seat sent this, e.g. "wren-mercury-seat-3"
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  agentReportedIdx: index("agent_heartbeat_leases_agent_reported_idx").on(table.agentId, table.reportedAt),
}));
```

Only the most recent row per `agentId` matters for liveness (`ORDER BY reportedAt DESC LIMIT 1`);
older rows are kept as a bounded audit trail (pruned by an existing/future retention job, out of
scope here — see the `activity_log` retention pattern if one exists). This keeps
`agents.statusEvidence` as a **cache of the latest lease**, refreshed on every heartbeat-lease
POST, while `agent_heartbeat_leases` is the append-only source of truth — the same
cache-plus-ledger split `agent_runtime_state` (cache) already has relative to `heartbeat_runs`
(ledger).

## 3. API surface

### 3.1 `GET /agents/:id` (and other read paths sharing `buildAgentDetail`)

**No route code change is required for `executionModel`, `statusSource`, or `statusEvidence` to
appear in the response.** Verified directly: `GET /agents/:id`
(`server/src/routes/agents.ts:2817`) calls `buildAgentDetail`, which spreads
`...agent` (or the restricted view) over the full row returned by `svc.getById`
(`server/src/services/agents.ts:371`). `getById` does `db.select().from(agents)` (select-star) and
passes the row through `normalizeAgentRow` → `normalizeAgentBaseRow`, which also spreads `...row`
(`server/src/services/agents.ts:300-305`). The restricted view
(`redactForRestrictedAgentView`, `server/src/routes/agents.ts:2066`) blanks only
`adapterConfig`/`runtimeConfig` and otherwise spreads the row too. A new plain (non-secret) column
therefore surfaces automatically on every read path that already returns the agent row, with zero
route changes, and needs no explicit redaction decision because it carries no credential material.

The one read path that is an **allowlist**, not a spread — `redactAgentConfiguration`
(`server/src/routes/agents.ts:2075`, used by `GET /agents/:id/configuration`) — does need one line
added per field if this design wants `executionModel`/`statusSource` visible there too. That route
is out of scope for the increment in §7 (it's a distinct endpoint the ticket doesn't ask about),
but is worth listing so a future PR doesn't miss it.

### 3.2 New endpoint: `POST /agents/:id/heartbeat-lease`

The external-liveness ingestion path pull-mode bridges call instead of writing `agents.status`
directly.

```
POST /agents/:id/heartbeat-lease
Auth: same actor model as other agent-scoped write routes (agent's own API key, or a
      board actor with write access to the agent — reuse whatever `assertAgentReadAllowed`'s
      write-side sibling already gates other agent-mutation routes with; not a new auth concept).
Body: {
  status: "active" | "running" | "idle" | "error",   // subset of DIRECT_NON_INVOKABLE_STATUSES-complement;
                                                        // a pull-mode lease cannot claim "paused"/"terminated"/
                                                        // "pending_approval" — those remain board-only actions
  ttlSeconds?: number,        // default 180, matches the ComCap bridge's ~2min interval with headroom
  sourceLabel?: string,       // free text identifying the bridge/seat instance
  metadata?: Record<string, unknown>,
}
Response: {
  id, status, executionModel, statusSource, statusEvidence, lastHeartbeatAt
}
```

Server behavior:
1. 404 if agent missing; 409 (not silently accepted) if `agent.executionModel !== "pull"` — a
   `dispatch`-mode agent's status must never be writable by this endpoint, so a bridge pointed at
   the wrong agent id fails loudly instead of corrupting a Paperclip-managed agent's status.
2. Insert a row into `agent_heartbeat_leases`.
3. Update `agents.status`, `statusSource = "external_heartbeat"`, `statusEvidence = {leaseId,
   reportedAt, ttlSeconds, sourceLabel}`, `lastHeartbeatAt = now()` in the same transaction.
4. This is explicitly **not** routed through `heartbeat.wakeup()` or any `heartbeat_runs` row — it
   never touches `claimQueuedRun`, budgets, or the dispatch funnel at all. It is a pure status/lease
   write, structurally similar to how `pausedAt`/`pauseReason` are written directly today by the
   pause action, not through the run-claim path.

## 4. Status derivation for pull-mode agents

For a `dispatch`-mode agent, `status` is Paperclip's own record of what it last did — there is no
"derivation," it's authored by the scheduler. For a `pull`-mode agent, there is no dispatch loop
authoring it, so `status` must be **derived** from the most recent
`agent_heartbeat_leases` row plus a TTL check, computed at read time (not cached indefinitely),
since nothing else will notice a stalled bridge on its own:

| UI state | Derivation rule |
|---|---|
| `running` | Latest lease `reportedStatus == "running"` and `now() - reportedAt < ttlSeconds`. |
| `idle` | Latest lease `reportedStatus == "idle"` (or `"active"`) and `now() - reportedAt < ttlSeconds`. Distinguish "idle" (seat is alive, has no work) from "idle-but-queued" using existing signals Paperclip already has independent of the lease: are there `queued` `heartbeat_runs` or `agent_wakeup_requests` rows for this agent? If yes → `idle_but_queued`; a pull-mode agent that is alive but has unclaimed queued work the way it's configured is a distinct, actionable UI state from a pull-mode agent that is alive and has nothing to do. |
| `idle_but_queued` | Latest lease within TTL and reports `idle`, AND at least one `queued` row exists in `heartbeat_runs` or `agent_wakeup_requests` for this `agentId`. This is a genuinely new signal a `dispatch`-mode agent's UI doesn't need, because a `dispatch`-mode agent's queued work gets claimed by the scheduler; a `pull`-mode agent's queued work sits there until *it* claims it, so "queued but nobody's claiming it" is exactly the failure mode this state exists to surface. |
| `blocked` | Latest lease reports `error`, within TTL. Distinct from `unreachable` — the seat is alive and telling Paperclip it's stuck (mirrors `errorReason` semantics for dispatch-mode agents). |
| `unreachable` | No lease row exists, or `now() - reportedAt >= ttlSeconds`. This is the TTL-expiry case the direct-PATCH bridge cannot express today — a crashed/partitioned bridge currently freezes `status` at its last value forever; under this design it becomes an explicit, derivable `unreachable` after one missed interval's grace period. |

This derivation is a **read-time computation**, not a write. It belongs in `buildAgentDetail` (or
a small helper it calls) as an additional derived field on the response — analogous to how
`orgChainHealth` is already computed at read time in `normalizeAgentRows`
(`server/src/services/agents.ts:317-329`) rather than stored. It must not overwrite
`agents.status` itself on a plain `GET` — a read should never have a side effect on data another
system (the scheduler) treats as authoritative. If `unreachable` needs to become a first-class
`agents.status` value the scheduler itself reacts to (e.g., to auto-page or auto-fail queued work
against a dead pull agent), that is a dispatch-side decision explicitly deferred to §7 — it is not
part of this increment's read-only derivation.

## 5. Scheduler skip logic (design only — not implemented in this pass)

The correct, minimal choke point is **`evaluateAgentInvokability`**
(`server/src/services/agent-invokability.ts:73`) — specifically as a new leading check inside that
function (or immediately before its `getAgentWorkEligibility` call), returning a new
`AgentInvokabilityBlockReason` value such as `"pull_mode"`:

```ts
if (agent.executionModel === "pull") {
  return blocked("pull_mode", "Agent is pull-mode and does not accept Paperclip-initiated dispatch", { agentId: agent.id }, false);
}
```

Why this is the correct single funnel, not a scattered set of checks:

- `claimQueuedRun` (`server/src/services/heartbeat.ts:12472`) already routes every queued-run
  claim through exactly one invokability check (line 12479-12485) before it does anything else —
  budget checks, daily cap, pause holds, dependency blockers, staleness, and finally the CAS claim
  all happen *after* this gate, so blocking here means a pull-mode agent's queued runs get
  cancelled at the very first gate, before any budget/cap bookkeeping is touched.
- `claimDueTimerHeartbeat` (line ~12386) is the *other* place a dispatch can originate (the
  periodic "is this agent's heartbeat due" check) — but it does not need its own
  `executionModel` check, because every timer-driven wakeup it produces still has to pass through
  `claimQueuedRun`'s invokability gate before a run actually claims and executes. Duplicating the
  check there would be redundant, not defense-in-depth, since nothing currently reaches adapter
  execution without going through `claimQueuedRun` first — the existing test in §6 (the "no
  actionable work" negative control) already demonstrates this: `heartbeat.wakeup()` can decide
  there's nothing to do and short-circuit before `claimQueuedRun` even runs, and it still produces
  `run === null` with the adapter never invoked. A pull-mode check inside `evaluateAgentInvokability`
  is reached from *both* `wakeup()`'s pre-checks and `claimQueuedRun`'s explicit call
  (`evaluateAgentInvokability`/`evaluateAgentInvokabilityFromDb` per line 12479-12481), so one
  change covers both call shapes.
  This mirrors exactly the existing `paused`/`terminated`/`pending_approval` pattern —
  those are also single-status-field checks that this same function already owns, and adding
  `pull_mode` alongside them is additive to an existing pattern rather than a new architectural
  seam.
- Scattering the check across every dispatch call site instead (timer heartbeat, manual
  wake-agent API route, issue-assignment auto-wake, etc.) would require finding and updating every
  current and future call site that can originate a run — exactly the kind of fragile, easy-to-miss
  gate this codebase has already consolidated once (that consolidation is *why*
  `evaluateAgentInvokability` exists as a single function today rather than being inlined at each
  caller).

**This must default to inert.** `executionModel` defaults to `"dispatch"`, so
`agent.executionModel === "pull"` is `false` for every existing agent and this new branch never
fires for them — behavior is unchanged. This is exactly the kind of control-flow change flagged as
higher-risk in the task brief (changing what `claimQueuedRun` does, even gated by a default), which
is why it is written up here as a **design**, not implemented in this pass — see §7.

## 6. Negative-control test design

Mirrors the existing template at
`server/src/__tests__/heartbeat-process-recovery.test.ts:1268`
("skips generic timer wakes without invoking an adapter when no assigned work is actionable") —
same fixture shape (real embedded-postgres DB via `getEmbeddedPostgresTestSupport`, real
`heartbeatService(db)`, only the adapter-execute boundary mocked via `vi.hoisted`), extended with a
new fixture helper that seeds an agent with `executionModel: "pull"`:

```ts
it("skips dispatch for a pull-mode agent even when a wakeup and queued work exist, but accepts an external heartbeat lease", async () => {
  const { companyId, agentId } = await seedPullModeAgentFixture(); // executionModel: "pull"
  const heartbeat = heartbeatService(db);

  // 1. Simulate a condition that would normally trigger dispatch for a dispatch-mode agent:
  //    a timer wakeup with actionable queued work present.
  const run = await heartbeat.wakeup(agentId, {
    source: "timer",
    triggerDetail: "system",
    reason: "heartbeat_timer",
    requestedByActorType: "system",
    requestedByActorId: "heartbeat_scheduler",
    contextSnapshot: { source: "scheduler", reason: "interval_elapsed", now: "2026-08-21T00:00:00.000Z" },
  });

  expect(run).toBeNull();
  expect(mockAdapterExecute).not.toHaveBeenCalled();

  const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  expect(runs.every((r) => r.status === "cancelled" || r.status === "queued")).toBe(true);
  // no run of this agent ever reaches "running" or "completed"
  expect(runs.some((r) => r.status === "running" || r.status === "completed")).toBe(false);

  // 2. Confirm the external heartbeat-lease path is independent of dispatch and DOES update status.
  const before = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]!);
  expect(before.statusSource).toBe("dispatch_run"); // default, unset by step 1

  const leaseResponse = await postHeartbeatLease(agentId, { status: "running", ttlSeconds: 180, sourceLabel: "test-bridge" });
  expect(leaseResponse.status).toBe(200);

  const after = await db.select().from(agents).where(eq(agents.id, agentId)).then((r) => r[0]!);
  expect(after.status).toBe("running");
  expect(after.statusSource).toBe("external_heartbeat");
  expect(after.lastHeartbeatAt).not.toBeNull();
  expect(mockAdapterExecute).not.toHaveBeenCalled(); // still never invoked — the lease path is not a dispatch path
});

it("rejects a heartbeat-lease POST against a dispatch-mode agent (409)", async () => {
  const { agentId } = await seedIdleTimerAgentFixture(); // executionModel defaults to "dispatch"
  const res = await postHeartbeatLease(agentId, { status: "running" });
  expect(res.status).toBe(409);
});

it("existing dispatch-mode agent behavior is byte-for-byte unchanged with executionModel column present at its default", async () => {
  // identical assertions to the pre-existing "skips generic timer wakes..." test, run against
  // a fixture that now includes the executionModel column at its default value, proving the
  // new column's mere presence changes nothing for agents that never set it.
  const { companyId, agentId } = await seedIdleTimerAgentFixture();
  const heartbeat = heartbeatService(db);
  const run = await heartbeat.wakeup(agentId, { /* identical args as the existing test */ });
  expect(run).toBeNull();
  expect(mockAdapterExecute).not.toHaveBeenCalled();
  // ... identical remaining assertions to the existing test, see heartbeat-process-recovery.test.ts:1268
});
```

The third test is the one that actually proves "default-preserving" for the scheduler-skip change
in §5 — it is intentionally **not** run as part of the increment in §7, because §7 does not touch
`evaluateAgentInvokability`'s control flow at all yet. It is written here so the PR that eventually
does add the §5 check has an exact template to extend and no ambiguity about what "unchanged" means.

## 7. ComCap bridge migration path (ComCap's decision, not mandated here)

ComCap's existing stopgap bridge script (outside this repo, not touched by this design) currently
writes `agent.status` directly on a ~2-minute interval, presumably via a plain PATCH to whatever
agent-update route exists today. Whether it *should* migrate to `POST
/agents/:id/heartbeat-lease` instead is ComCap's call, not this repo's — but the argument for
migrating is:

- **Today**, a direct status PATCH is indistinguishable from any other status write — Paperclip
  cannot tell the bridge's write apart from a dispatch-path write, so `statusSource`/
  `statusEvidence` (§2.2) would show `dispatch_run` for a status that was never touched by a run,
  which is actively misleading during debugging.
- **Today**, there is no TTL — if the bridge stops running, the agent's status is frozen at
  whatever it last wrote, indefinitely. `unreachable` derivation (§4) requires a lease row with a
  TTL; a direct-PATCH bridge can't produce that unless it invents its own TTL convention on top of
  a plain status column, which is exactly the kind of thing this endpoint exists to centralize
  instead.
- **Today**, ComCap's bridge presumably decides "unreachable" logic (if any) on its own side,
  which means every consumer that reads `agent.status` in Paperclip has no way to know a status
  might be stale. Moving TTL-derivation server-side means every UI/API consumer gets the same
  `unreachable` answer, instead of the bridge being the only thing that knows.
- **Cost of migrating**: the bridge needs a code change (new endpoint, new auth if it's currently
  using an ambient credential the PATCH route accepted differently) and a decision about
  `ttlSeconds` tuned to its actual interval. This is real but small.

This repo does not decide FOR ComCap — this section only describes why the shape exists and what
migrating would buy, per the brief. Wiring the actual bridge script is out of scope (§8).

## 8. Explicitly out of scope / later phases

- **Wiring the ComCap bridge script itself** to call the new endpoint. That script lives outside
  this repo; this design only proposes the endpoint shape it could call.
- **Implementing the §5 scheduler-skip check** (`evaluateAgentInvokability`'s `pull_mode` branch)
  in this pass. See §7 of the top-level task and the Verification section of the PR for why: it is
  a dispatch/scheduler control-flow change, which the task's risk posture reserves for a follow-up
  PR with its own dedicated review, even though it is gated by a default that makes it inert for
  every existing agent.
- **The `POST /agents/:id/heartbeat-lease` endpoint itself**, and the `agent_heartbeat_leases`
  table. Also deferred — this is new write surface and a new auth-checked mutation path, which
  carries more risk than an additive schema column with no route wired to write it.
- **UI surfacing** of the derived `running`/`idle_but_queued`/`blocked`/`unreachable` states in the
  agents list/detail views. Depends on the read-time derivation helper in §4, which is not part of
  the increment.
- **Auto-reaction to `unreachable`** (e.g., auto-failing queued work assigned to a pull-mode agent
  whose lease has expired, alerting, or reassignment). This is a dispatch-side policy decision
  layered on top of the derivation in §4 and is explicitly not part of this design's scope beyond
  naming it as a plausible future direction.
- **`GET /agents/:id/configuration`'s allowlist-based redaction** (`redactAgentConfiguration`,
  `server/src/routes/agents.ts:2075`) does not gain `executionModel`/`statusSource` in this pass;
  noted in §3.1 for whoever picks that route up next.
- **Retention/pruning of `agent_heartbeat_leases` rows.** Noted in §2.3 as a bounded audit trail;
  no retention job is designed here.

## 9. Relationship to `doc/execution-semantics.md`

This design extends, rather than parallels, the "Non-Terminal Issue Liveness Contract" (§8) and
"Crash and Restart Recovery" (§9) sections of `doc/execution-semantics.md`. Those sections define
what counts as a durable, live action path for an *issue*; this design adds a durable liveness
signal for an *agent's execution substrate* itself (is the pull-mode seat alive at all), which is a
prerequisite question underneath "is there a live path for this issue" once an issue is assigned to
a pull-mode agent. A future revision of `doc/execution-semantics.md` should probably add pull-mode
agent lease expiry (`unreachable`, §4) as a recognized *invalid*-liveness condition — analogous to
how an "unmanaged local process is not a durable action path" (§8) already rules out unproven
liveness claims for issues, this rules out unproven liveness claims for agents — but that doc edit
is left for the follow-up PR that actually implements §5/§7, not this one, so the two changes land
with their actual behavior rather than describing behavior that doesn't exist yet.
