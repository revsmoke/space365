import React, { useEffect, useRef, useState } from 'react';
import { stdb, microsToDate, type MyZoneTask, type MembershipRequest } from '../stdb';
import { KIOSK } from '../config';
import { consentish } from '../graph_chat';
import { createPortalMeeting } from '../graph_me';
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

/** Next half-hour boundary as {date: 'YYYY-MM-DD', time: 'HH:MM'} local. */
export function nextHalfHour(now = new Date()): { date: string; time: string } {
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 30 - (d.getMinutes() % 30));
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * "Open a portal" — create a real calendar meeting (Calendars.ReadWrite,
 * delegated; consented on first use). The meetings surface polls every ~5m,
 * and the ingest maps portals to the ORGANIZER's team zone — which may not be
 * the zone whose board this is, hence the helper text.
 */
function OpenPortalForm() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState(() => nextHalfHour().date);
  const [startTime, setStartTime] = useState(() => nextHalfHour().time);
  const [duration, setDuration] = useState(30);
  const [teamsMeeting, setTeamsMeeting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [toast, setToast] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 8000);
    return () => clearTimeout(t);
  }, [toast]);

  const submit = async () => {
    if (!title.trim() || !startDate || !startTime || busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNeedsConsent(false);
    try {
      const start = new Date(`${startDate}T${startTime}:00`);
      const end = new Date(start.getTime() + duration * 60_000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
      await createPortalMeeting({
        subject: title.trim(),
        startDateTime: fmt(start),
        endDateTime: fmt(end),
        teamsMeeting,
      });
      setTitle('');
      setOpen(false);
      setToast(true);
    } catch (err) {
      if (consentish(err)) {
        setNeedsConsent(true);
        setError('Creating a meeting needs consent for calendar access.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="portal-create">
      {!open && (
        <button className="ghost-btn portal-create-toggle" onClick={() => setOpen(true)}>
          ➕ Open a portal
        </button>
      )}
      {open && (
        <div className="portal-create-form">
          <input
            className="zone-input"
            placeholder="Meeting title"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <div className="portal-create-row">
            <input
              className="zone-input"
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
            />
            <input
              className="zone-input"
              type="time"
              step={900}
              value={startTime}
              onChange={e => setStartTime(e.target.value)}
            />
            <select
              className="zone-input portal-create-duration"
              value={duration}
              onChange={e => setDuration(Number(e.target.value))}
            >
              <option value={30}>30 min</option>
              <option value={60}>60 min</option>
            </select>
          </div>
          <label className="portal-create-check">
            <input
              type="checkbox"
              checked={teamsMeeting}
              onChange={e => setTeamsMeeting(e.target.checked)}
            />{' '}
            Teams meeting
          </label>
          <div className="dim zone-note">Appears in your team's zone.</div>
          <div className="portal-create-row">
            <button
              className="primary-btn"
              disabled={busy || !title.trim()}
              onClick={() => void submit()}
            >
              {busy ? '…' : 'Schedule'}
            </button>
            <button className="ghost-btn" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          {error && (
            <div className="error-box">
              {error}
              {needsConsent && (
                <button className="primary-btn messages-grant" onClick={() => void submit()}>
                  Grant access
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {toast && (
        <div className="zone-toast">
          Portal scheduled — it will appear in the world within a few minutes.
        </div>
      )}
    </div>
  );
}

/**
 * Membership ceremonies — request to join/leave THIS zone's group. The client
 * can't read team_member (private), so both buttons always show and the
 * server's readable SenderErrors ('already a member', 'not a member',
 * 'disabled by your admin', ...) render inline. My own requests arrive via
 * the identity-gated my_membership_requests view.
 */
function MembershipSection({ teamId }: { teamId: string }) {
  useStore('membershipRequests');
  useStore('players'); // myUserId comes from my own player row
  const [busy, setBusy] = useState<'join' | 'leave' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const canRequest = stdb.signedInConnection || !!stdb.myUserId;

  const request = async (action: 'join' | 'leave') => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setError(null);
    try {
      const err = await stdb.requestMembership(teamId, action);
      if (err) setError(err);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  // My latest ceremony for this group (newest first by created_at, then id).
  const mine = [...stdb.membershipRequests.values()]
    .filter(r => r.teamId === teamId)
    .sort((a, b) => (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : b.id < a.id ? -1 : 1));
  const latest: MembershipRequest | undefined = mine[0];

  return (
    <>
      <div className="zone-section-title">Membership</div>
      {!canRequest && <div className="dim zone-empty">Sign in to join.</div>}
      {canRequest && (
        <>
          <div className="zone-member-row">
            <button
              className="ghost-btn zone-member-btn"
              disabled={busy !== null}
              onClick={() => void request('join')}
            >
              {busy === 'join' ? '…' : '🚪 Request to join'}
            </button>
            <button
              className="ghost-btn zone-member-btn"
              disabled={busy !== null}
              onClick={() => void request('leave')}
            >
              {busy === 'leave' ? '…' : 'Request to leave'}
            </button>
          </div>
          {error && <div className="error-box">{error}</div>}
          {latest && (
            <div className="zone-member-status">
              {latest.status === 'pending' && (
                <>
                  <span className="chip chip-amber">{latest.action} pending</span>{' '}
                  <span className="dim">Requested — the world is working on it…</span>
                </>
              )}
              {latest.status === 'done' && (
                <>
                  <span className="chip chip-green">✓ {latest.action === 'join' ? 'joined' : 'left'}</span>{' '}
                  <span className="dim">The world carried out your request.</span>
                </>
              )}
              {latest.status === 'failed' && (
                <>
                  <span className="chip chip-red">{latest.action} failed</span>{' '}
                  <span className="dim">{latest.resultRef || 'The world could not complete it.'}</span>
                </>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
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
      {!KIOSK && stdb.signedInConnection && <OpenPortalForm />}

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

      {!KIOSK && <MembershipSection teamId={zone.teamId} />}

      {stdb.isAdmin && <RequestChannelForm teamId={zone.teamId} />}
    </div>
  );
}
