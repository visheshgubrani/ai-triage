-- Eval guards (docs/architecture.md §8): labels, results and finished runs can't be rewritten after
-- the fact, and the headline numbers (test split) only come from frozen configs.
-- Each guard raises integrity_constraint_violation (23000), like reject_mutation() in 0002_rls.sql.

-- An item's label and snapshot never change. A wrong label is retired (once) and replaced by a new item.
CREATE FUNCTION eval_items_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
     AND to_jsonb(NEW) - 'retired_at' = to_jsonb(OLD) - 'retired_at' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'eval_items are immutable; an item may only be retired, once (% rejected)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

CREATE TRIGGER eval_items_immutable BEFORE UPDATE OR DELETE ON eval_items
  FOR EACH ROW EXECUTE FUNCTION eval_items_guard();
--> statement-breakpoint

-- Results are graded once, when written.
CREATE TRIGGER eval_results_immutable BEFORE UPDATE OR DELETE ON eval_results
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- A run records its progress while queued or running; what it ran (dataset, split, config, mode) is
-- fixed, and a finished run (done or failed) never changes again.
CREATE FUNCTION eval_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status IN ('queued', 'running')
     AND to_jsonb(NEW) - ARRAY['status', 'aggregates', 'started_at', 'finished_at', 'error']
       = to_jsonb(OLD) - ARRAY['status', 'aggregates', 'started_at', 'finished_at', 'error'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'eval_runs: only an active run''s progress may change (% rejected)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

CREATE TRIGGER eval_runs_immutable BEFORE UPDATE OR DELETE ON eval_runs
  FOR EACH ROW EXECUTE FUNCTION eval_runs_guard();
--> statement-breakpoint

-- Thresholds are chosen on calib and frozen before test is run (invariant 9), so a test-split run
-- needs a frozen config. The API refuses first (config_not_frozen); this is the backstop.
CREATE FUNCTION eval_runs_test_split_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.split = 'test' AND NOT EXISTS (
    SELECT 1 FROM pipeline_configs
    WHERE tenant_id = NEW.tenant_id AND id = NEW.config_id AND frozen_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'eval_runs: a test-split run needs a frozen config'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER eval_runs_test_split BEFORE INSERT ON eval_runs
  FOR EACH ROW EXECUTE FUNCTION eval_runs_test_split_guard();
