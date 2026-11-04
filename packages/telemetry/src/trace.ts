import { AsyncLocalStorage } from "node:async_hooks";

// A trace id follows one piece of work across processes: the api's request id goes into every job
// it enqueues (packages/db enqueue()), each job runs under its trace, and the jobs it enqueues
// carry it on. So every log line about one document, from upload to webhook, shares an id.

const store = new AsyncLocalStorage<{ traceId: string }>();

export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return store.run({ traceId }, fn);
}

export const currentTraceId = (): string | undefined => store.getStore()?.traceId;
