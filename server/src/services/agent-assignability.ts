import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  getAgentWorkEligibility,
  type AgentEligibilityAgent,
  type AgentOrgChainHealth,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type AgentAssignmentKind = "work" | "routine";

type AssignabilityAgent = AgentEligibilityAgent;

type AgentAssignmentConflictReason =
  | "pending_approval"
  | "assignee_paused"
  | "assignee_terminated"
  | "assignee_unknown_status"
  | "ancestor_terminated"
  | "ancestor_missing"
  | "ancestor_cross_company"
  | "ancestor_cycle"
  | "ancestor_depth_exceeded";

function assignmentMessage(kind: AgentAssignmentKind, reason: AgentAssignmentConflictReason) {
  if (reason === "assignee_paused") {
    return "Cannot start work for a paused agent";
  }
  if (reason === "pending_approval") {
    return kind === "routine"
      ? "Cannot assign routines to pending approval agents"
      : "Cannot assign work to pending approval agents";
  }
  if (reason === "assignee_terminated") {
    return kind === "routine"
      ? "Cannot assign routines to terminated agents"
      : "Cannot assign work to terminated agents";
  }
  if (reason === "assignee_unknown_status") {
    return kind === "routine"
      ? "Cannot assign routines to agents with an unsupported lifecycle status"
      : "Cannot assign work to agents with an unsupported lifecycle status";
  }
  return kind === "routine"
    ? "Cannot assign routines to agents with an invalid org chain"
    : "Cannot assign work to agents with an invalid org chain";
}

function conflictDetails(input: {
  companyId: string;
  assigneeAgentId: string;
  reason: AgentAssignmentConflictReason;
  chain: AssignabilityAgent[];
  invalidAncestorAgentId?: string | null;
  missingAncestorAgentId?: string | null;
}) {
  return {
    code: "agent_not_assignable",
    reason: input.reason,
    companyId: input.companyId,
    assigneeAgentId: input.assigneeAgentId,
    invalidAncestorAgentId: input.invalidAncestorAgentId ?? null,
    missingAncestorAgentId: input.missingAncestorAgentId ?? null,
    ancestorChain: input.chain.map((agent) => ({
      id: agent.id,
      companyId: agent.companyId,
      status: agent.status,
      reportsTo: agent.reportsTo,
    })),
  };
}

async function getAgent(db: Db, agentId: string, lockForUpdate = false): Promise<AssignabilityAgent | null> {
  const query = db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.id, agentId));
  const rows = lockForUpdate ? await query.for("update") : await query;
  return rows[0] ?? null;
}

async function listCompanyAgents(db: Db, companyId: string, lockForUpdate = false): Promise<AssignabilityAgent[]> {
  const query = db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.companyId, companyId))
    .orderBy(agents.id);
  return lockForUpdate ? query.for("update") : query;
}

function assignmentReasonFromHealth(health: AgentOrgChainHealth): AgentAssignmentConflictReason {
  if (health.reason === "terminated_ancestor") return "ancestor_terminated";
  if (health.reason === "missing_manager") return "ancestor_missing";
  if (health.reason === "cycle") return "ancestor_cycle";
  return "ancestor_missing";
}

export async function assertAssignableAgent(
  db: Db,
  companyId: string,
  agentId: string | null | undefined,
  options: {
    kind?: AgentAssignmentKind;
    lockForUpdate?: boolean;
    requireInvokable?: boolean;
  } = {},
) {
  if (!agentId) return;
  const kind = options.kind ?? "work";
  const companyAgents = await listCompanyAgents(db, companyId, options.lockForUpdate);
  const assignee = companyAgents.find((candidate) => candidate.id === agentId)
    ?? await getAgent(db, agentId, options.lockForUpdate);
  if (!assignee) throw notFound("Assignee agent not found");
  if (assignee.companyId !== companyId) {
    throw unprocessable("Assignee must belong to same company");
  }

  const eligibility = getAgentWorkEligibility({ agent: assignee, agents: companyAgents });
  const chain = eligibility.orgChainHealth.fullChain.map((entry) => ({
    id: entry.id,
    companyId: entry.companyId,
    name: entry.name,
    status: entry.status,
    reportsTo: entry.reportsTo,
  }));

  const eligibilityReason = options.requireInvokable
    ? eligibility.invokabilityReason
    : eligibility.assignabilityReason;
  if (eligibilityReason === "eligible") return;

  if (eligibilityReason === "paused") {
    throw conflict(assignmentMessage(kind, "assignee_paused"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "assignee_paused",
      chain,
    }));
  }
  if (eligibilityReason === "pending_approval") {
    throw conflict(assignmentMessage(kind, "pending_approval"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "pending_approval",
      chain,
    }));
  }
  if (eligibilityReason === "terminated") {
    throw conflict(assignmentMessage(kind, "assignee_terminated"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "assignee_terminated",
      chain,
    }));
  }
  if (eligibilityReason === "unknown_status") {
    throw conflict(assignmentMessage(kind, "assignee_unknown_status"), conflictDetails({
      companyId,
      assigneeAgentId: agentId,
      reason: "assignee_unknown_status",
      chain,
    }));
  }

  const reason = assignmentReasonFromHealth(eligibility.orgChainHealth);
  const firstInvalidAncestor = eligibility.orgChainHealth.firstInvalidAncestor;
  throw conflict(assignmentMessage(kind, reason), conflictDetails({
    companyId,
    assigneeAgentId: agentId,
    reason,
    chain,
    invalidAncestorAgentId:
      firstInvalidAncestor && firstInvalidAncestor.status !== "missing"
        ? firstInvalidAncestor.id
        : null,
    missingAncestorAgentId:
      firstInvalidAncestor?.status === "missing"
        ? firstInvalidAncestor.id
        : null,
  }));
}
