/**
 * Space365 SpacetimeDB module — the authoritative world.
 *
 * All M365-derived state, game state, and config live here. Writes happen only
 * through reducers; clients read only through public tables and views.
 * Privacy invariants (SPEC §5/§10): private channels never leak to non-members,
 * quests are owner-only, admin data is role-gated. Enforced by views, not RLS.
 */
import { schema, table, t, SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';

// ---------------------------------------------------------------------------
// Time constants (all persisted times are u64 micros since Unix epoch)
// ---------------------------------------------------------------------------
const MICROS_PER_SEC = 1_000_000n;
const MICROS_PER_MIN = 60n * MICROS_PER_SEC;
const MICROS_PER_HOUR = 60n * MICROS_PER_MIN;

const WINDOWS: { key: string; micros: bigint }[] = [
  { key: '1m', micros: MICROS_PER_MIN },
  { key: '5m', micros: 5n * MICROS_PER_MIN },
  { key: '1h', micros: MICROS_PER_HOUR },
];

// ---------------------------------------------------------------------------
// Org mirror (private; exposed through views)
// ---------------------------------------------------------------------------
const user = table(
  { name: 'user', public: true },
  {
    user_id: t.string().primaryKey(), // Entra object id
    display_name: t.string(),
    dept: t.string(),
    title: t.string(),
    avatar_seed: t.u32(),
    opt_in_personal: t.bool(),
    is_active: t.bool(),
  }
);

const team = table(
  { name: 'team' },
  {
    team_id: t.string().primaryKey(),
    name: t.string(),
    zone_id: t.u32().index('btree'),
    is_enabled: t.bool(),
  }
);

const channel = table(
  { name: 'channel' },
  {
    channel_id: t.string().primaryKey(),
    team_id: t.string().index('btree'),
    name: t.string(),
    room_id: t.u32().index('btree'),
    is_enabled: t.bool(),
    visibility: t.string(), // 'standard' | 'private' | 'shared'
  }
);

const teamMember = table(
  {
    name: 'team_member',
    indexes: [{ accessor: 'by_team_user', algorithm: 'btree', columns: ['team_id', 'user_id'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    team_id: t.string(),
    user_id: t.string().index('btree'),
    role: t.string(),
    synced_at: t.u64(),
  }
);

const channelMember = table(
  {
    name: 'channel_member',
    indexes: [{ accessor: 'by_channel_user', algorithm: 'btree', columns: ['channel_id', 'user_id'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    channel_id: t.string(),
    user_id: t.string().index('btree'),
    role: t.string(),
    synced_at: t.u64(),
  }
);

// Maps SpacetimeDB identities (OIDC iss+sub) to Entra user ids.
const identityLink = table(
  { name: 'identity_link' },
  {
    identity: t.identity().primaryKey(),
    user_id: t.string().index('btree'),
    linked_at: t.u64(),
  }
);

// ---------------------------------------------------------------------------
// Live world signals
// ---------------------------------------------------------------------------
const roomState = table(
  { name: 'room_state' },
  {
    channel_id: t.string().primaryKey(),
    room_id: t.u32().index('btree'),
    glow: t.f32(),
    last_activity_at: t.u64(),
  }
);

const presence = table(
  { name: 'presence' },
  {
    user_id: t.string().primaryKey(),
    availability: t.string(), // Available | Busy | Away | InAMeeting | Offline...
    activity: t.string(),
    source: t.string(), // 'graph' | 'calendar_fallback'
    last_updated: t.u64(),
  }
);

const activityEvent = table(
  {
    name: 'activity_event',
    indexes: [{ accessor: 'by_channel_time', algorithm: 'btree', columns: ['channel_id', 'occurred_at'] }],
  },
  {
    event_id: t.string().primaryKey(), // stable idempotency key (shared/types createEventId)
    event_type: t.string(),
    occurred_at: t.u64(),
    team_id: t.string(),
    channel_id: t.string(),
    actor_user_id: t.option(t.string()),
    message_id: t.option(t.string()),
    thread_id: t.option(t.string()),
    ingested_at: t.u64(),
  }
);

const channelActivityAgg = table(
  {
    name: 'channel_activity_agg',
    indexes: [
      { accessor: 'by_channel_window', algorithm: 'btree', columns: ['channel_id', 'window_key', 'window_start'] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    channel_id: t.string(),
    window_key: t.string(), // '1m' | '5m' | '1h'
    window_start: t.u64().index('btree'),
    msg_count: t.u32(),
    react_count: t.u32(),
    active_user_estimate: t.u32(),
  }
);

// Transient burst signals for client VFX — event table, never stored.
const evtRoomBurst = table(
  { name: 'evt_room_burst', public: true, event: true },
  {
    id: t.u64().primaryKey().autoInc(),
    channel_id: t.string(),
    room_id: t.u32(),
    kind: t.string(), // 'spike' | 'reaction_storm' | 'new_thread'
    magnitude: t.f32(),
  }
);

// ---------------------------------------------------------------------------
// Personal
// ---------------------------------------------------------------------------
const quest = table(
  { name: 'quest' },
  {
    quest_id: t.string().primaryKey(),
    user_id: t.string().index('btree'),
    kind: t.string(), // 'mention' | 'meeting' | 'onboarding'
    title: t.string(),
    source_ref: t.string(),
    deeplink: t.string(),
    created_at: t.u64(),
    status: t.string(), // 'open' | 'done' | 'dismissed'
  }
);

// ---------------------------------------------------------------------------
// Expanded M365 surface (P4)
// ---------------------------------------------------------------------------
const meeting = table(
  { name: 'meeting' },
  {
    event_id: t.string().primaryKey(),
    team_id: t.option(t.string()),
    zone_id: t.u32().index('btree'),
    subject_redacted: t.string(),
    starts_at: t.u64().index('btree'),
    ends_at: t.u64(),
    join_url: t.option(t.string()), // populated once OnlineMeetings.Read.All lands
    state: t.string(), // 'upcoming' | 'soon' | 'live' | 'ended'
  }
);

const bookingsAppointment = table(
  { name: 'bookings_appointment', public: true },
  {
    appointment_id: t.string().primaryKey(),
    business_id: t.string(),
    service_name: t.string(),
    starts_at: t.u64().index('btree'),
    status: t.string(),
  }
);

const callStatsAgg = table(
  { name: 'call_stats_agg', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    bucket_start: t.u64().index('btree'), // hour bucket
    modality: t.string(), // 'audio' | 'video' | 'pstn' | 'meeting'
    call_count: t.u32(),
    total_minutes: t.f32(),
  }
);

const auditStatsAgg = table(
  { name: 'audit_stats_agg' },
  {
    id: t.u64().primaryKey().autoInc(),
    bucket_start: t.u64().index('btree'), // hour bucket
    category: t.string(), // directory audit category
    count: t.u32(),
  }
);

const subscriptionHealth = table(
  { name: 'subscription_health' },
  {
    graph_subscription_id: t.string().primaryKey(),
    resource: t.string(),
    expires_at: t.u64(),
    last_renewed_at: t.u64(),
    state: t.string(), // 'active' | 'expiring' | 'failed'
  }
);

const graphCursor = table(
  { name: 'graph_cursor' },
  {
    resource: t.string().primaryKey(),
    delta_link: t.string(),
    updated_at: t.u64(),
  }
);

// ---------------------------------------------------------------------------
// Game state (public)
// ---------------------------------------------------------------------------
const playerState = table(
  { name: 'player_state', public: true },
  {
    identity: t.identity().primaryKey(),
    user_id: t.string(),
    x: t.f32(),
    y: t.f32(),
    z: t.f32(),
    heading: t.f32(),
    zone_id: t.u32().index('btree'),
    animation: t.string(), // 'idle' | 'walk' | 'run'
    emote: t.option(t.string()),
    online: t.bool(),
    updated_at: t.u64(),
  }
);

const decoration = table(
  { name: 'decoration', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    zone_id: t.u32().index('btree'),
    owner_user_id: t.string().index('btree'),
    prop_kind: t.string(),
    x: t.f32(),
    y: t.f32(),
    z: t.f32(),
    rotation: t.f32(),
    placed_at: t.u64(),
  }
);

const achievement = table(
  { name: 'achievement', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    team_id: t.string().index('btree'),
    kind: t.string(),
    earned_at: t.u64(),
    window_ref: t.string(),
  }
);

const worldState = table(
  { name: 'world_state', public: true },
  {
    id: t.u32().primaryKey(), // always 0
    day_phase: t.f32(), // 0..1 across 24h local office time
    mood: t.f32(), // 0..1 org-wide activity level
    updated_at: t.u64(),
  }
);

// ---------------------------------------------------------------------------
// Config / auth / audit (private; admin views)
// ---------------------------------------------------------------------------
const config = table(
  { name: 'config' },
  {
    key: t.string().primaryKey(),
    value: t.string(), // JSON or scalar-as-string
    updated_at: t.u64(),
  }
);

const roleGrant = table(
  { name: 'role_grant' },
  {
    identity: t.identity().primaryKey(),
    role: t.string(), // 'admin' | 'service' | 'kiosk'
    granted_at: t.u64(),
  }
);

const auditLog = table(
  { name: 'audit_log' },
  {
    id: t.u64().primaryKey().autoInc(),
    actor: t.string(), // identity hex or 'system'
    action: t.string(),
    at: t.u64().index('btree'),
    details_redacted: t.string(),
  }
);

// ---------------------------------------------------------------------------
// Schedule tables (game loop)
// ---------------------------------------------------------------------------
const tickGlowDecayTimer = table(
  { name: 'tick_glow_decay_timer', scheduled: (): any => tickGlowDecay },
  { scheduled_id: t.u64().primaryKey().autoInc(), scheduled_at: t.scheduleAt() }
);

const tickAggTimer = table(
  { name: 'tick_agg_timer', scheduled: (): any => tickAgg },
  { scheduled_id: t.u64().primaryKey().autoInc(), scheduled_at: t.scheduleAt() }
);

const tickAmbientTimer = table(
  { name: 'tick_ambient_timer', scheduled: (): any => tickAmbient },
  { scheduled_id: t.u64().primaryKey().autoInc(), scheduled_at: t.scheduleAt() }
);

const tickRetentionTimer = table(
  { name: 'tick_retention_timer', scheduled: (): any => tickRetention },
  { scheduled_id: t.u64().primaryKey().autoInc(), scheduled_at: t.scheduleAt() }
);

const tickAchievementsTimer = table(
  { name: 'tick_achievements_timer', scheduled: (): any => tickAchievements },
  { scheduled_id: t.u64().primaryKey().autoInc(), scheduled_at: t.scheduleAt() }
);

// ---------------------------------------------------------------------------
// Schema export
// ---------------------------------------------------------------------------
const spacetimedb = schema({
  user,
  team,
  channel,
  teamMember,
  channelMember,
  identityLink,
  roomState,
  presence,
  activityEvent,
  channelActivityAgg,
  evtRoomBurst,
  quest,
  meeting,
  bookingsAppointment,
  callStatsAgg,
  auditStatsAgg,
  subscriptionHealth,
  graphCursor,
  playerState,
  decoration,
  achievement,
  worldState,
  config,
  roleGrant,
  auditLog,
  tickGlowDecayTimer,
  tickAggTimer,
  tickAmbientTimer,
  tickRetentionTimer,
  tickAchievementsTimer,
});
export default spacetimedb;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowMicros(ctx: any): bigint {
  return ctx.timestamp.microsSinceUnixEpoch as bigint;
}

function getConfig(ctx: any, key: string, fallback: string): string {
  const row = ctx.db.config.key.find(key);
  return row ? row.value : fallback;
}

function setConfig(ctx: any, key: string, value: string): void {
  const existing = ctx.db.config.key.find(key);
  if (existing) ctx.db.config.key.update({ ...existing, value, updated_at: nowMicros(ctx) });
  else ctx.db.config.insert({ key, value, updated_at: nowMicros(ctx) });
}

function audit(ctx: any, action: string, details: string): void {
  ctx.db.auditLog.insert({
    id: 0n,
    actor: ctx.sender.toHexString(),
    action,
    at: nowMicros(ctx),
    details_redacted: details,
  });
}

function roleOf(ctx: any): string | null {
  const grant = ctx.db.roleGrant.identity.find(ctx.sender);
  return grant ? grant.role : null;
}

function requireRole(ctx: any, roles: string[]): void {
  const r = roleOf(ctx);
  if (!r || !roles.includes(r)) {
    throw new SenderError(`requires role in [${roles.join(',')}]`);
  }
}

function ingestAllowed(ctx: any): boolean {
  return getConfig(ctx, 'ingest_paused', 'false') !== 'true';
}

function linkedUserId(ctx: any): string | null {
  const link = ctx.db.identityLink.identity.find(ctx.sender);
  return link ? link.user_id : null;
}

function bumpWindow(ctx: any, channelId: string, occurredAt: bigint, msgDelta: number, reactDelta: number): number {
  let oneMinCount = 0;
  for (const w of WINDOWS) {
    const windowStart = (occurredAt / w.micros) * w.micros;
    const rows = [...ctx.db.channelActivityAgg.by_channel_window.filter([channelId, w.key, windowStart])];
    if (rows.length > 0) {
      const row = rows[0];
      const updated = {
        ...row,
        msg_count: row.msg_count + msgDelta,
        react_count: row.react_count + reactDelta,
      };
      ctx.db.channelActivityAgg.id.update(updated);
      if (w.key === '1m') oneMinCount = updated.msg_count;
    } else {
      ctx.db.channelActivityAgg.insert({
        id: 0n,
        channel_id: channelId,
        window_key: w.key,
        window_start: windowStart,
        msg_count: msgDelta,
        react_count: reactDelta,
        active_user_estimate: 0,
      });
      if (w.key === '1m') oneMinCount = msgDelta;
    }
  }
  return oneMinCount;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
export const init = spacetimedb.init((ctx) => {
  const now = nowMicros(ctx);
  // Config defaults (admin-tunable at runtime)
  const defaults: [string, string][] = [
    ['dev_mode', 'true'],
    ['safe_mode', 'false'],
    ['ingest_paused', 'false'],
    ['allow_presence', 'true'],
    ['allow_aggregates', 'true'],
    ['allow_content_on_click', 'false'],
    ['presence_feature', 'flag_off'], // awaiting Presence.Read.All (calendar fallback active)
    ['online_meetings_feature', 'flag_off'], // awaiting OnlineMeetings.Read.All
    ['spike_threshold_1m', '10'],
    ['retention_events_hours', '24'],
    ['retention_agg_days', '90'],
    ['decoration_budget', '20'],
    ['layout_version', '1'],
    ['office_hours_start', '8'],
    ['office_hours_end', '18'],
    ['office_utc_offset_minutes', '-300'], // America/New_York standard; admin-tunable
  ];
  for (const [k, v] of defaults) {
    if (!ctx.db.config.key.find(k)) ctx.db.config.insert({ key: k, value: v, updated_at: now });
  }
  ctx.db.worldState.insert({ id: 0, day_phase: 0.5, mood: 0, updated_at: now });
  // Game loop
  ctx.db.tickGlowDecayTimer.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(5n * MICROS_PER_SEC) });
  ctx.db.tickAggTimer.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(MICROS_PER_MIN) });
  ctx.db.tickAmbientTimer.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(MICROS_PER_MIN) });
  ctx.db.tickRetentionTimer.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(MICROS_PER_HOUR) });
  ctx.db.tickAchievementsTimer.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(24n * MICROS_PER_HOUR) });
});

