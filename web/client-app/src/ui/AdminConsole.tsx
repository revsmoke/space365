import React, { useEffect, useMemo, useRef, useState } from 'react';
import { stdb, microsToDate, type AdminChannel } from '../stdb';
import { useStore } from './hooks';

/**
 * Admin console (PLAN P4.7), rendered at #/admin.
 *
 * Authorization is server-enforced: all admin_* views return zero rows for
 * non-admin identities, so an empty admin_config doubles as the auth gate.
 * Scope data comes from the admin_teams / admin_channels inventory views
 * (full org inventory including disabled + private rows, admin-gated).
 */

const GRANT_CMD = (hex: string) => `spacetime call space365 grant_role '"${hex}"' '"admin"' --server local`;

// ---- small building blocks -------------------------------------------------

function Toggle({
  checked,
  onChange,
  danger,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`switch ${checked ? 'switch-on' : ''} ${danger ? 'switch-danger' : ''}`}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

function timeAgo(d: Date): string {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return d.toLocaleString();
}

function countdown(to: Date): { text: string; expiringSoon: boolean } {
  const ms = to.getTime() - Date.now();
  if (ms <= 0) return { text: 'expired', expiringSoon: true };
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return { text: h > 0 ? `${h}h ${m}m` : `${m}m`, expiringSoon: ms < 6 * 3_600_000 };
}

// ---- gate -------------------------------------------------------------------

function NotAuthorized() {
  useStore('policy');
  useStore('status');
  const [copied, setCopied] = useState(false);
  const hex = stdb.identityHex;
  const devMode = stdb.policy?.devMode ?? false;
  return (
    <div className="admin-gate">
      <h2>Not authorized</h2>
      <p className="dim">
        This console requires the <strong>admin</strong> role. The server returns no admin data for
        this identity.
      </p>
      {devMode && hex && (
        <div className="link-box">
          <p className="dim">Dev mode: grant this browser identity admin via the CLI, then reload.</p>
          <div className="admin-ident-row">
            <code className="admin-ident">{hex}</code>
            <button
              className="ghost-btn"
              onClick={() => {
                navigator.clipboard?.writeText(GRANT_CMD(hex));
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied!' : 'Copy grant command'}
            </button>
          </div>
          <pre className="admin-cmd">{GRANT_CMD(hex)}</pre>
        </div>
      )}
    </div>
  );
}

// ---- panels ------------------------------------------------------------------

/**
 * "Found a new zone" — admin asks the world to create a real M365 group+team
 * (admin_request_group; the ingest worker provisions it). The new zone then
 * arrives through the normal enabled-teams sync — nothing else to render here.
 */
function FoundZoneForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState(false);
  // synchronous re-entrancy guard (state updates are async; see RequestChannelForm)
  const inFlight = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(false), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const submit = async () => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const err = await stdb.adminRequestGroup(name.trim(), description.trim());
      if (err) {
        setError(err);
      } else {
        setName('');
        setDescription('');
        setOpen(false);
        setToast(true);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="found-zone">
      {!open && (
        <button className="ghost-btn" onClick={() => setOpen(true)}>
          🏛️ Found a new zone
        </button>
      )}
      {open && (
        <div className="found-zone-form">
          <input
            className="search"
            placeholder="Group name"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <input
            className="search"
            placeholder="Description (optional)"
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
          <div className="found-zone-actions">
            <button className="primary-btn" disabled={busy} onClick={() => void submit()}>
              {busy ? '…' : 'Found it'}
            </button>
            <button className="ghost-btn" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          {error && <div className="error-box">{error}</div>}
        </div>
      )}
      {toast && <div className="zone-toast">Requested — the world will build the new zone shortly.</div>}
    </div>
  );
}

function ScopePanel() {
  useStore('adminScope');
  const [openTeam, setOpenTeam] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const teams = [...stdb.adminTeams.values()].sort((a, b) => a.name.localeCompare(b.name));
  const channelsByTeam = useMemo(() => {
    const map = new Map<string, AdminChannel[]>();
    for (const ch of stdb.adminChannels.values()) {
      const list = map.get(ch.teamId) ?? [];
      list.push(ch);
      map.set(ch.teamId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [stdb.version('adminScope')]);

  const setScope = async (kind: 'team' | 'channel', id: string, enabled: boolean) => {
    setBusyId(id);
    setError(null);
    const err = await stdb.adminSetScope(kind, id, enabled);
    setBusyId(null);
    if (err) setError(err);
  };

  return (
    <section className="admin-panel">
      <div className="admin-panel-head">
        <h3>Scope</h3>
        <FoundZoneForm />
      </div>
      <p className="dim admin-panel-sub">
        Which teams and channels exist in the world. Disabled rows are invisible to everyone.
      </p>
      {error && <div className="error-box">{error}</div>}
      <div className="admin-scroll">
        {teams.length === 0 && <div className="dim empty">No teams ingested yet.</div>}
        {teams.map(team => {
          const channels = channelsByTeam.get(team.teamId) ?? [];
          const open = openTeam === team.teamId;
          return (
            <div key={team.teamId} className="scope-team">
              <div className="scope-row">
                <button
                  className="scope-expander"
                  onClick={() => setOpenTeam(open ? null : team.teamId)}
                  aria-expanded={open}
                >
                  {open ? '▾' : '▸'}
                </button>
                <span className="scope-name" title={team.teamId}>
                  {team.name} <span className="dim">· zone {team.zoneId} · {channels.length} ch</span>
                </span>
                <Toggle
                  checked={team.isEnabled}
                  disabled={busyId === team.teamId}
                  onChange={v => setScope('team', team.teamId, v)}
                />
              </div>
              {open &&
                channels.map(ch => (
                  <div key={ch.channelId} className="scope-row scope-channel">
                    <span className="scope-name" title={ch.channelId}>
                      {ch.visibility === 'private' ? '🔒 ' : ''}
                      {ch.name} <span className="dim">· room {ch.roomId}</span>
                    </span>
                    <Toggle
                      checked={ch.isEnabled}
                      disabled={busyId === ch.channelId}
                      onChange={v => setScope('channel', ch.channelId, v)}
                    />
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// `optional`: the key may be absent from config until first set — treat
// missing as 'false' and keep the toggle usable (first flip creates the row).
const BOOL_KEYS: { key: string; label: string; danger?: boolean; optional?: boolean }[] = [
  { key: 'allow_presence', label: 'Presence (staff avatars)' },
  { key: 'allow_aggregates', label: 'Activity aggregates (glow & feed)' },
  { key: 'allow_content_on_click', label: 'Content on click' },
  { key: 'allow_group_join', label: 'Self-service group join/leave', optional: true },
  { key: 'safe_mode', label: 'SAFE MODE — pause & hide everything', danger: true },
  { key: 'ingest_paused', label: 'Pause ingestion' },
  { key: 'dev_mode', label: 'Developer mode' },
];

const NUM_KEYS: { key: string; label: string }[] = [
  { key: 'spike_threshold_1m', label: 'Spike threshold (msgs/1m)' },
  { key: 'retention_events_hours', label: 'Event retention (hours)' },
  { key: 'retention_agg_days', label: 'Aggregate retention (days)' },
  { key: 'decoration_budget', label: 'Decoration budget / user' },
];

function PolicyPanel() {
  useStore('adminConfig');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const val = (key: string) => stdb.adminConfig.get(key)?.value;

  const setConfig = async (key: string, value: string) => {
    setBusyKey(key);
    setError(null);
    const err = await stdb.adminUpdateConfig(key, value);
    setBusyKey(null);
    if (err) setError(err);
  };

  return (
    <section className="admin-panel">
      <h3>Policy</h3>
      <p className="dim admin-panel-sub">Privacy and safety switches. Changes apply live to every client.</p>
      {error && <div className="error-box">{error}</div>}
      <div className="admin-scroll">
        {BOOL_KEYS.map(({ key, label, danger, optional }) => (
          <div key={key} className={`policy-row ${danger ? 'policy-danger' : ''}`}>
            <span>{label}</span>
            <Toggle
              checked={val(key) === 'true'}
              danger={danger}
              disabled={busyKey === key || (!optional && val(key) === undefined)}
              onChange={v => setConfig(key, v ? 'true' : 'false')}
            />
          </div>
        ))}
        <div className="policy-nums">
          {NUM_KEYS.map(({ key, label }) => {
            const current = val(key) ?? '';
            const draft = drafts[key] ?? current;
            const dirty = draft !== current;
            return (
              <label key={key} className="policy-num-row">
                <span>{label}</span>
                <span className="policy-num-controls">
                  <input
                    className="search policy-num-input"
                    type="number"
                    value={draft}
                    onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && dirty && setConfig(key, draft)}
                  />
                  <button
                    className="primary-btn"
                    disabled={!dirty || busyKey === key || draft.trim() === ''}
                    onClick={() => setConfig(key, draft.trim())}
                  >
                    Save
                  </button>
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HealthPanel() {
  useStore('adminHealth');
  // live countdown tick
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const rows = [...stdb.adminHealth.values()].sort((a, b) => a.resource.localeCompare(b.resource));

  const chip = (state: string, expiringSoon: boolean): { cls: string; label: string } => {
    if (state === 'failed') return { cls: 'chip-red', label: 'failed' };
    if (state === 'dry_run') return { cls: 'chip-amber', label: 'dry run' };
    if (expiringSoon) return { cls: 'chip-amber', label: 'expiring' };
    if (state === 'active') return { cls: 'chip-green', label: 'active' };
    return { cls: 'chip-amber', label: state };
  };

  return (
    <section className="admin-panel">
      <h3>Subscription health</h3>
      <p className="dim admin-panel-sub">{rows.length} Graph change-notification subscriptions.</p>
      <div className="admin-scroll">
        {rows.length === 0 && <div className="dim empty">No subscriptions reported.</div>}
        <table className="admin-table">
          <thead>
            <tr>
              <th>Resource</th>
              <th>State</th>
              <th>Expires</th>
              <th>Renewed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(h => {
              const cd = countdown(microsToDate(h.expiresAt));
              const c = chip(h.state, cd.expiringSoon);
              return (
                <tr key={h.graphSubscriptionId}>
                  <td className="admin-resource" title={h.graphSubscriptionId}>
                    {h.resource}
                  </td>
                  <td>
                    <span className={`chip ${c.cls}`}>{c.label}</span>
                  </td>
                  <td>{cd.text}</td>
                  <td className="dim">
                    {h.lastRenewedAt > 0n ? timeAgo(microsToDate(h.lastRenewedAt)) : 'never'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AuditPanel() {
  useStore('adminAudit');
  const entries = stdb.adminAudit.slice(0, 50);

  // Aggregate audit stats by category (summed across hourly buckets).
  const bars = useMemo(() => {
    const totals = new Map<string, number>();
    for (const s of stdb.adminAuditStats) {
      totals.set(s.category, (totals.get(s.category) ?? 0) + s.count);
    }
    const list = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const max = Math.max(1, ...list.map(([, n]) => n));
    return list.map(([category, count]) => ({ category, count, pct: (count / max) * 100 }));
  }, [stdb.version('adminAudit')]);

  return (
    <section className="admin-panel">
      <h3>Audit</h3>
      <p className="dim admin-panel-sub">Recent admin actions (details redacted server-side).</p>
      {bars.length > 0 && (
        <div className="audit-bars">
          {bars.map(b => (
            <div key={b.category} className="audit-bar-row">
              <span className="audit-bar-label">{b.category}</span>
              <span className="audit-bar-track">
                <span className="audit-bar-fill" style={{ width: `${b.pct}%` }} />
              </span>
              <span className="audit-bar-count">{b.count}</span>
            </div>
          ))}
        </div>
      )}
      <div className="admin-scroll">
        {entries.length === 0 && <div className="dim empty">No audit entries.</div>}
        {entries.map(a => (
          <div key={a.id.toString()} className="audit-row">
            <code className="audit-actor" title={a.actor}>
              {a.actor === 'system' ? 'system' : a.actor.replace(/^0x/, '').slice(0, 8)}
            </code>
            <span className="audit-action">{a.action}</span>
            <span className="dim audit-when">{timeAgo(microsToDate(a.at))}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- page --------------------------------------------------------------------

export function AdminConsole() {
  useStore('adminConfig');
  useStore('status');

  return (
    <div className="admin-page">
      <div className="admin-header">
        <h1>Admin console</h1>
        <a className="ghost-btn" href="#/">
          ← Back to world
        </a>
      </div>
      {stdb.isAdmin ? (
        <div className="admin-grid">
          <ScopePanel />
          <PolicyPanel />
          <HealthPanel />
          <AuditPanel />
        </div>
      ) : (
        <NotAuthorized />
      )}
    </div>
  );
}
