/**
 * 1:1 Teams chats over Microsoft Graph (Chat.ReadWrite delegated — consented
 * per user on first use via the MSAL popup fallback in getGraphToken).
 *
 * Privacy invariants match RoomMessages: chat content is EPHEMERAL — it lives
 * in component state only, is never persisted anywhere, and is plain text
 * (HTML stripped on read, contentType 'text' on write).
 */
import { account, getGraphToken } from './auth';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export const CHAT_SCOPES = ['Chat.ReadWrite'];

export interface ChatMessage {
  id: string;
  /** Graph user id (== Entra oid) of the sender; null for system/unknown */
  senderOid: string | null;
  senderName: string;
  at: string;
  text: string;
}

/** The signed-in user's Entra object id (Graph user id). */
export function myOid(): string | null {
  const acct = account();
  if (!acct) return null;
  const claims = acct.idTokenClaims as Record<string, unknown> | undefined;
  if (claims && typeof claims.oid === 'string' && claims.oid) return claims.oid;
  // homeAccountId is "<oid>.<tid>"
  const oid = acct.homeAccountId?.split('.')[0];
  return oid || null;
}

export function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').trim();
}

/** True when an error smells like missing consent / interaction required. */
export function consentish(err: unknown): boolean {
  const s = String((err as Error)?.message ?? err);
  return /consent|AADSTS65001|interaction_required|Authorization_RequestDenied|Forbidden|403|401/i.test(s);
}

async function graphFetch(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const token = await getGraphToken(CHAT_SCOPES);
  const res = await fetch(`${GRAPH}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Graph error ${res.status}: ${body.slice(0, 160)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Create-or-get the 1:1 chat with the target user. Graph returns the existing
 * oneOnOne chat when one already exists between the two members, so this is
 * safe to call on every panel open.
 */
export async function ensureOneOnOneChat(targetOid: string): Promise<string> {
  const me = myOid();
  if (!me) throw new Error('not signed in');
  const member = (oid: string) => ({
    '@odata.type': '#microsoft.graph.aadUserConversationMember',
    roles: ['owner'],
    'user@odata.bind': `${GRAPH}/users('${oid}')`,
  });
  const chat = await graphFetch('/chats', {
    method: 'POST',
    body: { chatType: 'oneOnOne', members: [member(me), member(targetOid)] },
  });
  const id = chat?.id;
  if (!id) throw new Error('Graph returned no chat id');
  return String(id);
}

/** Last 25 messages of a chat, plain text, oldest first. Ephemeral. */
export async function listMessages(chatId: string): Promise<ChatMessage[]> {
  const data = await graphFetch(`/chats/${encodeURIComponent(chatId)}/messages?$top=25`);
  const out: ChatMessage[] = [];
  for (const m of data?.value ?? []) {
    const raw = m?.body?.content ?? '';
    const text = m?.body?.contentType === 'html' ? stripHtml(raw) : String(raw).trim();
    if (!text) continue; // skip system/empty messages
    out.push({
      id: String(m.id),
      senderOid: m?.from?.user?.id ?? null,
      senderName: m?.from?.user?.displayName ?? 'Unknown',
      at: m?.createdDateTime
        ? new Date(m.createdDateTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : '',
      text,
    });
  }
  return out.reverse(); // Graph returns newest first
}

/** Send a plain-text message into the chat as the signed-in user. */
export async function sendMessage(chatId: string, text: string): Promise<void> {
  await graphFetch(`/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: { body: { contentType: 'text', content: text } },
  });
}
