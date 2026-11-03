import { browserApi } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/** Whether this instance offers Sign in with Google (it has an OAuth client). */
export async function googleEnabled(): Promise<boolean> {
  try {
    const res = await browserApi.auth.providers.$get();
    return res.ok && (await res.json()).google;
  } catch {
    return false;
  }
}

/**
 * Starts a Google sign-in. Google sends the browser back to the API, which lands it on `returnTo`
 * (or on /sign-in?error=… when it can't sign the person in; see signInErrorText).
 */
export async function signInWithGoogle(returnTo = "/"): Promise<string | null> {
  const origin = window.location.origin;
  const { error } = await authClient.signIn.social({
    provider: "google",
    callbackURL: `${origin}${returnTo}`,
    errorCallbackURL: `${origin}/sign-in`,
  });
  return error ? authErrorText(error, "Couldn't start Google sign-in") : null;
}

/** Better Auth errors carry `message`; the api's own refusals carry `error` (ErrorResponse). */
export function authErrorText(error: { message?: string; error?: unknown }, fallback: string): string {
  if (error.message) return error.message;
  return typeof error.error === "string" ? error.error : fallback;
}

/** What the `?error=` code Better Auth puts on /sign-in after a Google round trip means. */
export function signInErrorText(code: string): string {
  switch (code) {
    case "not_invited":
      return "There's no invitation for that Google account. Ask an admin of your workspace for an invite link.";
    case "account_not_linked":
      return "An account with this email exists but isn't linked to Google. Sign in with your password, then link Google under Settings → Security.";
    case "email_not_verified":
      return "Google hasn't verified that email address, so it can't be used to sign in.";
    case "access_denied":
      return "Google sign-in was cancelled.";
    default:
      return `Google sign-in didn't work (${code}).`;
  }
}
