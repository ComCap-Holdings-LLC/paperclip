CREATE TABLE "exhaust_issue_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  "source_issue_id" uuid NOT NULL,
  "work_parent_id" uuid NOT NULL,
  "delivery_fingerprint" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "exhaust_issue_aliases_kind_check" CHECK ("kind" IN ('identity_v1', 'legacy_hash')),
  CONSTRAINT "exhaust_issue_aliases_value_check" CHECK (
    ("kind" = 'identity_v1' AND "value" ~ '^exhaust-finding:v1:sha256:[a-f0-9]{64}$') OR
    ("kind" = 'legacy_hash' AND "value" ~ '^[a-f0-9]{16}$')
  ),
  CONSTRAINT "exhaust_issue_aliases_delivery_fingerprint_check" CHECK (
    "delivery_fingerprint" IS NULL OR "delivery_fingerprint" ~ '^sha256:[a-f0-9]{64}$'
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "exhaust_issue_aliases_issue_kind_value_uq"
  ON "exhaust_issue_aliases" USING btree ("issue_id", "kind", "value");
--> statement-breakpoint
CREATE INDEX "exhaust_issue_aliases_lookup_idx"
  ON "exhaust_issue_aliases" USING btree ("company_id", "kind", "value", "source_issue_id", "work_parent_id");
--> statement-breakpoint
CREATE TABLE "exhaust_alias_backfill_state" (
  "company_id" uuid PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "cursor_issue_id" uuid,
  "status" text DEFAULT 'pending' NOT NULL,
  "processed_count" integer DEFAULT 0 NOT NULL,
  "skipped_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "exhaust_alias_backfill_state_status_check" CHECK ("status" IN ('pending', 'complete', 'failed'))
);

-- Historical prose is deliberately not scanned. The service incrementally reads
-- only the leading structured control block, validates its explicit parent/source
-- scope, and records skipped rows for operational follow-up.
