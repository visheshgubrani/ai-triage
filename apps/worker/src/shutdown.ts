// Stopping the worker: pg-boss stops fetching and waits for running jobs; after the grace period,
// in-flight model calls are aborted, so their jobs fail now and retry on another worker instead of
// running out their expiry here.
const controller = new AbortController();

/** Aborts every model call a job started through jobSignal(). */
export const abortInFlight = () => controller.abort(new Error("the worker is shutting down"));

/** A job's own signal (aborted when pg-boss expires it) combined with shutdown. */
export const jobSignal = (job: { signal?: AbortSignal }): AbortSignal =>
  job.signal ? AbortSignal.any([job.signal, controller.signal]) : controller.signal;
