# Google Workspace and Gmail

> How to set up the Google OAuth client that ai-triage uses for **Sign in with Google** and **Gmail mailbox sync**, and what Google requires before real people can use it. The design is in [architecture.md](architecture.md) (§3, §5) and the controls are in [security.md](security.md).

One OAuth client serves both features:

| Feature | Scopes | Redirect URI | Tokens kept |
|---|---|---|---|
| Sign in with Google (Better Auth) | `openid email profile` | `${PUBLIC_URL}/api/auth/callback/google` | None. Sign-in needs only the identity, so the tokens are dropped |
| Mailbox connection (an admin connects e.g. `ap@company.com`) | `openid email` + `https://www.googleapis.com/auth/gmail.readonly` | `${PUBLIC_URL}/api/integrations/google/callback` | A refresh token per mailbox, encrypted with the key ring (`ENCRYPTION_KEYS`), which belongs to the tenant rather than to the admin who connected it |
| Workspace domain check (auto-join) | `openid email` | `${PUBLIC_URL}/api/integrations/google/callback` | None. Only the `hd` claim is read |

Without `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, every Google feature is hidden and the rest of the app works as before. The demo runs against a local fake Google (`pnpm fake-google`, from `packages/mailbox/src/testing/`), so it needs no Google project.

## 1. Create the OAuth client

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick one) for this instance.
2. **APIs & Services → Library:** enable the **Gmail API**.
3. **Google Auth Platform → Branding:** set the app name, support email, your domain(s) under authorized domains, and the privacy policy and terms links (External apps need them).
4. **Audience:** pick the user type.
   - **Internal:** only accounts in your own Workspace organization can sign in or connect a mailbox, and Google doesn't review the app. This is right for a self-hosted instance used by one company.
   - **External:** any Google account. This is needed for a hosted instance that serves several companies, and Google's rules below apply.
5. **Data access:** add the scopes `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` and `.../auth/gmail.readonly`.
6. **Clients → Create client → Web application.** Add both authorized redirect URIs, exactly:
   - `https://<your host>/api/auth/callback/google`
   - `https://<your host>/api/integrations/google/callback`

   The host is `PUBLIC_URL`: the web app, which serves the API under `/api`. Locally that is `http://localhost:3000`, which Google accepts over http.

   **Changed in 0.7:** both URIs used to be on the API's own host (`BETTER_AUTH_URL`), and the mailbox one had no `/api`. Register the new ones before upgrading.
7. Put the client id and secret in the environment of the **api and the worker**:
   ```bash
   GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```
   The worker refreshes mailbox tokens, so it needs the secret too.

## 2. What Google requires (External apps)

`gmail.readonly` is a **restricted scope**, so an External app needs more than an Internal one:

- **Testing** publishing status (the default): at most 100 test users, each added by hand under Audience. **Refresh tokens expire after 7 days**, so every connected mailbox shows "Reconnect needed" weekly. This is fine for trying it out, not for production.
- **In production:** Google must verify the app before people outside your organization can grant `gmail.readonly`. The verification includes a restricted-scope review and a yearly third-party security assessment (CASA), and it is the operator's responsibility. Until then, unverified users see a warning screen and Google caps the number of users.
- Sign in with Google alone uses only non-sensitive scopes and needs just the brand verification.

An **Internal** app has none of these limits, which is why a self-hosted single-company instance should use it.

## 3. Google Workspace admins

- If your Workspace restricts third-party apps (**Admin console → Security → Access and data control → API controls → Manage third-party app access**), mark this app's client id as **Trusted**. Otherwise users get "access blocked" when they connect a mailbox.
- The mailbox to connect must be a real Gmail mailbox: a user account (for example a licensed `ap@company.com`). A Google Group has no Gmail mailbox, so to triage mail sent to a group, add a user mailbox as a member and connect that.
- To bring in only some mail, have a Gmail filter apply a label (for example `Triage`) and pick that label as the mailbox's intake label. The default intake label is the Inbox.

## 4. Using it

1. Create a tenant and invite its first admin. The command prints an invite link:
   ```bash
   pnpm tenant:create --name "Acme" --slug acme --admin you@acme.com
   ```
2. The admin opens the link, chooses **Continue with Google**, and lands in the tenant. Admins must still turn on TOTP 2FA (Settings → Security) when `REQUIRE_ADMIN_2FA` is on, which is the default.
3. **Settings → Members:** invite people by link, or turn on **Workspace domain auto-join**. To claim a domain, you sign in with a Google account in that Workspace, so a domain can only be claimed by someone who belongs to it.
4. **Settings → Mailboxes → Connect Google mailbox:** sign in as the mailbox, pick the intake label, and optionally import the last few days of mail. New mail shows up within about a minute.

## 5. Behaviour worth knowing

- **Read-only.** The app never changes the mailbox: it doesn't mark mail as read, label it, move it or delete it.
- **Polling.** Each connected mailbox is checked about once a minute, through Gmail's history API. If a mailbox was unreachable for longer than Gmail keeps history (about a week), the next sync falls back to listing recent mail, and duplicates are dropped by Message-ID.
- **Skipped mail.** Drafts, sent mail, spam, trash and chat messages are ignored. Mail over the size or attachment limits is skipped with a reason, which the mailbox page shows.
- **Sender authentication.** For synced mail, the `sender_unauthenticated` gate is **on by default**. It reads only the results Google's servers wrote (DMARC, or DKIM when there is no DMARC), never headers a sender could forge. Mail between users of the same Workspace often carries no results, so it goes to review. A config can turn the gate off (`sender.mailbox.require: false`).
- **Disconnecting** revokes the token at Google and deletes it here. Documents already ingested stay. If Google refuses a token (revoked by the user, a password reset, or a Testing-mode expiry), the mailbox stops syncing and shows **Reconnect**.

## 6. Try it without a Google project

A fake Google, `packages/mailbox/src/testing/fake-google.ts` answers the OAuth and Gmail calls mailbox sync makes, and its consent screen agrees at once as `ap@demo-workspace.test`. The Docker quickstart runs it (the `fake-google` service). For `pnpm dev`:

```bash
pnpm fake-google        # http://localhost:9040
```

Then start the app with `GOOGLE_CLIENT_ID=demo-fake-google GOOGLE_CLIENT_SECRET=demo-fake-google-secret GOOGLE_OAUTH_URL=http://localhost:9040 GOOGLE_API_URL=http://localhost:9040` (through turbo, add `--env-mode=loose`, or put them in `.env`). Deliver mail with `curl --data-binary @some.eml http://localhost:9040/fake/deliver`; `pnpm e2e` includes `e2e/gmail.spec.ts`, which does all of this.

Sign in with Google isn't faked: Better Auth always talks to the real Google, so against the fake it is hidden (and so are Google-only invitations and the Workspace domain). Production refuses the fake's URLs unless `TRIAGE_DEMO=true`.
