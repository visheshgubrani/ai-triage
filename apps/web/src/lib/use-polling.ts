"use client";

import { useEffect, useRef } from "react";

/**
 * Calls `load` now and every `ms` while the tab is visible (a hidden tab stops polling and catches up
 * when shown again). Each call gets an AbortSignal that is aborted when the next one starts or the
 * component unmounts, so a slow response never overwrites a newer one.
 */
export function usePolling(load: (signal: AbortSignal) => Promise<void>, ms: number) {
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let controller = new AbortController();
    const run = () => {
      controller.abort();
      controller = new AbortController();
      latest.current(controller.signal).catch((err: unknown) => {
        if ((err as Error).name !== "AbortError") console.error(err);
      });
    };
    run();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, ms);
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      controller.abort();
    };
  }, [ms]);
}
