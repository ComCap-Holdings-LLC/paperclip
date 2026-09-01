import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { issueService, TERMINAL_HEARTBEAT_RUN_STATUSES } from "./issues.js";

export const EXTERNAL_PULL_RUN_TRIGGER = "external_pull";
export const PULL_RUN_LEASE_DEFAULT_SECONDS = 120;
export const PULL_RUN_LEASE_MIN_SECONDS = 30;
export const PULL_RUN_LEASE_MAX_SECONDS = 600;
const LIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"];

function leaseExpiry(now: Date, leaseSeconds: number) {
  return new Date(now.getTime() + leaseSeconds * 1_000);
}

function assertLeaseSeconds(leaseSeconds: number) {
  if (
    !Number.isInteger(leaseSeconds)
    || leaseSeconds < PULL_RUN_LEASE_MIN_SECONDS
    || leaseSeconds > PULL_RUN_LEASE_MAX_SECONDS
  ) {
    throw badRequest(
      `leaseSeconds must be an integer between ${PULL_RUN_LEASE_MIN_SECONDS} and ${PULL_RUN_LEASE_MAX_SECONDS}`,
    );
  }
}

function isExpired(run: { leaseExpiresAt: Date | null }, now: Date) {
  return run.leaseExpiresAt == null || run.leaseExpiresAt.getTime() <= now.getTime();
}

