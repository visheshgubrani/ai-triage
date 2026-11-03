-- Review guards: the database enforces what approvals rely on, not only the app (docs/architecture.md §4).
-- Each guard raises integrity_constraint_violation (23000), like reject_mutation() in 0002_rls.sql.

-- Decisions are the review queue's audit trail: insert-only.
CREATE TRIGGER review_decisions_immutable BEFORE UPDATE OR DELETE ON review_decisions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- An action's payload is frozen at approval; only its delivery bookkeeping may change.
CREATE FUNCTION actions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND to_jsonb(NEW) - ARRAY['status', 'attempts', 'last_error', 'delivered_at', 'updated_at']
       = to_jsonb(OLD) - ARRAY['status', 'attempts', 'last_error', 'delivered_at', 'updated_at'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'actions: only delivery columns may change (% rejected)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

CREATE TRIGGER actions_immutable BEFORE UPDATE OR DELETE ON actions
  FOR EACH ROW EXECUTE FUNCTION actions_guard();
--> statement-breakpoint

-- An extraction revision never changes, except that route records its decision on it once.
-- Edits are new revisions (author = 'user'), so an approval always binds to unchanged values.
CREATE FUNCTION extractions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.decision IS NULL
     AND to_jsonb(NEW) - ARRAY['gate_results', 'score', 'decision', 'decision_reasons']
       = to_jsonb(OLD) - ARRAY['gate_results', 'score', 'decision', 'decision_reasons'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'extractions are immutable; route may record a decision once (% rejected)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

CREATE TRIGGER extractions_immutable BEFORE UPDATE OR DELETE ON extractions
  FOR EACH ROW EXECUTE FUNCTION extractions_guard();
