import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { agentService } from "../services/agents.js";
import { persistActivity } from "../services/activity-log.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { logger } from "../middleware/logger.js";
import { assertAssignableAgent as assertAgentAssignable } from "../services/agent-assignability.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale execution lock route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("stale issue execution lock routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-execution-lock-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAgentAndRuns() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const currentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: currentRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, agentId, failedRunId, currentRunId };
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_key",
      keyId: randomUUID(),
    };
  }

  function agentJwtActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  it("allows an assigned agent PATCH to recover a terminal stale executionRunId", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered execution lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Recovered execution lock");

    const row = await db
      .select({
        title: issues.title,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "Recovered execution lock",
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it.each([
    { status: "done" as const, title: "Done release preserves status", completedAt: new Date() },
    { status: "cancelled" as const, title: "Cancelled release preserves status", cancelledAt: new Date() },
    { status: "in_review" as const, title: "In review release preserves status" },
    { status: "blocked" as const, title: "Blocked release preserves status" },
  ])(
    "preserves $status when releasing a non-in_progress issue",
    async ({ status, title, completedAt, cancelledAt }) => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title,
        status,
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: currentRunId,
        executionRunId: currentRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
        ...(completedAt ? { completedAt } : {}),
        ...(cancelledAt ? { cancelledAt } : {}),
      });

      const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .post(`/api/issues/${issueId}/release`)
        .send();

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.status).toBe(status);

      const row = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row).toEqual({
        status,
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionLockedAt: null,
      });
    },
  );

  it("allows the rightful assignee to release after the owning run failed", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Failed run release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("lets the current assignee recover a timed_out stale checkout owner during PATCH", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const timedOutRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId,
      status: "timed_out",
      invocationSource: "manual",
      finishedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: timedOutRunId,
      executionRunId: timedOutRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered stale checkout lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("still returns 409 when a different live checkout owner is active", async () => {
    const { companyId, agentId, failedRunId } = await seedCompanyAgentAndRuns();
    const liveOwnerRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveOwnerRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: liveOwnerRunId,
      executionRunId: liveOwnerRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, failedRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should fail" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe("Issue run ownership conflict");
  });

  it("preserves live checkout ownership on checkout conflicts without retry side effects", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const contenderRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: contenderRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout race",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, contenderRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Issue checkout conflict",
    });

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    const checkoutActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.checked_out"));
    expect(checkoutActivity).toHaveLength(0);
  });

  it("restricts admin force-release to board users with company access and writes an audit event", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Admin force release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(403);
    await request(createApp({
      type: "board",
      userId: "outside-user",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    }))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(404);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/force-release?clearAssignee=true`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue).toMatchObject({
      id: issueId,
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(res.body.previous).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
    });

    const audit = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.admin_force_release"))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      action: "issue.admin_force_release",
      actorType: "user",
      actorId: "board-user",
      details: {
        issueId,
        actorUserId: "board-user",
        prevCheckoutRunId: currentRunId,
        prevExecutionRunId: failedRunId,
        clearAssignee: true,
      },
    });
  });

  it("self-heals a stale checkoutRunId via clearCheckoutRunIfTerminal on checkout (Fix B path)", async () => {
    // Reproduces the recurrence pattern: prior owning run died, executionRunId
    // was cleared by releaseIssueExecutionAndPromote, but checkoutRunId stayed
    // pinned to the dead run. The new agent's POST /checkout would 409 forever
    // without the clearCheckoutRunIfTerminal helper in svc.checkout.
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock after reassignment",
      // Status off in_progress + checkoutRunId still set — adoptStaleCheckoutRun
      // cannot recover from this; only clearCheckoutRunIfTerminal can.
      status: "todo",
      priority: "high",
      assigneeAgentId: otherAgentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp(agentActor(companyId, otherAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: otherAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: otherAgentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("rejects agent JWTs from external executor endpoints", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor auth boundary",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const response = await request(createApp(agentJwtActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send({ runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"] });

    expect(response.status).toBe(403);
    expect(response.body.error).toMatch(/agent api key/i);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.externalExecutorIssueId, issueId))).toHaveLength(0);
  });

  it("rejects board sessions and foreign-company agent keys from external executor checkout", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const foreign = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor credential boundary",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const body = { runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"] };

    const board = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send(body);
    const foreignAgent = await request(createApp(agentActor(foreign.companyId, foreign.agentId, foreign.currentRunId)))
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send({ ...body, runKey: randomUUID() });

    expect(board.status).toBe(403);
    expect(board.body.error).toMatch(/agent api key/i);
    expect(foreignAgent.status).toBe(404);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.externalExecutorIssueId, issueId))).toHaveLength(0);
    expect(currentRunId).toBeTruthy();
  });

  it("admits exactly one concurrent external executor checkout and makes a duplicate key idempotent", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor race",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const firstKey = randomUUID();
    const secondKey = randomUUID();
    const [first, second] = await Promise.all([
      request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
        runKey: firstKey,
        expectedExecutionVersion: 0,
        expectedStatuses: ["todo"],
      }),
      request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
        runKey: secondKey,
        expectedExecutionVersion: 0,
        expectedStatuses: ["todo"],
      }),
    ]);
    const winner = [first, second].find((response) => response.status === 201);
    const loser = [first, second].find((response) => response.status === 409);
    expect(winner?.body).toMatchObject({ idempotent: false, issue: { id: issueId, executionVersion: 1 } });
    expect(loser?.body.error).toMatch(/checkout|binding|version/i);

    const retry = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey: winner!.body.run.runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({
      idempotent: true,
      run: { id: winner!.body.run.id, executionVersion: 1 },
    });

    const checkoutAudits = await db
      .select({
        action: activityLog.action,
        entityId: activityLog.entityId,
        runId: activityLog.runId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.external_executor_checked_out"));
    expect(checkoutAudits).toHaveLength(1);
    expect(checkoutAudits[0]).toMatchObject({
      action: "issue.external_executor_checked_out",
      entityId: issueId,
      runId: winner!.body.run.id,
      details: {
        externalExecutorRunId: winner!.body.run.id,
        runKey: winner!.body.run.runKey,
        expectedExecutionVersion: 0,
        boundExecutionVersion: 1,
        holdId: null,
      },
    });

    const forgedIssueId = randomUUID();
    await db.insert(issues).values({
      id: forgedIssueId,
      companyId,
      title: "Forged executor run key target",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const forged = await request(app).post(`/api/issues/${forgedIssueId}/external-executor/checkout`).send({
      runKey: winner!.body.run.runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(forged.status).toBe(409);
    const forgedIssue = await db
      .select({ executionVersion: issues.executionVersion, externalExecutorRunId: issues.externalExecutorRunId })
      .from(issues)
      .where(eq(issues.id, forgedIssueId))
      .then((rows) => rows[0]);
    expect(forgedIssue).toEqual({ executionVersion: 0, externalExecutorRunId: null });

    const issue = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        externalExecutorRunId: issues.externalExecutorRunId,
        executionVersion: issues.executionVersion,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: winner!.body.run.id,
      executionRunId: winner!.body.run.id,
      externalExecutorRunId: winner!.body.run.id,
      executionVersion: 1,
    });
    const executorRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.externalExecutorIssueId, issueId));
    expect(executorRuns).toHaveLength(1);
  });

  it("keeps a duplicate external checkout idempotent after its project is paused", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const projectId = randomUUID();
    const issueId = randomUUID();
    const runKey = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Executor project" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "External executor retry after pause",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    await db
      .update(projects)
      .set({ pausedAt: new Date(), pauseReason: "manual safety pause" })
      .where(eq(projects.id, projectId));
    const retry = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({ idempotent: true, run: { id: checkout.body.run.id } });
  });

  it("keeps a duplicate external checkout idempotent after its agent is paused", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const runKey = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor retry after agent pause",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    await db.update(agents).set({ status: "paused", pausedAt: new Date() }).where(eq(agents.id, agentId));
    const retry = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body).toMatchObject({ idempotent: true, run: { id: checkout.body.run.id } });
  });

  it("rejects a new external checkout for a paused agent without mutation", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.update(agents).set({ status: "paused", pausedAt: new Date() }).where(eq(agents.id, agentId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Paused external executor cannot start",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const response = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send({ runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"] });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/paused agent/i);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.externalExecutorIssueId, issueId))).toEqual([]);
    expect(await db.select({ status: issues.status, executionVersion: issues.executionVersion, externalExecutorRunId: issues.externalExecutorRunId })
      .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
      .toEqual({ status: "todo", executionVersion: 0, externalExecutorRunId: null });
  });

  it("holds agent eligibility stable until external checkout commits", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor agent status race",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    let eligibilityRead!: () => void;
    const eligibilityWasRead = new Promise<void>((resolve) => { eligibilityRead = resolve; });
    let allowCheckout!: () => void;
    const checkoutMayContinue = new Promise<void>((resolve) => { allowCheckout = resolve; });
    const service = issueService(db, {
      assertAssignableAgent: async (...args) => {
        await assertAgentAssignable(...args);
        eligibilityRead();
        await checkoutMayContinue;
      },
    });

    const checkoutPromise = service.externalExecutorCheckout({
      issueId,
      companyId,
      agentId,
      expectedProjectId: null,
      expectedParentId: null,
      expectedAssigneeAgentId: agentId,
      runKey: randomUUID(),
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
      audit: { actorType: "agent", actorId: agentId, agentId, runId: null, agentApiKeyId: null },
    });
    await eligibilityWasRead;

    let pauseCommitted = false;
    const pausePromise = db
      .update(agents)
      .set({ status: "paused", pausedAt: new Date() })
      .where(eq(agents.id, agentId))
      .then(() => { pauseCommitted = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const pauseCommittedBeforeCheckout = pauseCommitted;
    allowCheckout();

    const checkout = await checkoutPromise;
    await pausePromise;
    expect(pauseCommittedBeforeCheckout).toBe(false);
    expect(checkout).toMatchObject({ idempotent: false, issue: { id: issueId, executionVersion: 1 } });
  });

  it("rejects a new external checkout while its project is paused", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const projectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paused executor project",
      pausedAt: new Date(),
      pauseReason: "manual safety pause",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "External executor cannot start",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const response = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send({ runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/project is paused/i);
  });

  it("rejects moving an ancestor scope while a descendant has an active external executor", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const sourceProjectId = randomUUID();
    const targetProjectId = randomUUID();
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    await db.insert(projects).values([
      { id: sourceProjectId, companyId, name: "Source executor project" },
      { id: targetProjectId, companyId, name: "Target executor project" },
    ]);
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        projectId: sourceProjectId,
        title: "External executor parent",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: childIssueId,
        companyId,
        projectId: sourceProjectId,
        parentId: parentIssueId,
        title: "External executor child",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);

    const checkout = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${childIssueId}/external-executor/checkout`)
      .send({ runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    await expect(issueService(db).update(parentIssueId, { projectId: targetProjectId }))
      .rejects.toThrow(/active external executor/i);

    const parent = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(eq(issues.id, parentIssueId))
      .then((rows) => rows[0]);
    const child = await db
      .select({ externalExecutorRunId: issues.externalExecutorRunId })
      .from(issues)
      .where(eq(issues.id, childIssueId))
      .then((rows) => rows[0]);
    expect(parent?.projectId).toBe(sourceProjectId);
    expect(child?.externalExecutorRunId).toBe(checkout.body.run.id);
  });

  it("rejects an external checkout while an unresolved blocker exists without creating a run", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Unresolved prerequisite",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked external executor issue",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const response = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${blockedIssueId}/external-executor/checkout`)
      .send({ runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"] });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: "Issue is blocked by unresolved blockers",
      details: { unresolvedBlockerIssueIds: [blockerIssueId] },
    });
    const issue = await db
      .select({ executionVersion: issues.executionVersion, externalExecutorRunId: issues.externalExecutorRunId })
      .from(issues)
      .where(eq(issues.id, blockedIssueId))
      .then((rows) => rows[0]);
    expect(issue).toEqual({ executionVersion: 0, externalExecutorRunId: null });
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.externalExecutorIssueId, blockedIssueId));
    expect(runs).toHaveLength(0);
  });

  it("rejects stale, foreign, and generic terminal mutations while accepting only the bound executor CAS", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const foreignAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: foreignAgentId,
      companyId,
      name: "Foreign executor",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External terminal CAS",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const runKey = randomUUID();
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    const genericPatch = await request(app).patch(`/api/issues/${issueId}`).send({ status: "done" });
    expect(genericPatch.status).toBe(409);
    const hiddenPatch = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ hiddenAt: new Date().toISOString() });
    expect(hiddenPatch.status).toBe(409);
    const genericRelease = await request(app).post(`/api/issues/${issueId}/release`).send();
    expect(genericRelease.status).toBe(409);
    const forceRelease = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .send({ clearAssignee: true });
    expect(forceRelease.status).toBe(409);
    const deleteAttempt = await request(createApp(boardActor(companyId))).delete(`/api/issues/${issueId}`);
    expect(deleteAttempt.status).toBe(409);
    const unregistered = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
      runKey: randomUUID(),
      expectedExecutionVersion: 1,
      issueStatus: "done",
      outcome: "succeeded",
    });
    expect(unregistered.status).toBe(409);
    const stale = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
      runKey,
      expectedExecutionVersion: 0,
      issueStatus: "done",
      outcome: "succeeded",
    });
    expect(stale.status).toBe(409);
    const foreign = await request(createApp(agentActor(companyId, foreignAgentId, randomUUID())))
      .post(`/api/issues/${issueId}/external-executor/terminal`)
      .send({
        runKey,
        expectedExecutionVersion: 1,
        issueStatus: "done",
        outcome: "succeeded",
      });
    expect(foreign.status).toBe(403);

    const [firstTerminal, secondTerminal] = await Promise.all([
      request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
        runKey,
        expectedExecutionVersion: 1,
        issueStatus: "done",
        outcome: "succeeded",
      }),
      request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
        runKey,
        expectedExecutionVersion: 1,
        issueStatus: "done",
        outcome: "succeeded",
      }),
    ]);
    const terminal = [firstTerminal, secondTerminal].find((response) => response.status === 200)!;
    const terminalLoser = [firstTerminal, secondTerminal].find((response) => response.status === 409)!;
    expect(terminal.status, JSON.stringify(terminal.body)).toBe(200);
    expect(terminalLoser.status, JSON.stringify(terminalLoser.body)).toBe(409);
    expect(terminal.body).toMatchObject({ issue: { status: "done", executionVersion: 2 } });

    const late = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
      runKey,
      expectedExecutionVersion: 1,
      issueStatus: "done",
      outcome: "succeeded",
    });
    expect(late.status).toBe(409);
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]);
    expect(run).toEqual({ status: "succeeded" });
  });

  it("rejects a checkout under an active pause hold without creating a run or changing the version", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const holdId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Held external executor issue",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(issueTreeHolds).values({
      id: holdId,
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "manual safety hold",
      createdByActorType: "user",
    });

    const response = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send({ runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { holdId } });
    const issue = await db
      .select({ executionVersion: issues.executionVersion, externalExecutorRunId: issues.externalExecutorRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue).toEqual({ executionVersion: 0, externalExecutorRunId: null });
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.externalExecutorIssueId, issueId));
    expect(runs).toHaveLength(0);
  });

  it("serializes an external checkout against pause-hold creation so only one can commit", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor hold race",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const checkout = request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send({ runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    const pauseHold = issueTreeControlService(db).createHold(companyId, issueId, {
      mode: "pause",
      reason: "concurrent safety hold",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    const [checkoutResult, holdResult] = await Promise.allSettled([checkout, pauseHold]);
    const checkoutCommitted = checkoutResult.status === "fulfilled" && checkoutResult.value.status === 201;
    const holdCommitted = holdResult.status === "fulfilled";
    expect(Number(checkoutCommitted) + Number(holdCommitted)).toBe(1);

    const issue = await db
      .select({ executionVersion: issues.executionVersion, externalExecutorRunId: issues.externalExecutorRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    const activeHolds = await db
      .select({ id: issueTreeHolds.id })
      .from(issueTreeHolds)
      .where(eq(issueTreeHolds.rootIssueId, issueId));
    if (checkoutCommitted) {
      expect(issue).toMatchObject({ executionVersion: 1 });
      expect(issue?.externalExecutorRunId).toBeTruthy();
      expect(activeHolds).toHaveLength(0);
    } else {
      expect(issue).toEqual({ executionVersion: 1, externalExecutorRunId: null });
      expect(activeHolds).toHaveLength(1);
    }
  });

  it("serializes checkout against cancel-hold creation and leaves no stranded binding", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor cancel hold race",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const checkout = request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send({ runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    const cancelHold = issueTreeControlService(db).createHold(companyId, issueId, {
      mode: "cancel",
      reason: "concurrent cancellation",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    const [checkoutResult, holdResult] = await Promise.allSettled([checkout, cancelHold]);
    const checkoutCommitted = checkoutResult.status === "fulfilled" && checkoutResult.value.status === 201;
    const holdCommitted = holdResult.status === "fulfilled";
    expect(Number(checkoutCommitted) + Number(holdCommitted)).toBe(1);
    const issue = await db
      .select({ executionVersion: issues.executionVersion, externalExecutorRunId: issues.externalExecutorRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    if (checkoutCommitted) {
      expect(issue?.externalExecutorRunId).toBeTruthy();
      expect(issue?.executionVersion).toBe(1);
    } else {
      expect(issue).toEqual({ executionVersion: 1, externalExecutorRunId: null });
    }
  });

  it("permits explicit board crash recovery and rejects agent recovery", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const runKey = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor recovery",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    await request(app).post(`/api/issues/${issueId}/external-executor/recover`).send({
      runKey,
      expectedExecutionVersion: 1,
      reason: "worker process lost",
    }).expect(403);
    const recovered = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/external-executor/recover`)
      .send({ runKey, expectedExecutionVersion: 1, reason: "worker process lost" });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body).toMatchObject({ issue: { status: "todo", executionVersion: 2 } });
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]);
    expect(run).toEqual({ status: "timed_out" });
    const recoveryAudits = await db
      .select({ action: activityLog.action, actorType: activityLog.actorType, actorId: activityLog.actorId, agentId: activityLog.agentId, runId: activityLog.runId, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.external_executor_recovered"));
    expect(recoveryAudits).toEqual([expect.objectContaining({
      action: "issue.external_executor_recovered", actorType: "user", actorId: "board-user", agentId: null, runId: checkout.body.run.id,
      details: expect.objectContaining({ externalExecutorRunId: checkout.body.run.id, runKey, expectedExecutionVersion: 1, executionVersion: 2 }),
    })]);
  });

  it("leaves an external executor run running when the orphan reaper runs", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const runKey = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor process-loss fence",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    await heartbeatService(db).reapOrphanedRuns();
    const afterReap = await db
      .select({
        externalExecutorRunId: issues.externalExecutorRunId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionVersion: issues.executionVersion,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(afterReap).toEqual({
      externalExecutorRunId: checkout.body.run.id,
      checkoutRunId: checkout.body.run.id,
      executionRunId: checkout.body.run.id,
      executionVersion: 1,
    });
    const runningAfterReap = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]);
    expect(runningAfterReap).toEqual({ status: "running" });

    const terminal = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
      runKey,
      expectedExecutionVersion: 1,
      issueStatus: "done",
      outcome: "succeeded",
    });
    expect(terminal.status, JSON.stringify(terminal.body)).toBe(200);
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]);
    expect(run).toEqual({ status: "succeeded" });
    const terminalAudits = await db
      .select({ action: activityLog.action, actorType: activityLog.actorType, actorId: activityLog.actorId, agentId: activityLog.agentId, runId: activityLog.runId, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.external_executor_terminalized"));
    expect(terminalAudits).toEqual([expect.objectContaining({
      action: "issue.external_executor_terminalized", actorType: "agent", actorId: agentId, agentId, runId: checkout.body.run.id,
      details: expect.objectContaining({ externalExecutorRunId: checkout.body.run.id, runKey, expectedExecutionVersion: 1, executionVersion: 2, issueStatus: "done", outcome: "succeeded" }),
    })]);
  });

  it("leaves an external executor run running during graceful shutdown drain", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const runKey = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor shutdown fence",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    const drained = await heartbeatService(db).drainRunningRunsForShutdown(
      "SIGTERM",
      new Date(),
      [checkout.body.run.id],
    );
    expect(drained.interruptedRunIds).not.toContain(checkout.body.run.id);
    const afterDrain = await db
      .select({
        externalExecutorRunId: issues.externalExecutorRunId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionVersion: issues.executionVersion,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(afterDrain).toEqual({
      externalExecutorRunId: checkout.body.run.id,
      checkoutRunId: checkout.body.run.id,
      executionRunId: checkout.body.run.id,
      executionVersion: 1,
    });
    const runningAfterDrain = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]);
    expect(runningAfterDrain).toEqual({ status: "running" });

    const terminal = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
      runKey,
      expectedExecutionVersion: 1,
      issueStatus: "done",
      outcome: "succeeded",
    });
    expect(terminal.status, JSON.stringify(terminal.body)).toBe(200);
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]);
    expect(run).toEqual({ status: "succeeded" });
  });

  it("replays an intact external checkout after the assignee is paused and its run is cancelled", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const runKey = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Paused external executor replay",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app)
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send({ runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    await agentService(db).pause(agentId);
    await heartbeatService(db).cancelActiveForAgent(agentId);

    expect(await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]))
      .toEqual({ status: "cancelled" });
    expect(await db
      .select({
        externalExecutorRunId: issues.externalExecutorRunId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionVersion: issues.executionVersion,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]))
      .toEqual({
        externalExecutorRunId: checkout.body.run.id,
        checkoutRunId: checkout.body.run.id,
        executionRunId: checkout.body.run.id,
        executionVersion: 1,
      });

    const replay = await request(app)
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send({ runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body).toMatchObject({
      idempotent: true,
      issue: { id: issueId, executionVersion: 1 },
      run: { id: checkout.body.run.id, runKey, executionVersion: 1 },
    });

    const foreignReplay = await request(createApp(agentActor(companyId, randomUUID(), currentRunId)))
      .post(`/api/issues/${issueId}/external-executor/checkout`)
      .send({ runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    expect(foreignReplay.status).toBe(403);
    expect(await db
      .select({ externalExecutorRunId: issues.externalExecutorRunId, executionVersion: issues.executionVersion })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]))
      .toEqual({ externalExecutorRunId: checkout.body.run.id, executionVersion: 1 });
  });

  it("rolls back external checkout when its audit write fails", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "audit rollback", status: "todo", priority: "high" });
    const service = (await import("../services/issues.js")).issueService(db, {
      persistActivity: async () => { throw new Error("audit unavailable"); },
    });
    await expect(service.externalExecutorCheckout({
      issueId, companyId, agentId, expectedProjectId: null, expectedParentId: null, expectedAssigneeAgentId: null,
      runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"],
      audit: { actorType: "agent", actorId: agentId, agentId, runId: null, agentApiKeyId: null },
    })).rejects.toThrow("audit unavailable");
    const issue = await db.select({ executionVersion: issues.executionVersion, externalExecutorRunId: issues.externalExecutorRunId })
      .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue).toEqual({ executionVersion: 0, externalExecutorRunId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
  });

  it("rolls back external terminal when its audit write fails", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID(); const runKey = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "terminal audit rollback", status: "todo", priority: "high", assigneeAgentId: agentId });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({ runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    expect(checkout.status).toBe(201);
    const service = (await import("../services/issues.js")).issueService(db, {
      persistActivity: async () => { throw new Error("audit unavailable"); },
    });
    await expect(service.terminalExternalExecutorRun({
      issueId, companyId, agentId, expectedProjectId: null, expectedParentId: null, expectedAssigneeAgentId: agentId,
      runKey, expectedExecutionVersion: 1, issueStatus: "done", outcome: "succeeded",
      audit: { actorType: "agent", actorId: agentId, agentId, runId: currentRunId, agentApiKeyId: null },
    })).rejects.toThrow("audit unavailable");
    const issue = await db.select({ externalExecutorRunId: issues.externalExecutorRunId, executionVersion: issues.executionVersion }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    const run = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, checkout.body.run.id)).then((rows) => rows[0]);
    expect(issue).toEqual({ externalExecutorRunId: checkout.body.run.id, executionVersion: 1 });
    expect(run).toEqual({ status: "running" });
  });

  it("rolls back external recovery when its audit write fails", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID(); const runKey = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "recovery audit rollback", status: "todo", priority: "high", assigneeAgentId: agentId });
    const checkout = await request(createApp(agentActor(companyId, agentId, currentRunId))).post(`/api/issues/${issueId}/external-executor/checkout`).send({ runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    expect(checkout.status).toBe(201);
    const service = (await import("../services/issues.js")).issueService(db, {
      persistActivity: async () => { throw new Error("audit unavailable"); },
    });
    await expect(service.recoverExternalExecutorRun({
      issueId, companyId, runKey, expectedExecutionVersion: 1, reason: "audit rollback",
      audit: { actorType: "user", actorId: randomUUID(), agentId: null, runId: null, agentApiKeyId: null },
    })).rejects.toThrow("audit unavailable");
    const issue = await db.select({ status: issues.status, externalExecutorRunId: issues.externalExecutorRunId, executionVersion: issues.executionVersion }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue).toEqual({ status: "in_progress", externalExecutorRunId: checkout.body.run.id, executionVersion: 1 });
  });

  it("publishes a committed checkout audit once and never publishes a rolled-back audit", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "publish ordering", status: "todo", priority: "high" });
    const liveEvents: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => liveEvents.push(event));
    try {
      const failing = (await import("../services/issues.js")).issueService(db, {
        persistActivity: async () => { throw new Error("audit unavailable"); },
      });
      await expect(failing.externalExecutorCheckout({
        issueId, companyId, agentId, expectedProjectId: null, expectedParentId: null, expectedAssigneeAgentId: null,
        runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"],
        audit: { actorType: "agent", actorId: agentId, agentId, runId: null, agentApiKeyId: null },
      })).rejects.toThrow("audit unavailable");
      expect(liveEvents).toEqual([]);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).toEqual([]);

      const runKey = randomUUID();
      const service = (await import("../services/issues.js")).issueService(db);
      const succeeded = await service.externalExecutorCheckout({
        issueId, companyId, agentId, expectedProjectId: null, expectedParentId: null, expectedAssigneeAgentId: null,
        runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"],
        audit: { actorType: "agent", actorId: agentId, agentId, runId: null, agentApiKeyId: null },
      });
      expect(succeeded.idempotent).toBe(false);
      const retried = await service.externalExecutorCheckout({
        issueId, companyId, agentId, expectedProjectId: null, expectedParentId: null, expectedAssigneeAgentId: agentId,
        runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"],
        audit: { actorType: "agent", actorId: agentId, agentId, runId: null, agentApiKeyId: null },
      });
      expect(retried).toMatchObject({ idempotent: true, run: { id: succeeded.run.id } });
      expect(liveEvents).toHaveLength(1);
      expect(liveEvents[0]).toMatchObject({ type: "activity.logged", payload: {
        action: "issue.external_executor_checked_out", actorType: "agent", actorId: agentId, agentId,
      } });
      expect(await db.select({ executionVersion: issues.executionVersion, externalExecutorRunId: issues.externalExecutorRunId })
        .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
        .toEqual({ executionVersion: 1, externalExecutorRunId: succeeded.run.id });
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("rolls back a checkout when work fails after its audit row persists", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const liveEvents: unknown[] = [];
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as any);
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => liveEvents.push(event));
    await db.insert(issues).values({ id: issueId, companyId, title: "post-audit rollback", status: "todo", priority: "high" });
    try {
      const service = (await import("../services/issues.js")).issueService(db, {
        persistActivity: async (tx, input) => {
          await persistActivity(tx, input);
          throw new Error("later transactional work failed");
        },
      });
      await expect(service.externalExecutorCheckout({
        issueId, companyId, agentId, expectedProjectId: null, expectedParentId: null, expectedAssigneeAgentId: null,
        runKey: randomUUID(), expectedExecutionVersion: 0, expectedStatuses: ["todo"],
        audit: { actorType: "agent", actorId: agentId, agentId, runId: null, agentApiKeyId: null },
      })).rejects.toThrow("later transactional work failed");
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).toEqual([]);
      expect(liveEvents).toEqual([]);
      const issue = await db.select({ executionVersion: issues.executionVersion, externalExecutorRunId: issues.externalExecutorRunId })
        .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
      expect(issue).toEqual({ executionVersion: 0, externalExecutorRunId: null });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      warn.mockRestore();
    }
  });

  it("keeps a committed checkout authoritative when its live publication listener throws", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID(); const runKey = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "checkout publication failure", status: "todo", priority: "high" });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as any);
    let listenerAttempts = 0;
    const unsubscribe = subscribeCompanyLiveEvents(companyId, () => { listenerAttempts += 1; throw new Error("live listener failed"); });
    try {
      const app = createApp(agentActor(companyId, agentId, currentRunId));
      const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({ runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);
      expect(checkout.body).toMatchObject({ idempotent: false, issue: { executionVersion: 1 } });
      const retry = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({ runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(retry.body).toMatchObject({ idempotent: true });
      expect(listenerAttempts).toBe(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))).toEqual([expect.objectContaining({
        action: "issue.external_executor_checked_out", entityId: issueId, runId: checkout.body.run.id,
        actorType: "agent", actorId: agentId, agentId,
      })]);
      expect(await db.select({ externalExecutorRunId: issues.externalExecutorRunId, executionVersion: issues.executionVersion })
        .from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
        .toEqual({ externalExecutorRunId: checkout.body.run.id, executionVersion: 1 });
      expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, checkout.body.run.id)).then((rows) => rows[0]))
        .toEqual({ status: "running" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ companyId, action: "issue.external_executor_checked_out", entityId: issueId, runId: checkout.body.run.id, lifecycleCommitted: true }), expect.stringMatching(/publish/i));
    } finally {
      unsubscribe();
      warn.mockRestore();
    }
  });

  it("keeps a committed terminal result authoritative when its live publication listener throws", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID(); const runKey = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "terminal publication failure", status: "todo", priority: "high", assigneeAgentId: agentId });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({ runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    expect(checkout.status).toBe(201);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as any);
    let listenerAttempts = 0;
    const unsubscribe = subscribeCompanyLiveEvents(companyId, () => { listenerAttempts += 1; throw new Error("live listener failed"); });
    try {
      const terminal = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({ runKey, expectedExecutionVersion: 1, issueStatus: "done", outcome: "succeeded" });
      expect(terminal.status, JSON.stringify(terminal.body)).toBe(200);
      expect(listenerAttempts).toBe(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.external_executor_terminalized"))).toEqual([expect.objectContaining({ action: "issue.external_executor_terminalized", entityId: issueId, runId: checkout.body.run.id, actorType: "agent", actorId: agentId, agentId })]);
      expect((await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({ runKey, expectedExecutionVersion: 1, issueStatus: "done", outcome: "succeeded" })).status).toBe(409);
      expect(await db.select({ status: issues.status, externalExecutorRunId: issues.externalExecutorRunId, executionVersion: issues.executionVersion }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
        .toEqual({ status: "done", externalExecutorRunId: null, executionVersion: 2 });
      expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, checkout.body.run.id)).then((rows) => rows[0])).toEqual({ status: "succeeded" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ companyId, action: "issue.external_executor_terminalized", entityId: issueId, runId: checkout.body.run.id, lifecycleCommitted: true }), expect.stringMatching(/publish/i));
    } finally {
      unsubscribe();
      warn.mockRestore();
    }
  });

  it("keeps a committed recovery result authoritative when its live publication listener throws", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID(); const runKey = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "recovery publication failure", status: "todo", priority: "high", assigneeAgentId: agentId });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({ runKey, expectedExecutionVersion: 0, expectedStatuses: ["todo"] });
    expect(checkout.status).toBe(201);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as any);
    let listenerAttempts = 0;
    const unsubscribe = subscribeCompanyLiveEvents(companyId, () => { listenerAttempts += 1; throw new Error("live listener failed"); });
    try {
      const recoveryApp = createApp(boardActor(companyId));
      const recovered = await request(recoveryApp).post(`/api/issues/${issueId}/external-executor/recover`).send({ runKey, expectedExecutionVersion: 1, reason: "publication failure" });
      expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
      expect(listenerAttempts).toBe(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.external_executor_recovered"))).toEqual([expect.objectContaining({ action: "issue.external_executor_recovered", entityId: issueId, runId: checkout.body.run.id, actorType: "user", actorId: "board-user", agentId: null })]);
      expect((await request(recoveryApp).post(`/api/issues/${issueId}/external-executor/recover`).send({ runKey, expectedExecutionVersion: 1, reason: "publication failure" })).status).toBe(409);
      expect(await db.select({ status: issues.status, externalExecutorRunId: issues.externalExecutorRunId, executionVersion: issues.executionVersion }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]))
        .toEqual({ status: "todo", externalExecutorRunId: null, executionVersion: 2 });
      expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, checkout.body.run.id)).then((rows) => rows[0])).toEqual({ status: "timed_out" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ companyId, action: "issue.external_executor_recovered", entityId: issueId, runId: checkout.body.run.id, lifecycleCommitted: true }), expect.stringMatching(/publish/i));
    } finally {
      unsubscribe();
      warn.mockRestore();
    }
  });

  it("keeps a healthy external binding running until board recovery", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const runKey = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor process-loss fence",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    // External executors have no local process handle. The local orphan reaper
    // must leave the registered run running so its owner can still terminalize
    // it, while the binding remains fenced from ordinary checkout.
    await db
      .update(heartbeatRuns)
      .set({ updatedAt: new Date("2000-01-01T00:00:00.000Z") })
      .where(eq(heartbeatRuns.id, checkout.body.run.id));
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 1 });
    const afterReap = await db
      .select({
        externalExecutorRunId: issues.externalExecutorRunId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionVersion: issues.executionVersion,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(afterReap).toEqual({
      externalExecutorRunId: checkout.body.run.id,
      checkoutRunId: checkout.body.run.id,
      executionRunId: checkout.body.run.id,
      executionVersion: 1,
    });
    const stillRunning = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]);
    expect(stillRunning).toEqual({ status: "running" });

    const ordinaryCheckout = await request(app).post(`/api/issues/${issueId}/checkout`).send({
      agentId,
      expectedStatuses: ["todo", "in_progress"],
    });
    expect(ordinaryCheckout.status).toBe(409);

    const recovered = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/external-executor/recover`)
      .send({ runKey, expectedExecutionVersion: 1, reason: "orphaned executor process after server restart" });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]);
    expect(run).toEqual({ status: "timed_out" });
  });

  it("lets the fenced executor report after lease teardown terminalized its run", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const runKey = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Late external executor result after lease teardown",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    const externalRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]!);
    await heartbeatService(db).terminalizeRunOnLeaseRelease(externalRun);

    const terminal = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
      runKey,
      expectedExecutionVersion: 1,
      issueStatus: "done",
      outcome: "succeeded",
    });
    expect(terminal.status, JSON.stringify(terminal.body)).toBe(200);
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]);
    expect(run).toEqual({ status: "succeeded" });
  });

  it("lets board recovery repair corrupt secondary locks for the exact external run", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const runKey = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External executor secondary-lock repair",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    // Simulate a partial persistence failure after the authoritative external
    // binding committed. Generic lifecycle routes remain fenced by that
    // binding, so only the board's run-key/version-bound recovery can repair it.
    await db
      .update(issues)
      .set({ checkoutRunId: null, executionRunId: null })
      .where(eq(issues.id, issueId));
    const ordinaryCheckout = await request(app).post(`/api/issues/${issueId}/checkout`).send({
      agentId,
      expectedStatuses: ["todo", "in_progress"],
    });
    expect(ordinaryCheckout.status).toBe(409);

    const recovered = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/external-executor/recover`)
      .send({ runKey, expectedExecutionVersion: 1, reason: "repair corrupt secondary locks" });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body).toMatchObject({
      issue: {
        status: "todo",
        externalExecutorRunId: null,
        checkoutRunId: null,
        executionRunId: null,
        executionVersion: 2,
      },
      repairedSecondaryLocks: true,
    });
    const audit = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.external_executor_recovered"))
      .then((rows) => rows[0]);
    expect(audit?.details).toMatchObject({
      externalExecutorRunId: checkout.body.run.id,
      runKey,
      expectedExecutionVersion: 1,
      repairedSecondaryLocks: true,
    });
  });

  it("does not let an external executor bypass a pending review on terminal success", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External review governance",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: { type: "user", userId: "reviewer" },
        returnAssignee: { type: "agent", agentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const runKey = randomUUID();
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["in_progress"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    const terminal = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
      runKey,
      expectedExecutionVersion: 1,
      issueStatus: "done",
      outcome: "succeeded",
    });
    expect(terminal.status, JSON.stringify(terminal.body)).toBe(422);
    expect(terminal.body.error).toMatch(/review|approval/i);
  });

  it("starts the configured review policy instead of terminalizing directly", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "ReviewAgent",
      role: "reviewer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External terminal execution policy",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId }],
        }],
      },
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const runKey = randomUUID();
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["in_progress"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    const terminal = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
      runKey,
      expectedExecutionVersion: 1,
      issueStatus: "done",
      outcome: "succeeded",
    });
    expect(terminal.status, JSON.stringify(terminal.body)).toBe(200);
    expect(terminal.body.issue).toMatchObject({
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageType: "review",
      },
    });
  });

  it("records a successful unconfigured review handoff as succeeded", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const runKey = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Successful review handoff",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["in_progress"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    const terminal = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
      runKey,
      expectedExecutionVersion: 1,
      issueStatus: "in_review",
      outcome: "succeeded",
    });
    expect(terminal.status, JSON.stringify(terminal.body)).toBe(200);
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, checkout.body.run.id))
      .then((rows) => rows[0]);
    expect(run).toEqual({ status: "succeeded" });
  });

  it("does not let an external executor enter blocked without an unblock path", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External blocked governance",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    });
    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const runKey = randomUUID();
    const checkout = await request(app).post(`/api/issues/${issueId}/external-executor/checkout`).send({
      runKey,
      expectedExecutionVersion: 0,
      expectedStatuses: ["todo"],
    });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(201);

    const terminal = await request(app).post(`/api/issues/${issueId}/external-executor/terminal`).send({
      runKey,
      expectedExecutionVersion: 1,
      issueStatus: "blocked",
      outcome: "failed",
    });
    expect(terminal.status, JSON.stringify(terminal.body)).toBe(422);
    expect(terminal.body.error).toMatch(/blocked|unblock/i);
  });
});
