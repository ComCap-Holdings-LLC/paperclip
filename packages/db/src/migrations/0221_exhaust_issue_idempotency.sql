ALTER TABLE "issue_create_idempotency_keys"
  ADD COLUMN "request_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "issues"
  ADD COLUMN "exhaust_identity" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "issues_company_exhaust_identity_uq"
  ON "issues" USING btree ("company_id", "exhaust_identity")
  WHERE "issues"."exhaust_identity" IS NOT NULL;

-- Intentionally no historical backfill: descriptions are not an authoritative
-- identity source, and ambiguous legacy markers must be quarantined/audited by
-- a separate follow-up before any row receives an exhaust identity.
