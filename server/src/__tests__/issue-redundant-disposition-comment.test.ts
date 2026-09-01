import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  findRedundantSelfDispositionComment,
  isNearDuplicateDispositionComment,
} from "../routes/issues.js";

type FakeCommentRow = {
  id: string;
  body: string;
  authorUserId: string | null;
  authorAgentId: string | null;
  deletedAt: Date | null;
};

// Minimal stand-in for the drizzle chain
// `db.select({...}).from(issueComments).where(...).orderBy(...).limit(1).then(...)`
// used by findRedundantSelfDispositionComment. `.limit()` resolves the rows,
// matching real drizzle where `.limit()` returns a thenable query.
function fakeDbReturning(rows: FakeCommentRow[]): Db {
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => Promise.resolve(rows),
  };
  return builder as unknown as Db;
}

const BASE_INPUT = {
  companyId: "company-1",
  issueId: "issue-1",
  actorType: "user" as const,
  actorId: "user-1",
  issueStatus: "blocked",
};

describe("isNearDuplicateDispositionComment", () => {
  it("treats byte-identical text as a duplicate", () => {
    expect(
      isNearDuplicateDispositionComment(
        "Preservation only, still blocked on review.",
        "Preservation only, still blocked on review.",
      ),
    ).toBe(true);
  });

  it("treats near-identical text (minor wording/formatting drift) as a duplicate", () => {
    expect(
      isNearDuplicateDispositionComment(
        "## Status\nPreservation only — still blocked on open review verdict. No new blockers.",
        "## Status\nPreservation only, still blocked on open review verdict. No new blockers found.",
      ),
    ).toBe(true);
  });

  it("does not treat materially different text as a duplicate", () => {
    expect(
      isNearDuplicateDispositionComment(
        "Preservation only, still blocked on open review verdict.",
        "Review verdict resolved; merging the fix now and closing out the blocker.",
      ),
    ).toBe(false);
  });

  it("does not discard materially different fenced evidence", () => {
    expect(
      isNearDuplicateDispositionComment(
        "Still blocked.\n```\nError: migration timed out after 10s\n```",
        "Still blocked.\n```\nError: migration timed out after 20s\n```",
      ),
    ).toBe(false);
  });

  it("treats empty input as not duplicate", () => {
    expect(isNearDuplicateDispositionComment("", "still blocked")).toBe(false);
    expect(isNearDuplicateDispositionComment("still blocked", "")).toBe(false);
  });
});

