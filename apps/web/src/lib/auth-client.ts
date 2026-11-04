import { organizationClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Better Auth runs inside the API, at /api/auth on this same origin. Without a baseURL the client
// uses window.location.origin (it refuses a relative one).
export const authClient = createAuthClient({
  plugins: [organizationClient(), twoFactorClient()],
});
