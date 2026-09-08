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
  issueCreateIdempotencyKeys,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS,
  issueService,
} from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create deduplication route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue create deduplication routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-deduplication-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function createAgentApp(agentCompanyId: string, agentId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId,
        companyId: agentCompanyId,
        runId: null,
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedParent(companyId: string) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    }).returning();
    return parent;
  }

  it("replays the existing issue for the same company idempotency key", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Prepare release", idempotencyKey: "run-1:prepare-release" })
      .expect(201);
    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        parentId: parent.id,
        title: "Different retry payload",
        idempotencyKey: "run-1:prepare-release",
        allowDuplicate: true,
      })
      .expect(200);

    expect(replay.body).toMatchObject({
      id: first.body.id,
      title: "Prepare release",
      deduplicated: true,
      deduplicationReason: "idempotency_key",
    });
    expect(await db.select().from(issueCreateIdempotencyKeys)).toHaveLength(1);
  });

  it("expires old idempotency keys before replay lookup", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const oldIssueId = randomUUID();
    const idempotencyKey = "run-1:expired-retry";
    const expiredCreatedAt = new Date(
      Date.now() - (ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    await db.insert(issues).values({
      id: oldIssueId,
      companyId,
      parentId: parent.id,
      title: "Expired retry target",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueCreateIdempotencyKeys).values({
      companyId,
      idempotencyKey,
      issueId: oldIssueId,
      createdAt: expiredCreatedAt,
    });

    const recreated = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Expired retry creates new work", idempotencyKey })
      .expect(201);

    const rows = await db.select().from(issueCreateIdempotencyKeys);
    expect(recreated.body.id).not.toBe(oldIssueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId,
      idempotencyKey,
      issueId: recreated.body.id,
    });
  });

  it("returns a recent open sibling whose normalized title matches", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Create   a single PR" })
      .expect(201);
    const duplicate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "  create a SINGLE pr  " })
      .expect(200);

    expect(duplicate.body).toMatchObject({
      id: first.body.id,
      deduplicated: true,
      deduplicationReason: "recent_open_title",
    });
  });

  it("serializes keyed and title-only creates for the same issue", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const [keyed, titleOnly] = await Promise.all([
      request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Coordinate launch", idempotencyKey: "run-2:coordinate-launch" }),
      request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Coordinate launch" }),
    ]);

    expect([keyed.status, titleOnly.status].sort()).toEqual([200, 201]);
    expect(keyed.body.id).toBe(titleOnly.body.id);
    expect([keyed, titleOnly].find((response) => response.status === 200)?.body).toMatchObject({
      deduplicated: true,
      deduplicationReason: "recent_open_title",
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, parent.id))).toHaveLength(1);
    expect(await db.select().from(issueCreateIdempotencyKeys)).toEqual([
      expect.objectContaining({ issueId: keyed.body.id, idempotencyKey: "run-2:coordinate-launch" }),
    ]);

    const replay = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Different title", idempotencyKey: "run-2:coordinate-launch" })
      .expect(200);
    expect(replay.body).toMatchObject({
      id: keyed.body.id,
      deduplicated: true,
      deduplicationReason: "idempotency_key",
    });
  });

  it("allows an explicit duplicate create", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const first = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Investigate incident" })
      .expect(201);
    const duplicate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Investigate incident", allowDuplicate: true })
      .expect(201);

    expect(duplicate.body.id).not.toBe(first.body.id);
  });

  it("does not apply the route soft guard to internal service creates", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const svc = issueService(db);

    const first = await svc.create(companyId, {
      parentId: parent.id,
      title: "System-generated follow-up",
      status: "todo",
      priority: "medium",
    });
    const second = await svc.create(companyId, {
      parentId: parent.id,
      title: "System-generated follow-up",
      status: "todo",
      priority: "medium",
    });

    expect(second.id).not.toBe(first.id);
  });

  it("does not let closed or older issues block a recreate", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const oldIssueId = randomUUID();
    const closedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: oldIssueId,
        companyId,
        parentId: parent.id,
        title: "Retry old work",
        status: "todo",
        priority: "medium",
        createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000),
      },
      {
        id: closedIssueId,
        companyId,
        parentId: parent.id,
        title: "Retry closed work",
        status: "done",
        priority: "medium",
      },
    ]);

    const recreatedOld = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Retry old work" })
      .expect(201);
    const recreatedClosed = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Retry closed work" })
      .expect(201);

    expect(recreatedOld.body.id).not.toBe(oldIssueId);
    expect(recreatedClosed.body.id).not.toBe(closedIssueId);
  });

  it("stores the request run header on manual creates", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();
    const runId = randomUUID();
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Creating agent",
      role: "engineer",
      status: "active",
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
    });

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ parentId: parent.id, title: "Attributed create" })
      .expect(201);
    const [created] = await db.select().from(issues).where(eq(issues.id, response.body.id));

    expect(created.originKind).toBe("manual");
    expect(created.originRunId).toBe(runId);
  });

  describe("versioned exhaust identity creates", () => {
    const exhaustIdentity = `exhaust:v2:${"a".repeat(64)}`;

    it("canonicalizes identity whitespace before fingerprinting and persistence", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const svc = issueService(db);
      const idempotencyKey = "canonical-whitespace-key";

      const first = await svc.create(companyId, {
        parentId: parent.id,
        title: "Canonical finding",
        exhaustIdentity: `  ${exhaustIdentity}  `,
        idempotencyKey,
      });
      const replay = await svc.create(companyId, {
        parentId: parent.id,
        title: "Canonical finding",
        exhaustIdentity,
        idempotencyKey,
      });

      expect(replay.id).toBe(first.id);
      expect(first.exhaustIdentity).toBe(exhaustIdentity);
      expect(await db.select().from(issues).where(eq(issues.exhaustIdentity, exhaustIdentity))).toHaveLength(1);
    });

    it("rejects a non-fingerprinted replay of an existing fingerprinted key", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const app = createApp();
      const idempotencyKey = "fingerprinted-key-without-identity";

      const first = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Fingerprinted finding", exhaustIdentity, idempotencyKey })
        .expect(201);
      const conflict = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Fingerprinted finding", idempotencyKey })
        .expect(409);

      expect(conflict.body.error).toMatch(/idempotency key.*different request/i);
      const persistedIssues = await db.select().from(issues);
      expect(persistedIssues).toHaveLength(2);
      expect(persistedIssues).toContainEqual(expect.objectContaining({ id: first.body.id, exhaustIdentity }));
      expect(await db.select().from(issueCreateIdempotencyKeys)).toHaveLength(1);
    });

    it("durably replays the same key and fingerprint while preserving a terminal receipt", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const app = createApp();
      const body = {
        parentId: parent.id,
        title: "File review finding",
        description: "A stable semantic request",
        exhaustIdentity,
      };

      const first = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .set("Idempotency-Key", "exhaust-run-1:finding-a")
        .send(body)
        .expect(201);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.body.id));
      await db.update(issueCreateIdempotencyKeys).set({
        createdAt: new Date(
          Date.now() - (ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
        ),
      }).where(eq(issueCreateIdempotencyKeys.issueId, first.body.id));

      const replay = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .set("Idempotency-Key", "exhaust-run-1:finding-a")
        .send(body)
        .expect(200);

      expect(replay.body).toMatchObject({
        id: first.body.id,
        identifier: first.body.identifier,
        companyId,
        parentId: parent.id,
        exhaustIdentity,
        status: "done",
        deduplicated: true,
        deduplicationReason: "idempotency_key",
      });
      const mappings = await db.select().from(issueCreateIdempotencyKeys);
      expect(mappings).toHaveLength(1);
      expect(mappings[0]?.requestFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it("rejects a changed semantic request under the same versioned key", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const app = createApp();
      const idempotencyKey = "exhaust-run-2:finding-a";

      const first = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Original finding", exhaustIdentity, idempotencyKey })
        .expect(201);
      const conflict = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title: "Changed finding", exhaustIdentity, idempotencyKey })
        .expect(409);

      expect(conflict.body.error).toMatch(/idempotency key.*different request/i);
      expect(await db.select().from(issues).where(eq(issues.exhaustIdentity, exhaustIdentity))).toEqual([
        expect.objectContaining({ id: first.body.id, title: "Original finding" }),
      ]);
    });

    it("serializes distinct keys for one identity and rejects conflicting semantics", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const app = createApp();
      const create = (idempotencyKey: string, title = "Concurrent finding") => request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ parentId: parent.id, title, exhaustIdentity, idempotencyKey });

      const [first, second] = await Promise.all([
        create("exhaust-run-3:key-a"),
        create("exhaust-run-3:key-b"),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 201]);
      expect(first.body.id).toBe(second.body.id);
      const identityReplay = first.status === 200 ? first : second;
      expect(identityReplay.body).toMatchObject({
        deduplicated: true,
        deduplicationReason: "exhaust_identity",
      });
      expect(await db.select().from(issues).where(eq(issues.exhaustIdentity, exhaustIdentity))).toHaveLength(1);
      expect(await db.select().from(issueCreateIdempotencyKeys)).toHaveLength(2);

      const changed = await create("exhaust-run-3:key-c", "Conflicting finding");
      expect(changed.status).toBe(409);
      expect(changed.body.error).toMatch(/identity.*different request/i);
      expect(await db.select().from(issues).where(eq(issues.exhaustIdentity, exhaustIdentity))).toHaveLength(1);
    });

    it("keeps identities company-scoped and returns an exact authoritative receipt", async () => {
      const firstCompanyId = await seedCompany();
      const secondCompanyId = await seedCompany();
      const firstParent = await seedParent(firstCompanyId);
      const secondParent = await seedParent(secondCompanyId);
      const app = createApp();

      const first = await request(app)
        .post(`/api/companies/${firstCompanyId}/issues`)
        .send({
          parentId: firstParent.id,
          title: "First company finding",
          exhaustIdentity,
          idempotencyKey: "first-company-key",
        })
        .expect(201);
      const second = await request(app)
        .post(`/api/companies/${secondCompanyId}/issues`)
        .send({
          parentId: secondParent.id,
          title: "Second company finding",
          exhaustIdentity,
          idempotencyKey: "second-company-key",
        })
        .expect(201);

      expect(first.body.id).not.toBe(second.body.id);
      await request(app)
        .get(`/api/companies/${firstCompanyId}/issues/by-exhaust-identity`)
        .query({ identity: exhaustIdentity })
        .expect(200, {
          id: first.body.id,
          identifier: first.body.identifier,
          companyId: firstCompanyId,
          parentId: firstParent.id,
          exhaustIdentity,
          status: "backlog",
        });
      await request(app)
        .get(`/api/companies/${secondCompanyId}/issues/by-exhaust-identity`)
        .query({ identity: exhaustIdentity })
        .expect(200, {
          id: second.body.id,
          identifier: second.body.identifier,
          companyId: secondCompanyId,
          parentId: secondParent.id,
          exhaustIdentity,
          status: "backlog",
        });
    });

    it("rejects malformed or missing identity input and cross-company agent lookup", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Scoped agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      await request(createApp())
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "Missing key", exhaustIdentity })
        .expect(400);
      await request(createApp())
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "Malformed identity", exhaustIdentity: "exhaust:v2:not-a-hash", idempotencyKey: "bad" })
        .expect(400);
      await request(createApp())
        .post(`/api/companies/${companyId}/issues`)
        .set("Idempotency-Key", "header-key")
        .send({ title: "Conflicting key sources", exhaustIdentity, idempotencyKey: "body-key" })
        .expect(400);
      await request(createApp())
        .get(`/api/companies/${companyId}/issues/by-exhaust-identity`)
        .expect(400);
      await request(createApp())
        .get(`/api/companies/${companyId}/issues/by-exhaust-identity`)
        .query({ identity: "exhaust:v2:not-a-hash" })
        .expect(400);
      await request(createAgentApp(companyId, agentId))
        .get(`/api/companies/${otherCompanyId}/issues/by-exhaust-identity`)
        .query({ identity: exhaustIdentity })
        .expect(403);
    });

    it("does not treat a legacy mapping as fingerprint-equivalent", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        parentId: parent.id,
        title: "Legacy mapping target",
        status: "todo",
        priority: "medium",
      });
      await db.insert(issueCreateIdempotencyKeys).values({
        companyId,
        idempotencyKey: "legacy-mapping-key",
        issueId,
      });

      const response = await request(createApp())
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          title: "Versioned request",
          exhaustIdentity,
          idempotencyKey: "legacy-mapping-key",
        })
        .expect(409);

      expect(response.body.error).toMatch(/legacy idempotency mapping/i);
      expect(await db.select().from(issues)).toHaveLength(2);
    });

    it.each([
      { caseName: "has no mapping", legacyFingerprint: undefined },
      { caseName: "has a null-fingerprint mapping", legacyFingerprint: null },
    ])("fails closed when an identity winner $caseName", async ({ legacyFingerprint }) => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        parentId: parent.id,
        exhaustIdentity,
        title: "Legacy identity winner",
        status: "done",
        priority: "medium",
      });
      if (legacyFingerprint === null) {
        await db.insert(issueCreateIdempotencyKeys).values({
          companyId,
          idempotencyKey: "legacy-winner-key",
          issueId,
          requestFingerprint: legacyFingerprint,
        });
      }

      const response = await request(createApp())
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          title: "Legacy identity winner",
          exhaustIdentity,
          idempotencyKey: "new-versioned-key",
        })
        .expect(409);

      expect(response.body.error).toMatch(/identity.*different request/i);
      const mappings = await db.select().from(issueCreateIdempotencyKeys);
      if (legacyFingerprint === null) {
        expect(mappings).toEqual([
          expect.objectContaining({
            issueId,
            idempotencyKey: "legacy-winner-key",
            requestFingerprint: null,
          }),
        ]);
      } else {
        expect(mappings).toEqual([]);
      }
    });

    it("fails closed when an identity winner has a different durable fingerprint", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        parentId: parent.id,
        exhaustIdentity,
        title: "Existing identity winner",
        status: "todo",
        priority: "medium",
      });
      await db.insert(issueCreateIdempotencyKeys).values({
        companyId,
        idempotencyKey: "existing-versioned-key",
        issueId,
        requestFingerprint: `sha256:${"b".repeat(64)}`,
      });

      await request(createApp())
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          title: "Existing identity winner",
          exhaustIdentity,
          idempotencyKey: "new-versioned-key",
        })
        .expect(409);

      expect(await db.select().from(issueCreateIdempotencyKeys)).toHaveLength(1);
    });
  });
});
