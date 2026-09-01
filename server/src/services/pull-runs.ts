import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
  type LogActivityInput,
} from "./activity-log.js";
import { issueService } from "./issues.js";
import {
  EXTERNAL_PULL_RUN_TRIGGER,
  expireExternalPullRun,
  externalPullRunIsExpired,
  LIVE_PULL_RUN_STATUSES,
  TERMINAL_HEARTBEAT_RUN_STATUSES,
} from "./external-pull-run-lifecycle.js";

export { EXTERNAL_PULL_RUN_TRIGGER } from "./external-pull-run-lifecycle.js";
export const PULL_RUN_LEASE_DEFAULT_SECONDS = 120;
export const PULL_RUN_LEASE_MIN_SECONDS = 30;
export const PULL_RUN_LEASE_MAX_SECONDS = 600;

export interface PullRunAuditActor {
  actorType: "agent" | "system";
  actorId: string;
  agentId?: string | null;
  agentApiKeyId?: string | null;
  responsibleUserIdOverride?: string | null;
}

export interface PullRunLifecycleAuthorization {
  /**
   * The complete issue-lock set authorized by the route before entering the
   * lifecycle transaction. The service revalidates it after locking the same
   * rows so an issue cannot be attached to the run between authorization and
   * cleanup.
   */
  authorizedIssueIds?: readonly string[];
  /** Re-run route authorization against the issue rows held by this transaction. */
  revalidateLockedIssues?: (
    tx: Db,
    issues: readonly PullRunLifecycleIssueAuthorizationSnapshot[],
  ) => Promise<void>;
}

export interface PullRunLifecycleIssueAuthorizationSnapshot {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  identifier: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
}

const lifecycleIssueAuthorizationSelection = {
  id: issues.id,
  companyId: issues.companyId,
  projectId: issues.projectId,
  parentId: issues.parentId,
  status: issues.status,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  identifier: issues.identifier,
  checkoutRunId: issues.checkoutRunId,
  executionRunId: issues.executionRunId,
};

const DEFAULT_PULL_RUN_AUDIT_ACTOR: PullRunAuditActor = {
  actorType: "system",
  actorId: "external-pull-run-service",
};

class PullRunAttachmentSetChangedError extends Error {}

function sameIssueIds(
  first: readonly { id: string }[],
  second: readonly { id: string }[],
) {
  return first.length === second.length && first.every((issue, index) => issue.id === second[index]?.id);
}

async function lifecycleAuthorizationIssueIds(
  tx: Db,
  companyId: string,
  runId: string,
  includeAncestors: boolean,
) {
  if (!includeAncestors) {
    return tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        or(eq(issues.checkoutRunId, runId), eq(issues.executionRunId, runId)),
      ))
      .orderBy(issues.id);
  }
  return tx.execute<{ id: string }>(sql`
    WITH RECURSIVE authorization_issues AS (
      SELECT ${issues.id} AS id, ${issues.parentId} AS parent_id
      FROM ${issues}
      WHERE ${issues.companyId} = ${companyId}
        AND (${issues.checkoutRunId} = ${runId} OR ${issues.executionRunId} = ${runId})
      UNION
      SELECT parent.${sql.identifier("id")} AS id, parent.${sql.identifier("parent_id")} AS parent_id
      FROM ${issues} parent
      JOIN authorization_issues child ON parent.${sql.identifier("id")} = child.parent_id
      WHERE parent.${sql.identifier("company_id")} = ${companyId}
    )
    SELECT id FROM authorization_issues ORDER BY id
  `);
}

async function lockLifecycleAuthorizationIssues(
  tx: Db,
  companyId: string,
  runId: string,
  includeAncestors: boolean,
) {
  const issueIds = await lifecycleAuthorizationIssueIds(tx, companyId, runId, includeAncestors);
  if (issueIds.length === 0) return [];
  const lockedIssues = await tx
    .select(lifecycleIssueAuthorizationSelection)
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds.map((issue) => issue.id))))
    .orderBy(issues.id)
    .for("update");
  const issueIdsAfterLock = await lifecycleAuthorizationIssueIds(tx, companyId, runId, includeAncestors);
  if (!sameIssueIds(issueIds, issueIdsAfterLock)) throw new PullRunAttachmentSetChangedError();
  return lockedIssues.filter(
    (issue) => issue.checkoutRunId === runId || issue.executionRunId === runId,
  );
}

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
  return externalPullRunIsExpired(run, now);
}