export const onConnect = spacetimedb.clientConnected((ctx) => {
  const existing = ctx.db.playerState.identity.find(ctx.sender);
  if (existing) {
    ctx.db.playerState.identity.update({ ...existing, online: true, updated_at: nowMicros(ctx) });
  }
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  const existing = ctx.db.playerState.identity.find(ctx.sender);
  if (existing) {
    ctx.db.playerState.identity.update({ ...existing, online: false, animation: 'idle', updated_at: nowMicros(ctx) });
  }
});

// ---------------------------------------------------------------------------
// Scheduled reducers (game loop)
// ---------------------------------------------------------------------------
export const tickGlowDecay = spacetimedb.reducer(
  { timer: tickGlowDecayTimer.rowType },
  (ctx, _args) => {
    for (const room of [...ctx.db.roomState.iter()]) {
      if (room.glow <= 0.001) {
        if (room.glow !== 0) ctx.db.roomState.channel_id.update({ ...room, glow: 0 });
        continue;
      }
      ctx.db.roomState.channel_id.update({ ...room, glow: room.glow * 0.97 });
    }
  }
);

export const tickAgg = spacetimedb.reducer(
  { timer: tickAggTimer.rowType },
  (ctx, _args) => {
    const now = nowMicros(ctx);
    const fiveMinAgo = now - 5n * MICROS_PER_MIN;
    // active_user_estimate: distinct actors in last 5m, written to the current 5m window
    for (const ch of [...ctx.db.channel.iter()]) {
      if (!ch.is_enabled) continue;
      const actors = new Set<string>();
      // Prefix scan on multi-column index requires array form at runtime (2.6.1
      // types say scalar, runtime says array — runtime wins).
      for (const ev of [...ctx.db.activityEvent.by_channel_time.filter([ch.channel_id] as any)]) {
        if (ev.occurred_at >= fiveMinAgo && ev.actor_user_id) actors.add(ev.actor_user_id);
      }
      if (actors.size === 0) continue;
      const w = WINDOWS[1]; // 5m
      const windowStart = (now / w.micros) * w.micros;
      const rows = [...ctx.db.channelActivityAgg.by_channel_window.filter([ch.channel_id, w.key, windowStart])];
      if (rows.length > 0) {
        ctx.db.channelActivityAgg.id.update({ ...rows[0], active_user_estimate: actors.size });
      } else {
        ctx.db.channelActivityAgg.insert({
          id: 0n,
          channel_id: ch.channel_id,
          window_key: w.key,
          window_start: windowStart,
          msg_count: 0,
          react_count: 0,
          active_user_estimate: actors.size,
        });
      }
    }
  }
);

