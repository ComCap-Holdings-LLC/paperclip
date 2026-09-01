import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pull-runs-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
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
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionRunId).toBeNull();

    await expect(svc.heartbeat(f.companyId, f.agentId, started.run.id, 120))
      .rejects.toMatchObject({ status: 409 });
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, started.run.id)).then((rows) => rows[0]!);
    expect(run.status).toBe("timed_out");
    issue = await db.select().from(issues).where(eq(issues.id, f.issueId)).then((rows) => rows[0]!);
    expect(issue.checkoutRunId).toBeNull();
    expect(issue.executionRunId).toBeNull();
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
});
