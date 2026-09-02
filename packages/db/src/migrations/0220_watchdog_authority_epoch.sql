ALTER TABLE "issue_watchdogs" ADD COLUMN "authority_epoch" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_task_watchdog_authority_lineage(
  target_company_id uuid,
  target_issue_id uuid,
  target_parent_id uuid,
  target_visible boolean,
  target_can_ascend boolean
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT target_visible THEN
    RETURN;
  END IF;

  WITH RECURSIVE lineage(id, parent_id, can_ascend, depth) AS (
    SELECT target_issue_id, target_parent_id, target_can_ascend, 0
    UNION ALL
    SELECT parent.id,
           parent.parent_id,
           parent.origin_kind <> 'task_watchdog',
           lineage.depth + 1
      FROM issues parent
      JOIN lineage ON parent.id = lineage.parent_id
     WHERE lineage.can_ascend
       AND parent.company_id = target_company_id
       AND parent.hidden_at IS NULL
       AND parent.harness_kind IS NULL
       AND lineage.depth < 99
  )
  UPDATE issue_watchdogs
     SET authority_epoch = authority_epoch + 1
   WHERE company_id = target_company_id
     AND status = 'active'
     AND issue_id IN (SELECT id FROM lineage);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_task_watchdog_authority_for_issue(
  target_company_id uuid,
  target_issue_id_text text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  target issues%ROWTYPE;
BEGIN
  IF target_issue_id_text IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO target
    FROM issues
   WHERE company_id = target_company_id
     AND id::text = target_issue_id_text;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM bump_task_watchdog_authority_lineage(
    target.company_id,
    target.id,
    target.parent_id,
    target.hidden_at IS NULL AND target.harness_kind IS NULL,
    target.origin_kind <> 'task_watchdog'
  );
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_task_watchdog_authority_on_issue_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM bump_task_watchdog_authority_lineage(
      OLD.company_id,
      OLD.id,
      OLD.parent_id,
      OLD.hidden_at IS NULL AND OLD.harness_kind IS NULL,
      OLD.origin_kind <> 'task_watchdog'
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM bump_task_watchdog_authority_lineage(
      NEW.company_id,
      NEW.id,
      NEW.parent_id,
      NEW.hidden_at IS NULL AND NEW.harness_kind IS NULL,
      NEW.origin_kind <> 'task_watchdog'
    );
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER issues_bump_task_watchdog_authority
AFTER INSERT OR UPDATE OR DELETE ON issues
FOR EACH ROW EXECUTE FUNCTION bump_task_watchdog_authority_on_issue_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_task_watchdog_authority_on_direct_issue_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_row jsonb;
  new_row jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_row := to_jsonb(OLD);
    PERFORM bump_task_watchdog_authority_for_issue(
      (old_row ->> TG_ARGV[0])::uuid,
      old_row ->> TG_ARGV[1]
    );
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_row := to_jsonb(NEW);
    PERFORM bump_task_watchdog_authority_for_issue(
      (new_row ->> TG_ARGV[0])::uuid,
      new_row ->> TG_ARGV[1]
    );
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER issue_relations_bump_task_watchdog_authority
AFTER INSERT OR UPDATE OR DELETE ON issue_relations
FOR EACH ROW EXECUTE FUNCTION bump_task_watchdog_authority_on_direct_issue_change('company_id', 'related_issue_id');
--> statement-breakpoint
CREATE TRIGGER issue_thread_interactions_bump_task_watchdog_authority
AFTER INSERT OR UPDATE OR DELETE ON issue_thread_interactions
FOR EACH ROW EXECUTE FUNCTION bump_task_watchdog_authority_on_direct_issue_change('company_id', 'issue_id');
--> statement-breakpoint
CREATE TRIGGER issue_approvals_bump_task_watchdog_authority
AFTER INSERT OR UPDATE OR DELETE ON issue_approvals
FOR EACH ROW EXECUTE FUNCTION bump_task_watchdog_authority_on_direct_issue_change('company_id', 'issue_id');
--> statement-breakpoint
CREATE TRIGGER issue_comments_bump_task_watchdog_authority
AFTER INSERT OR UPDATE OR DELETE ON issue_comments
FOR EACH ROW EXECUTE FUNCTION bump_task_watchdog_authority_on_direct_issue_change('company_id', 'issue_id');
--> statement-breakpoint
CREATE TRIGGER issue_documents_bump_task_watchdog_authority
AFTER INSERT OR UPDATE OR DELETE ON issue_documents
FOR EACH ROW EXECUTE FUNCTION bump_task_watchdog_authority_on_direct_issue_change('company_id', 'issue_id');
--> statement-breakpoint
CREATE TRIGGER issue_work_products_bump_task_watchdog_authority
AFTER INSERT OR UPDATE OR DELETE ON issue_work_products
FOR EACH ROW EXECUTE FUNCTION bump_task_watchdog_authority_on_direct_issue_change('company_id', 'issue_id');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_task_watchdog_authority_on_approval_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  approval_company_id uuid;
  target_approval_id uuid;
  linked_issue record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    approval_company_id := NEW.company_id;
    target_approval_id := NEW.id;
  ELSE
    approval_company_id := OLD.company_id;
    target_approval_id := OLD.id;
  END IF;

  FOR linked_issue IN
    SELECT ia.issue_id::text AS issue_id
      FROM issue_approvals ia
     WHERE ia.company_id = approval_company_id
       AND ia.approval_id = target_approval_id
  LOOP
    PERFORM bump_task_watchdog_authority_for_issue(approval_company_id, linked_issue.issue_id);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approvals_bump_task_watchdog_authority
AFTER INSERT OR UPDATE OR DELETE ON approvals
FOR EACH ROW EXECUTE FUNCTION bump_task_watchdog_authority_on_approval_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_task_watchdog_authority_on_heartbeat_run_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_row jsonb;
  changed_company_id uuid;
  changed_run_id uuid;
  attached_issue record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    changed_row := to_jsonb(OLD);
    changed_company_id := OLD.company_id;
    changed_run_id := OLD.id;
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'context_snapshot' ->> 'issueId');
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'context_snapshot' ->> 'taskId');
    FOR attached_issue IN
      SELECT id::text AS id FROM issues
       WHERE company_id = changed_company_id AND execution_run_id = changed_run_id
    LOOP
      PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, attached_issue.id);
    END LOOP;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    changed_row := to_jsonb(NEW);
    changed_company_id := NEW.company_id;
    changed_run_id := NEW.id;
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'context_snapshot' ->> 'issueId');
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'context_snapshot' ->> 'taskId');
    FOR attached_issue IN
      SELECT id::text AS id FROM issues
       WHERE company_id = changed_company_id AND execution_run_id = changed_run_id
    LOOP
      PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, attached_issue.id);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER heartbeat_runs_bump_task_watchdog_authority
AFTER INSERT OR UPDATE OR DELETE ON heartbeat_runs
FOR EACH ROW EXECUTE FUNCTION bump_task_watchdog_authority_on_heartbeat_run_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_task_watchdog_authority_on_wakeup_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_row jsonb;
  changed_company_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    changed_row := to_jsonb(OLD);
    changed_company_id := OLD.company_id;
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'payload' ->> 'issueId');
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'payload' ->> 'taskId');
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'payload' -> '_paperclipWakeContext' ->> 'issueId');
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'payload' -> '_paperclipWakeContext' ->> 'taskId');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    changed_row := to_jsonb(NEW);
    changed_company_id := NEW.company_id;
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'payload' ->> 'issueId');
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'payload' ->> 'taskId');
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'payload' -> '_paperclipWakeContext' ->> 'issueId');
    PERFORM bump_task_watchdog_authority_for_issue(changed_company_id, changed_row -> 'payload' -> '_paperclipWakeContext' ->> 'taskId');
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_wakeup_requests_bump_task_watchdog_authority
AFTER INSERT OR UPDATE OR DELETE ON agent_wakeup_requests
FOR EACH ROW EXECUTE FUNCTION bump_task_watchdog_authority_on_wakeup_change();