export const tickAmbient = spacetimedb.reducer(
  { timer: tickAmbientTimer.rowType },
  (ctx, _args) => {
    const now = nowMicros(ctx);
    // day_phase from configured office timezone
    const offsetMin = BigInt(parseInt(getConfig(ctx, 'office_utc_offset_minutes', '-300'), 10));
    const localMicros = now + offsetMin * MICROS_PER_MIN;
    const microsIntoDay = localMicros % (24n * MICROS_PER_HOUR);
    const dayPhase = Number(microsIntoDay) / Number(24n * MICROS_PER_HOUR);
    // mood: msg volume in the last hour, squashed to 0..1
    const hourAgo = now - MICROS_PER_HOUR;
    let msgs = 0;
    for (const agg of [...ctx.db.channelActivityAgg.iter()]) {
      if (agg.window_key === '1m' && agg.window_start >= hourAgo) msgs += agg.msg_count;
    }
    const mood = msgs / (msgs + 50); // saturating
    const ws = ctx.db.worldState.id.find(0);
    if (ws) ctx.db.worldState.id.update({ ...ws, day_phase: dayPhase, mood, updated_at: now });
    // meeting state machine
    const soonWindow = 15n * MICROS_PER_MIN;
    for (const m of [...ctx.db.meeting.iter()]) {
      let state = m.state;
      if (now >= m.ends_at) state = 'ended';
      else if (now >= m.starts_at) state = 'live';
      else if (m.starts_at - now <= soonWindow) state = 'soon';
      else state = 'upcoming';
      if (state !== m.state) ctx.db.meeting.event_id.update({ ...m, state });
    }
  }
);

