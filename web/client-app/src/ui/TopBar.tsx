import React, { useMemo, useState } from 'react';
import { stdb } from '../stdb';
import { KIOSK } from '../config';
import { useStore } from './hooks';
import { account, signIn, signOut } from '../auth';
import type { WorldApp } from '../world';

interface SearchHit {
  kind: 'zone' | 'room';
  id: number;
  name: string;
  sub: string;
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
}: {
  world: WorldApp;
  onOpenPrivacy: () => void;
  onOpenLegend: () => void;
}) {
  useStore('status');
  useStore('zones');
  useStore('rooms');
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
    return out.slice(0, 8);
  }, [query, stdb.version('rooms'), stdb.version('zones')]);

  const travel = (hit: SearchHit) => {
    if (hit.kind === 'zone') world.fastTravelToZone(hit.id);
    else world.fastTravelToRoom(hit.id);
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
                <button key={`${h.kind}-${h.id}`} className="search-hit" onClick={() => travel(h)}>
                  <span>{h.kind === 'zone' ? '⬢' : '▣'} {h.name}</span>
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
