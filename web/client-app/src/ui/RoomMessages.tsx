import React, { useState } from 'react';
import { stdb } from '../stdb';
import { useStore } from './hooks';
import { getGraphToken } from '../auth';

/**
 * Room "Messages" (P4.9 participation): ephemeral read of the channel's
 * recent messages + a composer that posts as the signed-in user.
 *
 * Privacy invariants:
 *  - shown only when signed in AND world_policy.allow_content_on_click
 *  - message content lives in component state ONLY — never localStorage,
 *    never SpacetimeDB, gone on unmount/reload
 *  - plain text only (HTML stripped)
 */

interface EphemeralMessage {
  id: string;
  sender: string;
  at: string;
  text: string;
}

const GRAPH = 'https://graph.microsoft.com/v1.0';

function stripHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent ?? '').trim();
}

function toEphemeral(m: Record<string, any>): EphemeralMessage | null {
  const raw = m?.body?.content ?? '';
  const text = m?.body?.contentType === 'html' ? stripHtml(raw) : String(raw).trim();
  if (!text) return null; // skip system/empty messages
  return {
    id: String(m.id),
    sender: m?.from?.user?.displayName ?? 'Unknown',
    at: m?.createdDateTime
      ? new Date(m.createdDateTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '',
    text,
  };
}

function consentish(err: unknown): boolean {
  const s = String((err as Error)?.message ?? err);
  return /consent|AADSTS65001|interaction_required|Authorization_RequestDenied|Forbidden|403/i.test(s);
}

export function RoomMessages({ teamId, channelId }: { teamId: string; channelId: string }) {
  useStore('policy');
  useStore('adminConfig');
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<EphemeralMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // thread reply composer (one open at a time)
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [repliedTo, setRepliedTo] = useState<string | null>(null);

  const signedIn = stdb.signedInConnection;
  const allowed = stdb.allowContentOnClick;

  if (!signedIn) return null;
  if (!allowed) {
    return (
      <div className="room-messages">
        <div className="dim messages-hint">Content on click is disabled by your admin.</div>
      </div>
    );
  }

  const load = async () => {
    setLoading(true);
    setError(null);
    setNeedsConsent(false);
    try {
      const token = await getGraphToken(['ChannelMessage.Read.All']);
      const res = await fetch(
        `${GRAPH}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages?$top=10`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 403 || res.status === 401) {
          setNeedsConsent(true);
          setError('Reading messages needs admin-consented access.');
        } else {
          setError(`Graph error ${res.status}: ${body.slice(0, 140)}`);
        }
        setMessages(null);
        return;
      }
      const data = await res.json();
      const list = (data.value ?? [])
        .map(toEphemeral)
        .filter((m: EphemeralMessage | null): m is EphemeralMessage => m !== null)
        .reverse(); // oldest first
      setMessages(list);
    } catch (err) {
      if (consentish(err)) {
        setNeedsConsent(true);
        setError('Access not granted yet.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setMessages(null);
    } finally {
      setLoading(false);
    }
  };

  const send = async () => {
    const content = draft.trim();
    if (!content) return;
    setSending(true);
    setSendError(null);
    try {
      const token = await getGraphToken(['ChannelMessage.Send']);
      const res = await fetch(
        `${GRAPH}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: { contentType: 'text', content } }),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        setSendError(`Send failed (${res.status}): ${body.slice(0, 140)}`);
        return;
      }
      // optimistic append
      setMessages(prev => [
        ...(prev ?? []),
        {
          id: `local-${Date.now()}`,
          sender: 'You',
          at: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          text: content,
        },
      ]);
      setDraft('');
    } catch (err) {
      setSendError(consentish(err) ? 'Sending needs your consent — try again and accept the popup.' : String(err));
    } finally {
      setSending(false);
    }
  };

  // POST a reply into the message's thread (ChannelMessage.Send, same scope
  // as the channel composer). Reply counts are NOT shown: the Graph list
  // endpoint doesn't include them and fetching /replies per message is an
  // extra call each — not cheap, skipped by design.
  const sendReply = async (messageId: string) => {
    const content = replyDraft.trim();
    if (!content) return;
    setReplySending(true);
    setReplyError(null);
    try {
      const token = await getGraphToken(['ChannelMessage.Send']);
      const res = await fetch(
        `${GRAPH}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(
          channelId
        )}/messages/${encodeURIComponent(messageId)}/replies`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: { contentType: 'text', content } }),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        setReplyError(`Reply failed (${res.status}): ${body.slice(0, 140)}`);
        return;
      }
      setReplyDraft('');
      setReplyTo(null);
      setRepliedTo(messageId);
    } catch (err) {
      setReplyError(
        consentish(err) ? 'Replying needs your consent — try again and accept the popup.' : String(err)
      );
    } finally {
      setReplySending(false);
    }
  };

  return (
    <div className="room-messages">
      <button
        className="ghost-btn messages-toggle"
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next && messages === null && !loading) void load();
        }}
      >
        💬 Messages {expanded ? '▾' : '▸'}
      </button>
      {expanded && (
        <div className="messages-body">
          {loading && <div className="dim messages-hint">Loading…</div>}
          {error && (
            <div className="error-box">
              {error}
              {needsConsent && (
                <button className="primary-btn messages-grant" onClick={() => void load()}>
                  Grant access
                </button>
              )}
            </div>
          )}
          {messages !== null && messages.length === 0 && (
            <div className="dim messages-hint">No recent messages.</div>
          )}
          {messages !== null && messages.length > 0 && (
            <div className="messages-list">
              {messages.map(m => {
                // optimistic local echoes have no Graph id → no thread to reply to
                const replyable = !m.id.startsWith('local-');
                return (
                  <div key={m.id} className="message-row">
                    <span className="message-sender">{m.sender}</span>
                    <span className="dim message-time">{m.at}</span>
                    <div className="message-text">{m.text}</div>
                    {replyable && (
                      <div className="message-actions">
                        <button
                          className="ghost-btn reply-btn"
                          onClick={() => {
                            setReplyError(null);
                            setReplyDraft('');
                            setReplyTo(replyTo === m.id ? null : m.id);
                          }}
                        >
                          ↩ Reply
                        </button>
                        {repliedTo === m.id && replyTo !== m.id && (
                          <span className="dim reply-sent">Reply sent to the thread ✓</span>
                        )}
                      </div>
                    )}
                    {replyTo === m.id && (
                      <div className="reply-composer">
                        <div className="composer">
                          <textarea
                            className="composer-input"
                            placeholder="Reply in this thread…"
                            rows={2}
                            value={replyDraft}
                            onChange={e => setReplyDraft(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                void sendReply(m.id);
                              }
                              if (e.key === 'Escape') setReplyTo(null);
                            }}
                            autoFocus
                          />
                          <button
                            className="primary-btn"
                            disabled={replySending || !replyDraft.trim()}
                            onClick={() => void sendReply(m.id)}
                          >
                            {replySending ? '…' : 'Reply'}
                          </button>
                        </div>
                        {replyError && <div className="error-box">{replyError}</div>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <div className="composer">
            <textarea
              className="composer-input"
              placeholder="Message this channel as yourself…"
              rows={2}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="primary-btn" disabled={sending || !draft.trim()} onClick={() => void send()}>
              {sending ? '…' : 'Send'}
            </button>
          </div>
          {sendError && <div className="error-box">{sendError}</div>}
          <div className="dim messages-privacy">Ephemeral view — nothing is stored.</div>
        </div>
      )}
    </div>
  );
}