export function pullRunService(db: Db) {
  async function auditedTransaction<T>(
    operation: (tx: Db, publications: ActivityPublication[]) => Promise<T>,
  ): Promise<T> {
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => operation(tx as unknown as Db, publications));
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  function activityActor(
    auditActor: PullRunAuditActor | undefined,
    fallbackAgentId: string,
  ): Pick<
    LogActivityInput,
    | "actorType"
    | "actorId"
    | "agentId"
    | "agentApiKeyId"
    | "responsibleUserIdOverride"
  > {
    const actor = auditActor ?? DEFAULT_PULL_RUN_AUDIT_ACTOR;
    return {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? fallbackAgentId,
      agentApiKeyId: actor.agentApiKeyId ?? null,
      ...(actor.responsibleUserIdOverride !== undefined
        ? { responsibleUserIdOverride: actor.responsibleUserIdOverride }
        : {}),
    };
  }

  /** Scheduler-facing recovery: expired external pulls cannot depend on a
   * later client request to release their issue checkout. */
  async function sweepExpired(now = new Date(), limit = 100) {
    const candidates = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.triggerDetail, EXTERNAL_PULL_RUN_TRIGGER),
        inArray(heartbeatRuns.status, LIVE_PULL_RUN_STATUSES),
        or(isNull(heartbeatRuns.leaseExpiresAt), lte(heartbeatRuns.leaseExpiresAt, now)),
      ))
      .limit(limit);
    let expired = 0;
    for (const candidate of candidates) if (await expireExternalPullRun(db, candidate.id, now)) expired += 1;
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

  async function loadOwnedRun(companyId: string, agentId: string, runId: string, dbOrTx: Db = db) {
    const run = await dbOrTx
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
    auditActor?: PullRunAuditActor;
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
      await expireExternalPullRun(db, issue.checkoutRunId);
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

    return auditedTransaction(async (tx, publications) => {
      await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${input.issueId} and ${issues.companyId} = ${input.companyId} for update`);
      const lockedIssue = await tx
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
        })
        .from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!lockedIssue) throw notFound("Issue not found");

      if (lockedIssue.assigneeAgentId === input.agentId && lockedIssue.checkoutRunId) {
        const existing = await loadOwnedRun(
          input.companyId,
          input.agentId,
          lockedIssue.checkoutRunId,
          tx,
        ).catch(() => null);
        if (existing && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(existing.status) && !isExpired(existing, new Date())) {
          const currentIssue = await issueService(tx).getById(input.issueId);
          await logActivity(tx, {
            companyId: input.companyId,
            ...activityActor(input.auditActor, input.agentId),
            runId: existing.id,
            action: "pull_run.start_idempotent",
            entityType: "issue",
            entityId: input.issueId,
            issueId: input.issueId,
            details: { pullRunId: existing.id, leaseSeconds: input.leaseSeconds },
          }, publications);
          return { run: existing, issue: currentIssue, idempotent: true };
        }
      }

      const now = new Date();
      const run = await tx
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
      const claimed = await issueService(tx).checkout(
        input.issueId,
        input.agentId,
        input.expectedStatuses,
        run.id,
      );
      await logActivity(tx, {
        companyId: input.companyId,
        ...activityActor(input.auditActor, input.agentId),
        runId: run.id,
        action: "pull_run.started",
        entityType: "issue",
        entityId: input.issueId,
        issueId: input.issueId,
        details: { pullRunId: run.id, leaseSeconds: input.leaseSeconds },
      }, publications);
      return { run, issue: claimed, idempotent: false };
    });
  }

  async function heartbeat(
    companyId: string,
    agentId: string,
    runId: string,
    leaseSeconds: number,
    auditActor?: PullRunAuditActor,
    authorization?: PullRunLifecycleAuthorization,
  ) {
    assertLeaseSeconds(leaseSeconds);
    await requirePullAgent(companyId, agentId);
    const run = await loadOwnedRun(companyId, agentId, runId);
    if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) throw conflict("Pull run is terminal");
    const initialNow = new Date();
    if (isExpired(run, initialNow)) {
      await expireExternalPullRun(db, run.id, initialNow);
      throw conflict("Pull run lease expired");
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const updated = await auditedTransaction(async (tx, publications) => {
          const lockedIssues = await lockLifecycleAuthorizationIssues(
            tx,
            companyId,
            run.id,
            Boolean(authorization?.revalidateLockedIssues),
          );
          await tx.execute(
            sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${run.id} for update`,
          );
          const attachedIssueIdsAfterRunLock = await tx
            .select({ id: issues.id })
            .from(issues)
            .where(and(
              eq(issues.companyId, companyId),
              or(eq(issues.checkoutRunId, run.id), eq(issues.executionRunId, run.id)),
            ))
            .orderBy(issues.id);
          if (!sameIssueIds(lockedIssues, attachedIssueIdsAfterRunLock)) {
            throw new PullRunAttachmentSetChangedError();
          }
          if (authorization?.authorizedIssueIds) {
            const authorizedIssueIds = [...new Set(authorization.authorizedIssueIds)].sort();
            const ownedIssueIds = lockedIssues.map((issue) => issue.id);
            if (
              authorizedIssueIds.length !== authorization.authorizedIssueIds.length
              || authorizedIssueIds.length !== ownedIssueIds.length
              || authorizedIssueIds.some((issueId, index) => issueId !== ownedIssueIds[index])
            ) {
              throw conflict("Pull run issue locks changed; retry");
            }
          }
          await authorization?.revalidateLockedIssues?.(tx, lockedIssues);
          const transactionNow = new Date();
          const next = await tx
            .update(heartbeatRuns)
            .set({
              leaseExpiresAt: leaseExpiry(transactionNow, leaseSeconds),
              lastUsefulActionAt: transactionNow,
              updatedAt: transactionNow,
            })
            .where(and(
              eq(heartbeatRuns.id, run.id),
              eq(heartbeatRuns.agentId, agentId),
              gt(heartbeatRuns.leaseExpiresAt, transactionNow),
              inArray(heartbeatRuns.status, LIVE_PULL_RUN_STATUSES),
            ))
            .returning()
            .then((rows) => rows[0] ?? null);
          if (!next) return null;
          await logActivity(tx, {
            companyId,
            ...activityActor(auditActor, agentId),
            runId: next.id,
            action: "pull_run.heartbeat",
            entityType: "heartbeat_run",
            entityId: next.id,
            details: { leaseSeconds },
          }, publications);
          return next;
        });
        if (!updated) {
          await expireExternalPullRun(db, run.id, new Date());
          throw conflict("Pull run is no longer live");
        }
        return updated;
      } catch (error) {
        if (error instanceof PullRunAttachmentSetChangedError && attempt < 2) continue;
        if (error instanceof PullRunAttachmentSetChangedError) throw conflict("Pull run issue locks changed; retry");
        throw error;
      }
    }
    throw conflict("Pull run attachment set changed; retry");
  }

  async function finish(
    companyId: string,
    agentId: string,
    runId: string,
    status: "succeeded" | "cancelled",
    auditActor?: PullRunAuditActor,
    authorization?: PullRunLifecycleAuthorization,
  ) {
    await requirePullAgent(companyId, agentId);
    const run = await loadOwnedRun(companyId, agentId, runId);
    if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) throw conflict("Pull run is terminal");
    const initialNow = new Date();
    if (isExpired(run, initialNow)) {
      await expireExternalPullRun(db, run.id, initialNow);
      throw conflict("Pull run lease expired");
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await auditedTransaction(async (tx, publications) => {
      // External pull-run lifecycle operations use issue -> run lock order.
      const ownedIssues = await lockLifecycleAuthorizationIssues(
        tx,
        companyId,
        run.id,
        Boolean(authorization?.revalidateLockedIssues),
      );
      await tx.execute(
        sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${run.id} for update`,
      );
      const attachedIssueIdsAfterRunLock = await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          or(eq(issues.checkoutRunId, run.id), eq(issues.executionRunId, run.id)),
        ))
        .orderBy(issues.id);
      // Do not lock an attachment discovered while holding the run lock: that
      // would invert checkout's issue -> run order. Roll back and retry so the
      // next attempt locks the complete set of issue rows first.
      if (!sameIssueIds(ownedIssues, attachedIssueIdsAfterRunLock)) {
        throw new PullRunAttachmentSetChangedError();
      }
      if (authorization?.authorizedIssueIds) {
        const authorizedIssueIds = [...new Set(authorization.authorizedIssueIds)].sort();
        const ownedIssueIds = ownedIssues.map((issue) => issue.id);
        if (
          authorizedIssueIds.length !== authorization.authorizedIssueIds.length
          || authorizedIssueIds.length !== ownedIssueIds.length
          || authorizedIssueIds.some((issueId, index) => issueId !== ownedIssueIds[index])
        ) {
          throw conflict("Pull run issue locks changed; retry");
        }
      }
      await authorization?.revalidateLockedIssues?.(tx, ownedIssues);
      const transactionNow = new Date();
      const updated = await tx
        .update(heartbeatRuns)
        .set({ status, finishedAt: transactionNow, leaseExpiresAt: null, updatedAt: transactionNow })
        .where(and(
          eq(heartbeatRuns.id, run.id),
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          gt(heartbeatRuns.leaseExpiresAt, transactionNow),
          inArray(heartbeatRuns.status, LIVE_PULL_RUN_STATUSES),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw conflict("Pull run is no longer live");
      const isRequeuedIssue = (issue: typeof ownedIssues[number]) => status === "cancelled" &&
        issue.status === "in_progress"
        && issue.assigneeAgentId === agentId
        && (issue.checkoutRunId == null || issue.checkoutRunId === run.id)
        && (issue.executionRunId == null || issue.executionRunId === run.id);
      const requeued = ownedIssues.some(isRequeuedIssue);
      if (ownedIssues.length > 0) {
        await tx
          .update(issues)
          .set({
            ...(status === "cancelled"
              ? {
                status: sql`case when ${issues.status} = 'in_progress' and ${issues.assigneeAgentId} = ${agentId} and (${issues.checkoutRunId} is null or ${issues.checkoutRunId} = ${run.id}) and (${issues.executionRunId} is null or ${issues.executionRunId} = ${run.id}) then 'todo' else ${issues.status} end`,
                assigneeAgentId: sql`case when ${issues.status} = 'in_progress' and ${issues.assigneeAgentId} = ${agentId} and (${issues.checkoutRunId} is null or ${issues.checkoutRunId} = ${run.id}) and (${issues.executionRunId} is null or ${issues.executionRunId} = ${run.id}) then null else ${issues.assigneeAgentId} end`,
              }
              : {}),
            checkoutRunId: sql`case when ${issues.checkoutRunId} = ${run.id} then null else ${issues.checkoutRunId} end`,
            executionRunId: sql`case when ${issues.executionRunId} = ${run.id} then null else ${issues.executionRunId} end`,
            executionAgentNameKey: sql`case when ${issues.executionRunId} = ${run.id} then null else ${issues.executionAgentNameKey} end`,
            executionLockedAt: sql`case when ${issues.executionRunId} = ${run.id} then null else ${issues.executionLockedAt} end`,
            updatedAt: transactionNow,
          })
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.id, ownedIssues.map((issue) => issue.id)),
          ));
      }
      await logActivity(tx, {
        companyId,
        ...activityActor(auditActor, agentId),
        runId: updated.id,
        action: status === "succeeded" ? "pull_run.completed" : "pull_run.cancelled",
        entityType: "heartbeat_run",
        entityId: updated.id,
        issueId: null,
        details: {
          issueIds: ownedIssues.map((issue) => issue.id),
          requeued,
        },
      }, publications);
      for (const issue of ownedIssues) {
        await logActivity(tx, {
          companyId,
          ...activityActor(auditActor, agentId),
          runId: updated.id,
          action: status === "succeeded" ? "pull_run.issue_completed" : "pull_run.issue_cancelled",
          entityType: "issue",
          entityId: issue.id,
          issueId: issue.id,
          details: { issueId: issue.id, requeued: isRequeuedIssue(issue) },
        }, publications);
      }
      return updated;
        });
      } catch (error) {
        if (error instanceof PullRunAttachmentSetChangedError && attempt < 2) continue;
        if (error instanceof PullRunAttachmentSetChangedError) throw conflict("Pull run issue locks changed; retry");
        throw error;
      }
    }
    throw conflict("Pull run issue locks changed; retry");
  }

  return {
    start,
    heartbeat,
    sweepExpired,
    complete: (
      companyId: string,
      agentId: string,
      runId: string,
      auditActor?: PullRunAuditActor,
      authorization?: PullRunLifecycleAuthorization,
    ) => finish(companyId, agentId, runId, "succeeded", auditActor, authorization),
    cancel: (
      companyId: string,
      agentId: string,
      runId: string,
      auditActor?: PullRunAuditActor,
      authorization?: PullRunLifecycleAuthorization,
    ) => finish(companyId, agentId, runId, "cancelled", auditActor, authorization),
  };
}
