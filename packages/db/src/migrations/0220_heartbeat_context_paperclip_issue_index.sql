-- COM-12977: this index was applied directly to paperclip-eu's live Postgres on 2026-08-29
-- (COM-12939) to stop full parallel seq scans on heartbeat_runs for the
-- context_snapshot->'paperclipIssue'->>'id' lookup path, but was never ported into a tracked
-- migration -- so a future schema rebuild from these migrations would silently drop it and
-- reintroduce the same 30-60s API timeouts. IF NOT EXISTS makes this a no-op against
-- paperclip-eu, where the index already exists, and a real CREATE everywhere else.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_paperclip_issue_id_idx" ON "heartbeat_runs" USING btree ("company_id", (("context_snapshot" -> 'paperclipIssue' ->> 'id')), "created_at" DESC);
