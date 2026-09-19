/**
 * A run that crashed (failed/cancelled/timed_out) or was killed (interrupted) had no opportunity to
 * comment and is not evidence of unproductivity. Only a succeeded run that stayed silent counts.
 */
export const PRODUCTIVE_TERMINAL_RUN_STATUSES = ["succeeded"] as const;
export const UNPRODUCTIVE_TERMINAL_RUN_STATUSES = ["interrupted", "failed", "cancelled", "timed_out"] as const;
export const TERMINAL_RUN_STATUSES = [
  ...PRODUCTIVE_TERMINAL_RUN_STATUSES,
  ...UNPRODUCTIVE_TERMINAL_RUN_STATUSES,
] as const;

function includesInList(list: ReadonlyArray<string>, value: string): boolean {
  return list.includes(value);
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

/**
 * Runs are newest-first. A run-created comment ends the streak whatever the run status; a
 * non-productive run without a comment is skipped (neither counted nor a break).
 */
export function countProductiveNoCommentStreak(
  runs: ReadonlyArray<{ id: string; status: string }>,
  commentRunIds: ReadonlySet<string>
): number {
  let streak = 0;
  for (const run of runs) {
    if (commentRunIds.has(run.id)) {
      break;
    }
    if (!isProductiveTerminalRunStatus(run.status)) {
      continue;
    }
    streak++;
  }
  return streak;
}