describe("findRedundantSelfDispositionComment", () => {
  it("(a) returns the prior comment when same actor + same disposition + no new fact", async () => {
    const db = fakeDbReturning([
      {
        id: "comment-1",
        body: "Preservation only, still blocked on open review verdict.",
        authorUserId: "user-1",
        authorAgentId: null,
        deletedAt: null,
      },
    ]);

    const result = await findRedundantSelfDispositionComment(db, {
      ...BASE_INPUT,
      commentBody: "Preservation only, still blocked on open review verdict.",
    });

    expect(result).toEqual({
      id: "comment-1",
      body: "Preservation only, still blocked on open review verdict.",
    });
  });

  it("(b) negative control: returns null when the disposition/comment text changed", async () => {
    const db = fakeDbReturning([
      {
        id: "comment-1",
        body: "Preservation only, still blocked on open review verdict.",
        authorUserId: "user-1",
        authorAgentId: null,
        deletedAt: null,
      },
    ]);

    const result = await findRedundantSelfDispositionComment(db, {
      ...BASE_INPUT,
      commentBody: "Review verdict resolved; merging the fix now and closing out the blocker.",
    });

    expect(result).toBeNull();
  });

  it("(b) negative control: returns null when a different actor posted the prior comment", async () => {
    const db = fakeDbReturning([
      {
        id: "comment-1",
        body: "Preservation only, still blocked on open review verdict.",
        authorUserId: "some-other-user",
        authorAgentId: null,
        deletedAt: null,
      },
    ]);

    const result = await findRedundantSelfDispositionComment(db, {
      ...BASE_INPUT,
      commentBody: "Preservation only, still blocked on open review verdict.",
    });

    expect(result).toBeNull();
  });

  it("(b) negative control: returns null when the issue status is outside the closeout set", async () => {
    const db = fakeDbReturning([
      {
        id: "comment-1",
        body: "Preservation only, still blocked on open review verdict.",
        authorUserId: "user-1",
        authorAgentId: null,
        deletedAt: null,
      },
    ]);

    const result = await findRedundantSelfDispositionComment(db, {
      ...BASE_INPUT,
      issueStatus: "in_progress",
      commentBody: "Preservation only, still blocked on open review verdict.",
    });

    expect(result).toBeNull();
  });

  it("returns null when there is no prior comment", async () => {
    const db = fakeDbReturning([]);

    const result = await findRedundantSelfDispositionComment(db, {
      ...BASE_INPUT,
      commentBody: "Preservation only, still blocked on open review verdict.",
    });

    expect(result).toBeNull();
  });

  it("returns null when the prior comment was soft-deleted", async () => {
    const db = fakeDbReturning([
      {
        id: "comment-1",
        body: "Preservation only, still blocked on open review verdict.",
        authorUserId: "user-1",
        authorAgentId: null,
        deletedAt: new Date(),
      },
    ]);

    const result = await findRedundantSelfDispositionComment(db, {
      ...BASE_INPUT,
      commentBody: "Preservation only, still blocked on open review verdict.",
    });

    expect(result).toBeNull();
  });

  it("matches on agent authorship when actorType is agent", async () => {
    const db = fakeDbReturning([
      {
        id: "comment-1",
        body: "Preservation only, still blocked on open review verdict.",
        authorUserId: null,
        authorAgentId: "agent-1",
        deletedAt: null,
      },
    ]);

    const result = await findRedundantSelfDispositionComment(db, {
      ...BASE_INPUT,
      actorType: "agent",
      actorId: "agent-1",
      commentBody: "Preservation only, still blocked on open review verdict.",
    });

    expect(result).toEqual({
      id: "comment-1",
      body: "Preservation only, still blocked on open review verdict.",
    });
  });

  // Sol's reproduced finding (adversarial review of the original PR): a
  // long, information-dense status template where only the named blocking
  // resource changes computed Jaccard = 0.935+ — above the 0.92 threshold —
  // and was silently swallowed. Pure Jaccard-over-unique-tokens is diluted
  // by shared boilerplate vocabulary in a long comment, so a few genuinely
  // new content words (here: which system is actually blocking) get
  // buried. This must never be suppressed, however similar the rest of the
  // template reads.
  it("does NOT suppress a long status comment when only the named blocker changes (Sol repro)", async () => {
    const priorBody =
      "Status update: this issue remains blocked pending an external approval that is outside our control. " +
      "The deployment pipeline, the staging environment, and the automated test suite are all green and ready " +
      "to proceed the moment the approval lands. We have escalated through the standard channel and pinged the " +
      "owning team twice this week with no response yet. No code changes are needed on our side once the " +
      "approval clears — the merge, deploy, and verification steps are all pre-staged and can run within " +
      "minutes. We are specifically blocked on cloudflare token approval, which is required before the DNS " +
      "record can be rotated safely. Will keep monitoring and post again once we hear back or after the next " +
      "scheduled check-in.";
    const newBody =
      "Status update: this issue remains blocked pending an external approval that is outside our control. " +
      "The deployment pipeline, the staging environment, and the automated test suite are all green and ready " +
      "to proceed the moment the approval lands. We have escalated through the standard channel and pinged the " +
      "owning team twice this week with no response yet. No code changes are needed on our side once the " +
      "approval clears — the merge, deploy, and verification steps are all pre-staged and can run within " +
      "minutes. We are specifically blocked on dwd scope approval, which is required before the DNS " +
      "record can be rotated safely. Will keep monitoring and post again once we hear back or after the next " +
      "scheduled check-in.";

    // Confirm this pair is exactly the shape Sol reproduced: overall
    // similarity clears the old bare-Jaccard threshold even though the
    // blocking resource named in the comment is genuinely different.
    expect(isNearDuplicateDispositionComment(priorBody, newBody)).toBe(false);

    const db = fakeDbReturning([
      {
        id: "comment-1",
        body: priorBody,
        authorUserId: "user-1",
        authorAgentId: null,
        deletedAt: null,
      },
    ]);

    const result = await findRedundantSelfDispositionComment(db, {
      ...BASE_INPUT,
      commentBody: newBody,
    });

    expect(result).toBeNull();
  });
});
