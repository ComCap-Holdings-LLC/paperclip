import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { pullRunService } from "../services/pull-runs.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("external pull-run leases", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let activityFailureFunctionName: string | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pull-runs-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    if (activityFailureFunctionName) {
      await db.execute(sql.raw(`drop trigger if exists ${activityFailureFunctionName} on activity_log`));
      await db.execute(sql.raw(`drop function if exists ${activityFailureFunctionName}()`));
      activityFailureFunctionName = null;
    }
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const dispatchAgentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Pull Co", issuePrefix: "PLR", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other Co", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Wren", role: "engineer", status: "idle", executionModel: "pull" },
      { id: otherAgentId, companyId, name: "Other", role: "engineer", status: "idle", executionModel: "pull" },
      { id: dispatchAgentId, companyId, name: "Dispatch", role: "engineer", status: "idle" },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, title: "Claim me", status: "todo" });
    return { companyId, otherCompanyId, agentId, otherAgentId, dispatchAgentId, issueId };
  }

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  it("requires an agent API key and refuses a client-supplied run id", async () => {
    const f = await fixture();
    const board = await request(createApp({
      type: "board",
      source: "local_implicit",
      userId: "local",
      companyIds: [f.companyId],
      memberships: [],
      isInstanceAdmin: true,
    })).post(`/api/issues/${f.issueId}/pull-runs`).send({});
    expect(board.status).toBe(403);

    const actor = {
      type: "agent" as const,
      source: "agent_key" as const,
      agentId: f.agentId,
      companyId: f.companyId,
      keyId: randomUUID(),
    };
    const suppliedRunId = randomUUID();
    const rejected = await request(createApp({ ...actor, runId: suppliedRunId }))
      .post(`/api/issues/${f.issueId}/pull-runs`)
      .send({});
    expect(rejected.status).toBe(400);

    const started = await request(createApp(actor))
      .post(`/api/issues/${f.issueId}/pull-runs`)
      .send({ leaseSeconds: 60 });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.runId).not.toBe(suppliedRunId);
  });

  it("rejects malformed pull-run route identifiers before querying UUID columns", async () => {
    const f = await fixture();
    const actor = {
      type: "agent" as const,
      source: "agent_key" as const,
      agentId: f.agentId,
      companyId: f.companyId,
      keyId: randomUUID(),
    };
    const app = createApp(actor);
    expect((await request(app).post("/api/issues/not-a-uuid/pull-runs").send({})).status).toBe(400);
    expect((await request(app).post("/api/pull-runs/not-a-uuid/heartbeat").send({})).status).toBe(400);
    expect((await request(app).post("/api/pull-runs/not-a-uuid/complete").send({})).status).toBe(400);
    expect((await request(app).post("/api/pull-runs/not-a-uuid/cancel").send({})).status).toBe(400);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("allows a no-run-id retry to return the existing server-owned lease", async () => {
    const f = await fixture();
    const actor = {
      type: "agent" as const,
      source: "agent_key" as const,
      agentId: f.agentId,
      companyId: f.companyId,
      keyId: randomUUID(),
    };
    const app = createApp(actor);
    const first = await request(app).post(`/api/issues/${f.issueId}/pull-runs`).send({ leaseSeconds: 60 });
    const retry = await request(app).post(`/api/issues/${f.issueId}/pull-runs`).send({ leaseSeconds: 60 });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.runId).toBe(first.body.runId);
  });

  it("applies scoped issue authorization before same-agent lifecycle control", async () => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    const denied = await request(createApp({
      type: "agent",
      source: "agent_key",
      agentId: f.agentId,
      companyId: f.companyId,
      keyId: randomUUID(),
      keyScope: { kind: "skill_test", issueId: randomUUID() },
    })).post(`/api/pull-runs/${started.run.id}/cancel`).send({});
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)))
      .toHaveLength(1);
  });

  it.each([
    ["complete"],
    ["cancel"],
  ] as const)("denies scoped lifecycle %s when another run-locked issue is outside the key scope", async (operation) => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    const issueBId = randomUUID();
    await db.insert(issues).values({
      id: issueBId,
      companyId: f.companyId,
      title: "Second owned issue outside scoped key",
      status: "in_progress",
      assigneeAgentId: f.agentId,
      checkoutRunId: started.run.id,
      executionRunId: started.run.id,
    });

    const denied = await request(createApp({
      type: "agent",
      source: "agent_key",
      agentId: f.agentId,
      companyId: f.companyId,
      keyId: randomUUID(),
      runId: started.run.id,
      keyScope: { kind: "skill_test", issueId: f.issueId },
    })).post(`/api/pull-runs/${started.run.id}/${operation}`).send({});

    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    const [run, issueA, issueB] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)).then((rows) => rows[0]!),
      db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!),
      db.select().from(issues).where(eq(issues.id, issueBId)).then((rows) => rows[0]!),
    ]);
    expect(run).toMatchObject({ status: "running", finishedAt: null });
    expect(issueA).toMatchObject({
      status: "in_progress",
      assigneeAgentId: f.agentId,
      checkoutRunId: started.run.id,
      executionRunId: started.run.id,
    });
    expect(issueB).toMatchObject({
      status: "in_progress",
      assigneeAgentId: f.agentId,
      checkoutRunId: started.run.id,
      executionRunId: started.run.id,
    });
  });

  it("server-issues a live run, atomically claims the issue, and retries idempotently", async () => {
    const f = await fixture();
    const svc = pullRunService(db);
    const input = {
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo", "in_progress"],
      leaseSeconds: 120,
    };
    const [first, retry] = await Promise.all([svc.start(input), svc.start(input)]);

    expect(first.run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(retry.run.id).toBe(first.run.id);
    expect([first.idempotent, retry.idempotent].sort()).toEqual([false, true]);
    const issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(issue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: f.agentId,
      checkoutRunId: first.run.id,
      executionRunId: first.run.id,
    });
    const liveRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "running"));
    expect(liveRuns).toHaveLength(1);
  });

  it("rolls back the run and checkout when mandatory activity persistence fails", async () => {
    const f = await fixture();
    await db.execute(sql`
      create function reject_pull_run_started_activity()
      returns trigger
      language plpgsql
      as $function$
      begin
        raise exception 'forced pull-run activity failure';
      end;
      $function$
    `);
    activityFailureFunctionName = "reject_pull_run_started_activity";
    await db.execute(sql`
      create trigger reject_pull_run_started_activity
      before insert on ${activityLog}
      for each row
      when (new.action = 'pull_run.started')
      execute function reject_pull_run_started_activity()
    `);

    await expect(pullRunService(db).start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    })).rejects.toThrow(/insert into "activity_log"/);

    const issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(issue).toMatchObject({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
    });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("rejects dispatch agents and cross-agent or cross-company run control", async () => {
    const f = await fixture();
    const svc = pullRunService(db);
    await expect(svc.start({
      companyId: f.companyId,
      agentId: f.dispatchAgentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    })).rejects.toMatchObject({ status: 403 });

    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    await expect(svc.heartbeat(f.companyId, f.otherAgentId, started.run.id, 120))
      .rejects.toMatchObject({ status: 404 });
    await expect(svc.complete(f.otherCompanyId, f.agentId, started.run.id))
      .rejects.toMatchObject({ status: 404 });
    await expect(svc.heartbeat(f.companyId, f.agentId, started.run.id, 29))
      .rejects.toMatchObject({ status: 400 });
  });

  it("renews a bounded lease, completes once, and immediately clears ownership locks", async () => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 60,
    });
    const renewed = await svc.heartbeat(f.companyId, f.agentId, started.run.id, 120);
    expect(renewed?.leaseExpiresAt?.getTime()).toBeGreaterThan(started.run.leaseExpiresAt!.getTime());
    const completed = await svc.complete(f.companyId, f.agentId, started.run.id);
    expect(completed.status).toBe("succeeded");
    const issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionRunId).toBeNull();
    const lifecycleActions = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.runId, started.run.id));
    expect(lifecycleActions.map((row) => row.action)).toEqual([
      "pull_run.started",
      "pull_run.heartbeat",
      "pull_run.completed",
      "pull_run.issue_completed",
    ]);
    expect(await db
      .select({ entityId: activityLog.entityId, action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, f.issueId)))
      .toContainEqual({ entityId: f.issueId, action: "pull_run.issue_completed" });
    await expect(svc.complete(f.companyId, f.agentId, started.run.id))
      .rejects.toMatchObject({ status: 409 });
  });

  it("expires stale leases, cleans locks, and cannot regain ownership through assertCheckoutOwner", async () => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 60,
    });
    await db.update(heartbeatRuns).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, started.run.id));

    await expect(issueService(db).assertCheckoutOwner(f.issueId, f.agentId, started.run.id))
      .rejects.toMatchObject({ status: 409 });
    let issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    let run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)).then((rows) => rows[0]!);
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionRunId).toBeNull();
    expect(run.status).toBe("timed_out");
    await expect(db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.runId, started.run.id)))
      .resolves.toContainEqual({ action: "pull_run.expired" });
    await expect(db
      .select({ entityId: activityLog.entityId, action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, f.issueId)))
      .resolves.toContainEqual({ entityId: f.issueId, action: "pull_run.issue_expired" });

    await expect(svc.heartbeat(f.companyId, f.agentId, started.run.id, 120))
      .rejects.toMatchObject({ status: 409 });
    run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)).then((rows) => rows[0]!);
    expect(run.status).toBe("timed_out");
    issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionRunId).toBeNull();
  });

  it("authoritatively sweeps expired orphaned runs without another client call", async () => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, expectedStatuses: ["todo"], leaseSeconds: 60 });
    await db.update(heartbeatRuns).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(heartbeatRuns.id, started.run.id));
    expect(await svc.sweepExpired()).toBe(1);
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)).then((rows) => rows[0]!);
    const issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(run.status).toBe("timed_out");
    expect(issue.checkoutRunId).toBeNull();
  });

  it("audits every issue affected by expiry", async () => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 60,
    });
    const secondIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondIssueId,
      companyId: f.companyId,
      title: "Second expired issue",
      status: "in_progress",
      assigneeAgentId: f.agentId,
      checkoutRunId: started.run.id,
      executionRunId: started.run.id,
    });
    await db.update(heartbeatRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, started.run.id));

    expect(await svc.sweepExpired()).toBe(1);
    const issueActivities = await db
      .select({ entityId: activityLog.entityId, action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.runId, started.run.id));
    expect(issueActivities.filter((row) => row.action === "pull_run.issue_expired").map((row) => row.entityId).sort())
      .toEqual([f.issueId, secondIssueId].sort());
  });

  it("rolls back timeout and lock release when expiry audit persistence fails", async () => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 60,
    });
    await db.update(heartbeatRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, started.run.id));
    await db.execute(sql`
      create function reject_pull_run_expired_activity()
      returns trigger
      language plpgsql
      as $function$
      begin
        raise exception 'forced pull-run expiry activity failure';
      end;
      $function$
    `);
    activityFailureFunctionName = "reject_pull_run_expired_activity";
    await db.execute(sql`
      create trigger reject_pull_run_expired_activity
      before insert on ${activityLog}
      for each row
      when (new.action = 'pull_run.expired')
      execute function reject_pull_run_expired_activity()
    `);

    await expect(svc.sweepExpired()).rejects.toThrow(/insert into "activity_log"/);

    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)).then((rows) => rows[0]!);
    const issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(run.status).toBe("running");
    expect(issue.checkoutRunId).toBe(started.run.id);
    expect(issue.executionRunId).toBe(started.run.id);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "pull_run.expired"))).toHaveLength(0);
  });

  it("clears only terminal-run lock columns and preserves a different live run", async () => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 60,
    });
    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId,
      companyId: f.companyId,
      agentId: f.agentId,
      status: "running",
      invocationSource: "manual",
    });
    await db.update(issues)
      .set({ executionRunId: liveRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, started.run.id));

    expect(await svc.sweepExpired()).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionRunId).toBe(liveRunId);
    expect(issue.executionLockedAt).toBeInstanceOf(Date);
  });

  it("cancel is owner-only, terminal, and requeues an in-progress issue", async () => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    const cancelled = await svc.cancel(f.companyId, f.agentId, started.run.id);
    expect(cancelled.status).toBe("cancelled");
    const issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(issue).toMatchObject({ status: "todo", assigneeAgentId: null, checkoutRunId: null, executionRunId: null });
  });

  it.each([
    ["complete", "succeeded", "pull_run.issue_completed"],
    ["cancel", "cancelled", "pull_run.issue_cancelled"],
  ] as const)("audits every issue affected by %s", async (operation, expectedStatus, issueAction) => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    const secondIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondIssueId,
      companyId: f.companyId,
      title: "Second owned issue",
      status: "in_progress",
      assigneeAgentId: f.agentId,
      checkoutRunId: started.run.id,
      executionRunId: started.run.id,
    });

    const finished = operation === "complete"
      ? await svc.complete(f.companyId, f.agentId, started.run.id)
      : await svc.cancel(f.companyId, f.agentId, started.run.id);

    expect(finished.status).toBe(expectedStatus);
    const issueActivities = await db
      .select({ entityId: activityLog.entityId, action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.runId, started.run.id));
    expect(issueActivities.filter((row) => row.action === issueAction).map((row) => row.entityId).sort())
      .toEqual([f.issueId, secondIssueId].sort());
  });

  it.each([
    ["complete", "succeeded"],
    ["cancel", "cancelled"],
  ] as const)("%s clears terminal locks across every matching issue without clearing unrelated locks", async (operation, expectedStatus) => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    const issueBId = randomUUID();
    const checkoutHolderId = randomUUID();
    const executionHolderId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: checkoutHolderId, companyId: f.companyId, agentId: f.agentId, status: "running", invocationSource: "manual" },
      { id: executionHolderId, companyId: f.companyId, agentId: f.agentId, status: "running", invocationSource: "manual" },
    ]);
    await db.insert(issues).values({
      id: issueBId,
      companyId: f.companyId,
      title: "Execution lock owner",
      status: "todo",
      checkoutRunId: checkoutHolderId,
      executionRunId: started.run.id,
      executionAgentNameKey: "wren",
      executionLockedAt: new Date(),
    });
    await db.update(issues)
      .set({ executionRunId: executionHolderId, executionAgentNameKey: "other", executionLockedAt: new Date() })
      .where(eq(issues.id, f.issueId));

    const finished = operation === "complete"
      ? await svc.complete(f.companyId, f.agentId, started.run.id)
      : await svc.cancel(f.companyId, f.agentId, started.run.id);

    expect(finished.status).toBe(expectedStatus);
    const [issueA, issueB] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!),
      db.select().from(issues).where(eq(issues.id, issueBId)).then((rows) => rows[0]!),
    ]);
    expect(issueA).toMatchObject({ checkoutRunId: null, executionRunId: executionHolderId });
    expect(issueB).toMatchObject({ checkoutRunId: checkoutHolderId, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
  });

  it.each([
    ["checkout-only", "checkout", false],
    ["execution-only", "execution", false],
    ["checkout with another execution holder", "checkout", true],
  ] as const)("%s terminal cleanup requeues only when no other lock remains", async (_description, ownedLock, hasOtherLock) => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    const otherRunId = randomUUID();
    if (hasOtherLock) {
      await db.insert(heartbeatRuns).values({
        id: otherRunId,
        companyId: f.companyId,
        agentId: f.agentId,
        status: "running",
        invocationSource: "manual",
      });
    }
    await db.update(issues)
      .set({
        checkoutRunId: ownedLock === "checkout" ? started.run.id : null,
        executionRunId: ownedLock === "execution" ? started.run.id : (hasOtherLock ? otherRunId : null),
        executionAgentNameKey: ownedLock === "execution" || hasOtherLock ? "wren" : null,
        executionLockedAt: ownedLock === "execution" || hasOtherLock ? new Date() : null,
      })
      .where(eq(issues.id, f.issueId));

    await svc.cancel(f.companyId, f.agentId, started.run.id);

    const issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(issue).toMatchObject(hasOtherLock
      ? { status: "in_progress", assigneeAgentId: f.agentId, checkoutRunId: null, executionRunId: otherRunId }
      : { status: "todo", assigneeAgentId: null, checkoutRunId: null, executionRunId: null });
  });

  it.each([
    ["checkout-only", "checkout", false],
    ["execution-only", "execution", false],
    ["checkout with another execution holder", "checkout", true],
  ] as const)("%s expiry cleanup requeues only when no other lock remains", async (_description, ownedLock, hasOtherLock) => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    const otherRunId = randomUUID();
    if (hasOtherLock) {
      await db.insert(heartbeatRuns).values({
        id: otherRunId,
        companyId: f.companyId,
        agentId: f.agentId,
        status: "running",
        invocationSource: "manual",
      });
    }
    await db.update(issues)
      .set({
        checkoutRunId: ownedLock === "checkout" ? started.run.id : null,
        executionRunId: ownedLock === "execution" ? started.run.id : (hasOtherLock ? otherRunId : null),
        executionAgentNameKey: ownedLock === "execution" || hasOtherLock ? "wren" : null,
        executionLockedAt: ownedLock === "execution" || hasOtherLock ? new Date() : null,
      })
      .where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, started.run.id));

    expect(await svc.sweepExpired()).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(issue).toMatchObject(hasOtherLock
      ? { status: "in_progress", assigneeAgentId: f.agentId, checkoutRunId: null, executionRunId: otherRunId }
      : { status: "todo", assigneeAgentId: null, checkoutRunId: null, executionRunId: null });
  });

  it.each([
    ["cancel", async (svc: ReturnType<typeof pullRunService>, companyId: string, agentId: string, runId: string) => svc.cancel(companyId, agentId, runId)],
    ["expire", async (svc: ReturnType<typeof pullRunService>, _companyId: string, _agentId: string, runId: string) => {
      await expect(svc.sweepExpired()).resolves.toBe(1);
    }],
  ] as const)("%s keeps an unrelated unlocked in-progress issue untouched", async (operation, act) => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values({
      id: unrelatedIssueId,
      companyId: f.companyId,
      title: "Unrelated unlocked issue",
      status: "in_progress",
      assigneeAgentId: f.agentId,
    });
    if (operation === "expire") {
      await db.update(heartbeatRuns)
        .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(heartbeatRuns.id, started.run.id));
    }

    await act(svc, f.companyId, f.agentId, started.run.id);

    const unrelatedIssue = await db.select().from(issues).where(eq(issues.id, unrelatedIssueId)).then((rows) => rows[0]!);
    expect(unrelatedIssue).toMatchObject({ status: "in_progress", assigneeAgentId: f.agentId, checkoutRunId: null, executionRunId: null });
  });
});
