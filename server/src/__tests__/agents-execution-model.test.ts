import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_input?: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "should never be invoked in these tests",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agents.executionModel tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agents.executionModel (additive, default-preserving column)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agents-execution-model-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIdleTimerAgentFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    // Deliberately does NOT set executionModel, to prove the column's DEFAULT
    // 'dispatch' applies to agents created exactly the way every agent is
    // created today.
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          skipTimerWhenNoActionableWork: true,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  it("defaults new agents to executionModel 'dispatch' with no application code change required", async () => {
    const { agentId } = await seedIdleTimerAgentFixture();

    const row = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    expect(row.executionModel).toBe("dispatch");
  });

  it(
    "existing dispatch-mode agent behavior is unchanged with the executionModel column present at its default " +
      "(same fixture and assertions as the pre-existing heartbeat 'no actionable work' negative control)",
    async () => {
      const { companyId, agentId } = await seedIdleTimerAgentFixture();
      const heartbeat = heartbeatService(db);

      const run = await heartbeat.wakeup(agentId, {
        source: "timer",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        requestedByActorType: "system",
        requestedByActorId: "heartbeat_scheduler",
        contextSnapshot: {
          source: "scheduler",
          reason: "interval_elapsed",
          now: "2026-08-21T00:00:00.000Z",
        },
      });

      expect(run).toBeNull();
      expect(mockAdapterExecute).not.toHaveBeenCalled();

      const requests = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        companyId,
        source: "timer",
        reason: "heartbeat.timer.no_actionable_work",
        status: "skipped",
        error: null,
      });

      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(0);
    },
  );

  it(
    "round-trips executionModel through the same service function GET /agents/:id calls (agentService.getById), " +
      "for both the default value and an explicit 'pull' value, with zero route/service code changes",
    async () => {
      const { agentId } = await seedIdleTimerAgentFixture();
      const svc = agentService(db);

      const defaulted = await svc.getById(agentId);
      expect(defaulted?.executionModel).toBe("dispatch");

      await db.update(agents).set({ executionModel: "pull" }).where(eq(agents.id, agentId));

      const explicit = await svc.getById(agentId);
      expect(explicit?.executionModel).toBe("pull");

      // Setting executionModel has no bearing on dispatch in this increment — no scheduler code
      // reads this field yet, so nothing about invoking the agent changes here. That wiring is
      // out of scope for this change; see doc/plans/2026-08-21-pull-agent-execution-model.md §5, §7.
    },
  );
});
