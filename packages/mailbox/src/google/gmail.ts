import { z } from "zod";
import { HistoryExpiredError, MailboxApiError, MailboxAuthError, MessageGoneError } from "../errors";
import { type GoogleDeps, send } from "./http";

// The few Gmail API calls mailbox sync needs (https://developers.google.com/gmail/api/reference/rest),
// all on `users/me` with the mailbox's access token, all read-only.

const authFailure = (status: number) =>
  status === 401 ? new MailboxAuthError("Gmail refused the access token") : undefined;

async function get<T>(
  deps: GoogleDeps,
  accessToken: string,
  path: string,
  schema: z.ZodType<T>,
  onError = authFailure,
) {
  const res = await send(
    deps,
    `${deps.config.apiUrl}/gmail/v1/users/me/${path}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
    onError,
  );
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) throw new MailboxApiError(502, `Unexpected Gmail response for ${path.split("?")[0]}`);
  return parsed.data;
}

const Profile = z.object({ emailAddress: z.string().min(3), historyId: z.string().min(1) });
export type GmailProfile = z.infer<typeof Profile>;

/** The mailbox's address and its current history id (the cursor a new connection starts from). */
export const getProfile = (deps: GoogleDeps, accessToken: string) => get(deps, accessToken, "profile", Profile);

const Labels = z.object({
  labels: z.array(z.object({ id: z.string(), name: z.string(), type: z.string().optional() })).default([]),
});
export type GmailLabel = z.infer<typeof Labels>["labels"][number];

export async function listLabels(deps: GoogleDeps, accessToken: string): Promise<GmailLabel[]> {
  return (await get(deps, accessToken, "labels", Labels)).labels;
}

const MessageRef = z.object({ id: z.string(), labelIds: z.array(z.string()).optional() });
const History = z.object({
  history: z
    .array(
      z.object({
        id: z.string(),
        messagesAdded: z.array(z.object({ message: MessageRef })).optional(),
        labelsAdded: z.array(z.object({ message: MessageRef, labelIds: z.array(z.string()) })).optional(),
      }),
    )
    .default([]),
  historyId: z.string(),
  nextPageToken: z.string().optional(),
});

export interface HistoryPage {
  /** Messages that arrived in the label, or had the label applied, in history order (may repeat). */
  messageIds: string[];
  /** The id of the newest history record on this page, if any. */
  lastHistoryId: string | null;
  /** The mailbox's current history id (the cursor once every page is read). */
  historyId: string;
  nextPageToken: string | null;
}

/**
 * One page of changes since `startHistoryId`: messages added to the mailbox with the label, and
 * messages the label was applied to later (a Gmail filter, or someone filing mail by hand). Throws
 * HistoryExpiredError when Gmail no longer has history that old (about a week).
 */
export async function listHistory(
  deps: GoogleDeps,
  accessToken: string,
  input: { startHistoryId: string; labelId: string; pageToken?: string | null; maxResults?: number },
): Promise<HistoryPage> {
  const params = new URLSearchParams({
    startHistoryId: input.startHistoryId,
    labelId: input.labelId,
    maxResults: String(input.maxResults ?? 500),
  });
  params.append("historyTypes", "messageAdded");
  params.append("historyTypes", "labelAdded");
  if (input.pageToken) params.set("pageToken", input.pageToken);
  const page = await get(deps, accessToken, `history?${params}`, History, (status) =>
    status === 404 ? new HistoryExpiredError("Gmail history expired") : authFailure(status),
  );
  const ids: string[] = [];
  for (const record of page.history) {
    for (const { message } of record.messagesAdded ?? []) ids.push(message.id);
    for (const added of record.labelsAdded ?? [])
      if (added.labelIds.includes(input.labelId)) ids.push(added.message.id);
  }
  return {
    messageIds: ids,
    lastHistoryId: page.history.at(-1)?.id ?? null,
    historyId: page.historyId,
    nextPageToken: page.nextPageToken ?? null,
  };
}

const MessageList = z.object({
  messages: z.array(z.object({ id: z.string() })).default([]),
  nextPageToken: z.string().optional(),
});

/** Message ids in the label matching a Gmail search (`q`, e.g. `newer_than:3d`), newest first. */
export async function listMessages(
  deps: GoogleDeps,
  accessToken: string,
  input: { labelId: string; q: string; max: number },
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      labelIds: input.labelId,
      q: input.q,
      maxResults: String(Math.min(500, input.max - ids.length)),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await get(deps, accessToken, `messages?${params}`, MessageList);
    ids.push(...page.messages.map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < input.max);
  return ids.slice(0, input.max);
}

const MessageMeta = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).default([]),
  sizeEstimate: z.number().nonnegative(),
  internalDate: z.string().optional(),
});
export type GmailMessageMeta = z.infer<typeof MessageMeta>;

const gone = (status: number) => (status === 404 ? new MessageGoneError("message deleted") : authFailure(status));

/** Labels and size of a message, without its content. */
export const getMessageMeta = (deps: GoogleDeps, accessToken: string, id: string) =>
  get(deps, accessToken, `messages/${encodeURIComponent(id)}?format=minimal`, MessageMeta, gone);

const RawMessage = MessageMeta.extend({ raw: z.string() });

/** The message exactly as received (RFC 5322 bytes), plus its labels and size. */
export async function getRawMessage(
  deps: GoogleDeps,
  accessToken: string,
  id: string,
): Promise<GmailMessageMeta & { raw: Uint8Array }> {
  const message = await get(deps, accessToken, `messages/${encodeURIComponent(id)}?format=raw`, RawMessage, gone);
  return { ...message, raw: new Uint8Array(Buffer.from(message.raw, "base64url")) };
}

/** Labels that mean a message isn't mail someone sent to this mailbox. */
export const NOT_INBOUND_LABELS = ["DRAFT", "SENT", "SPAM", "TRASH", "CHAT"] as const;
