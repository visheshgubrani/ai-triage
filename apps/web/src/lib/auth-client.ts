import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Better Auth runs inside the API (/api/auth/*). The browser calls it cross-origin with
// credentials; on localhost the session cookie is shared because cookies ignore the port.
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787",
  plugins: [organizationClient()],
});
