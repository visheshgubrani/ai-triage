"use client";

import { useState } from "react";
import { Button } from "@/components/button";
import { signInWithGoogle } from "@/lib/google";

/** "Continue with Google": a full-width secondary button with Google's mark. */
export function GoogleButton({
  returnTo = "/",
  errorTo = "/sign-in",
  onError,
}: {
  returnTo?: string;
  /** Where Google errors land (`?error=` is appended). */
  errorTo?: string;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      className="w-full"
      size="lg"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        const problem = await signInWithGoogle(returnTo, errorTo);
        if (problem) {
          setPending(false);
          onError(problem);
        }
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 48 48" className="h-4 w-4">
        <path
          fill="#EA4335"
          d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"
        />
        <path
          fill="#FBBC05"
          d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.6 10.7l7.9-6.1z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"
        />
      </svg>
      {pending ? "Opening Google…" : "Continue with Google"}
    </Button>
  );
}

/** Between two ways of signing in. */
export function OrDivider({ children }: { children: string }) {
  return (
    <p className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
      {children}
    </p>
  );
}
