import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentRuntimeState, agentTaskSessions, agents, issues } from "@paperclipai/db";
import type {
  AgentRuntimeConfig,
  AgentStatus,
  PullAgentLifecycle,
  PullAgentLifecycleEvidence,
  PullAgentLifecycleReport,
  PullAgentLifecycleState,
} from "@paperclipai/shared";

const DEFAULT_PULL_LEASE_TTL_SEC = 120;
const REPORT_STATE_KEY = "pullLifecycleReport";
const REPORT_RUNTIME_KEY = "pullLifecycle";
const NATIVE_SESSION_LIMIT = 20;
const MUTABLE_AGENT_STATUS = new Set<AgentStatus>(["idle", "running", "error", "active"]);

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

export function agentStatusFromPullLifecycle(state: PullAgentLifecycleState): AgentStatus | null {
  if (state === "running") return "running";
  if (state === "idle" || state === "idle_queued" || state === "unreachable") return "idle";
  return null;
}

/** Prefer the native runtime-state lease; fall back to runtimeConfig.pullLifecycle
 *  so a host reporter can persist evidence through the existing agent PATCH before
 *  /lifecycle-report is deployed. */
export function resolveStoredPullReport(
  runtimeStateJson: unknown,
  runtimeConfig: unknown,
): StoredPullAgentLifecycleReport | null {
  const fromState = asStoredReport(asRecord(runtimeStateJson)[REPORT_STATE_KEY]);
  if (fromState) return fromState;
  return asStoredReport(asRecord(runtimeConfig)[REPORT_RUNTIME_KEY]);
}

function isFreshLease(report: StoredPullAgentLifecycleReport | null, now: Date): boolean {
  if (!report) return false;
  const expiresAt = new Date(report.expiresAt);
  return !Number.isNaN(expiresAt.getTime()) && expiresAt > now;
}

export function derivePullAgentLifecycle(input: {
  runtimeConfig: AgentRuntimeConfig;
  storedReport: StoredPullAgentLifecycleReport | null;
  queuedIssueCount: number;
  blockedIssueCount: number;
  nativeEvidence?: PullAgentLifecycleEvidence[];
  now?: Date;
}): PullAgentLifecycle {
  const executionModel = input.runtimeConfig.executionModel === "pull" ? "pull" : "push";
  const dispatchEnabled = executionModel === "push"
    || input.runtimeConfig.pull?.dispatchEnabled === true;
  const report = input.storedReport;
  const observedAt = report ? new Date(report.observedAt) : null;
  const expiresAt = report ? new Date(report.expiresAt) : null;
  const now = input.now ?? new Date();
  const nativeEvidence = input.nativeEvidence ?? [];
  const reportFresh = isFreshLease(report, now);
  const evidence = [...(reportFresh ? report?.evidence ?? [] : []), ...nativeEvidence];
  const nativeActive = nativeEvidence.some((item) => item.active);

  let state: PullAgentLifecycle["state"];
  if (executionModel === "push") {
    state = "idle";
  } else if (!reportFresh && !nativeActive) {
    state = "unreachable";
  } else if (reportFresh && report?.state === "blocked") {
    state = "blocked";
  } else if (
    nativeActive
    || (reportFresh && (report?.state === "running" || evidence.some((item) => item.active)))
  ) {
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
    source: reportFresh ? report?.source ?? null : nativeActive ? "task_session" : null,
    evidence,
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

  async function nativeEvidence(agent: typeof agents.$inferSelect, now: Date) {
    const runtimeConfig = agent.runtimeConfig as AgentRuntimeConfig;
    const ttlSec = runtimeConfig.pull?.leaseTtlSec ?? DEFAULT_PULL_LEASE_TTL_SEC;
    const rows = await db
      .select({
        id: agentTaskSessions.id,
        taskKey: agentTaskSessions.taskKey,
        sessionDisplayId: agentTaskSessions.sessionDisplayId,
        updatedAt: agentTaskSessions.updatedAt,
      })
      .from(agentTaskSessions)
      .where(and(
        eq(agentTaskSessions.companyId, agent.companyId),
        eq(agentTaskSessions.agentId, agent.id),
      ))
      .orderBy(desc(agentTaskSessions.updatedAt))
      .limit(NATIVE_SESSION_LIMIT);
    return rows.map((row): PullAgentLifecycleEvidence => {
      const updatedAt = row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
      const ageMs = now.getTime() - updatedAt.getTime();
      return {
        kind: "task_session",
        id: row.sessionDisplayId || row.taskKey || row.id,
        active: Number.isFinite(ageMs) && ageMs >= 0 && ageMs < ttlSec * 1_000,
        observedAt: Number.isNaN(updatedAt.getTime()) ? undefined : updatedAt.toISOString(),
        detail: row.taskKey,
      };
    });
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
    const [counts, sessions] = await Promise.all([
      issueCounts(agent.companyId, agent.id),
      nativeEvidence(agent, now),
    ]);
    return derivePullAgentLifecycle({
      runtimeConfig: agent.runtimeConfig as AgentRuntimeConfig,
      storedReport: resolveStoredPullReport(runtimeState?.stateJson, agent.runtimeConfig),
      nativeEvidence: sessions,
      ...counts,
      now,
    });
  }

  async function syncAgentStatus(
    agent: typeof agents.$inferSelect,
    lifecycle: PullAgentLifecycle,
    now: Date,
  ) {
    const next = agentStatusFromPullLifecycle(lifecycle.state);
    if (!next) return;
    if (!MUTABLE_AGENT_STATUS.has(agent.status as AgentStatus)) return;
    if (agent.status === next) return;
    await db.update(agents).set({ status: next, updatedAt: now }).where(eq(agents.id, agent.id));
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

    const lifecycle = await get(agent, now);
    await syncAgentStatus(agent, lifecycle, now);
    return lifecycle;
  }

  async function reconcile(agent: typeof agents.$inferSelect, now = new Date()) {
    const lifecycle = await get(agent, now);
    await syncAgentStatus(agent, lifecycle, now);
    return lifecycle;
  }

  async function reconcilePullAgents(
    candidates: Array<typeof agents.$inferSelect>,
    now = new Date(),
  ) {
    let reconciled = 0;
    for (const agent of candidates) {
      const runtimeConfig = agent.runtimeConfig as AgentRuntimeConfig;
      if (runtimeConfig.executionModel !== "pull") continue;
      await reconcile(agent, now);
      reconciled += 1;
    }
    return reconciled;
  }

  return { get, report, reconcile, reconcilePullAgents };
}
