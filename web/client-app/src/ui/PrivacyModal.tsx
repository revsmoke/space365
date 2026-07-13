import React from 'react';
import { stdb } from '../stdb';
import { useStore } from './hooks';

function Flag({ on, label }: { on: boolean | undefined; label: string }) {
  return (
    <li>
      <span className={`flag ${on ? 'flag-on' : 'flag-off'}`}>{on ? 'ON' : 'OFF'}</span> {label}
    </li>
  );
}

export function PrivacyModal({ onClose }: { onClose: () => void }) {
  useStore('policy');
  const p = stdb.policy;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="panel-header">
          <h2>Privacy & data</h2>
          <button className="ghost-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p>
            Space365 renders your organization's Microsoft 365 workspace as an ambient world. By
            default it only shows <strong>metadata</strong> — never message content, file content,
            or email.
          </p>
          <h3>What this world is built from</h3>
          <ul>
            <li>Team and channel <em>names and structure</em> (zones and buildings).</li>
            <li>Per-channel <em>message counts</em> aggregated into 1m / 5m / 1h windows (room glow).</li>
            <li>Coarse activity bursts (visual effects) — magnitude only, no content.</li>
            <li>Directory display names for avatars of people exploring the world.</li>
          </ul>
          <h3>What is never collected</h3>
          <ul>
            <li>Message or document content, subject lines, or attachments.</li>
            <li>Private channels are hidden unless you are a member (server-enforced).</li>
            <li>Personal overlays (quests, mentions) exist only after you explicitly opt in.</li>
          </ul>
          <h3>Live policy flags</h3>
          {p ? (
            <ul className="flag-list">
              <Flag on={p.allowAggregates} label="Activity aggregates (room glow & feed)" />
              <Flag on={p.allowPresence} label="Coarse presence" />
              <Flag on={p.presenceFeature} label="Presence feature (Graph)" />
              <Flag on={p.safeMode} label="Safe mode (ingestion paused)" />
              <Flag on={p.devMode} label="Developer mode" />
            </ul>
          ) : (
            <p className="dim">Policy not loaded yet.</p>
          )}
          {p && <p className="dim">Layout version: {p.layoutVersion}</p>}
        </div>
      </div>
    </div>
  );
}
