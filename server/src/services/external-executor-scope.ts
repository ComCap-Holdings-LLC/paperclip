import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { conflict } from "../errors.js";

type ScopeDb = Pick<Db, "execute" | "select">;

export async function lockExternalExecutorScope(db: ScopeDb, companyId: string) {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:external-executor-scope:${companyId}`}, 0))`);
}

async function listScopeIssues(db: ScopeDb, companyId: string) {
  return db
    .select({
      id: issues.id,
      parentId: issues.parentId,
      projectId: issues.projectId,
      externalExecutorRunId: issues.externalExecutorRunId,
    })
    .from(issues)
    .where(eq(issues.companyId, companyId));
}

export async function assertIssueSubtreeHasNoExternalExecutor(
  db: ScopeDb,
  companyId: string,
  rootIssueId: string,
) {
  const rows = await listScopeIssues(db, companyId);
  const descendants = new Set([rootIssueId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.parentId && descendants.has(row.parentId) && !descendants.has(row.id)) {
        descendants.add(row.id);
        changed = true;
      }
    }
  }
  const bound = rows.find((row) => descendants.has(row.id) && row.externalExecutorRunId);
  if (bound) {
    throw conflict("Cannot move or reparent a scope containing an active external executor run", {
      issueId: bound.id,
      externalExecutorRunId: bound.externalExecutorRunId,
    });
  }
}

export async function assertProjectScopeHasNoExternalExecutor(
  db: ScopeDb,
  companyId: string,
  projectId: string,
) {
  const rows = await listScopeIssues(db, companyId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (!row.externalExecutorRunId) continue;
    let current: typeof row | undefined = row;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.projectId === projectId) {
        throw conflict("Cannot pause a project containing an active external executor run", {
          issueId: row.id,
          externalExecutorRunId: row.externalExecutorRunId,
          projectId,
        });
      }
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
}
