import React, { useEffect, useRef, useState } from 'react';
import { stdb, microsToDate, type MyZoneTask } from '../stdb';
import { useStore } from './hooks';

/**
 * Zone board — opens when a zone platform/label is clicked (and no room,
 * portal, tower or avatar was hit). Shows the team's upcoming meetings
 * (times + state only; no subjects by design) and the Planner tasks visible
 * to me (my_zone_tasks; membership-gated). Admins get a "request new
 * channel" mini-form executed asynchronously by the ingest worker.
 */

const STATE_LABEL: Record<string, string> = {
  upcoming: 'Upcoming',
  soon: 'Starting soon',
  live: 'Live now',
};

function fmtTime(us: bigint): string {
  return microsToDate(us).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function taskOrder(a: MyZoneTask, b: MyZoneTask): number {
  const doneA = a.percentComplete >= 100 ? 1 : 0;
  const doneB = b.percentComplete >= 100 ? 1 : 0;
  if (doneA !== doneB) return doneA - doneB; // completed last
  const dueA = a.due ?? '9999';
  const dueB = b.due ?? '9999';
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  return a.title.localeCompare(b.title);
}

function RequestChannelForm({ teamId }: { teamId: string }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState(false);
  // synchronous re-entrancy guard: state updates are async, so a rapid double
  // click could otherwise submit twice before `busy` re-renders
  const inFlight = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const submit = async () => {
    if (!name.trim() || busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const err = await stdb.adminRequestChannel(teamId, name.trim(), description.trim());
      if (err) {
        setError(err);
      } else {
        setName('');
        setDescription('');
        setToast(true);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="zone-request">
      <div className="zone-section-title">Request new channel</div>
      <input
        className="zone-input"
        placeholder="Channel name"
        value={name}
        onChange={e => setName(e.target.value)}
      />
      <input
        className="zone-input"
        placeholder="Description (optional)"
        value={description}
        onChange={e => setDescription(e.target.value)}
      />
      <button className="primary-btn" disabled={busy || !name.trim()} onClick={() => void submit()}>
        {busy ? '…' : 'Request'}
      </button>
      {error && <div className="error-box">{error}</div>}
      {toast && <div className="zone-toast">Requested — the world will build it shortly.</div>}
    </div>
  );
}

export function ZoneBoard({
  zoneId,
  onClose,
  onOpenLibrary,
}: {
  zoneId: number;
  onClose: () => void;
  /** opens the library panel; omitted in kiosk mode (line renders as plain text) */
  onOpenLibrary?: (teamId: string) => void;
}) {
  useStore('zones');
  useStore('portals');
  useStore('zoneTasks');
  useStore('adminConfig');
  useStore('zoneLibraries');
  useStore('zoneMailboxes');
  useStore('status');

  const zone = stdb.zones.get(zoneId);
  if (!zone) return null;

  const lib = stdb.zoneLibraries.get(zone.teamId);
  const mailbox = stdb.zoneMailboxes.get(zone.teamId);

  // de-dupe by eventId: the meeting_portals view can carry duplicate rows
  // per event (observed on the dev db), and eventId doubles as the React key
  const portalById = new Map(stdb.portals.filter(p => p.zoneId === zoneId).map(p => [p.eventId, p]));
  const portals = [...portalById.values()].sort((a, b) =>
    a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0
  );
  const tasks = [...stdb.zoneTasks.values()].filter(t => t.teamId === zone.teamId).sort(taskOrder);

  return (
    <div className="panel zone-board">
      <div className="panel-header">
        <h2>⬢ {zone.name}</h2>
        <button className="ghost-btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      {lib &&
        (onOpenLibrary ? (
          <button className="zone-stat-line zone-stat-link" onClick={() => onOpenLibrary(zone.teamId)}>
            📚 {lib.fileCount} files · {lib.recentCount7D} this week
          </button>
        ) : (
          <div className="zone-stat-line">
            📚 {lib.fileCount} files · {lib.recentCount7D} this week
          </div>
        ))}
      {mailbox && (
        <div className="zone-stat-line">✉️ {mailbox.threadCount7D} mail threads this week</div>
      )}

      <div className="zone-section-title">Upcoming meetings</div>
      {portals.length === 0 && <div className="dim zone-empty">No meetings on the board.</div>}
      {portals.length > 0 && (
        <div className="zone-portal-list">
          {portals.map(p => (
            <div key={p.eventId} className="zone-portal-row">
              <span className={`chip portal-state-${p.state}`}>{STATE_LABEL[p.state] ?? p.state}</span>
              <span className="zone-portal-time">
                {fmtTime(p.startsAt)} <span className="dim">→</span> {fmtTime(p.endsAt)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="dim zone-note">Subjects and attendees are never shown in the world.</div>

      <div className="zone-section-title">Team tasks</div>
      {tasks.length === 0 && (
        <div className="dim zone-empty">No visible tasks — sign in / not a member / no plans.</div>
      )}
      {tasks.length > 0 && (
        <div className="zone-task-list">
          {tasks.map(t => {
            const done = t.percentComplete >= 100;
            return (
              <div key={t.taskId} className="zone-task-row">
                <div className={`zone-task-title${done ? ' zone-task-done' : ''}`}>{t.title}</div>
                <div className="zone-task-meta dim">
                  {t.bucket && <span className="zone-task-bucket">{t.bucket}</span>}
                  {t.planTitle && <span> · {t.planTitle}</span>}
                  {t.due && <span> · due {t.due.slice(0, 10)}</span>}
                </div>
                <div className="glow-meter zone-task-progress" title={`${t.percentComplete}%`}>
                  <div className="glow-fill" style={{ width: `${Math.min(100, t.percentComplete)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {stdb.isAdmin && <RequestChannelForm teamId={zone.teamId} />}
    </div>
  );
}