export const tickRetention = spacetimedb.reducer(
  { timer: tickRetentionTimer.rowType },
  (ctx, _args) => {
    const now = nowMicros(ctx);
    const eventTtl = BigInt(parseInt(getConfig(ctx, 'retention_events_hours', '24'), 10)) * MICROS_PER_HOUR;
    const aggTtl = BigInt(parseInt(getConfig(ctx, 'retention_agg_days', '90'), 10)) * 24n * MICROS_PER_HOUR;
    for (const ev of [...ctx.db.activityEvent.iter()]) {
      if (now - ev.occurred_at > eventTtl) ctx.db.activityEvent.event_id.delete(ev.event_id);
    }
    for (const agg of [...ctx.db.channelActivityAgg.iter()]) {
      if (now - agg.window_start > aggTtl) ctx.db.channelActivityAgg.id.delete(agg.id);
    }
    for (const q of [...ctx.db.quest.iter()]) {
      if (q.status === 'dismissed' && now - q.created_at > 7n * 24n * MICROS_PER_HOUR) {
        ctx.db.quest.quest_id.delete(q.quest_id);
      }
    }
    for (const m of [...ctx.db.meeting.iter()]) {
      if (m.state === 'ended' && now - m.ends_at > 24n * MICROS_PER_HOUR) {
        ctx.db.meeting.event_id.delete(m.event_id);
      }
    }
  }
);

/**
 * Daily team-level awards (never individual — PRD principle 6).
 * Awards `most_active_zone` to the team with the highest message volume in
 * the trailing 24h, once per UTC day.
 */
export const tickAchievements = spacetimedb.reducer(
  { timer: tickAchievementsTimer.rowType },
  (ctx, _args) => {
    const now = nowMicros(ctx);
    const dayRef = `day-${now / (24n * MICROS_PER_HOUR)}`;
    for (const a of [...ctx.db.achievement.iter()]) {
      if (a.kind === 'most_active_zone' && a.window_ref === dayRef) return; // already awarded
    }
    const dayAgo = now - 24n * MICROS_PER_HOUR;
    const byTeam = new Map<string, number>();
    for (const agg of [...ctx.db.channelActivityAgg.iter()]) {
      if (agg.window_key !== '1h' || agg.window_start < dayAgo) continue;
      const ch = ctx.db.channel.channel_id.find(agg.channel_id);
      if (!ch || !ch.is_enabled) continue;
      byTeam.set(ch.team_id, (byTeam.get(ch.team_id) ?? 0) + agg.msg_count);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [teamId, count] of byTeam) {
      if (count > bestCount) {
        best = teamId;
        bestCount = count;
      }
    }
    if (best && bestCount > 0) {
      ctx.db.achievement.insert({ id: 0n, team_id: best, kind: 'most_active_zone', earned_at: now, window_ref: dayRef });
    }
  }
);

// ---------------------------------------------------------------------------
// Role bootstrap + admin
// ---------------------------------------------------------------------------
/** First caller bootstraps as admin; afterwards only admins can grant. */
export const grantRole = spacetimedb.reducer(
  { target: t.identity(), role: t.string() },
  (ctx, { target, role }) => {
    if (!['admin', 'service', 'kiosk'].includes(role)) throw new SenderError('unknown role');
    const anyGrant = [...ctx.db.roleGrant.iter()].length > 0;
    if (anyGrant) requireRole(ctx, ['admin']);
    const existing = ctx.db.roleGrant.identity.find(target);
    if (existing) ctx.db.roleGrant.identity.update({ ...existing, role, granted_at: nowMicros(ctx) });
    else ctx.db.roleGrant.insert({ identity: target, role, granted_at: nowMicros(ctx) });
    audit(ctx, 'grant_role', `${role} -> ${target.toHexString().slice(0, 12)}…`);
  }
);

/** Idempotent: seed any schedule-table rows missing after a hot module update. */
export const adminSeedSchedules = spacetimedb.reducer((ctx) => {
  requireRole(ctx, ['admin']);
  const seed = (tbl: any, interval: bigint) => {
    if ([...tbl.iter()].length === 0) {
      tbl.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(interval) });
    }
  };
  seed(ctx.db.tickGlowDecayTimer, 5n * MICROS_PER_SEC);
  seed(ctx.db.tickAggTimer, MICROS_PER_MIN);
  seed(ctx.db.tickAmbientTimer, MICROS_PER_MIN);
  seed(ctx.db.tickRetentionTimer, MICROS_PER_HOUR);
  seed(ctx.db.tickAchievementsTimer, 24n * MICROS_PER_HOUR);
  audit(ctx, 'seed_schedules', 'ok');
});

export const adminUpdateConfig = spacetimedb.reducer(
  { key: t.string(), value: t.string() },
  (ctx, { key, value }) => {
    requireRole(ctx, ['admin']);
    setConfig(ctx, key, value);
    audit(ctx, 'config_update', key);
  }
);

/** Enable/disable a team or channel in the world (allowlist control). */
export const adminSetScope = spacetimedb.reducer(
  { kind: t.string(), id: t.string(), enabled: t.bool() },
  (ctx, { kind, id, enabled }) => {
    requireRole(ctx, ['admin']);
    if (kind === 'team') {
      const row = ctx.db.team.team_id.find(id);
      if (row) ctx.db.team.team_id.update({ ...row, is_enabled: enabled });
    } else if (kind === 'channel') {
      const row = ctx.db.channel.channel_id.find(id);
      if (row) ctx.db.channel.channel_id.update({ ...row, is_enabled: enabled });
    } else {
      throw new SenderError('kind must be team|channel');
    }
    audit(ctx, 'scope_change', `${kind}:${id}=${enabled}`);
  }
);

export const linkIdentity = spacetimedb.reducer(
  { target: t.identity(), userId: t.string() },
  (ctx, { target, userId }) => {
    requireRole(ctx, ['admin', 'service']);
    const existing = ctx.db.identityLink.identity.find(target);
    if (existing) ctx.db.identityLink.identity.update({ ...existing, user_id: userId, linked_at: nowMicros(ctx) });
    else ctx.db.identityLink.insert({ identity: target, user_id: userId, linked_at: nowMicros(ctx) });
    audit(ctx, 'link_identity', userId);
  }
);

/** Dev-mode only: link the calling identity to a user id without service auth. */
export const debugLinkSelf = spacetimedb.reducer(
  { userId: t.string() },
  (ctx, { userId }) => {
    if (getConfig(ctx, 'dev_mode', 'false') !== 'true') throw new SenderError('dev_mode off');
    const existing = ctx.db.identityLink.identity.find(ctx.sender);
    if (existing) ctx.db.identityLink.identity.update({ ...existing, user_id: userId, linked_at: nowMicros(ctx) });
    else ctx.db.identityLink.insert({ identity: ctx.sender, user_id: userId, linked_at: nowMicros(ctx) });
  }
);

