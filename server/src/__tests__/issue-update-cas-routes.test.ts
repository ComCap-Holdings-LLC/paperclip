import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issueComments, issueRelations, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

// COM-12697: PATCH /issues/:id had no compare-and-swap primitive, unlike
// checkout's existing expectedStatuses -- so a caller doing
// read-then-conditionally-write (e.g. the unblock poller) could silently
// clobber a concurrent status change. These route-level tests exercise the
// full stack (real routes, real DB, real error-handler middleware), which is
// what actually proves the service's conflict() throw reaches the caller as
// an HTTP 409 rather than, say, an uncaught 500 or a swallowed rejection.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue update CAS route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("PATCH /issues/:id expectedStatuses (CAS guard)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-update-cas-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  async function seedIssue(status: "todo" | "blocked" | "in_progress" | "done") {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "CAS guard route issue",
      status,
      priority: "medium",
    });
    return { companyId, issueId };
  }

  it("returns 409 and leaves the row untouched when expectedStatuses no longer matches", async () => {
    const { companyId, issueId } = await seedIssue("blocked");

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "high", expectedStatuses: ["todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      details: { issueId, expectedStatuses: ["todo"], currentStatus: "blocked" },
    });

    const row = await db
      .select({ status: issues.status, priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ status: "blocked", priority: "medium" });
  });

  it("applies the write when expectedStatuses matches the current status", async () => {
    const { companyId, issueId } = await seedIssue("blocked");

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "high", expectedStatuses: ["blocked", "todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.priority).toBe("high");

    const row = await db
      .select({ priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ priority: "high" });
  });

  it("rejects a matched-then-diverged status even when the write also changes status", async () => {
    // Guards against a fix that only checks expectedStatuses against the
    // incoming status field (which wouldn't exist for a same-status update)
    // instead of against the issue's actual current row.
    const { companyId, issueId } = await seedIssue("done");

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo", expectedStatuses: ["in_progress"] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ status: "done" });
  });

  it("does not require expectedStatuses -- omitting it keeps the unconditional PATCH working", async () => {
    const { companyId, issueId } = await seedIssue("todo");

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send({ priority: "high" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.priority).toBe("high");
  });

  // Fable review (xreview, correctness lens): prove the schema is actually
  // enforced at the HTTP boundary via `validate(updateIssueRouteSchema)` --
  // req.body is the schema's *parsed output* by the time the handler reads
  // it (validate() does `req.body = schema.parse(req.body)` before calling
  // next()), so a malformed expectedStatuses must never reach the service as
  // unvalidated input (e.g. a bare string satisfying `.length > 0` with
  // substring semantics instead of array semantics, or a non-array throwing
  // inside svc.update rather than being rejected up front).
  it.each([
    { label: "a bare string instead of an array", body: { priority: "high", expectedStatuses: "todo" } },
    { label: "an empty array", body: { priority: "high", expectedStatuses: [] } },
    { label: "a value outside the issue status enum", body: { priority: "high", expectedStatuses: ["bogus"] } },
    { label: "a number", body: { priority: "high", expectedStatuses: 1 } },
  ])("returns 400 for expectedStatuses as $label, never reaching the service", async ({ body }) => {
    const { companyId, issueId } = await seedIssue("todo");

    const res = await request(createApp(boardActor(companyId)))
      .patch(`/api/issues/${issueId}`)
      .send(body);

    expect(res.status, JSON.stringify(res.body)).toBe(400);

    const row = await db
      .select({ priority: issues.priority })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ priority: "medium" });
  });
});
