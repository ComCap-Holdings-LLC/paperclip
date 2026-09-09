CREATE TABLE "exhaust_issue_alias_conflicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  "source_issue_id" uuid NOT NULL,
  "work_parent_id" uuid NOT NULL,
  "delivery_fingerprint" text,
  "reason" text NOT NULL,
  "quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "exhaust_issue_alias_conflicts_issue_kind_value_uq"
  ON "exhaust_issue_alias_conflicts" USING btree ("issue_id", "kind", "value");
--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY company_id, kind, value, source_issue_id, work_parent_id
    ORDER BY created_at ASC, issue_id ASC, id ASC
  ) AS claim_rank
  FROM exhaust_issue_aliases
)
INSERT INTO exhaust_issue_alias_conflicts
  (company_id, issue_id, kind, value, source_issue_id, work_parent_id, delivery_fingerprint, reason)
SELECT a.company_id, a.issue_id, a.kind, a.value, a.source_issue_id, a.work_parent_id,
       a.delivery_fingerprint, 'migration_duplicate_claim'
FROM exhaust_issue_aliases a
JOIN ranked r ON r.id = a.id
WHERE r.claim_rank > 1
ON CONFLICT (issue_id, kind, value) DO NOTHING;
--> statement-breakpoint
DELETE FROM exhaust_issue_aliases a
USING exhaust_issue_alias_conflicts q
WHERE q.issue_id = a.issue_id
  AND q.kind = a.kind
  AND q.value = a.value
  AND q.reason = 'migration_duplicate_claim';
--> statement-breakpoint
CREATE UNIQUE INDEX "exhaust_issue_aliases_company_scope_claim_uq"
  ON "exhaust_issue_aliases" USING btree
  ("company_id", "kind", "value", "source_issue_id", "work_parent_id");
