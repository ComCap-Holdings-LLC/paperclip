import { describe, expect, it } from "vitest";
import { resolveAgentHeartbeatDispatchPolicy } from "../services/heartbeat.js";

describe("pull-agent heartbeat dispatch policy", () => {
  it("keeps existing push agents dispatchable", () => {
    expect(resolveAgentHeartbeatDispatchPolicy({})).toEqual({
      executionModel: "push",
      dispatchEnabled: true,
    });
    expect(resolveAgentHeartbeatDispatchPolicy({ executionModel: "push" })).toEqual({
      executionModel: "push",
      dispatchEnabled: true,
    });
  });

  it("does not dispatch pull agents by default", () => {
    expect(resolveAgentHeartbeatDispatchPolicy({ executionModel: "pull" })).toEqual({
      executionModel: "pull",
      dispatchEnabled: false,
    });
    expect(resolveAgentHeartbeatDispatchPolicy({
      executionModel: "pull",
      pull: { dispatchEnabled: false },
    })).toEqual({
      executionModel: "pull",
      dispatchEnabled: false,
    });
  });

  it("dispatches pull agents only when explicitly enabled", () => {
    expect(resolveAgentHeartbeatDispatchPolicy({
      executionModel: "pull",
      pull: { dispatchEnabled: true },
    })).toEqual({
      executionModel: "pull",
      dispatchEnabled: true,
    });
  });
});
