import { describe, expect, it } from "vitest";
import { countProductiveNoCommentStreak, countUnproductiveTerminalRuns } from "./productivity-review-run-classification.js";

const mk = (statuses: string[]) => statuses.map((status, i) => ({ id: `r${i}`, status }));

describe("productivity review run classification", () => {
  it("returns 0 for ten failed runs with empty Set", () => {
    const runs = mk(["failed", "failed", "failed", "failed", "failed", "failed", "failed", "failed", "failed", "failed"]);
    expect(countProductiveNoCommentStreak(runs, new Set())).toBe(0);
  });

  it("returns 10 for ten succeeded runs with empty Set", () => {
    const runs = mk(["succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded", "succeeded"]);
    expect(countProductiveNoCommentStreak(runs, new Set())).toBe(10);
  });

  it("returns 2 for mixed runs where failed run stops at productive run with comment", () => {
    const runs = mk(["succeeded", "succeeded", "failed", "succeeded"]);
    expect(countProductiveNoCommentStreak(runs, new Set(["r3"]))).toBe(2);
  });

  it("returns 3 for unproductive terminal runs", () => {
    const runs = mk(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
    expect(countUnproductiveTerminalRuns(runs)).toBe(3);
  });
});