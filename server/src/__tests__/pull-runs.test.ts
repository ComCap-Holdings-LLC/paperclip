import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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

  async function waitForBlockedForUpdate(tableName: string, minimumWaiters = 1) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [waiting] = await db.execute<{ waiting: boolean }>(sql`
        SELECT count(*) >= ${minimumWaiters} AS waiting
          FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE ${`%${tableName}%`}
            AND query ILIKE '%for update%'
      `);
      if (waiting?.waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
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
    ["heartbeat"],
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

  it.each([
    ["heartbeat"],
    ["complete"],
    ["cancel"],
  ] as const)("revalidates locked issue authorization before lifecycle %s mutates the run", async (operation) => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    const descendantIssueId = randomUUID();
    await db.update(issues)
      .set({ assigneeAgentId: null, updatedAt: new Date() })
      .where(eq(issues.id, f.issueId));
    await db.insert(issues).values({
      id: descendantIssueId,
      companyId: f.companyId,
      parentId: f.issueId,
      title: "Attached descendant",
      status: "in_progress",
      assigneeAgentId: null,
      checkoutRunId: started.run.id,
      executionRunId: started.run.id,
    });
    const originalLeaseExpiresAt = started.run.leaseExpiresAt?.getTime();
    const lockDb = createDb(tempDb!.connectionString);
    const lockReady = deferred<number>();
    const releaseLock = deferred<void>();
    const authorizationChange = lockDb.transaction(async (tx) => {
      await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${descendantIssueId} for update`);
      const [connection] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      lockReady.resolve(connection!.pid);
      await releaseLock.promise;
      await tx.update(issues)
        .set({ assigneeAgentId: f.otherAgentId, updatedAt: new Date() })
        .where(eq(issues.id, descendantIssueId));
    });
    const lockPid = await lockReady.promise;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [connection] = await db.execute<{ state: string }>(sql`
        select state from pg_stat_activity where pid = ${lockPid}
      `);
      if (connection?.state === "idle in transaction") break;
      if (attempt === 79) throw new Error("authorization-change transaction did not become idle");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    try {
      const lifecycle = request(createApp({
        type: "agent",
        source: "agent_key",
        agentId: f.agentId,
        companyId: f.companyId,
        runId: started.run.id,
        keyScope: null,
      }))
        .post(`/api/pull-runs/${started.run.id}/${operation}`)
        .send(operation === "heartbeat" ? { leaseSeconds: 300 } : {})
        .then((response) => response);

      expect(await waitForBlockedForUpdate("issues")).toBe(true);
      releaseLock.resolve();
      await authorizationChange;
      const denied = await Promise.race([
        lifecycle,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("pull-run authorization revalidation timed out")),
          5_000,
        )),
      ]);

      expect(denied.status, JSON.stringify(denied.body)).toBe(409);
      const [run, primaryIssue, descendantIssue, lifecycleLogs] = await Promise.all([
        db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)).then((rows) => rows[0]!),
        db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!),
        db.select().from(issues).where(eq(issues.id, descendantIssueId)).then((rows) => rows[0]!),
        db.select({ action: activityLog.action }).from(activityLog).where(and(
          eq(activityLog.runId, started.run.id),
          inArray(activityLog.action, ["pull_run.heartbeat", "pull_run.completed", "pull_run.cancelled"]),
        )),
      ]);
      expect(run).toMatchObject({ status: "running", finishedAt: null });
      expect(run.leaseExpiresAt?.getTime()).toBe(originalLeaseExpiresAt);
      expect(primaryIssue).toMatchObject({
        status: "in_progress",
        assigneeAgentId: null,
        checkoutRunId: started.run.id,
        executionRunId: started.run.id,
      });
      expect(descendantIssue).toMatchObject({
        status: "in_progress",
        assigneeAgentId: f.otherAgentId,
        checkoutRunId: started.run.id,
        executionRunId: started.run.id,
      });
      expect(lifecycleLogs).toHaveLength(0);
    } finally {
      releaseLock.resolve();
      await Promise.allSettled([authorizationChange]);
      await lockDb.$client.end();
    }
  });

  it.each([
    ["heartbeat"],
    ["complete"],
    ["cancel"],
  ] as const)("does not %s after the lease expires while waiting for an issue lock", async (operation) => {
    const f = await fixture();
    const svc = pullRunService(db);
    const started = await svc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 60,
    });
    const lockDb = createDb(tempDb!.connectionString);
    const lockReady = deferred<void>();
    const releaseLock = deferred<void>();
    const issueLock = lockDb.transaction(async (tx) => {
      await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${f.issueId} for update`);
      lockReady.resolve();
      await releaseLock.promise;
    });
    await lockReady.promise;

    try {
      const lifecycle = operation === "heartbeat"
        ? svc.heartbeat(f.companyId, f.agentId, started.run.id, 120)
        : operation === "complete"
          ? svc.complete(f.companyId, f.agentId, started.run.id)
          : svc.cancel(f.companyId, f.agentId, started.run.id);
      expect(await waitForBlockedForUpdate("issues")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const expiredAt = new Date(Date.now() - 25);
      await db.update(heartbeatRuns)
        .set({ leaseExpiresAt: expiredAt })
        .where(eq(heartbeatRuns.id, started.run.id));
      releaseLock.resolve();

      await expect(lifecycle).rejects.toMatchObject({ status: 409 });
      const [run, lifecycleLogs] = await Promise.all([
        db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)).then((rows) => rows[0]!),
        db.select({ action: activityLog.action }).from(activityLog).where(and(
          eq(activityLog.runId, started.run.id),
          inArray(activityLog.action, ["pull_run.heartbeat", "pull_run.completed", "pull_run.cancelled"]),
        )),
      ]);
      if (operation === "heartbeat") {
        expect(run.status).toBe("timed_out");
        expect(run.finishedAt).not.toBeNull();
      } else {
        expect(run.status).toBe("running");
        expect(run.finishedAt).toBeNull();
      }
      expect(lifecycleLogs).toHaveLength(0);
    } finally {
      releaseLock.resolve();
      await Promise.allSettled([issueLock]);
      await lockDb.$client.end();
    }
  });

  it("returns conflict without renewing when heartbeat attachment stabilization exhausts its retries", async () => {
    const f = await fixture();
    const baseSvc = pullRunService(db);
    const started = await baseSvc.start({
      companyId: f.companyId,
      agentId: f.agentId,
      issueId: f.issueId,
      expectedStatuses: ["todo"],
      leaseSeconds: 120,
    });
    const secondAttachedIssueId = randomUUID();
    const candidateIssueId = randomUUID();
    await db.insert(issues).values([
      { id: secondAttachedIssueId, companyId: f.companyId, title: "Second attached", status: "todo" },
      { id: candidateIssueId, companyId: f.companyId, title: "Racing attachment", status: "todo" },
    ]);
    await issueService(db).checkout(secondAttachedIssueId, f.agentId, ["todo"], started.run.id, {
      requireExternalPullRun: true,
    });

    let attachmentSetError: (new () => Error) | null = null;
    let lifecycleTransactionAttempts = 0;
    const retryExhaustionDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return async (...args: Parameters<typeof db.transaction>) => {
          lifecycleTransactionAttempts += 1;
          if (attachmentSetError) throw new attachmentSetError();
          try {
            return await target.transaction(...args);
          } catch (error) {
            if (error instanceof Error && error.constructor.name === "PullRunAttachmentSetChangedError") {
              attachmentSetError = error.constructor as new () => Error;
            }
            throw error;
          }
        };
      },
    });
    const svc = pullRunService(retryExhaustionDb);
    const attachedIssueIds = [f.issueId, secondAttachedIssueId].sort();
    const issueLockDb = createDb(tempDb!.connectionString);
    const runLockDb = createDb(tempDb!.connectionString);
    const attachmentDb = createDb(tempDb!.connectionString);
    const issueLockReady = deferred<void>();
    const releaseIssueLock = deferred<void>();
    const runLockReady = deferred<void>();
    const releaseRunLock = deferred<void>();
    const issueLock = issueLockDb.transaction(async (tx) => {
      await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${attachedIssueIds[1]} for update`);
      issueLockReady.resolve();
      await releaseIssueLock.promise;
    });
    const runLock = runLockDb.transaction(async (tx) => {
      await tx.execute(sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${started.run.id} for update`);
      runLockReady.resolve();
      await releaseRunLock.promise;
    });
    await Promise.all([issueLockReady.promise, runLockReady.promise]);

    try {
      const lifecycle = svc.heartbeat(f.companyId, f.agentId, started.run.id, 300);
      expect(await waitForBlockedForUpdate("issues")).toBe(true);

      const attachment = attachmentDb.transaction(async (tx) => {
        await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${candidateIssueId} for update`);
        await tx.execute(sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${started.run.id} for update`);
        await tx
          .update(issues)
          .set({
            status: "in_progress",
            assigneeAgentId: f.agentId,
            checkoutRunId: started.run.id,
            executionRunId: started.run.id,
            executionLockedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(issues.id, candidateIssueId));
      });
      expect(await waitForBlockedForUpdate("heartbeat_runs")).toBe(true);

      releaseRunLock.resolve();
      await attachment;
      releaseIssueLock.resolve();
      await Promise.all([issueLock, runLock]);

      await expect(lifecycle).rejects.toMatchObject({ status: 409 });
      expect(lifecycleTransactionAttempts).toBe(3);
      const [run, heartbeatLogs] = await Promise.all([
        db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)).then((rows) => rows[0]!),
        db.select({ action: activityLog.action }).from(activityLog).where(and(
          eq(activityLog.runId, started.run.id),
          eq(activityLog.action, "pull_run.heartbeat"),
        )),
      ]);
      expect(run).toMatchObject({ status: "running", finishedAt: null });
      expect(run.leaseExpiresAt?.getTime()).toBe(started.run.leaseExpiresAt?.getTime());
      expect(heartbeatLogs).toHaveLength(0);
    } finally {
      releaseIssueLock.resolve();
      releaseRunLock.resolve();
      await Promise.allSettled([issueLock, runLock]);
      await Promise.all([
        issueLockDb.$client.end(),
        runLockDb.$client.end(),
        attachmentDb.$client.end(),
      ]);
    }
  });

  it("does not renew a scoped heartbeat when an attached issue is outside the authorized set", async () => {
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
      title: "Unauthorized attached issue",
      status: "in_progress",
      assigneeAgentId: f.agentId,
      checkoutRunId: started.run.id,
      executionRunId: started.run.id,
    });

    await expect(svc.heartbeat(f.companyId, f.agentId, started.run.id, 120, undefined, {
      authorizedIssueIds: [f.issueId],
    })).rejects.toMatchObject({ status: 409 });
    const [run, heartbeatLogs] = await Promise.all([
      db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)).then((rows) => rows[0]!),
      db.select({ action: activityLog.action }).from(activityLog).where(eq(activityLog.runId, started.run.id)),
    ]);
    expect(run.leaseExpiresAt?.getTime()).toBe(started.run.leaseExpiresAt?.getTime());
    expect(heartbeatLogs.map((row) => row.action)).not.toContain("pull_run.heartbeat");
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
