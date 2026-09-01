import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CROSS_ISSUE_INFLUENCE_ENFORCE_AT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";
import { EXTERNAL_PULL_RUN_TRIGGER } from "../services/external-pull-run-lifecycle.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-issue influence limit PostgreSQL serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-cap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows exactly 20 of 21 concurrent attempts from the same run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Concurrent Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      triggerDetail: EXTERNAL_PULL_RUN_TRIGGER,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    const input = {
      companyId,
      runId,
      agentId,
      targetIssueId,
      targetIssueIdentifier: "CAP-2",
      kind: "comment" as const,
    };
    const decisions = await Promise.all(Array.from({ length: 21 }, (_, index) =>
      observeCrossIssueInfluence(db, { ...input, kind: index % 2 === 0 ? "comment" : "update" }, async () => CROSS_ISSUE_INFLUENCE_ENFORCE_AT),
    ));

    expect(decisions.filter((decision) => decision?.allowed)).toHaveLength(20);
    expect(decisions.filter((decision) => !decision?.allowed)).toHaveLength(1);
    expect(decisions.map((decision) => decision?.count).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 21 }, (_, index) => index + 1),
    );

    const recorded = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_observed")).toHaveLength(20);
    expect(recorded.filter((row) => row.action === "issue.cross_issue_influence_cap_rejected")).toHaveLength(1);
  });

  it("refills the run budget after observations age out of the inclusive 60-second window", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const now = new Date("2026-08-12T00:01:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Rolling Coder", role: "engineer",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", triggerDetail: EXTERNAL_PULL_RUN_TRIGGER,
      leaseExpiresAt: new Date(Date.now() + 60_000), responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(activityLog).values(Array.from({ length: 20 }, () => ({
      companyId, actorType: "agent" as const, actorId: agentId, agentId, runId,
      action: "issue.cross_issue_influence_observed", entityType: "issue", entityId: targetIssueId,
      createdAt: new Date(now.getTime() - 60_001),
    })));

    await expect(observeCrossIssueInfluence(db, {
      companyId, runId, agentId, targetIssueId, targetIssueIdentifier: "CAP-2", kind: "comment",
    }, async () => now)).resolves.toMatchObject({ allowed: true, count: 1, cap: 20 });
  });

  it("counts observations exactly at the inclusive 60-second cutoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const now = new Date("2026-08-12T00:01:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Boundary Coder", role: "engineer",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", triggerDetail: EXTERNAL_PULL_RUN_TRIGGER,
      leaseExpiresAt: new Date(Date.now() + 60_000), responsibleUserId: "board-user",
      contextSnapshot: { issueId: sourceIssueId },
    });
    await db.insert(activityLog).values(Array.from({ length: 20 }, () => ({
      companyId, actorType: "agent" as const, actorId: agentId, agentId, runId,
      action: "issue.cross_issue_influence_observed", entityType: "issue", entityId: targetIssueId,
      createdAt: new Date(now.getTime() - 60_000),
    })));

    await expect(observeCrossIssueInfluence(db, {
      companyId, runId, agentId, targetIssueId, targetIssueIdentifier: "CAP-2", kind: "comment",
    }, async () => now)).resolves.toMatchObject({ allowed: false, count: 21, cap: 20 });
  });
});
