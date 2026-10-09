import { describe, expect, it } from "vitest";
import {
  shouldAutoCheckoutIssueForWake,
  shouldReopenClosedIssueForDeferredCommentWake,
} from "../services/heartbeat.ts";

describe("shouldReopenClosedIssueForDeferredCommentWake", () => {
  const closed = {
    hasComment: true,
    selfAuthored: false,
    issueStatus: "done" as const,
    wakeReason: "issue_commented",
    resumeIntent: false,
  };

  it("does not reopen a done issue for an ordinary human comment wake", () => {
    expect(shouldReopenClosedIssueForDeferredCommentWake(closed)).toBe(false);
  });

  it("does not treat actor type as intent — a user-requested comment wake stays closed", () => {
    expect(shouldReopenClosedIssueForDeferredCommentWake({
      ...closed,
      issueStatus: "cancelled",
    })).toBe(false);
  });

  it("reopens when the wake reason is the explicit comment reopen", () => {
    expect(shouldReopenClosedIssueForDeferredCommentWake({
      ...closed,
      wakeReason: "issue_reopened_via_comment",
    })).toBe(true);
  });

  it("reopens a cancelled issue when resume intent was recorded on the wake", () => {
    expect(shouldReopenClosedIssueForDeferredCommentWake({
      ...closed,
      issueStatus: "cancelled",
      resumeIntent: true,
    })).toBe(true);
  });

  it("does not reopen an open issue or a self-authored batch", () => {
    expect(shouldReopenClosedIssueForDeferredCommentWake({
      ...closed,
      issueStatus: "in_progress",
      wakeReason: "issue_reopened_via_comment",
    })).toBe(false);
    expect(shouldReopenClosedIssueForDeferredCommentWake({
      ...closed,
      selfAuthored: true,
      wakeReason: "issue_reopened_via_comment",
    })).toBe(false);
  });
});

describe("shouldAutoCheckoutIssueForWake", () => {
  it("auto-checks out an assigned todo issue for an actionable wake", () => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_assigned" },
      issueStatus: "todo",
      issueAssigneeAgentId: "agent-1",
      isDependencyReady: true,
      agentId: "agent-1",
    })).toBe(true);
  });

  it("does not auto-checkout pending execution-review state even if the row status is todo", () => {
    const reviewerAgentId = "11111111-1111-4111-8111-111111111111";
    const coderAgentId = "22222222-2222-4222-8222-222222222222";
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_recovery_action_restored" },
      issueStatus: "todo",
      issueAssigneeAgentId: reviewerAgentId,
      issueExecutionState: {
        status: "pending",
        currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      isDependencyReady: true,
      agentId: reviewerAgentId,
    })).toBe(false);
  });
});
