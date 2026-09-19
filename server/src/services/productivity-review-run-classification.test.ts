import { describe, expect, it } from "vitest";
import {
  PRODUCTIVE_TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  UNPRODUCTIVE_TERMINAL_RUN_STATUSES,
  countProductiveNoCommentStreak,
  countUnproductiveTerminalRuns,
} from "./productivity-review-run-classification.js";

const mk = (statuses: string[]) => statuses.map((status, i) => ({ id: `r${i}`, status }));

describe("productivity review run classification", () => {
  it("derives TERMINAL from the two subsets and treats interrupted as non-productive", () => {
    expect([...TERMINAL_RUN_STATUSES].sort()).toEqual(
      [...PRODUCTIVE_TERMINAL_RUN_STATUSES, ...UNPRODUCTIVE_TERMINAL_RUN_STATUSES].sort(),
    );
    expect(PRODUCTIVE_TERMINAL_RUN_STATUSES).toEqual(["succeeded"]);
    expect(UNPRODUCTIVE_TERMINAL_RUN_STATUSES).toContain("interrupted");
  });

  it("returns 0 for ten failed runs with empty Set", () => {
    expect(countProductiveNoCommentStreak(mk(Array(10).fill("failed")), new Set())).toBe(0);
  });

  it("returns 10 for ten succeeded runs with empty Set", () => {
    expect(countProductiveNoCommentStreak(mk(Array(10).fill("succeeded")), new Set())).toBe(10);
  });

  it("skips (does not break on) a silent failed run between succeeded runs", () => {
    expect(countProductiveNoCommentStreak(mk(["succeeded", "failed", "succeeded"]), new Set())).toBe(2);
  });

  it("does not count interrupted runs", () => {
    expect(countProductiveNoCommentStreak(mk(["succeeded", "interrupted", "succeeded"]), new Set())).toBe(2);
  });

  it("stops at a productive run with a comment", () => {
    expect(countProductiveNoCommentStreak(mk(["succeeded", "succeeded", "failed", "succeeded"]), new Set(["r3"]))).toBe(2);
  });

  it("breaks the streak on a comment made by a non-productive run", () => {
    // r1 is a failed run that carried a comment: the older succeeded runs must not be counted.
    expect(countProductiveNoCommentStreak(mk(["succeeded", "failed", "succeeded", "succeeded"]), new Set(["r1"]))).toBe(1);
    expect(countProductiveNoCommentStreak(mk(["timed_out", "succeeded"]), new Set(["r0"]))).toBe(0);
  });

  it("counts unproductive terminal runs including interrupted", () => {
    expect(countUnproductiveTerminalRuns(mk(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]))).toBe(4);
  });
});