// ---------------------------------------------------------------------------
// Ingest reducers (service role)
// ---------------------------------------------------------------------------
export const upsertUser = spacetimedb.reducer(
  {
    userId: t.string(),
    displayName: t.string(),
    dept: t.string(),
    title: t.string(),
    isActive: t.bool(),
  },
  (ctx, { userId, displayName, dept, title, isActive }) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    const existing = ctx.db.user.user_id.find(userId);
    if (existing) {
      ctx.db.user.user_id.update({ ...existing, display_name: displayName, dept, title, is_active: isActive });
    } else {
      // avatar_seed: stable pseudo-random from user id hash
      let seed = 0;
      for (let i = 0; i < userId.length; i++) seed = (seed * 31 + userId.charCodeAt(i)) >>> 0;
      ctx.db.user.insert({
        user_id: userId,
        display_name: displayName,
        dept,
        title,
        avatar_seed: seed,
        opt_in_personal: false,
        is_active: isActive,
      });
    }
  }
);

export const upsertTeam = spacetimedb.reducer(
  { teamId: t.string(), name: t.string(), zoneId: t.u32(), isEnabled: t.bool() },
  (ctx, { teamId, name, zoneId, isEnabled }) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    const existing = ctx.db.team.team_id.find(teamId);
    if (existing) ctx.db.team.team_id.update({ ...existing, name, zone_id: zoneId, is_enabled: isEnabled });
    else ctx.db.team.insert({ team_id: teamId, name, zone_id: zoneId, is_enabled: isEnabled });
  }
);

export const upsertChannel = spacetimedb.reducer(
  {
    channelId: t.string(),
    teamId: t.string(),
    name: t.string(),
    roomId: t.u32(),
    visibility: t.string(),
    isEnabled: t.bool(),
  },
  (ctx, { channelId, teamId, name, roomId, visibility, isEnabled }) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    const existing = ctx.db.channel.channel_id.find(channelId);
    if (existing) {
      ctx.db.channel.channel_id.update({ ...existing, team_id: teamId, name, room_id: roomId, visibility, is_enabled: isEnabled });
    } else {
      ctx.db.channel.insert({ channel_id: channelId, team_id: teamId, name, room_id: roomId, visibility, is_enabled: isEnabled });
      ctx.db.roomState.insert({ channel_id: channelId, room_id: roomId, glow: 0, last_activity_at: 0n });
    }
  }
);

/** Full membership replacement for one team (idempotent sync). */
export const syncTeamMembership = spacetimedb.reducer(
  { teamId: t.string(), userIds: t.array(t.string()), roles: t.array(t.string()) },
  (ctx, { teamId, userIds, roles }) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    const now = nowMicros(ctx);
    for (const row of [...ctx.db.teamMember.by_team_user.filter([teamId] as any)]) {
      ctx.db.teamMember.id.delete(row.id);
    }
    for (let i = 0; i < userIds.length; i++) {
      ctx.db.teamMember.insert({ id: 0n, team_id: teamId, user_id: userIds[i], role: roles[i] ?? 'member', synced_at: now });
    }
  }
);

export const syncChannelMembership = spacetimedb.reducer(
  { channelId: t.string(), userIds: t.array(t.string()), roles: t.array(t.string()) },
  (ctx, { channelId, userIds, roles }) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    const now = nowMicros(ctx);
    for (const row of [...ctx.db.channelMember.by_channel_user.filter([channelId] as any)]) {
      ctx.db.channelMember.id.delete(row.id);
    }
    for (let i = 0; i < userIds.length; i++) {
      ctx.db.channelMember.insert({ id: 0n, channel_id: channelId, user_id: userIds[i], role: roles[i] ?? 'member', synced_at: now });
    }
  }
);

export const ingestPresence = spacetimedb.reducer(
  { userId: t.string(), availability: t.string(), activity: t.string(), source: t.string() },
  (ctx, { userId, availability, activity, source }) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    if (getConfig(ctx, 'allow_presence', 'true') !== 'true') return;
    if (getConfig(ctx, 'safe_mode', 'false') === 'true') return;
    const existing = ctx.db.presence.user_id.find(userId);
    const now = nowMicros(ctx);
    if (existing) {
      ctx.db.presence.user_id.update({ ...existing, availability, activity, source, last_updated: now });
    } else {
      ctx.db.presence.insert({ user_id: userId, availability, activity, source, last_updated: now });
    }
  }
);

export const ingestChannelMessageEvent = spacetimedb.reducer(
  {
    eventId: t.string(),
    eventType: t.string(), // channel.message.created|updated|deleted|reaction
    occurredAtMicros: t.u64(),
    teamId: t.string(),
    channelId: t.string(),
    actorUserId: t.option(t.string()),
    messageId: t.option(t.string()),
    threadId: t.option(t.string()),
  },
  (ctx, args) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    if (getConfig(ctx, 'allow_aggregates', 'true') !== 'true') return;
    // Idempotency: primary-key insert throws on duplicate → check first.
    if (ctx.db.activityEvent.event_id.find(args.eventId)) return;
    const now = nowMicros(ctx);
    ctx.db.activityEvent.insert({
      event_id: args.eventId,
      event_type: args.eventType,
      occurred_at: args.occurredAtMicros,
      team_id: args.teamId,
      channel_id: args.channelId,
      actor_user_id: args.actorUserId,
      message_id: args.messageId,
      thread_id: args.threadId,
      ingested_at: now,
    });
    const isMsg = args.eventType === 'channel.message.created';
    const isReact = args.eventType === 'channel.message.reaction';
    const isDelete = args.eventType === 'channel.message.deleted';
    const oneMin = bumpWindow(ctx, args.channelId, args.occurredAtMicros, isMsg ? 1 : isDelete ? -0 : 0, isReact ? 1 : 0);
    // Room glow + burst detection
    const room = ctx.db.roomState.channel_id.find(args.channelId);
    if (room && (isMsg || isReact)) {
      const glowBump = isMsg ? 0.15 : 0.08;
      ctx.db.roomState.channel_id.update({
        ...room,
        glow: Math.min(1, room.glow + glowBump),
        last_activity_at: args.occurredAtMicros,
      });
      const threshold = parseInt(getConfig(ctx, 'spike_threshold_1m', '10'), 10);
      if (isMsg && oneMin === threshold) {
        ctx.db.evtRoomBurst.insert({ id: 0n, channel_id: args.channelId, room_id: room.room_id, kind: 'spike', magnitude: 1 });
      }
      if (isReact && oneMin >= threshold / 2) {
        ctx.db.evtRoomBurst.insert({ id: 0n, channel_id: args.channelId, room_id: room.room_id, kind: 'reaction_storm', magnitude: 0.6 });
      }
    }
  }
);

