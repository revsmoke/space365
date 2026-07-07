import React from 'react';

function Row({ swatch, name, desc }: { swatch: React.ReactNode; name: string; desc: string }) {
  return (
    <li className="legend-row">
      <span className="legend-swatch" aria-hidden>
        {swatch}
      </span>
      <span>
        <strong>{name}</strong> — {desc}
      </span>
    </li>
  );
}

/** "What am I looking at?" — plain-language key to every world element. */
export function LegendModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="panel-header">
          <h2>World legend</h2>
          <button className="ghost-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <h3>Places</h3>
          <ul className="legend-list">
            <Row swatch="🔵" name="Plaza" desc="the neutral hub at the center of the office" />
            <Row
              swatch="🟪"
              name="Zones (colored platforms)"
              desc="your real Teams; the color never changes for a given team"
            />
            <Row
              swatch="🏠"
              name="Rooms (buildings)"
              desc="channels in that team. Glow = live message activity, fading after ~2 quiet minutes; sparkles = a sudden burst"
            />
          </ul>
          <h3>The ring things</h3>
          <ul className="legend-list">
            <Row
              swatch="🗼"
              name="Comms Tower (spire with a stack of rings)"
              desc="the last 24 hours of real call & meeting volume — one ring per hour; bigger and brighter = more minutes; blue = audio, orange = video. Click it for the chart"
            />
            <Row
              swatch="⭕"
              name="Meeting portals (floating rings near zones)"
              desc="one ring per real calendar meeting, in the organizer's team zone; several meetings stack upward. Faint = upcoming, pulsing = starting soon, spinning with a beam = happening now. Click for times"
            />
            <Row
              swatch="🟢"
              name="Availability rings (at people's feet)"
              desc="live Teams presence: teal Available, orange Busy, red Do-not-disturb/Presenting, violet In a meeting or call, gray Away"
            />
          </ul>
          <h3>People</h3>
          <ul className="legend-list">
            <Row
              swatch="🧍"
              name="Standing figures"
              desc="everyone in the org with live presence, standing in their team's zone"
            />
            <Row
              swatch="🚶"
              name="Walking avatars with name plates"
              desc="signed-in players — real accounts, moving in real time"
            />
          </ul>
          <h3>Objects & ambience</h3>
          <ul className="legend-list">
            <Row swatch="🛎️" name="Front Desk (south of plaza)" desc="today's Bookings appointments ticker" />
            <Row swatch="🪴" name="Props" desc="decorations placed by players (🎨 button; 20 per person)" />
            <Row
              swatch="🌗"
              name="Sky & light"
              desc="the actual time of day at the office; floating motes get denser when the whole org is active"
            />
            <Row
              swatch="🗺️"
              name="Minimap (bottom right)"
              desc="zone dots with activity heat; the white dot is you; click anywhere on it to travel"
            />
          </ul>
          <p className="dim">
            Everything here is metadata — counts, times, presence states. Message content only ever
            appears if you click into a room while signed in, and it is never stored.
          </p>
        </div>
      </div>
    </div>
  );
}
