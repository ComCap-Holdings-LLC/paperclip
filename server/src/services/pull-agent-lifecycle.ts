import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentRuntimeState, agents, issues } from "@paperclipai/db";
import type {
  AgentRuntimeConfig,
  PullAgentLifecycle,
  PullAgentLifecycleReport,
} from "@paperclipai/shared";

const DEFAULT_PULL_LEASE_TTL_SEC = 120;
const REPORT_STATE_KEY = "pullLifecycleReport";

interface StoredPullAgentLifecycleReport extends PullAgentLifecycleReport {
  observedAt: string;
  expiresAt: string;
}
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStoredReport(value: unknown): StoredPullAgentLifecycleReport | null {
  const row = asRecord(value);
  if (
    typeof row.source !== "string"
    || typeof row.observedAt !== "string"
    || typeof row.expiresAt !== "string"
  ) return null;
  return row as unknown as StoredPullAgentLifecycleReport;
}

export function derivePullAgentLifecycle(input: {
  runtimeConfig: AgentRuntimeConfig;
  storedReport: StoredPullAgentLifecycleReport | null;
  queuedIssueCount: number;
  blockedIssueCount: number;
  now?: Date;
}): PullAgentLifecycle {
  const executionModel = input.runtimeConfig.executionModel === "pull" ? "pull" : "push";
  const dispatchEnabled = executionModel === "push"
    || input.runtimeConfig.pull?.dispatchEnabled === true;
  const report = input.storedReport;
  const observedAt = report ? new Date(report.observedAt) : null;
  const expiresAt = report ? new Date(report.expiresAt) : null;
  const now = input.now ?? new Date();

  let state: PullAgentLifecycle["state"];
  if (executionModel === "push") {
    state = "idle";
  } else if (!report || !expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
    state = "unreachable";
  } else if (report.state === "blocked") {
    state = "blocked";
  } else if (report.state === "running" || report.evidence?.some((item) => item.active)) {
    state = "running";
  } else if (input.queuedIssueCount > 0) {
    state = "idle_queued";
  } else if (input.blockedIssueCount > 0) {
    state = "blocked";
  } else {
    state = "idle";
  }

  return {
    executionModel,
    state,
    source: report?.source ?? null,
    evidence: report?.evidence ?? [],
    observedAt: observedAt && !Number.isNaN(observedAt.getTime()) ? observedAt : null,
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    queuedIssueCount: input.queuedIssueCount,
    blockedIssueCount: input.blockedIssueCount,
    dispatchEnabled,
  };
}

export function pullAgentLifecycleService(db: Db) {
  async function issueCounts(companyId: string, agentId: string) {
    const rows = await db
      .select({ status: issues.status, count: sql<number>`count(*)::int` })
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
      ))
      .groupBy(issues.status);
    const count = (statuses: string[]) => rows
      .filter((row) => statuses.includes(row.status))
      .reduce((sum, row) => sum + Number(row.count), 0);
    return {
      queuedIssueCount: count(["backlog", "todo", "in_progress", "in_review"]),
      blockedIssueCount: count(["blocked"]),
    };
  }

  async function get(agent: typeof agents.$inferSelect, now = new Date()) {
    const runtimeState = await db
      .select({ stateJson: agentRuntimeState.stateJson })
      .from(agentRuntimeState)
      .where(and(
        eq(agentRuntimeState.companyId, agent.companyId),
        eq(agentRuntimeState.agentId, agent.id),
      ))
      .then((rows) => rows[0] ?? null);
    const counts = await issueCounts(agent.companyId, agent.id);
    return derivePullAgentLifecycle({
      runtimeConfig: agent.runtimeConfig as AgentRuntimeConfig,
      storedReport: asStoredReport(runtimeState?.stateJson?.[REPORT_STATE_KEY]),
      ...counts,
      now,
    });
  }

  async function report(agent: typeof agents.$inferSelect, input: PullAgentLifecycleReport, now = new Date()) {
    const runtimeConfig = agent.runtimeConfig as AgentRuntimeConfig;
    const ttlSec = input.leaseTtlSec
      ?? runtimeConfig.pull?.leaseTtlSec
      ?? DEFAULT_PULL_LEASE_TTL_SEC;
    const stored: StoredPullAgentLifecycleReport = {
      ...input,
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSec * 1_000).toISOString(),
    };
    const patch = { [REPORT_STATE_KEY]: stored };

    await db.insert(agentRuntimeState).values({
      agentId: agent.id,
      companyId: agent.companyId,
      adapterType: agent.adapterType,
      stateJson: patch,
    }).onConflictDoUpdate({
      target: agentRuntimeState.agentId,
      set: {
        stateJson: sql`${agentRuntimeState.stateJson} || ${JSON.stringify(patch)}::jsonb`,
        updatedAt: now,
      },
    });

    return get(agent, now);
  }

  return { get, report };
}
