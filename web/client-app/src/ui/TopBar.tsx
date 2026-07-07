import React, { useMemo, useRef, useState } from 'react';
import { stdb } from '../stdb';
import { KIOSK } from '../config';
import { useStore } from './hooks';
import { account, signIn, signOut } from '../auth';
import { consentish } from '../graph_chat';
import { setMyPresence, clearMyPresence, type PreferredAvailability } from '../graph_me';
import type { WorldApp } from '../world';

type SearchHit =
  | { kind: 'zone' | 'room'; id: number; name: string; sub: string }
  | { kind: 'user'; userId: string; name: string; sub: string };

/** The five settable presence states + dot colors matching the world's
 *  availability ring palette (world/staff.ts). */
const PRESENCE_OPTIONS: { value: PreferredAvailability; label: string; color: string }[] = [
  { value: 'Available', label: 'Available', color: '#2dd4bf' },
  { value: 'Busy', label: 'Busy', color: '#f97316' },
  { value: 'DoNotDisturb', label: 'Do not disturb', color: '#ef4444' },
  { value: 'BeRightBack', label: 'Be right back', color: '#9ca3af' },
  { value: 'Away', label: 'Away', color: '#9ca3af' },
];

/**
 * Set-my-status dropdown (Presence.ReadWrite, delegated; consented on first
 * use). Rendered only when signed in. The world's staff ring updates on the
 * next presence poll — the tooltip says so.
 */
function StatusControl() {
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState<PreferredAvailability | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false);
  const lastChoice = useRef<string | null>(null);

  const apply = async (choice: string) => {
    lastChoice.current = choice;
    setBusy(true);
    setError(null);
    setNeedsConsent(false);
    try {
      if (choice === 'reset') {
        await clearMyPresence();
        setCurrent(null);
      } else {
        await setMyPresence(choice as PreferredAvailability);
        setCurrent(choice as PreferredAvailability);
      }
    } catch (err) {
      if (consentish(err)) {
        setNeedsConsent(true);
        setError('Setting your status needs consent for presence access.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const active = current ? PRESENCE_OPTIONS.find(o => o.value === current) : null;
  return (
    <span className="presence-set">
      {active && (
        <span
          className="presence-dot"
          style={{ background: active.color }}
          title={`${active.label} — world updates within a minute`}
        />
      )}
      <select
        className="presence-select"
        disabled={busy}
        value=""
        onChange={e => void apply(e.target.value)}
        title="Set my Teams status — world updates within a minute"
        aria-label="Set my status"
      >
        <option value="" disabled>
          {busy ? '…' : active ? active.label : 'Status'}
        </option>
        {PRESENCE_OPTIONS.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value="reset">Reset</option>
      </select>
      {error && (
        <div className="presence-pop error-box">
          {error}
          {needsConsent && lastChoice.current && (
            <button className="primary-btn messages-grant" onClick={() => void apply(lastChoice.current!)}>
              Grant access
            </button>
          )}
        </div>
      )}
    </span>
  );
}

/** Sign-in button / account chip. Reloading after auth changes is the v1 way
 *  to swap the SpacetimeDB connection identity. */
function AccountControl() {
  const [busy, setBusy] = useState(false);
  const acct = account();

  if (acct) {
    return (
      <span className="account-chip" title={acct.username}>
        <span className="account-name">{acct.name ?? acct.username}</span>
        <StatusControl />
        <button
          className="ghost-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await signOut().catch(() => undefined);
            window.location.reload();
          }}
        >
          Sign out
        </button>
      </span>
    );
  }
  return (
    <button
      className="primary-btn signin-btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await signIn();
          window.location.reload();
        } catch (err) {
          console.warn('[auth] sign-in cancelled/failed', err);
          setBusy(false);
        }
      }}
    >
      Sign in with Microsoft
    </button>
  );
}

export function TopBar({
  world,
  onOpenPrivacy,
  onOpenLegend,
  onChatUser,
}: {
  world: WorldApp;
  onOpenPrivacy: () => void;
  onOpenLegend: () => void;
  /** open a 1:1 chat with a person found via search (absent in kiosk) */
  onChatUser?: (person: { oid: string; displayName: string }) => void;
}) {
  useStore('status');
  useStore('zones');
  useStore('rooms');
  useStore('users');
  useStore('adminConfig');
  const [query, setQuery] = useState('');

  const hits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: SearchHit[] = [];
    for (const z of stdb.zones.values()) {
      if (z.name.toLowerCase().includes(q)) out.push({ kind: 'zone', id: z.zoneId, name: z.name, sub: 'zone' });
    }
    for (const r of stdb.rooms.values()) {
      if (r.name.toLowerCase().includes(q)) {
        out.push({ kind: 'room', id: r.roomId, name: r.name, sub: stdb.zoneName(Math.floor(r.roomId / 100)) });
      }
    }
    if (onChatUser) {
      for (const u of stdb.users.values()) {
        if (u.isActive && u.displayName.toLowerCase().includes(q)) {
          out.push({ kind: 'user', userId: u.userId, name: u.displayName, sub: u.title || 'person' });
        }
      }
    }
    return out.slice(0, 8);
  }, [query, onChatUser, stdb.version('rooms'), stdb.version('zones'), stdb.version('users')]);

  const travel = (hit: SearchHit) => {
    if (hit.kind === 'user') {
      onChatUser?.({ oid: hit.userId, displayName: hit.name });
    } else if (hit.kind === 'zone') {
      world.fastTravelToZone(hit.id);
    } else {
      world.fastTravelToRoom(hit.id);
    }
    setQuery('');
  };

  const status = stdb.status;
  return (
    <div className="topbar">
      <div className="brand">
        Space<span className="brand-365">365</span>
      </div>
      {!KIOSK && (
        <div className="search-wrap">
          <input
            className="search"
            placeholder="Search zones & rooms — Enter to fast travel"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && hits.length > 0) travel(hits[0]);
              if (e.key === 'Escape') setQuery('');
            }}
          />
          {hits.length > 0 && (
            <div className="search-results">
              {hits.map(h => (
                <button
                  key={h.kind === 'user' ? `user-${h.userId}` : `${h.kind}-${h.id}`}
                  className="search-hit"
                  onClick={() => travel(h)}
                >
                  <span>
                    {h.kind === 'user' ? `💬 Chat with ${h.name}` : `${h.kind === 'zone' ? '⬢' : '▣'} ${h.name}`}
                  </span>
                  <span className="dim">{h.sub}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="topbar-right">
        {!KIOSK && <AccountControl />}
        {!KIOSK && stdb.isAdmin && (
          <a className="ghost-btn" href="#/admin">
            Admin
          </a>
        )}
        <button className="ghost-btn" onClick={onOpenLegend} title="What am I looking at?">
          ❓ Legend
        </button>
        {!KIOSK && (
          <button className="ghost-btn" onClick={onOpenPrivacy}>
            Privacy & data
          </button>
        )}
        {KIOSK && <span className="kiosk-badge">KIOSK</span>}
        <span className={`status status-${status}`}>
          <span className="status-dot" />
          {status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Stale'}
        </span>
      </div>
    </div>
  );
}