export function pullRunService(db: Db) {
  const issuesSvc = issueService(db);

  async function expireRun(runId: string, now = new Date()) {
    return db.transaction(async (tx) => {
      // Lifecycle operations always lock issue before run.  The issue service's
      // checkout/adoption paths use the same order, avoiding a run->issue
      // deadlock when expiry races a checkout-owner assertion.
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.checkoutRunId} = ${runId} or ${issues.executionRunId} = ${runId} order by ${issues.id} for update`,
      );
      await tx.execute(
        sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${runId} for update`,
      );
      const run = await tx
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (
        !run
        || run.triggerDetail !== EXTERNAL_PULL_RUN_TRIGGER
        || TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)
        || !isExpired(run, now)
      ) {
        return false;
      }
      await tx
        .update(heartbeatRuns)
        .set({
          status: "timed_out",
          finishedAt: now,
          errorCode: "pull_run_lease_expired",
          error: "External pull-run lease expired",
          updatedAt: now,
        })
        .where(and(eq(heartbeatRuns.id, run.id), inArray(heartbeatRuns.status, LIVE_RUN_STATUSES)));
      await tx
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(and(eq(issues.checkoutRunId, run.id), eq(issues.executionRunId, run.id)));
      return true;
    });
  }

  /** Scheduler-facing recovery: expired external pulls cannot depend on a
   * later client request to release their issue checkout. */
  async function sweepExpired(now = new Date(), limit = 100) {
    const candidates = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.triggerDetail, EXTERNAL_PULL_RUN_TRIGGER),
        inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
        or(isNull(heartbeatRuns.leaseExpiresAt), lte(heartbeatRuns.leaseExpiresAt, now)),
      ))
      .limit(limit);
    let expired = 0;
    for (const candidate of candidates) if (await expireRun(candidate.id, now)) expired += 1;
    return expired;
  }

  async function requirePullAgent(companyId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, companyId: agents.companyId, executionModel: agents.executionModel })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Agent not found");
    if (agent.executionModel !== "pull") {
      throw forbidden("External pull runs require executionModel 'pull'");
    }
    return agent;
  }

  async function loadOwnedRun(companyId: string, agentId: string, runId: string) {
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, runId),
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.triggerDetail, EXTERNAL_PULL_RUN_TRIGGER),
      ))
      .then((rows) => rows[0] ?? null);
    if (!run) throw notFound("Pull run not found");
    return run;
  }

  async function start(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    expectedStatuses: string[];
    leaseSeconds: number;
  }) {
    assertLeaseSeconds(input.leaseSeconds);
    await requirePullAgent(input.companyId, input.agentId);
    let issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    if (issue.checkoutRunId) {
      await expireRun(issue.checkoutRunId);
      issue = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
        })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
    }

    if (issue.assigneeAgentId === input.agentId && issue.checkoutRunId) {
      const existing = await loadOwnedRun(input.companyId, input.agentId, issue.checkoutRunId).catch(() => null);
      if (existing && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(existing.status) && !isExpired(existing, new Date())) {
        return { run: existing, issue: await issuesSvc.getById(input.issueId), idempotent: true };
      }
    }

    const now = new Date();
    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "on_demand",
        triggerDetail: EXTERNAL_PULL_RUN_TRIGGER,
        status: "running",
        startedAt: now,
        lastUsefulActionAt: now,
        leaseExpiresAt: leaseExpiry(now, input.leaseSeconds),
        contextSnapshot: { issueId: input.issueId, source: "external_pull" },
      })
      .returning()
      .then((rows) => rows[0]!);

    try {
      const claimed = await issuesSvc.checkout(input.issueId, input.agentId, input.expectedStatuses, run.id);
      return { run, issue: claimed, idempotent: false };
    } catch (error) {
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: new Date(), errorCode: "pull_run_claim_failed", updatedAt: new Date() })
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")));

      const winnerIssue = await db
        .select({ assigneeAgentId: issues.assigneeAgentId, checkoutRunId: issues.checkoutRunId })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (winnerIssue?.assigneeAgentId === input.agentId && winnerIssue.checkoutRunId) {
        const winner = await loadOwnedRun(input.companyId, input.agentId, winnerIssue.checkoutRunId).catch(() => null);
        if (winner && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(winner.status) && !isExpired(winner, new Date())) {
          return { run: winner, issue: await issuesSvc.getById(input.issueId), idempotent: true };
        }
      }
      throw error;
    }
  }

  async function heartbeat(companyId: string, agentId: string, runId: string, leaseSeconds: number) {
    assertLeaseSeconds(leaseSeconds);
    await requirePullAgent(companyId, agentId);
    const run = await loadOwnedRun(companyId, agentId, runId);
    if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) throw conflict("Pull run is terminal");
    const now = new Date();
    if (isExpired(run, now)) {
      await expireRun(run.id, now);
      throw conflict("Pull run lease expired");
    }
    const updated = await db
      .update(heartbeatRuns)
      .set({ leaseExpiresAt: leaseExpiry(now, leaseSeconds), lastUsefulActionAt: now, updatedAt: now })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.agentId, agentId),
        gt(heartbeatRuns.leaseExpiresAt, now),
        inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!updated) {
      await expireRun(run.id, new Date());
      throw conflict("Pull run is no longer live");
    }
    return updated;
  }

  async function finish(companyId: string, agentId: string, runId: string, status: "succeeded" | "cancelled") {
    await requirePullAgent(companyId, agentId);
    const run = await loadOwnedRun(companyId, agentId, runId);
    if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) throw conflict("Pull run is terminal");
    const now = new Date();
    if (isExpired(run, now)) {
      await expireRun(run.id, now);
      throw conflict("Pull run lease expired");
    }
    return db.transaction(async (tx) => {
      // See expireRun: issue -> run is the canonical lifecycle lock order.
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.checkoutRunId} = ${run.id} or ${issues.executionRunId} = ${run.id} order by ${issues.id} for update`,
      );
      await tx.execute(
        sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${run.id} for update`,
      );
      const updated = await tx
        .update(heartbeatRuns)
        .set({ status, finishedAt: now, leaseExpiresAt: null, updatedAt: now })
        .where(and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          gt(heartbeatRuns.leaseExpiresAt, now),
          inArray(heartbeatRuns.status, LIVE_RUN_STATUSES),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw conflict("Pull run is no longer live");

      const ownedIssue = await tx
        .select({ id: issues.id, status: issues.status })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeAgentId, agentId),
          eq(issues.checkoutRunId, run.id),
          eq(issues.executionRunId, run.id),
        ))
        .then((rows) => rows[0] ?? null);
      if (ownedIssue) {
        await tx
          .update(issues)
          .set({
            ...(status === "cancelled" && ownedIssue.status === "in_progress"
              ? { status: "todo", assigneeAgentId: null }
              : {}),
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(and(
            eq(issues.id, ownedIssue.id),
            eq(issues.assigneeAgentId, agentId),
            eq(issues.checkoutRunId, run.id),
            eq(issues.executionRunId, run.id),
          ));
      }
      return updated;
    });
  }

  return {
    start,
    heartbeat,
    sweepExpired,
    complete: (companyId: string, agentId: string, runId: string) => finish(companyId, agentId, runId, "succeeded"),
    cancel: (companyId: string, agentId: string, runId: string) => finish(companyId, agentId, runId, "cancelled"),
  };
}
