import React, { useEffect, useRef, useState } from 'react';
import { stdb } from '../stdb';
import { useStore } from './hooks';
import {
  ensureOneOnOneChat,
  listMessages,
  sendMessage,
  consentish,
  myOid,
  type ChatMessage,
} from '../graph_chat';

/**
 * 1:1 chat panel — opened by clicking a staff figure / player avatar in the
 * world or a "Chat with…" search hit. Real Teams chat via delegated Graph.
 *
 * Ephemeral by design: chat content exists in component state only; polling
 * refreshes every 15s while the panel is open; gone on close. Never rendered
 * in kiosk mode (the App simply doesn't mount it).
 */

export interface ChatTarget {
  oid: string;
  displayName: string;
}

const POLL_MS = 15_000;

const AVAILABILITY_LABEL: Record<string, string> = {
  Available: 'Available',
  AvailableIdle: 'Available',
  Busy: 'Busy',
  BusyIdle: 'Busy',
  DoNotDisturb: 'Do not disturb',
  InAMeeting: 'In a meeting',
  InACall: 'In a call',
  InAConferenceCall: 'In a call',
  Presenting: 'Presenting',
  Away: 'Away',
  BeRightBack: 'Be right back',
  OffWork: 'Off work',
};

function availabilityChipClass(availability: string): string {
  if (/^Available/.test(availability)) return 'chip-green';
  if (/Busy|InA|Presenting|DoNotDisturb/.test(availability)) return 'chip-amber';
  return 'chip';
}

export function ChatPanel({ target, onClose }: { target: ChatTarget; onClose: () => void }) {
  useStore('status');
  useStore('staff');
  useStore('presence');
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0); // bump to retry after consent
  const listRef = useRef<HTMLDivElement | null>(null);

  const signedIn = stdb.signedInConnection;
  const me = myOid();
  const availability =
    stdb.presence.get(target.oid)?.availability ?? stdb.staff.get(target.oid)?.availability ?? null;

  // Open (or re-open) the chat whenever the target changes, then poll.
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    setChatId(null);
    setMessages(null);
    setError(null);
    setNeedsConsent(false);
    setSendError(null);
    setLoading(true);

    const refresh = async (id: string) => {
      const list = await listMessages(id);
      if (!cancelled) setMessages(list);
    };

    (async () => {
      try {
        const id = await ensureOneOnOneChat(target.oid);
        if (cancelled) return;
        setChatId(id);
        await refresh(id);
        if (cancelled) return;
        timer = setInterval(() => {
          refresh(id).catch(err => console.warn('[chat] poll failed', err));
        }, POLL_MS);
      } catch (err) {
        if (cancelled) return;
        if (consentish(err)) {
          setNeedsConsent(true);
          setError('Chat needs your consent for Teams chat access.');
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [signedIn, target.oid, attempt]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async () => {
    const content = draft.trim();
    if (!content || !chatId) return;
    setSending(true);
    setSendError(null);
    try {
      await sendMessage(chatId, content);
      // optimistic append
      setMessages(prev => [
        ...(prev ?? []),
        {
          id: `local-${Date.now()}`,
          senderOid: me,
          senderName: 'You',
          at: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          text: content,
        },
      ]);
      setDraft('');
    } catch (err) {
      setSendError(
        consentish(err) ? 'Sending needs your consent — try again and accept the popup.' : String(err)
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="panel chat-panel">
      <div className="panel-header">
        <h2>💬 {target.displayName}</h2>
        <button className="ghost-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {availability && (
        <span className={`chip ${availabilityChipClass(availability)} chat-availability`}>
          {AVAILABILITY_LABEL[availability] ?? availability}
        </span>
      )}

      {!signedIn ? (
        <div className="dim chat-gate">Sign in to chat.</div>
      ) : (
        <>
          {loading && <div className="dim messages-hint">Opening chat…</div>}
          {error && (
            <div className="error-box">
              {error}
              {needsConsent && (
                <button className="primary-btn messages-grant" onClick={() => setAttempt(a => a + 1)}>
                  Grant access
                </button>
              )}
            </div>
          )}
          {messages !== null && (
            <div className="chat-list" ref={listRef}>
              {messages.length === 0 && <div className="dim messages-hint">No messages yet — say hi.</div>}
              {messages.map(m => {
                const mine = m.senderOid !== null && me !== null && m.senderOid === me;
                return (
                  <div key={m.id} className={`chat-row${mine ? ' chat-mine' : ''}`}>
                    <div className="chat-bubble">
                      <div className="chat-meta dim">
                        {mine ? 'You' : m.senderName} · {m.at}
                      </div>
                      <div className="message-text">{m.text}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="composer">
            <textarea
              className="composer-input"
              placeholder={`Message ${target.displayName}…`}
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
            <button
              className="primary-btn"
              disabled={sending || !draft.trim() || !chatId}
              onClick={() => void send()}
            >
              {sending ? '…' : 'Send'}
            </button>
          </div>
          {sendError && <div className="error-box">{sendError}</div>}
          <div className="dim messages-privacy">Real Teams chat — nothing is stored in the world.</div>
        </>
      )}
    </div>
  );
}
