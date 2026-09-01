import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";

export const EXTERNAL_PULL_RUN_TRIGGER = "external_pull";
export const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);
export const LIVE_PULL_RUN_STATUSES = ["queued", "scheduled_retry", "running"];

export function externalPullRunIsExpired(
  run: { leaseExpiresAt: Date | null },
  now: Date,
) {
  return run.leaseExpiresAt == null || run.leaseExpiresAt.getTime() <= now.getTime();
}

/**
 * Atomically expires an external pull run and releases only the issue lock
 * columns that still belong to it. Lifecycle mutations always lock issue rows
 * before the run row.
 */
export async function expireExternalPullRun(db: Db, runId: string, now = new Date()) {
  const publications: ActivityPublication[] = [];
  const expired = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const lockedIssueIds = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.companyId, sql`(select ${heartbeatRuns.companyId} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${runId})`),
        or(eq(issues.checkoutRunId, runId), eq(issues.executionRunId, runId)),
      ))
      .orderBy(issues.id)
      .for("update");
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
      || !externalPullRunIsExpired(run, now)
    ) {
      return false;
    }

    const updated = await tx
      .update(heartbeatRuns)
      .set({
        status: "timed_out",
        finishedAt: now,
        errorCode: "pull_run_lease_expired",
        error: "External pull-run lease expired",
        updatedAt: now,
      })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        inArray(heartbeatRuns.status, LIVE_PULL_RUN_STATUSES),
      ))
      .returning({ id: heartbeatRuns.id })
      .then((rows) => rows[0] ?? null);
    if (!updated) return false;

    const ownedIssues = await tx
      .select({
        id: issues.id,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(and(
        eq(issues.companyId, run.companyId),
        inArray(issues.id, lockedIssueIds.map((issue) => issue.id)),
      ))
      .orderBy(issues.id);
    if (ownedIssues.length > 0) {
      await tx
        .update(issues)
        .set({
          status: sql`case when ${issues.status} = 'in_progress' and ${issues.assigneeAgentId} = ${run.agentId} and (${issues.checkoutRunId} is null or ${issues.checkoutRunId} = ${run.id}) and (${issues.executionRunId} is null or ${issues.executionRunId} = ${run.id}) then 'todo' else ${issues.status} end`,
          assigneeAgentId: sql`case when ${issues.status} = 'in_progress' and ${issues.assigneeAgentId} = ${run.agentId} and (${issues.checkoutRunId} is null or ${issues.checkoutRunId} = ${run.id}) and (${issues.executionRunId} is null or ${issues.executionRunId} = ${run.id}) then null else ${issues.assigneeAgentId} end`,
          checkoutRunId: sql`case when ${issues.checkoutRunId} = ${run.id} then null else ${issues.checkoutRunId} end`,
          executionRunId: sql`case when ${issues.executionRunId} = ${run.id} then null else ${issues.executionRunId} end`,
          executionAgentNameKey: sql`case when ${issues.executionRunId} = ${run.id} then null else ${issues.executionAgentNameKey} end`,
          executionLockedAt: sql`case when ${issues.executionRunId} = ${run.id} then null else ${issues.executionLockedAt} end`,
          updatedAt: now,
        })
        .where(and(
          eq(issues.companyId, run.companyId),
          inArray(issues.id, ownedIssues.map((issue) => issue.id)),
        ));
    }

    await logActivity(tx, {
      companyId: run.companyId,
      actorType: "system",
      actorId: "pull-run-lease-sweeper",
      agentId: run.agentId,
      runId: run.id,
      action: "pull_run.expired",
      entityType: "heartbeat_run",
      entityId: run.id,
      issueId: null,
      details: {
        issueIds: ownedIssues.map((issue) => issue.id),
        reason: "lease_expired",
      },
    }, publications);
    for (const issue of ownedIssues) {
      await logActivity(tx, {
        companyId: run.companyId,
        actorType: "system",
        actorId: "pull-run-lease-sweeper",
        agentId: run.agentId,
        runId: run.id,
        action: "pull_run.issue_expired",
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        details: { issueId: issue.id, reason: "lease_expired" },
      }, publications);
    }
    return true;
  });

  for (const publication of publications) publishActivity(publication);
  return expired;
}
