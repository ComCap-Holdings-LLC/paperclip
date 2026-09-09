import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
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

    it("persists scoped aliases transactionally and resolves an authoritative terminal receipt", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const alias = `exhaust-finding:v1:sha256:${"b".repeat(64)}`;
      const deliveryFingerprint = `sha256:${"c".repeat(64)}`;

      const created = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          sourceIssueId: source.id,
          title: "Scoped alias finding",
          exhaustIdentity,
          exhaustAliases: [
            { kind: "identity_v1", value: alias },
            { kind: "legacy_hash", value: "d603cce66164f3f9" },
            { kind: "identity_v1", value: alias },
          ],
          deliveryFingerprint,
          idempotencyKey: "scoped-alias-key",
        })
        .expect(201);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, created.body.id));

      const lookup = await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "identity_v1", value: alias, sourceIssueId: source.id, workParentId: parent.id })
        .expect(200);
      expect(lookup.body).toEqual({
        id: created.body.id,
        identifier: created.body.identifier,
        companyId,
        parentId: parent.id,
        exhaustIdentity,
        status: "done",
        sourceIssueId: source.id,
        workParentId: parent.id,
        deliveryFingerprint,
      });
      const persistedAliases = Array.from(await db.execute(sql<{
        value: string;
        delivery_fingerprint: string | null;
      }>`
        select value, delivery_fingerprint
        from exhaust_issue_aliases
        where issue_id = ${created.body.id}::uuid
        order by value
      `));
      expect(persistedAliases).toHaveLength(2);
      expect(persistedAliases.every((row) => row.delivery_fingerprint === deliveryFingerprint)).toBe(true);

      const mismatchedAlias = `exhaust-finding:v1:sha256:${"9".repeat(64)}`;
      await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          sourceIssueId: source.id,
          title: "Scoped alias finding",
          exhaustIdentity,
          exhaustAliases: [{ kind: "identity_v1", value: mismatchedAlias }],
          deliveryFingerprint,
          idempotencyKey: "scoped-alias-mismatch-key",
        })
        .expect(409);
      await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "identity_v1", value: mismatchedAlias, sourceIssueId: source.id, workParentId: parent.id })
        .expect(404, { code: "EXHAUST_ALIAS_NOT_FOUND", error: "Exhaust alias not found" });

      await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "identity_v1", value: alias, sourceIssueId: parent.id, workParentId: parent.id })
        .expect(404, { code: "EXHAUST_ALIAS_NOT_FOUND", error: "Exhaust alias not found" });
    });

    it("returns typed ambiguity and readiness failures without selecting a candidate", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const alias = "d603cce66164f3f9";
      const deliveryFingerprint = `sha256:${"d".repeat(64)}`;
      const create = (identity: string, key: string) => request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          sourceIssueId: source.id,
          title: key,
          exhaustIdentity: identity,
          exhaustAliases: [{ kind: "legacy_hash", value: alias }],
          deliveryFingerprint,
          idempotencyKey: key,
        });
      await create(exhaustIdentity, "ambiguous-a").expect(201);
      const [historicalDuplicate] = await db.insert(issues).values({
        companyId,
        parentId: parent.id,
        title: "Pre-constraint ambiguous alias",
        status: "done",
        priority: "medium",
        exhaustIdentity: `exhaust:v2:${"e".repeat(64)}`,
      }).returning();
      await db.execute(sql`drop index exhaust_issue_aliases_company_scope_claim_uq`);
      try {
        await db.execute(sql`
          insert into exhaust_issue_aliases
            (company_id, issue_id, kind, value, source_issue_id, work_parent_id, delivery_fingerprint)
          values
            (${companyId}::uuid, ${historicalDuplicate.id}::uuid, 'legacy_hash', ${alias},
             ${source.id}::uuid, ${parent.id}::uuid, ${deliveryFingerprint})
        `);
        await request(app)
          .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
          .query({ kind: "legacy_hash", value: alias, sourceIssueId: source.id, workParentId: parent.id })
          .expect(409, { code: "EXHAUST_ALIAS_AMBIGUOUS", error: "Exhaust alias is ambiguous" });
        await db.execute(sql`
          update exhaust_alias_backfill_state
          set status = 'pending', cursor_issue_id = null
          where company_id = ${companyId}::uuid
        `);
        await db.execute(sql`
          create or replace function test_resolve_ambiguous_alias_after_ready()
          returns trigger language plpgsql as $$
          begin
            delete from exhaust_issue_aliases where issue_id = '${sql.raw(historicalDuplicate.id)}'::uuid;
            return new;
          end
          $$
        `);
        await db.execute(sql`
          create trigger test_resolve_ambiguous_alias_after_ready
          after update on exhaust_alias_backfill_state
          for each row when (new.status = 'complete')
          execute function test_resolve_ambiguous_alias_after_ready()
        `);
        await request(app)
          .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
          .query({ kind: "legacy_hash", value: alias, sourceIssueId: source.id, workParentId: parent.id })
          .expect(409, { code: "EXHAUST_ALIAS_CHANGED", error: "Exhaust alias changed during reconciliation" });
      } finally {
        await db.execute(sql`drop trigger if exists test_resolve_ambiguous_alias_after_ready on exhaust_alias_backfill_state`);
        await db.execute(sql`drop function if exists test_resolve_ambiguous_alias_after_ready()`);
        await db.execute(sql`delete from exhaust_issue_aliases where issue_id = ${historicalDuplicate.id}::uuid`);
        await db.execute(sql`
          create unique index exhaust_issue_aliases_company_scope_claim_uq
          on exhaust_issue_aliases (company_id, kind, value, source_issue_id, work_parent_id)
        `);
      }

      await db.execute(sql`
        insert into exhaust_alias_backfill_state
          (company_id, status, attempt_count, next_retry_at, last_error)
        values
          (${companyId}::uuid, 'failed', 1, now() + interval '1 hour', 'injected transient failure')
        on conflict (company_id) do update
          set status = excluded.status,
              attempt_count = excluded.attempt_count,
              next_retry_at = excluded.next_retry_at,
              last_error = excluded.last_error
      `);
      const [beforeRetry] = Array.from(await db.execute(sql<{ processed_count: number }>`
        select processed_count
        from exhaust_alias_backfill_state
        where company_id = ${companyId}::uuid
      `));
      await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "legacy_hash", value: "aaaaaaaaaaaaaaaa", sourceIssueId: source.id, workParentId: parent.id })
        .expect(503, { code: "EXHAUST_ALIAS_NOT_READY", error: "Exhaust alias index is not ready" });
      await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "legacy_hash", value: "aaaaaaaaaaaaaaaa", sourceIssueId: source.id, workParentId: parent.id })
        .expect(503, { code: "EXHAUST_ALIAS_NOT_READY", error: "Exhaust alias index is not ready" });
      const [immediateRetry] = Array.from(await db.execute(sql<{
        status: string;
        processed_count: number;
      }>`
        select status, processed_count
        from exhaust_alias_backfill_state
        where company_id = ${companyId}::uuid
      `));
      expect(immediateRetry).toEqual({ status: "failed", processed_count: beforeRetry.processed_count });

      await db.execute(sql`
        update exhaust_alias_backfill_state
        set next_retry_at = now() - interval '1 second'
        where company_id = ${companyId}::uuid
      `);
      await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "legacy_hash", value: "aaaaaaaaaaaaaaaa", sourceIssueId: source.id, workParentId: parent.id })
        .expect(404, { code: "EXHAUST_ALIAS_NOT_FOUND", error: "Exhaust alias not found" });
      const [recoveredState] = Array.from(await db.execute(sql<{
        status: string;
        last_error: string | null;
      }>`
        select status, last_error
        from exhaust_alias_backfill_state
        where company_id = ${companyId}::uuid
      `));
      expect(recoveredState).toEqual({ status: "complete", last_error: null });
    });

    it("returns a persisted scoped alias during backfill cooldown but keeps unknown aliases not-ready", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const alias = "abcdef0123456789";
      const deliveryFingerprint = `sha256:${"a".repeat(64)}`;
      const created = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          sourceIssueId: source.id,
          title: "Persisted alias during cooldown",
          exhaustIdentity,
          exhaustAliases: [{ kind: "legacy_hash", value: alias }],
          deliveryFingerprint,
          idempotencyKey: "persisted-alias-during-cooldown",
        })
        .expect(201);
      await db.execute(sql`
        insert into exhaust_alias_backfill_state
          (company_id, status, attempt_count, next_retry_at, last_error)
        values
          (${companyId}::uuid, 'failed', 1, now() + interval '1 hour', 'injected transient failure')
        on conflict (company_id) do update
          set status = excluded.status,
              attempt_count = excluded.attempt_count,
              next_retry_at = excluded.next_retry_at,
              last_error = excluded.last_error
      `);

      const persisted = await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "legacy_hash", value: alias, sourceIssueId: source.id, workParentId: parent.id })
        .expect(200);
      expect(persisted.body).toMatchObject({
        id: created.body.id,
        exhaustIdentity,
        sourceIssueId: source.id,
        workParentId: parent.id,
      });
      await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "legacy_hash", value: "0000000000000000", sourceIssueId: source.id, workParentId: parent.id })
        .expect(503, { code: "EXHAUST_ALIAS_NOT_READY", error: "Exhaust alias index is not ready" });
    });

    it.each(["pending", "failed"] as const)(
      "advances an eligible %s backfill even when the requested alias is already persisted",
      async (initialStatus) => {
        const companyId = await seedCompany();
        const parent = await seedParent(companyId);
        const source = await seedParent(companyId);
        const app = createApp();
        const persistedAlias = initialStatus === "pending" ? "1111111111111111" : "2222222222222222";
        const historicalHash = (initialStatus === "pending" ? "8" : "9").repeat(64);
        const historicalAlias = `exhaust-finding:v1:sha256:${historicalHash}`;
        const historicalIdentity = `exhaust:v2:${historicalHash}`;
        const created = await request(app)
          .post(`/api/companies/${companyId}/issues`)
          .send({
            parentId: parent.id,
            sourceIssueId: source.id,
            title: `Persisted ${initialStatus} alias`,
            exhaustIdentity: initialStatus === "pending"
              ? `exhaust:v2:${"1".repeat(64)}`
              : `exhaust:v2:${"2".repeat(64)}`,
            exhaustAliases: [{ kind: "legacy_hash", value: persistedAlias }],
            deliveryFingerprint: `sha256:${"b".repeat(64)}`,
            idempotencyKey: `persisted-${initialStatus}-alias`,
          })
          .expect(201);
        const [historical] = await db.insert(issues).values({
          companyId,
          parentId: parent.id,
          title: `Later ${initialStatus} historical alias`,
          status: "done",
          priority: "medium",
          exhaustIdentity: historicalIdentity,
          description: [
            historicalIdentity,
            `legacy-identity: ${historicalAlias}`,
            `parent-id: ${parent.id}`,
            `source-issue-id: ${source.id}`,
          ].join("\n"),
        }).returning();
        await db.execute(sql`
          insert into exhaust_alias_backfill_state
            (company_id, status, attempt_count, next_retry_at, last_error)
          values
            (${companyId}::uuid, ${initialStatus}, ${initialStatus === "failed" ? 1 : 0},
             ${initialStatus === "failed" ? sql`now() - interval '1 second'` : sql`null`},
             ${initialStatus === "failed" ? "injected transient failure" : null})
          on conflict (company_id) do update
            set status = excluded.status,
                attempt_count = excluded.attempt_count,
                next_retry_at = excluded.next_retry_at,
                last_error = excluded.last_error,
                cursor_issue_id = null
        `);

        const persisted = await request(app)
          .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
          .query({
            kind: "legacy_hash",
            value: persistedAlias,
            sourceIssueId: source.id,
            workParentId: parent.id,
          })
          .expect(200);
        expect(persisted.body.id).toBe(created.body.id);

        const [state] = Array.from(await db.execute(sql<{
          status: string;
          processed_count: number;
        }>`
          select status, processed_count
          from exhaust_alias_backfill_state
          where company_id = ${companyId}::uuid
        `));
        expect(state.status).toBe("complete");
        expect(state.processed_count).toBeGreaterThan(0);
        const backfilled = await request(app)
          .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
          .query({
            kind: "identity_v1",
            value: historicalAlias,
            sourceIssueId: source.id,
            workParentId: parent.id,
          })
          .expect(200);
        expect(backfilled.body.id).toBe(historical.id);
      },
    );

    it("returns retryable conflict when a persisted alias disappears during reconciliation", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const alias = "3333333333333333";
      const created = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          sourceIssueId: source.id,
          title: "Persisted alias hidden after readiness",
          exhaustIdentity: `exhaust:v2:${"3".repeat(64)}`,
          exhaustAliases: [{ kind: "legacy_hash", value: alias }],
          deliveryFingerprint: `sha256:${"c".repeat(64)}`,
          idempotencyKey: "persisted-alias-post-ready-transient",
        })
        .expect(201);
      await db.execute(sql`
        insert into exhaust_alias_backfill_state (company_id, status)
        values (${companyId}::uuid, 'pending')
        on conflict (company_id) do update
          set status = excluded.status,
              cursor_issue_id = null,
              next_retry_at = null
      `);
      await db.execute(sql`
        create or replace function test_drop_exhaust_alias_after_ready()
        returns trigger
        language plpgsql
        as $$
        begin
          delete from exhaust_issue_aliases where company_id = new.company_id;
          return new;
        end
        $$
      `);
      await db.execute(sql`
        create trigger test_drop_exhaust_alias_after_ready
        after update on exhaust_alias_backfill_state
        for each row
        when (new.status = 'complete')
        execute function test_drop_exhaust_alias_after_ready()
      `);

      try {
        await request(app)
          .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
          .query({ kind: "legacy_hash", value: alias, sourceIssueId: source.id, workParentId: parent.id })
          .expect(409, { code: "EXHAUST_ALIAS_CHANGED", error: "Exhaust alias changed during reconciliation" });
        const [state] = Array.from(await db.execute(sql<{ status: string }>`
          select status
          from exhaust_alias_backfill_state
          where company_id = ${companyId}::uuid
        `));
        expect(state.status).toBe("complete");
        const [remaining] = Array.from(await db.execute(sql<{ count: number }>`
          select count(*)::integer as count
          from exhaust_issue_aliases
          where company_id = ${companyId}::uuid
            and issue_id = ${created.body.id}::uuid
        `));
        expect(remaining.count).toBe(0);
      } finally {
        await db.execute(sql`drop trigger if exists test_drop_exhaust_alias_after_ready on exhaust_alias_backfill_state`);
        await db.execute(sql`drop function if exists test_drop_exhaust_alias_after_ready()`);
      }
    });

    it("returns retryable conflict when a persisted alias remaps during reconciliation", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const alias = "4444444444444444";
      const first = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          sourceIssueId: source.id,
          title: "Alias owner before reconciliation",
          exhaustIdentity: `exhaust:v2:${"4".repeat(64)}`,
          exhaustAliases: [{ kind: "legacy_hash", value: alias }],
          deliveryFingerprint: `sha256:${"d".repeat(64)}`,
          idempotencyKey: "alias-owner-before-reconciliation",
        })
        .expect(201);
      const [replacement] = await db.insert(issues).values({
        companyId,
        parentId: parent.id,
        title: "Alias owner after reconciliation",
        status: "done",
        priority: "medium",
        exhaustIdentity: `exhaust:v2:${"5".repeat(64)}`,
      }).returning();
      await db.execute(sql`
        insert into exhaust_alias_backfill_state (company_id, status)
        values (${companyId}::uuid, 'pending')
        on conflict (company_id) do update set status = 'pending', cursor_issue_id = null
      `);
      await db.execute(sql`
        create or replace function test_remap_exhaust_alias_after_ready()
        returns trigger language plpgsql as $$
        begin
          update exhaust_issue_aliases
          set issue_id = '${sql.raw(replacement.id)}'::uuid
          where company_id = new.company_id and issue_id = '${sql.raw(first.body.id)}'::uuid;
          return new;
        end
        $$
      `);
      await db.execute(sql`
        create trigger test_remap_exhaust_alias_after_ready
        after update on exhaust_alias_backfill_state
        for each row when (new.status = 'complete')
        execute function test_remap_exhaust_alias_after_ready()
      `);
      try {
        await request(app)
          .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
          .query({ kind: "legacy_hash", value: alias, sourceIssueId: source.id, workParentId: parent.id })
          .expect(409, { code: "EXHAUST_ALIAS_CHANGED", error: "Exhaust alias changed during reconciliation" });
      } finally {
        await db.execute(sql`drop trigger if exists test_remap_exhaust_alias_after_ready on exhaust_alias_backfill_state`);
        await db.execute(sql`drop function if exists test_remap_exhaust_alias_after_ready()`);
      }
    });

    it("atomically claims aliases in canonical order across reversed concurrent requests", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const alias = "5555555555555555";
      const identityAlias = `exhaust-finding:v1:sha256:${"5".repeat(64)}`;
      const aliases = [
        { kind: "identity_v1" as const, value: identityAlias },
        { kind: "legacy_hash" as const, value: alias },
      ];
      const create = (suffix: string, requestAliases: typeof aliases) => request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          sourceIssueId: source.id,
          title: "Concurrent alias claim",
          exhaustIdentity: `exhaust:v2:${suffix.repeat(64)}`,
          exhaustAliases: requestAliases,
          deliveryFingerprint: `sha256:${"e".repeat(64)}`,
          idempotencyKey: `concurrent-alias-${suffix}`,
        });

      const responses = await Promise.all([create("6", aliases), create("7", [...aliases].reverse())]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const claimed = Array.from(await db.execute(sql<{ issue_id: string; kind: string }>`
        select issue_id, kind from exhaust_issue_aliases
        where company_id = ${companyId}::uuid
          and ((kind = 'legacy_hash' and value = ${alias})
            or (kind = 'identity_v1' and value = ${identityAlias}))
        order by kind
      `));
      expect(claimed).toHaveLength(2);
      expect(new Set(claimed.map((row) => row.issue_id)).size).toBe(1);
    });

    it("quarantines a duplicate historical alias claim without displacing its owner", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const alias = "6666666666666666";
      const owner = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          sourceIssueId: source.id,
          title: "Canonical alias owner",
          exhaustIdentity: `exhaust:v2:${"8".repeat(64)}`,
          exhaustAliases: [{ kind: "legacy_hash", value: alias }],
          deliveryFingerprint: `sha256:${"f".repeat(64)}`,
          idempotencyKey: "canonical-alias-owner",
        })
        .expect(201);
      const [historical] = await db.insert(issues).values({
        companyId,
        parentId: parent.id,
        title: "Historical duplicate alias claimant",
        status: "done",
        priority: "medium",
        exhaustIdentity: `exhaust:v2:${"9".repeat(64)}`,
        description: [
          `exhaust:v2:${"9".repeat(64)}`,
          `exhaust-hash: ${alias}`,
          `parent-id: ${parent.id}`,
          `source-issue-id: ${source.id}`,
        ].join("\n"),
      }).returning();
      await db.execute(sql`
        insert into exhaust_alias_backfill_state (company_id, status)
        values (${companyId}::uuid, 'pending')
        on conflict (company_id) do update set status = 'pending', cursor_issue_id = null
      `);

      const lookup = await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "legacy_hash", value: alias, sourceIssueId: source.id, workParentId: parent.id })
        .expect(200);
      expect(lookup.body.id).toBe(owner.body.id);
      const conflicts = Array.from(await db.execute(sql<{ issue_id: string; reason: string }>`
        select issue_id, reason
        from exhaust_issue_alias_conflicts
        where company_id = ${companyId}::uuid
          and issue_id = ${historical.id}::uuid
          and kind = 'legacy_hash'
          and value = ${alias}
      `));
      expect(conflicts).toEqual([{ issue_id: historical.id, reason: "backfill_claim_conflict" }]);
    });

    it("retries a non-claim backfill fault when quarantine persistence fails", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const alias = "9090909090909090";
      const [historical] = await db.insert(issues).values({
        companyId,
        parentId: parent.id,
        title: "Historical alias with injected persistence fault",
        status: "done",
        priority: "medium",
        exhaustIdentity: `exhaust:v2:${"a".repeat(64)}`,
        description: [
          `exhaust:v2:${"a".repeat(64)}`,
          `exhaust-hash: ${alias}`,
          `parent-id: ${parent.id}`,
          `source-issue-id: ${source.id}`,
        ].join("\n"),
      }).returning();
      await db.execute(sql`
        create or replace function test_fail_nonclaim_alias_insert()
        returns trigger language plpgsql as $$
        begin
          if new.issue_id = '${sql.raw(historical.id)}'::uuid then
            raise exception 'injected non-claim persistence failure';
          end if;
          return new;
        end
        $$
      `);
      await db.execute(sql`
        create trigger test_fail_nonclaim_alias_insert
        before insert on exhaust_issue_aliases
        for each row execute function test_fail_nonclaim_alias_insert()
      `);
      await db.execute(sql`
        create or replace function test_fail_alias_quarantine_insert()
        returns trigger language plpgsql as $$
        begin
          if new.issue_id = '${sql.raw(historical.id)}'::uuid then
            raise exception 'injected quarantine persistence failure';
          end if;
          return new;
        end
        $$
      `);
      await db.execute(sql`
        create trigger test_fail_alias_quarantine_insert
        before insert on exhaust_issue_alias_conflicts
        for each row execute function test_fail_alias_quarantine_insert()
      `);
      await db.execute(sql`
        insert into exhaust_alias_backfill_state (company_id, status)
        values (${companyId}::uuid, 'pending')
        on conflict (company_id) do update set status = 'pending', cursor_issue_id = null
      `);

      try {
        await request(app)
          .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
          .query({ kind: "legacy_hash", value: alias, sourceIssueId: source.id, workParentId: parent.id })
          .expect(503, { code: "EXHAUST_ALIAS_NOT_READY", error: "Exhaust alias index is not ready" });
        const [failedState] = Array.from(await db.execute(sql<{
          status: string;
          cursor_issue_id: string | null;
          processed_count: number;
          skipped_count: number;
        }>`
          select status, cursor_issue_id, processed_count, skipped_count
          from exhaust_alias_backfill_state
          where company_id = ${companyId}::uuid
        `));
        expect(failedState).toEqual({
          status: "failed",
          cursor_issue_id: null,
          processed_count: 0,
          skipped_count: 0,
        });
        expect(Array.from(await db.execute(sql`
          select id from exhaust_issue_alias_conflicts where issue_id = ${historical.id}::uuid
        `))).toHaveLength(0);

        await db.execute(sql`drop trigger test_fail_alias_quarantine_insert on exhaust_issue_alias_conflicts`);
        await db.execute(sql`
          update exhaust_alias_backfill_state
          set next_retry_at = now() - interval '1 second'
          where company_id = ${companyId}::uuid
        `);
        await request(app)
          .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
          .query({ kind: "legacy_hash", value: alias, sourceIssueId: source.id, workParentId: parent.id })
          .expect(404, { code: "EXHAUST_ALIAS_NOT_FOUND", error: "Exhaust alias not found" });
        const [conflict] = Array.from(await db.execute(sql<{ reason: string }>`
          select reason
          from exhaust_issue_alias_conflicts
          where company_id = ${companyId}::uuid and issue_id = ${historical.id}::uuid
        `));
        expect(conflict.reason).toBe("backfill_persistence_error");
        const [recoveredState] = Array.from(await db.execute(sql<{
          status: string;
          cursor_issue_id: string | null;
          processed_count: number;
          skipped_count: number;
        }>`
          select status, cursor_issue_id, processed_count, skipped_count
          from exhaust_alias_backfill_state
          where company_id = ${companyId}::uuid
        `));
        expect(recoveredState).toEqual({
          status: "complete",
          cursor_issue_id: historical.id,
          processed_count: 1,
          skipped_count: 1,
        });
      } finally {
        await db.execute(sql`drop trigger if exists test_fail_alias_quarantine_insert on exhaust_issue_alias_conflicts`);
        await db.execute(sql`drop function if exists test_fail_alias_quarantine_insert()`);
        await db.execute(sql`drop trigger if exists test_fail_nonclaim_alias_insert on exhaust_issue_aliases`);
        await db.execute(sql`drop function if exists test_fail_nonclaim_alias_insert()`);
      }
    });

    it("prevents generic PATCH from releasing or remapping exhaust dedupe claims", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const replacementParent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const identity = `exhaust:v2:${"d".repeat(64)}`;
      const alias = "7777777777777777";
      const identityAlias = `exhaust-finding:v1:sha256:${"7".repeat(64)}`;
      const created = await request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({
          parentId: parent.id,
          sourceIssueId: source.id,
          title: "Immutable dedupe claims",
          exhaustIdentity: identity,
          exhaustAliases: [
            { kind: "legacy_hash", value: alias },
            { kind: "identity_v1", value: identityAlias },
          ],
          deliveryFingerprint: `sha256:${"1".repeat(64)}`,
          idempotencyKey: "immutable-dedupe-claims",
        })
        .expect(201);

      const unchangedPatch = await request(app).patch(`/api/issues/${created.body.id}`).send({
        sourceIssueId: source.id,
        exhaustAliases: [
          { kind: "legacy_hash", value: alias },
          { kind: "identity_v1", value: identityAlias },
          { kind: "legacy_hash", value: alias },
        ],
        deliveryFingerprint: `sha256:${"1".repeat(64)}`,
      });
      const storedControls = Array.from(await db.execute(sql`
        select kind, value, source_issue_id, delivery_fingerprint
        from exhaust_issue_aliases where issue_id = ${created.body.id}::uuid
      `));
      expect(storedControls).toEqual(expect.arrayContaining([
        {
          kind: "identity_v1",
          value: identityAlias,
          source_issue_id: source.id,
          delivery_fingerprint: `sha256:${"1".repeat(64)}`,
        },
        {
          kind: "legacy_hash",
          value: alias,
          source_issue_id: source.id,
          delivery_fingerprint: `sha256:${"1".repeat(64)}`,
        },
      ]));
      expect(storedControls).toHaveLength(2);
      expect(unchangedPatch.status, JSON.stringify(unchangedPatch.body)).toBe(200);

      await request(app).patch(`/api/issues/${created.body.id}`).send({ exhaustIdentity: null }).expect(409);
      await request(app).patch(`/api/issues/${created.body.id}`).send({ parentId: replacementParent.id }).expect(409);
      for (const changedControls of [
        { sourceIssueId: replacementParent.id },
        { sourceIssueId: null },
        { exhaustAliases: [{ kind: "legacy_hash", value: "8888888888888888" }] },
        { exhaustAliases: [] },
        { deliveryFingerprint: `sha256:${"2".repeat(64)}` },
        { deliveryFingerprint: null },
      ]) {
        await request(app).patch(`/api/issues/${created.body.id}`).send(changedControls).expect(409);
      }
      const [unchanged] = await db.select().from(issues).where(eq(issues.id, created.body.id));
      expect(unchanged).toMatchObject({ exhaustIdentity: identity, parentId: parent.id });
    });

    it("migration 0223 retains the canonical alias row and quarantines every identical loser", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const [issue] = await db.insert(issues).values({
        companyId,
        parentId: parent.id,
        title: "Duplicate migration fixture",
        status: "done",
        priority: "medium",
        exhaustIdentity: `exhaust:v2:${"e".repeat(64)}`,
      }).returning();
      const migration = readFileSync(
        new URL("../../../packages/db/src/migrations/0223_exhaust_alias_claims.sql", import.meta.url),
        "utf8",
      );
      const rollbackMarker = new Error("rollback migration fixture");
      const keeperAliasRowId = "10000000-0000-4000-8000-000000000001";
      const loserAliasRowIds = [
        "20000000-0000-4000-8000-000000000002",
        "30000000-0000-4000-8000-000000000003",
      ];

      await expect(db.transaction(async (tx) => {
        await tx.execute(sql`drop index exhaust_issue_aliases_company_scope_claim_uq`);
        await tx.execute(sql`drop index exhaust_issue_aliases_issue_kind_value_uq`);
        await tx.execute(sql`drop table exhaust_issue_alias_conflicts`);
        await tx.execute(sql`
          insert into exhaust_issue_aliases
            (id, company_id, issue_id, kind, value, source_issue_id, work_parent_id)
          values
            (${keeperAliasRowId}::uuid, ${companyId}::uuid, ${issue.id}::uuid, 'legacy_hash', 'abababababababab', ${source.id}::uuid, ${parent.id}::uuid),
            (${loserAliasRowIds[0]}::uuid, ${companyId}::uuid, ${issue.id}::uuid, 'legacy_hash', 'abababababababab', ${source.id}::uuid, ${parent.id}::uuid),
            (${loserAliasRowIds[1]}::uuid, ${companyId}::uuid, ${issue.id}::uuid, 'legacy_hash', 'abababababababab', ${source.id}::uuid, ${parent.id}::uuid)
        `);
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.execute(sql.raw(statement));
        }

        const retained = Array.from(await tx.execute(sql<{ id: string }>`
          select id from exhaust_issue_aliases
          where issue_id = ${issue.id}::uuid and kind = 'legacy_hash' and value = 'abababababababab'
        `));
        const quarantined = Array.from(await tx.execute(sql<{ alias_row_id: string }>`
          select alias_row_id from exhaust_issue_alias_conflicts
          where issue_id = ${issue.id}::uuid and kind = 'legacy_hash' and value = 'abababababababab'
          order by alias_row_id
        `));
        const indexes = Array.from(await tx.execute(sql<{ indexname: string }>`
          select indexname from pg_indexes
          where schemaname = current_schema()
            and indexname = 'exhaust_issue_aliases_company_scope_claim_uq'
        `));
        expect(retained).toEqual([{ id: keeperAliasRowId }]);
        expect(quarantined.map((row) => row.alias_row_id)).toEqual(loserAliasRowIds);
        expect(indexes).toHaveLength(1);
        throw rollbackMarker;
      })).rejects.toBe(rollbackMarker);
    });

    it("backfills only an explicit structured control block and validates alias input", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const alias = `exhaust-finding:v1:sha256:${"f".repeat(64)}`;
      const [historical] = await db.insert(issues).values({
        companyId,
        parentId: parent.id,
        title: "Historical structured finding",
        status: "cancelled",
        priority: "medium",
        exhaustIdentity,
        description: [
          exhaustIdentity,
          `legacy-identity: ${alias}`,
          "exhaust-hash: d603cce66164f3f9",
          `parent-id: ${parent.id}`,
          `source-issue-id: ${source.id}`,
          "",
          `forged prose legacy-identity: exhaust-finding:v1:sha256:${"0".repeat(64)}`,
        ].join("\n"),
      }).returning();
      await db.execute(sql`delete from exhaust_alias_backfill_state where company_id = ${companyId}`);

      const lookup = await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "identity_v1", value: alias, sourceIssueId: source.id, workParentId: parent.id })
        .expect(200);
      expect(lookup.body.id).toBe(historical.id);
      await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "identity_v1", value: `exhaust-finding:v1:sha256:${"0".repeat(64)}`, sourceIssueId: source.id, workParentId: parent.id })
        .expect(404);
      await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "legacy_hash", value: "not-a-hash", sourceIssueId: source.id, workParentId: parent.id })
        .expect(400);
    });

    it("quarantines a poison historical control block and advances to a later valid alias", async () => {
      const companyId = await seedCompany();
      const parent = await seedParent(companyId);
      const source = await seedParent(companyId);
      const app = createApp();
      const poisonId = "10000000-0000-4000-8000-000000000001";
      const validId = "20000000-0000-4000-8000-000000000002";
      const validAlias = `exhaust-finding:v1:sha256:${"7".repeat(64)}`;
      await db.insert(issues).values([
        {
          id: poisonId,
          companyId,
          parentId: parent.id,
          title: "Poison historical alias row",
          status: "cancelled",
          priority: "medium",
          exhaustIdentity: `exhaust:v2:${"6".repeat(64)}`,
          description: [
            `exhaust:v2:${"6".repeat(64)}`,
            `legacy-identity: exhaust-finding:v1:sha256:${"6".repeat(64)}`,
            `parent-id: ${parent.id}`,
            "source-issue-id: definitely-not-a-uuid",
          ].join("\n"),
        },
        {
          id: validId,
          companyId,
          parentId: parent.id,
          title: "Later valid historical alias row",
          status: "done",
          priority: "medium",
          exhaustIdentity: `exhaust:v2:${"7".repeat(64)}`,
          description: [
            `exhaust:v2:${"7".repeat(64)}`,
            `legacy-identity: ${validAlias}`,
            `parent-id: ${parent.id}`,
            `source-issue-id: ${source.id}`,
          ].join("\n"),
        },
      ]);
      await db.execute(sql`delete from exhaust_alias_backfill_state where company_id = ${companyId}`);

      const lookup = await request(app)
        .get(`/api/companies/${companyId}/issues/by-exhaust-alias`)
        .query({ kind: "identity_v1", value: validAlias, sourceIssueId: source.id, workParentId: parent.id })
        .expect(200);
      expect(lookup.body).toMatchObject({ id: validId, status: "done" });
      const [state] = Array.from(await db.execute(sql<{
        cursor_issue_id: string | null;
        status: string;
        processed_count: number;
        skipped_count: number;
        last_error: string | null;
      }>`
        select cursor_issue_id, status, processed_count, skipped_count, last_error
        from exhaust_alias_backfill_state
        where company_id = ${companyId}::uuid
      `));
      expect(state).toEqual({
        cursor_issue_id: validId,
        status: "complete",
        processed_count: 2,
        skipped_count: 1,
        last_error: `skipped issue ${poisonId}: invalid structured control block`,
      });
    });
  });
});