export const upsertMeeting = spacetimedb.reducer(
  {
    eventId: t.string(),
    teamId: t.option(t.string()),
    zoneId: t.u32(),
    subjectRedacted: t.string(),
    startsAtMicros: t.u64(),
    endsAtMicros: t.u64(),
    joinUrl: t.option(t.string()),
  },
  (ctx, a) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    const existing = ctx.db.meeting.event_id.find(a.eventId);
    const row = {
      event_id: a.eventId,
      team_id: a.teamId,
      zone_id: a.zoneId,
      subject_redacted: a.subjectRedacted,
      starts_at: a.startsAtMicros,
      ends_at: a.endsAtMicros,
      join_url: a.joinUrl,
      state: existing ? existing.state : 'upcoming',
    };
    if (existing) ctx.db.meeting.event_id.update(row);
    else ctx.db.meeting.insert(row);
  }
);

export const upsertBookingAppointment = spacetimedb.reducer(
  { appointmentId: t.string(), businessId: t.string(), serviceName: t.string(), startsAtMicros: t.u64(), status: t.string() },
  (ctx, a) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    const existing = ctx.db.bookingsAppointment.appointment_id.find(a.appointmentId);
    const row = {
      appointment_id: a.appointmentId,
      business_id: a.businessId,
      service_name: a.serviceName,
      starts_at: a.startsAtMicros,
      status: a.status,
    };
    if (existing) ctx.db.bookingsAppointment.appointment_id.update(row);
    else ctx.db.bookingsAppointment.insert(row);
  }
);

export const ingestCallStats = spacetimedb.reducer(
  { bucketStartMicros: t.u64(), modality: t.string(), callCount: t.u32(), totalMinutes: t.f32() },
  (ctx, a) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    for (const row of [...ctx.db.callStatsAgg.bucket_start.filter(a.bucketStartMicros)]) {
      if (row.modality === a.modality) {
        ctx.db.callStatsAgg.id.update({ ...row, call_count: a.callCount, total_minutes: a.totalMinutes });
        return;
      }
    }
    ctx.db.callStatsAgg.insert({
      id: 0n,
      bucket_start: a.bucketStartMicros,
      modality: a.modality,
      call_count: a.callCount,
      total_minutes: a.totalMinutes,
    });
  }
);

export const ingestAuditStats = spacetimedb.reducer(
  { bucketStartMicros: t.u64(), category: t.string(), count: t.u32() },
  (ctx, a) => {
    requireRole(ctx, ['service', 'admin']);
    if (!ingestAllowed(ctx)) return;
    for (const row of [...ctx.db.auditStatsAgg.bucket_start.filter(a.bucketStartMicros)]) {
      if (row.category === a.category) {
        ctx.db.auditStatsAgg.id.update({ ...row, count: a.count });
        return;
      }
    }
    ctx.db.auditStatsAgg.insert({ id: 0n, bucket_start: a.bucketStartMicros, category: a.category, count: a.count });
  }
);

export const createOrUpdateQuest = spacetimedb.reducer(
  {
    questId: t.string(),
    userId: t.string(),
    kind: t.string(),
    title: t.string(),
    sourceRef: t.string(),
    deeplink: t.string(),
    status: t.string(),
  },
  (ctx, a) => {
    requireRole(ctx, ['service', 'admin']);
    if (getConfig(ctx, 'safe_mode', 'false') === 'true') return;
    const owner = ctx.db.user.user_id.find(a.userId);
    if (!owner || !owner.opt_in_personal) return; // opt-in enforced server-side
    const existing = ctx.db.quest.quest_id.find(a.questId);
    const row = {
      quest_id: a.questId,
      user_id: a.userId,
      kind: a.kind,
      title: a.title,
      source_ref: a.sourceRef,
      deeplink: a.deeplink,
      created_at: existing ? existing.created_at : nowMicros(ctx),
      status: a.status,
    };
    if (existing) ctx.db.quest.quest_id.update(row);
    else ctx.db.quest.insert(row);
  }
);

export const updateSubscriptionHealth = spacetimedb.reducer(
  { graphSubscriptionId: t.string(), resource: t.string(), expiresAtMicros: t.u64(), state: t.string() },
  (ctx, a) => {
    requireRole(ctx, ['service', 'admin']);
    const existing = ctx.db.subscriptionHealth.graph_subscription_id.find(a.graphSubscriptionId);
    const row = {
      graph_subscription_id: a.graphSubscriptionId,
      resource: a.resource,
      expires_at: a.expiresAtMicros,
      last_renewed_at: nowMicros(ctx),
      state: a.state,
    };
    if (existing) ctx.db.subscriptionHealth.graph_subscription_id.update(row);
    else ctx.db.subscriptionHealth.insert(row);
  }
);

export const setGraphCursor = spacetimedb.reducer(
  { resource: t.string(), deltaLink: t.string() },
  (ctx, { resource, deltaLink }) => {
    requireRole(ctx, ['service', 'admin']);
    const existing = ctx.db.graphCursor.resource.find(resource);
    if (existing) ctx.db.graphCursor.resource.update({ ...existing, delta_link: deltaLink, updated_at: nowMicros(ctx) });
    else ctx.db.graphCursor.insert({ resource, delta_link: deltaLink, updated_at: nowMicros(ctx) });
  }
);

// ---------------------------------------------------------------------------
// Client reducers (game interactions)
// ---------------------------------------------------------------------------
export const movePlayer = spacetimedb.reducer(
  { x: t.f32(), y: t.f32(), z: t.f32(), heading: t.f32(), zoneId: t.u32(), animation: t.string() },
  (ctx, { x, y, z, heading, zoneId, animation }) => {
    const existing = ctx.db.playerState.identity.find(ctx.sender);
    const now = nowMicros(ctx);
    if (existing) {
      ctx.db.playerState.identity.update({ ...existing, x, y, z, heading, zone_id: zoneId, animation, online: true, updated_at: now });
    } else {
      ctx.db.playerState.insert({
        identity: ctx.sender,
        user_id: linkedUserId(ctx) ?? '',
        x, y, z, heading,
        zone_id: zoneId,
        animation,
        emote: undefined,
        online: true,
        updated_at: now,
      });
    }
  }
);

