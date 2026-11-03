import { createServer } from "node:http";
import { FakeGoogle } from "./fake-google";

// `pnpm fake-google`: the fake Google over HTTP, for the local demo and the Gmail e2e (docs/google.md).
// Point the app at it with GOOGLE_OAUTH_URL / GOOGLE_API_URL (TRIAGE_DEMO only). Its consent screen
// agrees at once, as the demo mailbox. Deliver mail into it with:
//   curl --data-binary @fixtures/.../some.eml http://localhost:9040/fake/deliver
// Sign in with Google isn't faked: Better Auth always talks to the real Google.

const port = Number(process.env.FAKE_GOOGLE_PORT ?? 9040);
export const DEMO_MAILBOX = process.env.FAKE_GOOGLE_MAILBOX ?? "ap@demo-workspace.test";

const google = new FakeGoogle({
  clientId: process.env.GOOGLE_CLIENT_ID ?? "demo-fake-google",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "demo-fake-google-secret",
});
google.addMailbox(DEMO_MAILBOX, { hd: DEMO_MAILBOX.split("@")[1] });

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname === "/fake/deliver" && req.method === "POST") {
      const to = url.searchParams.get("to") ?? DEMO_MAILBOX;
      const labels = url.searchParams.getAll("label");
      const id = google.deliver(to, new Uint8Array(body), labels.length ? labels : undefined);
      res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ id, to }));
      return;
    }
    if (url.pathname === "/fake/state" && req.method === "GET") {
      const mailboxes = [...google.mailboxes.values()].map((m) => ({ email: m.email, messages: m.messages.size }));
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ mailboxes, revoked: google.revoked.length }));
      return;
    }
    const response = await google.handle(
      new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])) as [
          string,
          string,
        ][],
        body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" }).end((err as Error).message);
  }
});
server.listen(port, () => console.log(`fake Google on http://localhost:${port} (mailbox ${DEMO_MAILBOX})`));
