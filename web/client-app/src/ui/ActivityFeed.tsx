import React, { useState } from 'react';
import { stdb, microsToDate } from '../stdb';
import { useStore } from './hooks';
import type { WorldApp } from '../world';

function timeAgo(d: Date): string {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return d.toLocaleDateString();
}

export function ActivityFeed({ world }: { world: WorldApp }) {
  useStore('activity');
  useStore('rooms');
  useStore('zones');
  const [teamFilter, setTeamFilter] = useState<string>('');

  const teams = [...stdb.zones.values()];
  const items = stdb.feed
    .filter(item => {
      if (!teamFilter) return true;
      const roomId = stdb.roomByChannel.get(item.channelId);
      const room = roomId !== undefined ? stdb.rooms.get(roomId) : undefined;
      return room?.teamId === teamFilter;
    })
    .slice(0, 40);

  return (
    <div className="panel feed">
      <div className="panel-header">
        <h2>Activity</h2>
        <select className="team-filter" value={teamFilter} onChange={e => setTeamFilter(e.target.value)}>
          <option value="">All teams</option>
          {teams.map(t => (
            <option key={t.teamId} value={t.teamId}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="feed-list">
        {items.length === 0 && <div className="dim empty">No recent activity</div>}
        {items.map(item => {
          const roomId = stdb.roomByChannel.get(item.channelId);
          return (
            <button
              key={item.key}
              className={`feed-row ${item.kind === 'burst' ? 'feed-burst' : ''}`}
              onClick={() => roomId !== undefined && world.fastTravelToRoom(roomId)}
              title="Fast travel"
            >
              <span className="feed-name">
                {item.kind === 'burst' ? '⚡ ' : ''}
                {stdb.channelName(item.channelId)}
              </span>
              <span className="feed-meta">
                {item.kind === 'burst'
                  ? `${item.burstKind ?? 'burst'} ×${(item.magnitude ?? 0).toFixed(1)}`
                  : `${item.msgCount} msg${item.msgCount === 1 ? '' : 's'}`}
                {' · '}
                {timeAgo(microsToDate(item.at))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
