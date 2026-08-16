import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("pull agent lifecycle routes", () => {
  const ctx = useEmbeddedPostgres("paperclip-pull-agent-lifecycle-routes-", {
    resetEach: async (db) => {
      await db.delete(activityLog);
      await db.delete(agentRuntimeState);
      await db.delete(heartbeatRuns);
      await db.delete(issues);
      await db.delete(agents);
      await resetCompanyIssueFixtures(db);
    },
  });

  function agentActor(companyId: string, agentId: string) {
    return {
      type: "agent" as const,
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt" as const,
    };
  }

  async function seedAgent(runtimeConfig: Record<string, unknown> = { executionModel: "pull" }) {
    const seeded = await seedCompanyWithBoardAccess(ctx.db, "PullLifecycle");
    const agentId = randomUUID();
    await ctx.db.insert(agents).values({
      id: agentId,
      companyId: seeded.companyId,
      name: "Wren",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig,
      permissions: {},
    });
    return { ...seeded, agentId };
  }

  it("GET /agents/:id/lifecycle is unreachable for a pull agent with no lease", async () => {
    const { actor, agentId } = await seedAgent();
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      executionModel: "pull",
      state: "unreachable",
      dispatchEnabled: false,
      queuedIssueCount: 0,
      blockedIssueCount: 0,
    });
  });

  it("POST /agents/:id/lifecycle-report persists a lease and GET derives running", async () => {
    const { actor, agentId, companyId } = await seedAgent();
    await ctx.db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "process",
      stateJson: { keepMe: true, totalRuns: 9 },
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const posted = await request(app)
      .post(`/api/agents/${agentId}/lifecycle-report`)
      .send({
        source: "resident-seat",
        state: "running",
        evidence: [{ kind: "external_lease", id: "vps-poller-5", active: true }],
      });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({
      executionModel: "pull",
      state: "running",
      source: "resident-seat",
      dispatchEnabled: false,
    });
    expect(posted.body.expiresAt).toEqual(expect.any(String));

    const stored = await ctx.db
      .select({ stateJson: agentRuntimeState.stateJson })
      .from(agentRuntimeState)
      .then((rows) => rows[0]?.stateJson);
    expect(stored).toMatchObject({
      keepMe: true,
      totalRuns: 9,
      pullLifecycleReport: {
        source: "resident-seat",
        state: "running",
      },
    });

    const got = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(got.status).toBe(200);
    expect(got.body.state).toBe("running");
    expect(got.body.evidence).toEqual([
      { kind: "external_lease", id: "vps-poller-5", active: true },
    ]);

    const after = await ctx.db.select({ status: agents.status }).from(agents);
    expect(after).toEqual([{ status: "running" }]);
  });

  it("rejects lifecycle reports for push agents", async () => {
    const { actor, agentId } = await seedAgent({});
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app)
      .post(`/api/agents/${agentId}/lifecycle-report`)
      .send({ source: "resident-seat" });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/pull-executed/i);
  });

  it("lets a pull agent report only its own lifecycle", async () => {
    const { companyId, agentId } = await seedAgent();
    const otherId = randomUUID();
    await ctx.db.insert(agents).values({
      id: otherId,
      companyId,
      name: "Other",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { executionModel: "pull" },
      permissions: {},
    });
    const app = routeApp(ctx.db, agentActor(companyId, agentId) as never, agentRoutes);
    const own = await request(app)
      .post(`/api/agents/${agentId}/lifecycle-report`)
      .send({ source: "self" });
    expect(own.status).toBe(200);
    const other = await request(app)
      .post(`/api/agents/${otherId}/lifecycle-report`)
      .send({ source: "self" });
    expect(other.status).toBe(403);
    expect(other.body.error).toMatch(/own lifecycle/i);
  });

  it("hides another company's agent as 404", async () => {
    const { agentId } = await seedAgent();
    const outsider = await seedCompanyWithBoardAccess(ctx.db, "Outsider");
    const app = routeApp(ctx.db, outsider.actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(res.status).toBe(404);
  });

  it("GET /lifecycle idles an expired running pull agent without a heartbeat run", async () => {
    const { actor, agentId } = await seedAgent();
    const app = routeApp(ctx.db, actor, agentRoutes);
    const posted = await request(app)
      .post(`/api/agents/${agentId}/lifecycle-report`)
      .send({
        source: "resident-seat",
        state: "running",
        evidence: [{ kind: "external_lease", id: "vps-poller", active: true }],
      });
    expect(posted.status).toBe(200);
    expect(posted.body.state).toBe("running");

    const stored = await ctx.db
      .select({ stateJson: agentRuntimeState.stateJson })
      .from(agentRuntimeState)
      .then((rows) => rows[0]?.stateJson as Record<string, unknown>);
    const report = {
      ...(stored.pullLifecycleReport as Record<string, unknown>),
      expiresAt: "2026-08-14T19:59:59.000Z",
      observedAt: "2026-08-14T19:58:00.000Z",
    };
    await ctx.db.update(agentRuntimeState).set({
      stateJson: { ...stored, pullLifecycleReport: report },
    });
    await ctx.db.update(agents).set({ status: "running" });

    const got = await request(app).get(`/api/agents/${agentId}/lifecycle`);
    expect(got.status).toBe(200);
    expect(got.body.state).toBe("unreachable");
    const after = await ctx.db.select({ status: agents.status }).from(agents);
    expect(after).toEqual([{ status: "idle" }]);
    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
  });

  it("GET /agents/:id embeds pullLifecycle from runtimeConfig when native state is empty", async () => {
    const { actor, agentId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
      pullLifecycle: {
        source: "resident-seat",
        state: "running",
        observedAt: "2026-08-16T15:00:00.000Z",
        expiresAt: "2026-08-16T16:00:00.000Z",
        evidence: [{ kind: "external_lease", id: "vps-poller", active: true }],
      },
    });
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}`);
    expect(res.status).toBe(200);
    expect(res.body.pullLifecycle).toMatchObject({
      executionModel: "pull",
      state: "running",
      source: "resident-seat",
      dispatchEnabled: false,
    });
    expect(res.body.pullLifecycle.evidence).toEqual([
      { kind: "external_lease", id: "vps-poller", active: true },
    ]);
    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
  });

  it("GET /agents/:id does not embed pullLifecycle for push agents", async () => {
    const { actor, agentId } = await seedAgent({});
    const app = routeApp(ctx.db, actor, agentRoutes);
    const res = await request(app).get(`/api/agents/${agentId}`);
    expect(res.status).toBe(200);
    expect(res.body.pullLifecycle).toBeUndefined();
  });

  it("timer ticks reconcile pull agents and do not enqueue heartbeat runs", async () => {
    const { agentId } = await seedAgent({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
      heartbeat: { enabled: true, intervalSec: 60 },
    });
    await ctx.db.insert(agentRuntimeState).values({
      agentId,
      companyId: (await ctx.db.select({ companyId: agents.companyId }).from(agents).then((rows) => rows[0]!.companyId)),
      adapterType: "process",
      stateJson: {
        pullLifecycleReport: {
          source: "resident-seat",
          state: "running",
          observedAt: "2026-08-14T19:58:00.000Z",
          expiresAt: "2026-08-14T19:59:59.000Z",
          evidence: [{ kind: "external_lease", id: "vps-poller", active: true }],
        },
      },
    });
    await ctx.db.update(agents).set({
      status: "running",
      lastHeartbeatAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    const result = await heartbeatService(ctx.db).tickTimers(new Date("2026-08-14T20:00:00.000Z"));
    expect(result.enqueued).toBe(0);
    const after = await ctx.db.select({ status: agents.status }).from(agents);
    expect(after).toEqual([{ status: "idle" }]);
    const runs = await ctx.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(runs).toEqual([]);
  });
});
