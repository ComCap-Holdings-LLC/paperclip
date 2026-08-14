import { describe, expect, it } from "vitest";
import { derivePullAgentLifecycle } from "../services/pull-agent-lifecycle.js";

const now = new Date("2026-08-14T20:00:00.000Z");

function report(overrides: Record<string, unknown> = {}) {
  return {
    source: "resident-seat",
    observedAt: "2026-08-14T19:59:30.000Z",
    expiresAt: "2026-08-14T20:01:30.000Z",
    evidence: [],
    ...overrides,
  } as never;
}

describe("derivePullAgentLifecycle", () => {
  it("treats a pull agent with no fresh lease as unreachable", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: null,
      queuedIssueCount: 3,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle.state).toBe("unreachable");
    expect(lifecycle.dispatchEnabled).toBe(false);
  });

  it("derives running from active process evidence", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({ evidence: [{ kind: "external_lease", active: true }] }),
      queuedIssueCount: 2,
      blockedIssueCount: 1,
      now,
    });

    expect(lifecycle.state).toBe("running");
    expect(lifecycle.source).toBe("resident-seat");
  });

  it("distinguishes an idle pull agent that has queued work", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({ state: "idle" }),
      queuedIssueCount: 2,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle.state).toBe("idle_queued");
  });

  it("lets an explicit blocked report override queued work", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({ state: "blocked" }),
      queuedIssueCount: 2,
      blockedIssueCount: 1,
      now,
    });

    expect(lifecycle.state).toBe("blocked");
  });

  it("marks an expired report unreachable", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: { executionModel: "pull" },
      storedReport: report({ expiresAt: "2026-08-14T19:59:59.999Z", state: "running" }),
      queuedIssueCount: 0,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle.state).toBe("unreachable");
  });

  it("keeps push agents dispatchable without pull evidence", () => {
    const lifecycle = derivePullAgentLifecycle({
      runtimeConfig: {},
      storedReport: null,
      queuedIssueCount: 0,
      blockedIssueCount: 0,
      now,
    });

    expect(lifecycle).toMatchObject({ executionModel: "push", state: "idle", dispatchEnabled: true });
  });
});
