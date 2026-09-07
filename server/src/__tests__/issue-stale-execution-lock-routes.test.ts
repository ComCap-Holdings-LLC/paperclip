import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";

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
    await db.delete(heartbeatRuns);
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
  });
});
