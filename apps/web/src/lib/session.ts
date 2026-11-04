import { MeResponse } from "@ai-triage/contracts";
import { cookies } from "next/headers";
import { api } from "@/lib/api";

/**
 * The signed-in user, read through the API with the browser's cookie (server components only).
 * `noWorkspace`: signed in, but not a member of any tenant (yet, or any more).
 */
export async function getSessionState(): Promise<{ me: MeResponse | null; noWorkspace: boolean }> {
  const cookie = (await cookies()).toString();
  try {
    const res = await api.me.$get(undefined, { headers: { cookie } });
    // 403 comes from the tenant middleware, which the RPC types don't list.
    if (!res.ok) return { me: null, noWorkspace: (res.status as number) === 403 };
    return { me: MeResponse.parse(await res.json()), noWorkspace: false };
  } catch {
    return { me: null, noWorkspace: false };
  }
}

export async function getMe(): Promise<MeResponse | null> {
  return (await getSessionState()).me;
}

/** A fresh install (no workspace yet) goes to the first-run setup page. */
export async function setupNeeded(): Promise<boolean> {
  try {
    const res = await api.setup.status.$get();
    return res.ok && (await res.json()).needed;
  } catch {
    return false;
  }
}
