"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Keeps a server-rendered page current: refetches it every `ms` while the tab is visible. */
export function AutoRefresh({ ms }: { ms: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, ms);
    return () => clearInterval(timer);
  }, [ms, router]);
  return null;
}
