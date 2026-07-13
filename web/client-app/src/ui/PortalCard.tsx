import React from 'react';
import { stdb, microsToDate, type MeetingPortal } from '../stdb';

const STATE_LABEL: Record<string, string> = {
  upcoming: 'Upcoming',
  soon: 'Starting soon',
  live: 'Live now',
};

/** Meeting portal info card — time/place only; no subject exists by design. */
export function PortalCard({ portal, onClose }: { portal: MeetingPortal; onClose: () => void }) {
  const fmt = (us: bigint) =>
    microsToDate(us).toLocaleString([], {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  return (
    <div className="panel portal-card">
      <div className="panel-header">
        <h2>Meeting portal</h2>
        <button className="ghost-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <span className={`chip portal-state-${portal.state}`}>{STATE_LABEL[portal.state] ?? portal.state}</span>
      <div className="portal-times">
        <div>
          <span className="dim">Starts</span> {fmt(portal.startsAt)}
        </div>
        <div>
          <span className="dim">Ends</span> {fmt(portal.endsAt)}
        </div>
        <div>
          <span className="dim">Zone</span>{' '}
          {portal.zoneId === 0 ? 'Plaza' : stdb.zoneName(portal.zoneId)}
        </div>
      </div>
      <p className="dim portal-note">Subject and attendees are never shown in the world.</p>
    </div>
  );
}
