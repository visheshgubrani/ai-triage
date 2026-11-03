import { ErrorResponse } from "@ai-triage/contracts";

/** The API's error body (any status the RPC types don't list), or a generic one. */
export async function readError(res: Response): Promise<ErrorResponse> {
  try {
    const parsed = ErrorResponse.safeParse(await res.json());
    if (parsed.success) return parsed.data;
  } catch {}
  return { error: `Request failed (${res.status})` };
}
