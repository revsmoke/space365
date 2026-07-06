import React from 'react';
import { stdb, microsToDate } from '../stdb';
import { KIOSK } from '../config';
import { useStore } from './hooks';

export function RoomPanel({ roomId, onClose }: { roomId: number; onClose: () => void }) {
  useStore('rooms');
  useStore('activity');
  const room = stdb.rooms.get(roomId);
  if (!room) return null;

  const zoneName = stdb.zoneName(Math.floor(roomId / 100));
  const w5 = stdb.windowCount(room.channelId, '5m');
  const w1h = stdb.windowCount(room.channelId, '1h');
  const lastActivity = room.lastActivityAt > 0n ? microsToDate(room.lastActivityAt) : null;
  const glowPct = Math.round(Math.min(1, room.glow) * 100);
  const deepLink = `https://teams.microsoft.com/l/channel/${encodeURIComponent(room.channelId)}/${encodeURIComponent(
    room.name
  )}?groupId=${encodeURIComponent(room.teamId)}`;

  return (
    <div className="panel room-panel">
      <div className="panel-header">
        <h2>
          {room.isPrivate ? '🔒 ' : ''}
          {room.name}
        </h2>
        <button className="ghost-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="room-sub dim">{zoneName}</div>
      <div className="glow-meter" title={`Glow ${glowPct}%`}>
        <div className="glow-fill" style={{ width: `${glowPct}%` }} />
      </div>
      <div className="room-stats">
        <div className="stat">
          <div className="stat-num">{w5.msgs}</div>
          <div className="stat-label">msgs / 5m</div>
        </div>
        <div className="stat">
          <div className="stat-num">{w1h.msgs}</div>
          <div className="stat-label">msgs / 1h</div>
        </div>
        <div className="stat">
          <div className="stat-num">{Math.max(w5.users, w1h.users)}</div>
          <div className="stat-label">~active users</div>
        </div>
      </div>
      <div className="room-meta dim">
        Last activity: {lastActivity ? lastActivity.toLocaleString() : 'never'}
      </div>
      {!KIOSK && (
        <a className="teams-link" href={deepLink} target="_blank" rel="noreferrer noopener">
          Open in Teams ↗
        </a>
      )}
    </div>
  );
}
