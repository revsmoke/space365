import React from 'react';
import { stdb, microsToDate } from '../stdb';
import { useStore } from './hooks';

/**
 * Library panel — opens when a zone's library building is clicked (or the
 * files line on the zone board). Ambient stats come from the public
 * zone_library row; the file list is my_library_files (membership-gated, so
 * it is empty unless signed in AND a member of the team). Never rendered in
 * kiosk mode (the click is inert, like person clicks).
 */

function fmtWhen(us: bigint): string {
  return microsToDate(us).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function LibraryPanel({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  useStore('zones');
  useStore('zoneLibraries');
  useStore('libraryFiles');
  useStore('status');

  const zone = [...stdb.zones.values()].find(z => z.teamId === teamId);
  const lib = stdb.zoneLibraries.get(teamId);

  const files = [...stdb.libraryFiles.values()]
    .filter(f => f.teamId === teamId)
    .sort((a, b) => (b.modifiedAt < a.modifiedAt ? -1 : b.modifiedAt > a.modifiedAt ? 1 : 0));

  return (
    <div className="panel library-panel">
      <div className="panel-header">
        <h2>📚 {zone?.name ?? teamId} — Library</h2>
        <button className="ghost-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {lib ? (
        <div className="library-stats dim">
          {lib.fileCount} files · {lib.recentCount7D} updated this week · last activity{' '}
          {fmtWhen(lib.lastFileAt)}
        </div>
      ) : (
        <div className="library-stats dim">No library stats for this team yet.</div>
      )}

      <div className="zone-section-title">Files</div>
      {!stdb.signedInConnection && <div className="dim zone-empty">Sign in to see files.</div>}
      {stdb.signedInConnection && files.length === 0 && (
        <div className="dim zone-empty">No visible files — not a member or no files.</div>
      )}
      {stdb.signedInConnection && files.length > 0 && (
        <div className="library-file-list">
          {files.map(f => (
            <div key={f.fileId} className="library-file-row">
              <div className="library-file-name" title={f.name}>
                {f.name}
              </div>
              <div className="library-file-meta dim">{fmtWhen(f.modifiedAt)}</div>
              <a
                className="ghost-btn library-file-open"
                href={f.webUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open ↗
              </a>
            </div>
          ))}
        </div>
      )}
      <div className="dim zone-note">Only files you can already access in M365 are listed.</div>
    </div>
  );
}
