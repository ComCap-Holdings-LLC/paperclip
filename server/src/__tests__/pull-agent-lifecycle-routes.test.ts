import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  issues,
} from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
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
});