export const setEmote = spacetimedb.reducer(
  { emote: t.option(t.string()) },
  (ctx, { emote }) => {
    const existing = ctx.db.playerState.identity.find(ctx.sender);
    if (existing) ctx.db.playerState.identity.update({ ...existing, emote, updated_at: nowMicros(ctx) });
  }
);

export const placeDecoration = spacetimedb.reducer(
  { zoneId: t.u32(), propKind: t.string(), x: t.f32(), y: t.f32(), z: t.f32(), rotation: t.f32() },
  (ctx, { zoneId, propKind, x, y, z, rotation }) => {
    const userId = linkedUserId(ctx);
    if (!userId) throw new SenderError('link your account first');
    const budget = parseInt(getConfig(ctx, 'decoration_budget', '20'), 10);
    const mine = [...ctx.db.decoration.owner_user_id.filter(userId)];
    if (mine.length >= budget) throw new SenderError('decoration budget reached');
    ctx.db.decoration.insert({ id: 0n, zone_id: zoneId, owner_user_id: userId, prop_kind: propKind, x, y, z, rotation, placed_at: nowMicros(ctx) });
  }
);

export const removeDecoration = spacetimedb.reducer(
  { decorationId: t.u64() },
  (ctx, { decorationId }) => {
    const row = ctx.db.decoration.id.find(decorationId);
    if (!row) return;
    const userId = linkedUserId(ctx);
    const isAdmin = roleOf(ctx) === 'admin';
    if (!isAdmin && row.owner_user_id !== userId) throw new SenderError('not your decoration');
    ctx.db.decoration.id.delete(decorationId);
  }
);

export const setPersonalOptIn = spacetimedb.reducer(
  { optIn: t.bool() },
  (ctx, { optIn }) => {
    const userId = linkedUserId(ctx);
    if (!userId) throw new SenderError('link your account first');
    const u = ctx.db.user.user_id.find(userId);
    if (!u) throw new SenderError('unknown user');
    ctx.db.user.user_id.update({ ...u, opt_in_personal: optIn });
    if (!optIn) {
      for (const q of [...ctx.db.quest.user_id.filter(userId)]) {
        ctx.db.quest.quest_id.delete(q.quest_id);
      }
    }
  }
);

export const dismissQuest = spacetimedb.reducer(
  { questId: t.string() },
  (ctx, { questId }) => {
    const q = ctx.db.quest.quest_id.find(questId);
    if (!q) return;
    const userId = linkedUserId(ctx);
    if (q.user_id !== userId) throw new SenderError('not your quest');
    ctx.db.quest.quest_id.update({ ...q, status: 'dismissed' });
  }
);

// ---------------------------------------------------------------------------
// Views (authorization surface)
// ---------------------------------------------------------------------------
const ZoneView = t.object('ZoneView', {
  team_id: t.string(),
  name: t.string(),
  zone_id: t.u32(),
});

const RoomView = t.object('RoomView', {
  channel_id: t.string(),
  team_id: t.string(),
  name: t.string(),
  room_id: t.u32(),
  glow: t.f32(),
  last_activity_at: t.u64(),
  is_private: t.bool(),
});

const AggView = t.object('AggView', {
  channel_id: t.string(),
  window_key: t.string(),
  window_start: t.u64(),
  msg_count: t.u32(),
  react_count: t.u32(),
  active_user_estimate: t.u32(),
});

const PresenceView = t.object('PresenceView', {
  user_id: t.string(),
  availability: t.string(),
  source: t.string(),
});

const PolicyView = t.object('PolicyView', {
  allow_presence: t.bool(),
  allow_aggregates: t.bool(),
  safe_mode: t.bool(),
  dev_mode: t.bool(),
  layout_version: t.u32(),
  presence_feature: t.bool(),
});

/** Ambient world: enabled zones. Same for every viewer. */
export const worldZones = spacetimedb.anonymousView(
  { name: 'world_zones', public: true },
  t.array(ZoneView),
  (ctx) =>
    [...ctx.db.team.iter()]
      .filter((tm) => tm.is_enabled)
      .map((tm) => ({ team_id: tm.team_id, name: tm.name, zone_id: tm.zone_id }))
);

/** Ambient world: enabled NON-private rooms with live glow. Private channels never appear here. */
export const worldRooms = spacetimedb.anonymousView(
  { name: 'world_rooms', public: true },
  t.array(RoomView),
  (ctx) => {
    const out: any[] = [];
    for (const ch of [...ctx.db.channel.iter()]) {
      if (!ch.is_enabled || ch.visibility === 'private') continue;
      const room = ctx.db.roomState.channel_id.find(ch.channel_id);
      out.push({
        channel_id: ch.channel_id,
        team_id: ch.team_id,
        name: ch.name,
        room_id: ch.room_id,
        glow: room ? room.glow : 0,
        last_activity_at: room ? room.last_activity_at : 0n,
        is_private: false,
      });
    }
    return out;
  }
);

/** Member-gated: private rooms visible only to their members. */
export const myPrivateRooms = spacetimedb.view(
  { name: 'my_private_rooms', public: true },
  t.array(RoomView),
  (ctx) => {
    const link = ctx.db.identityLink.identity.find(ctx.sender);
    if (!link) return [];
    const out: any[] = [];
    for (const cm of [...ctx.db.channelMember.user_id.filter(link.user_id)]) {
      const ch = ctx.db.channel.channel_id.find(cm.channel_id);
      if (!ch || !ch.is_enabled || ch.visibility !== 'private') continue;
      const room = ctx.db.roomState.channel_id.find(ch.channel_id);
      out.push({
        channel_id: ch.channel_id,
        team_id: ch.team_id,
        name: ch.name,
        room_id: ch.room_id,
        glow: room ? room.glow : 0,
        last_activity_at: room ? room.last_activity_at : 0n,
        is_private: true,
      });
    }
    return out;
  }
);

/** Ambient aggregates for non-private enabled channels (recent windows only). */
export const roomActivity = spacetimedb.anonymousView(
  { name: 'room_activity', public: true },
  t.array(AggView),
  (ctx) => {
    const allow = ctx.db.config.key.find('allow_aggregates');
    if (allow && allow.value !== 'true') return [];
    const out: any[] = [];
    for (const ch of [...ctx.db.channel.iter()]) {
      if (!ch.is_enabled || ch.visibility === 'private') continue;
      for (const agg of [...ctx.db.channelActivityAgg.by_channel_window.filter([ch.channel_id] as any)]) {
        out.push({
          channel_id: agg.channel_id,
          window_key: agg.window_key,
          window_start: agg.window_start,
          msg_count: agg.msg_count,
          react_count: agg.react_count,
          active_user_estimate: agg.active_user_estimate,
        });
      }
    }
    return out;
  }
);

