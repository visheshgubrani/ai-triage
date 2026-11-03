import type { Db } from "./index";

// Who Better Auth may create a user for. Public sign-up is closed (docs/security.md): email sign-up
// is off entirely, and Sign in with Google creates a user only for someone the app already expects.
// Users created outside Better Auth (seeds, tests, invitations accepted with a password) don't pass
// through here.

/** The verified identity a provider returned for someone who has no user yet. */
export interface Applicant {
  email: string;
  emailVerified: boolean;
  /** Google's `hd` claim: set only for Google Workspace accounts. */
  hostedDomain: string | null;
}

export type AdmissionRefusal = "email_not_verified" | "not_invited";

/** Null when the applicant may get a user; otherwise why not (the sign-in page explains the code). */
export async function admissionRefusal(_db: Db, applicant: Applicant): Promise<AdmissionRefusal | null> {
  if (!applicant.emailVerified) return "email_not_verified";
  return "not_invited";
}
