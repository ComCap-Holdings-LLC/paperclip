# COM-14404: Run-bound external executor CAS

## Contract

`POST /api/issues/:id/external-executor/checkout` is an agent-authenticated,
server-side transaction.  The client supplies a UUID idempotency key, the
current `executionVersion`, and permitted source statuses.  The transaction
locks the issue row, rejects hidden issues and active pause/cancel tree holds,
creates one registered `heartbeat_runs` record, and atomically binds the issue
to that run while advancing the version.

The heartbeat run durably records the executor key, issue, expected version,
hold snapshot, visibility snapshot, and a matching context snapshot.  The
company-scoped partial unique index on `(company_id, external_executor_run_key)`
prevents a forged/reused key from binding a second issue.  A retry with the same
agent, issue, and original version returns the already-bound run; any other
reuse is a conflict.

`POST /api/issues/:id/external-executor/terminal` is the only terminal path for
an active external executor.  Its update predicates include the bound run ID,
run key, agent, and current version.  The winning request clears the run lock,
advances the version, and terminalizes the heartbeat run in the same database
transaction.  A late, stale, or foreign request cannot change the issue.

Board-only `recover` is the explicit crash path.  It uses the same CAS and
marks the registered run `timed_out`; it does not let an agent self-release a
lost run.

## Lifecycle fences and compatibility

Existing checkouts remain compatible: new issue fields default to no external
run and version zero.  New nullable heartbeat fields leave prior heartbeat
records valid.  Migration 0219 adds the run/version binding and unique index;
0220 adds the persisted visibility snapshot.

Generic issue lifecycle mutation, normal release, admin force-release, and
tree pause/cancel/release/restore all acquire the issue-row fence.  They reject
an active external run rather than clearing it.  Tree control increments the
execution version, so a checkout request that observed the pre-hold state is
stale even after the hold is released.

`pc` is intentionally not changed: it authenticates as the board principal and
must not become a bypass for the agent-only executor endpoints.

## Verification matrix

| Requirement | Evidence |
| --- | --- |
| One checkout winner under concurrency | focused route race test |
| Idempotent retry / forged cross-issue key | focused route negative controls |
| Pause and cancel control races | focused route race tests |
| Stale, foreign, generic, force-release terminal denial | focused route negative controls |
| One terminal CAS winner | focused route concurrency test |
| Migration and type safety | migration generator and TypeScript checks |
| Independent review | COM-14406; pending fresh Sol/xhigh and Grok review |
| Production positive/negative readback | pending deployment of reviewed revision |