/** Coarse presence, policy-gated. */
export const presencePublic = spacetimedb.anonymousView(
  { name: 'presence_public', public: true },
  t.array(PresenceView),
  (ctx) => {
    const allowed = ctx.db.config.key.find('allow_presence');
    const safe = ctx.db.config.key.find('safe_mode');
    if ((allowed && allowed.value !== 'true') || (safe && safe.value === 'true')) return [];
    return [...ctx.db.presence.iter()].map((p) => ({
      user_id: p.user_id,
      availability: p.availability,
      source: p.source,
    }));
  }
);

const StaffPresenceView = t.object('StaffPresenceView', {
  user_id: t.string(),
  display_name: t.string(),
  zone_id: t.u32(), // primary team zone (first enabled membership), 0 = plaza
  availability: t.string(),
  is_active_player: t.bool(),
});

/**
 * Ambient staff: coarse presence per org user placed in their primary team
 * zone. Powers NPC-style avatars so the office feels inhabited even before
 * anyone plays. Policy-gated by allow_presence + safe_mode.
 */
export const staffPresence = spacetimedb.anonymousView(
  { name: 'staff_presence', public: true },
  t.array(StaffPresenceView),
  (ctx) => {
    const allowed = ctx.db.config.key.find('allow_presence');
    const safe = ctx.db.config.key.find('safe_mode');
    if ((allowed && allowed.value !== 'true') || (safe && safe.value === 'true')) return [];
    const activePlayers = new Set<string>();
    for (const p of [...ctx.db.playerState.iter()]) {
      if (p.online && p.user_id) activePlayers.add(p.user_id);
    }
    const out: any[] = [];
    for (const pr of [...ctx.db.presence.iter()]) {
      if (pr.availability === 'Offline' || pr.availability === 'PresenceUnknown') continue;
      const u = ctx.db.user.user_id.find(pr.user_id);
      if (!u || !u.is_active) continue;
      let zoneId = 0;
      for (const tm of [...ctx.db.teamMember.user_id.filter(pr.user_id)]) {
        const team = ctx.db.team.team_id.find(tm.team_id);
        if (team && team.is_enabled) {
          zoneId = team.zone_id;
          break;
        }
      }
      out.push({
        user_id: pr.user_id,
        display_name: u.display_name,
        zone_id: zoneId,
        availability: pr.availability,
        is_active_player: activePlayers.has(pr.user_id),
      });
    }
    return out;
  }
);

/** Client-safe policy flags (never exposes raw config). Single row as 1-element array. */
export const worldPolicy = spacetimedb.anonymousView(
  { name: 'world_policy', public: true },
  t.array(PolicyView),
  (ctx) => {
    const get = (k: string, d: string) => {
      const row = ctx.db.config.key.find(k);
      return row ? row.value : d;
    };
    return [{
      allow_presence: get('allow_presence', 'true') === 'true',
      allow_aggregates: get('allow_aggregates', 'true') === 'true',
      safe_mode: get('safe_mode', 'false') === 'true',
      dev_mode: get('dev_mode', 'false') === 'true',
      layout_version: parseInt(get('layout_version', '1'), 10),
      presence_feature: get('presence_feature', 'flag_off') === 'flag_on',
    }];
  }
);

/** Personal quests — owner only, opt-in enforced at write AND read. */
export const myQuests = spacetimedb.view(
  { name: 'my_quests', public: true },
  t.array(quest.rowType),
  (ctx) => {
    const link = ctx.db.identityLink.identity.find(ctx.sender);
    if (!link) return [];
    const u = ctx.db.user.user_id.find(link.user_id);
    if (!u || !u.opt_in_personal) return [];
    return [...ctx.db.quest.user_id.filter(link.user_id)].filter((q) => q.status === 'open');
  }
);

const MeetingPortalView = t.object('MeetingPortalView', {
  event_id: t.string(),
  zone_id: t.u32(),
  starts_at: t.u64(),
  ends_at: t.u64(),
  state: t.string(),
});

/** Ambient meeting portals — time/place only, no subject or join link. */
export const meetingPortals = spacetimedb.anonymousView(
  { name: 'meeting_portals', public: true },
  t.array(MeetingPortalView),
  (ctx) =>
    [...ctx.db.meeting.iter()]
      .filter((m) => m.state !== 'ended')
      .map((m) => ({ event_id: m.event_id, zone_id: m.zone_id, starts_at: m.starts_at, ends_at: m.ends_at, state: m.state }))
);

/** Admin-only ops data. */
export const adminHealth = spacetimedb.view(
  { name: 'admin_health', public: true },
  t.array(subscriptionHealth.rowType),
  (ctx) => {
    const grant = ctx.db.roleGrant.identity.find(ctx.sender);
    if (!grant || grant.role !== 'admin') return [];
    return [...ctx.db.subscriptionHealth.iter()];
  }
);

export const adminConfigView = spacetimedb.view(
  { name: 'admin_config', public: true },
  t.array(config.rowType),
  (ctx) => {
    const grant = ctx.db.roleGrant.identity.find(ctx.sender);
    if (!grant || grant.role !== 'admin') return [];
    return [...ctx.db.config.iter()];
  }
);

/** Full org inventory for the admin scope panel — includes disabled and private. */
export const adminTeams = spacetimedb.view(
  { name: 'admin_teams', public: true },
  t.array(team.rowType),
  (ctx) => {
    const grant = ctx.db.roleGrant.identity.find(ctx.sender);
    if (!grant || grant.role !== 'admin') return [];
    return [...ctx.db.team.iter()];
  }
);

export const adminChannels = spacetimedb.view(
  { name: 'admin_channels', public: true },
  t.array(channel.rowType),
  (ctx) => {
    const grant = ctx.db.roleGrant.identity.find(ctx.sender);
    if (!grant || grant.role !== 'admin') return [];
    return [...ctx.db.channel.iter()];
  }
);

/** Security Wing data — admin only. */
export const adminAuditStats = spacetimedb.view(
  { name: 'admin_audit_stats', public: true },
  t.array(auditStatsAgg.rowType),
  (ctx) => {
    const grant = ctx.db.roleGrant.identity.find(ctx.sender);
    if (!grant || grant.role !== 'admin') return [];
    return [...ctx.db.auditStatsAgg.iter()];
  }
);

export const adminAudit = spacetimedb.view(
  { name: 'admin_audit', public: true },
  t.array(auditLog.rowType),
  (ctx) => {
    const grant = ctx.db.roleGrant.identity.find(ctx.sender);
    if (!grant || grant.role !== 'admin') return [];
    return [...ctx.db.auditLog.iter()].slice(-200);
  }
);
