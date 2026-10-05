import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping wedged in_progress checkout recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regression coverage for the "orphaned checkout" defect: an issue can enter
// `in_progress` through a path that never attaches a run id (most commonly a
// checkout performed by a non-agent actor, e.g. a board API token, which has
// no run id of its own to record — see `checkout()` and `requireAgentRunId`
// in routes/issues.ts). If the run that would normally adopt the lock
// (`adoptUnownedCheckoutRun`) never shows up, the issue is stuck: the
// assignee-only write boundary treats `in_progress` as held even though
// checkoutRunId and executionRunId are both null, so nothing else can touch
// it and nothing ever releases it.
//
// Two independent defenses are covered here:
//   1. `reapWedgedInProgressCheckouts` — a time-based sweep that returns a
//      stale, run-less `in_progress` issue to `todo`.
//   2. The `update()` guard that requires a live run id when an agent
//      checks *itself* out into `in_progress` through the generic PATCH
//      path, mirroring the run-id requirement the exit path already
//      enforces for the same actor.
describeEmbeddedPostgres("wedged in_progress checkout recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wedged-checkout-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name = "Worker") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });
    return runId;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fixture issue",
      status: "in_progress",
      priority: "medium",
      ...overrides,
    });
    return issueId;
  }

  describe("reapWedgedInProgressCheckouts", () => {
    it("releases a stale, run-less in_progress issue back to todo and comments why", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const staleAfterMs = 2 * 60 * 60 * 1000;
      const staleUpdatedAt = new Date(Date.now() - staleAfterMs - 60_000);

      const issueId = await seedIssue(companyId, {
        assigneeAgentId: agentId,
        checkoutRunId: null,
        executionRunId: null,
        updatedAt: staleUpdatedAt,
      });

      const svc = issueService(db);
      const reaped = await svc.reapWedgedInProgressCheckouts(staleAfterMs);

      expect(reaped.map((row) => row.id)).toEqual([issueId]);

      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after?.status).toBe("todo");
      expect(after?.assigneeAgentId).toBeNull();
      expect(after?.checkoutRunId).toBeNull();
      expect(after?.executionRunId).toBeNull();

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0]?.authorType).toBe("system");
      expect(comments[0]?.body).toMatch(/wedged/i);
      expect(comments[0]?.body).toMatch(/todo/i);
    });

    it("does not reap a run-less in_progress issue that was updated recently", async () => {
      // Negative control: same shape as the positive case (in_progress, both
      // run ids null), but freshly updated — this could be a legitimate
      // checkout still waiting for its run to attach, so it must survive.
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);

      const issueId = await seedIssue(companyId, {
        assigneeAgentId: agentId,
        checkoutRunId: null,
        executionRunId: null,
        updatedAt: new Date(),
      });

      const svc = issueService(db);
      const reaped = await svc.reapWedgedInProgressCheckouts(2 * 60 * 60 * 1000);

      expect(reaped).toHaveLength(0);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after?.status).toBe("in_progress");
    });

    it("does not reap a stale in_progress issue that still has a recorded checkout run", async () => {
      // Negative control: a *present* (even if stale) checkoutRunId is a
      // different, already-handled case — clearExecutionRunIfTerminal /
      // clearCheckoutRunIfTerminal cover it. This reaper only owns the
      // "no run was ever recorded" state.
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const staleAfterMs = 2 * 60 * 60 * 1000;
      const runId = await seedRun(companyId, agentId);

      const issueId = await seedIssue(companyId, {
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: null,
        updatedAt: new Date(Date.now() - staleAfterMs - 60_000),
      });

      const svc = issueService(db);
      const reaped = await svc.reapWedgedInProgressCheckouts(staleAfterMs);

      expect(reaped).toHaveLength(0);
      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after?.status).toBe("in_progress");
      expect(after?.checkoutRunId).not.toBeNull();
    });
  });

  describe("update() self-checkout run id guard", () => {
    it("rejects an agent checking itself into in_progress via update without a run id", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, {
        status: "todo",
        assigneeAgentId: agentId,
      });

      const svc = issueService(db);
      await expect(
        svc.update(issueId, {
          status: "in_progress",
          actorAgentId: agentId,
          actorType: "agent",
          actorRunId: null,
        }),
      ).rejects.toMatchObject({ status: 422 });

      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after?.status).toBe("todo");
    });

    it("accepts an agent checking itself into in_progress via update when it carries a run id, and records the lock", async () => {
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, {
        status: "todo",
        assigneeAgentId: agentId,
      });
      const runId = await seedRun(companyId, agentId);

      const svc = issueService(db);
      const updated = await svc.update(issueId, {
        status: "in_progress",
        actorAgentId: agentId,
        actorType: "agent",
        actorRunId: runId,
      });

      expect(updated?.status).toBe("in_progress");
      expect(updated?.checkoutRunId).toBe(runId);
      expect(updated?.executionRunId).toBe(runId);
      expect(updated?.executionLockedAt).not.toBeNull();
    });

    it("does not require a run id for a board/user actor moving an issue into in_progress", async () => {
      // Unaffected-path control: the guard only applies to an agent actor
      // checking *itself* out. A board/user actor (e.g. `pc take`, which has
      // no agent-run concept at all) must keep working exactly as before —
      // the reap sweep above is what recovers this case if it never attaches
      // a run.
      const companyId = await seedCompany();
      const agentId = await seedAgent(companyId);
      const issueId = await seedIssue(companyId, {
        status: "todo",
        assigneeAgentId: agentId,
      });

      const svc = issueService(db);
      const updated = await svc.update(issueId, {
        status: "in_progress",
        actorType: "user",
        actorRunId: null,
      });

      expect(updated?.status).toBe("in_progress");
      expect(updated?.checkoutRunId).toBeNull();
      expect(updated?.executionRunId).toBeNull();
    });

    it("does not require a run id when an agent assigns a different agent into in_progress", async () => {
      // Unaffected-path control: this is not a self-checkout, so stamping the
      // acting agent's own run id would misattribute the lock. Checkout
      // remains the only path that can attach a run id it does not own.
      const companyId = await seedCompany();
      const orchestratorAgentId = await seedAgent(companyId, "Orchestrator");
      const workerAgentId = await seedAgent(companyId, "Worker");
      const issueId = await seedIssue(companyId, {
        status: "todo",
        assigneeAgentId: null,
      });

      const svc = issueService(db);
      const updated = await svc.update(issueId, {
        status: "in_progress",
        assigneeAgentId: workerAgentId,
        actorAgentId: orchestratorAgentId,
        actorType: "agent",
        actorRunId: null,
      });

      expect(updated?.status).toBe("in_progress");
      expect(updated?.assigneeAgentId).toBe(workerAgentId);
      expect(updated?.checkoutRunId).toBeNull();
      expect(updated?.executionRunId).toBeNull();
    });
  });
});
