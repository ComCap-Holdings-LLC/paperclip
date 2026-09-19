/** A run that failed before producing output had no opportunity to comment and is therefore not evidence of unproductivity. */
export const PRODUCTIVE_TERMINAL_RUN_STATUSES = ["succeeded", "interrupted"] as const;
export const UNPRODUCTIVE_TERMINAL_RUN_STATUSES = ["failed", "cancelled", "timed_out"] as const;
export const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;

function includesInList(list: ReadonlyArray<string>, value: string): boolean {
  return (list as ReadonlyArray<string>).includes(value);
}

export function isProductiveTerminalRunStatus(status: string): boolean {
  return includesInList(PRODUCTIVE_TERMINAL_RUN_STATUSES, status);
}

export function countUnproductiveTerminalRuns(runs: ReadonlyArray<{ status: string }>): number {
  let count = 0;
  for (const run of runs) {
    if (includesInList(UNPRODUCTIVE_TERMINAL_RUN_STATUSES, run.status)) {
      count++;
    }
  }
  return count;
}

export function countProductiveNoCommentStreak(
  runs: ReadonlyArray<{ id: string; status: string }>,
  commentRunIds: ReadonlySet<string>
): number {
  let streak = 0;
  for (const run of runs) {
    if (!isProductiveTerminalRunStatus(run.status)) {
      continue;
    }
    if (commentRunIds.has(run.id)) {
      break;
    }
    streak++;
  }
  return streak;
}