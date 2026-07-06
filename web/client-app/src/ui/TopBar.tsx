import React, { useMemo, useState } from 'react';
import { stdb } from '../stdb';
import { KIOSK } from '../config';
import { useStore } from './hooks';
import type { WorldApp } from '../world';

interface SearchHit {
  kind: 'zone' | 'room';
  id: number;
  name: string;
  sub: string;
}

export function TopBar({ world, onOpenPrivacy }: { world: WorldApp; onOpenPrivacy: () => void }) {
  useStore('status');
  useStore('zones');
  useStore('rooms');
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
