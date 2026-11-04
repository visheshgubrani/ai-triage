ALTER TABLE "eval_runs" DROP CONSTRAINT "eval_runs_llm_mode_check";--> statement-breakpoint
ALTER TABLE "llm_calls" DROP CONSTRAINT "llm_calls_mode_check";--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_llm_mode_check" CHECK ("eval_runs"."llm_mode" in ('live', 'replay', 'simulated'));--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_mode_check" CHECK ("llm_calls"."mode" in ('live', 'replay', 'simulated'));