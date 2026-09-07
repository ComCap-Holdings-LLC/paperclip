ALTER TABLE "heartbeat_runs" ADD COLUMN "external_executor_run_key" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "external_executor_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "external_executor_expected_version" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "external_executor_hold_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "external_executor_visible" boolean;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "external_executor_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_external_executor_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("external_executor_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "heartbeat_runs_external_executor_run_key_uq" ON "heartbeat_runs" USING btree ("company_id","external_executor_run_key") WHERE "heartbeat_runs"."external_executor_run_key" is not null;
