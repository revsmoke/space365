/**
 * DbConnection singleton + client-side store.
 *
 * Wraps the generated SpacetimeDB bindings (shared/bindings) behind typed
 * accessors and a tiny change-event bus so both the three.js world (imperative)
 * and the React overlay (useSyncExternalStore) can consume the same data.
 */
import { DbConnection, tables } from '@bindings';
import type { Infer } from 'spacetimedb';
import { SenderError } from 'spacetimedb';

import WorldZonesRow from '@bindings/world_zones_table';
import WorldRoomsRow from '@bindings/world_rooms_table';
import RoomActivityRow from '@bindings/room_activity_table';
import PlayerStateRow from '@bindings/player_state_table';
import UserRow from '@bindings/user_table';
import WorldStateRow from '@bindings/world_state_table';
import WorldPolicyRow from '@bindings/world_policy_table';
import PresencePublicRow from '@bindings/presence_public_table';
import MyQuestsRow from '@bindings/my_quests_table';
import MeetingPortalsRow from '@bindings/meeting_portals_table';
import EvtRoomBurstRow from '@bindings/evt_room_burst_table';
import StaffPresenceRow from '@bindings/staff_presence_table';
import AdminConfigRow from '@bindings/admin_config_view_table';
import AdminHealthRow from '@bindings/admin_health_table';
import AdminAuditRow from '@bindings/admin_audit_table';
import AdminAuditStatsRow from '@bindings/admin_audit_stats_table';
import AdminTeamsRow from '@bindings/admin_teams_table';
import AdminChannelsRow from '@bindings/admin_channels_table';
import CallStatsAggRow from '@bindings/call_stats_agg_table';
import BookingsAppointmentRow from '@bindings/bookings_appointment_table';
import DecorationRow from '@bindings/decoration_table';

import { STDB_URI, STDB_DB, TOKEN_STORAGE_KEY } from './config';

export type WorldZone = Infer<typeof WorldZonesRow>;
export type WorldRoom = Infer<typeof WorldRoomsRow>;
export type RoomActivity = Infer<typeof RoomActivityRow>;
export type PlayerState = Infer<typeof PlayerStateRow>;
export type UserRowT = Infer<typeof UserRow>;
export type WorldStateRowT = Infer<typeof WorldStateRow>;
export type WorldPolicy = Infer<typeof WorldPolicyRow>;
export type PresencePublic = Infer<typeof PresencePublicRow>;
export type MyQuest = Infer<typeof MyQuestsRow>;
export type MeetingPortal = Infer<typeof MeetingPortalsRow>;
export type RoomBurst = Infer<typeof EvtRoomBurstRow>;
export type StaffPresence = Infer<typeof StaffPresenceRow>;
export type AdminConfig = Infer<typeof AdminConfigRow>;
export type AdminHealth = Infer<typeof AdminHealthRow>;
export type AdminAudit = Infer<typeof AdminAuditRow>;
export type AdminAuditStat = Infer<typeof AdminAuditStatsRow>;
export type AdminTeam = Infer<typeof AdminTeamsRow>;
export type AdminChannel = Infer<typeof AdminChannelsRow>;
export type CallStatsAgg = Infer<typeof CallStatsAggRow>;
export type BookingsAppointment = Infer<typeof BookingsAppointmentRow>;
export type Decoration = Infer<typeof DecorationRow>;

export type ConnStatus = 'connecting' | 'live' | 'stale';

export type StoreEvent =
  | 'status'
  | 'zones'
  | 'rooms'
  | 'activity'
  | 'players'
  | 'users'
  | 'worldState'
  | 'policy'
  | 'presence'
  | 'quests'
  | 'portals'
  | 'staff'
  | 'burst'
  | 'adminConfig'
  | 'adminHealth'
  | 'adminAudit'
  | 'adminScope'
  | 'callStats'
  | 'bookings'
  | 'decorations';

type Listener = (payload?: unknown) => void;

const RECONNECT_DELAY_MS = 3000;
const ACTIVITY_FEED_MAX = 200;

export interface FeedItem {
  key: string;
  kind: 'activity' | 'burst';
  channelId: string;
  /** micros since epoch */
  at: bigint;
  msgCount: number;
  reactCount: number;
  magnitude?: number;
  burstKind?: string;
}

class Stdb {
  conn: DbConnection | null = null;
  status: ConnStatus = 'connecting';
  identityHex: string | null = null;

  /** zone_id -> zone */
  zones = new Map<number, WorldZone>();
  /** room_id -> room (world_rooms; private rooms visible via my_private_rooms merged in) */
  rooms = new Map<number, WorldRoom>();
  /** channel_id -> room_id for quick lookup */
  roomByChannel = new Map<string, number>();
  /** `${channelId}|${windowKey}|${windowStart}` -> row */
  activity = new Map<string, RoomActivity>();
  /** identity hex -> player */
  players = new Map<string, PlayerState>();
  /** user_id -> user */
  users = new Map<string, UserRowT>();
  worldState: WorldStateRowT | null = null;
  policy: WorldPolicy | null = null;
  presence = new Map<string, PresencePublic>();
  quests = new Map<string, MyQuest>();
  portals: MeetingPortal[] = [];
  /** user_id -> ambient staff presence (NPC avatars) */
  staff = new Map<string, StaffPresence>();
  /** hourly call aggregates (Comms Tower) */
  callStats: CallStatsAgg[] = [];
  /** Bookings appointments (Front Desk ticker) */
  bookings: BookingsAppointment[] = [];
  /** decoration id (stringified u64) -> row */
  decorations = new Map<string, Decoration>();

  /** the M365 user id this connection is linked to, if any (from own player row) */
  get myUserId(): string | null {
    if (!this.identityHex) return null;
    const me = this.players.get(this.identityHex);
    return me && me.userId ? me.userId : null;
  }

  // Admin console data (admin-gated views; all empty for non-admins).
  /** config key -> row */
  adminConfig = new Map<string, AdminConfig>();
  /** graph_subscription_id -> row */
  adminHealth = new Map<string, AdminHealth>();
  /** newest-first audit entries */
  adminAudit: AdminAudit[] = [];
  adminAuditStats: AdminAuditStat[] = [];
  /** team_id -> full team row (incl. disabled) */
  adminTeams = new Map<string, AdminTeam>();
  /** channel_id -> full channel row (incl. disabled + private) */
  adminChannels = new Map<string, AdminChannel>();
  /** true once the admin subscription applied AND returned config rows */
  get isAdmin(): boolean {
    return this.adminConfig.size > 0;
  }

  /** rolling feed of recent activity windows + bursts, newest first */
  feed: FeedItem[] = [];

  #listeners = new Map<StoreEvent, Set<Listener>>();
  #versions = new Map<StoreEvent, number>();
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #started = false;

  on(event: StoreEvent, cb: Listener): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  /** monotonically increasing per-event version, for useSyncExternalStore snapshots */
  version(event: StoreEvent): number {
    return this.#versions.get(event) ?? 0;
  }

  #emit(event: StoreEvent, payload?: unknown): void {
    this.#versions.set(event, (this.#versions.get(event) ?? 0) + 1);
    this.#listeners.get(event)?.forEach(cb => cb(payload));
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#connect();
  }

  #connect(): void {
    this.status = 'connecting';
    this.#emit('status');
    const token = localStorage.getItem(TOKEN_STORAGE_KEY) ?? undefined;

    this.conn = DbConnection.builder()
      .withUri(STDB_URI)
      .withDatabaseName(STDB_DB)
      .withToken(token)
      .onConnect((conn, identity, newToken) => {
        this.identityHex = identity.toHexString();
        localStorage.setItem(TOKEN_STORAGE_KEY, newToken);
        this.#registerCallbacks(conn);
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            this.status = 'live';
            this.#snapshotAll(conn);
            this.#emit('status');
          })
          .onError(ctx => {
            console.error('[stdb] subscription error', ctx);
            this.status = 'stale';
            this.#emit('status');
          })
          .subscribe([
            tables.worldZones,
            tables.worldRooms,
            tables.myPrivateRooms,
            tables.worldPolicy,
            tables.presencePublic,
            tables.staffPresence,
            tables.playerState,
            tables.user,
            tables.worldState,
            tables.meetingPortals,
            tables.evtRoomBurst,
            tables.callStatsAgg,
            tables.bookingsAppointment,
            tables.decoration,
          ]);
        // room_activity is subscribed separately: the current published module
        // can panic evaluating this view (multi-column index filter bug), and
        // an isolated subscription keeps the rest of the world live if it does.
        conn
          .subscriptionBuilder()
          .onApplied(() => this.#emit('activity'))
          .onError(ctx => console.warn('[stdb] room_activity subscription error', ctx))
          .subscribe([tables.roomActivity]);
        // Admin views (all return [] for non-admin identities). Isolated so an
        // authorization change or view error never affects the world subscription.
        conn
          .subscriptionBuilder()
          .onApplied(() => this.#snapshotAdmin(conn))
          .onError(ctx => console.warn('[stdb] admin subscription error', ctx))
          .subscribe([
            tables.adminConfigView,
            tables.adminHealth,
            tables.adminAudit,
            tables.adminAuditStats,
            tables.adminTeams,
            tables.adminChannels,
          ]);
      })
      .onConnectError((_ctx, err) => {
        console.error('[stdb] connect error', err);
        // A stale token can be rejected; drop it and retry fresh.
        if (localStorage.getItem(TOKEN_STORAGE_KEY)) {
          localStorage.removeItem(TOKEN_STORAGE_KEY);
        }
        this.status = 'stale';
        this.#emit('status');
        this.#scheduleReconnect();
      })
      .onDisconnect(() => {
        this.status = 'stale';
        this.#emit('status');
        this.#scheduleReconnect();
      })
      .build();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, RECONNECT_DELAY_MS);
  }

  /** Populate maps from the client cache after the subscription applies. */
  #snapshotAll(conn: DbConnection): void {
    this.zones.clear();
    for (const z of conn.db.worldZones.iter()) this.zones.set(z.zoneId, z);
    this.rooms.clear();
    this.roomByChannel.clear();
    for (const r of conn.db.worldRooms.iter()) this.#putRoom(r);
    for (const r of conn.db.myPrivateRooms.iter()) this.#putRoom(r);
    this.activity.clear();
    for (const a of conn.db.roomActivity.iter()) {
      this.activity.set(activityKey(a), a);
    }
    this.players.clear();
    for (const p of conn.db.playerState.iter()) {
      this.players.set(p.identity.toHexString(), p);
    }
    this.users.clear();
    for (const u of conn.db.user.iter()) this.users.set(u.userId, u);
    for (const w of conn.db.worldState.iter()) this.worldState = w;
    for (const p of conn.db.worldPolicy.iter()) this.policy = p;
    this.presence.clear();
    for (const p of conn.db.presencePublic.iter()) this.presence.set(p.userId, p);
    this.staff.clear();
    for (const s of conn.db.staffPresence.iter()) this.staff.set(s.userId, s);
    this.quests.clear();
    for (const q of conn.db.myQuests?.iter?.() ?? []) this.quests.set(q.questId, q);
    this.portals = [...conn.db.meetingPortals.iter()];
    this.callStats = [...conn.db.callStatsAgg.iter()];
    this.bookings = [...conn.db.bookingsAppointment.iter()];
    this.decorations.clear();
    for (const d of conn.db.decoration.iter()) this.decorations.set(d.id.toString(), d);
    this.#rebuildFeed();
    for (const e of [
      'zones', 'rooms', 'activity', 'players', 'users',
      'worldState', 'policy', 'presence', 'quests', 'portals', 'staff',
      'callStats', 'bookings', 'decorations',
    ] as StoreEvent[]) {
      this.#emit(e);
    }
  }

  #putRoom(r: WorldRoom): void {
    this.rooms.set(r.roomId, r);
    this.roomByChannel.set(r.channelId, r.roomId);
  }

  /**
   * Rebuild the admin maps from the client cache. Admin view rows arrive as
   * whole-set inserts/deletes, so re-iterating on change is simple and correct
   * at admin-console scale.
   */
  #snapshotAdmin(conn: DbConnection): void {
    this.adminConfig.clear();
    for (const c of conn.db.adminConfigView.iter()) this.adminConfig.set(c.key, c);
    this.adminHealth.clear();
    for (const h of conn.db.adminHealth.iter()) this.adminHealth.set(h.graphSubscriptionId, h);
    this.adminAudit = [...conn.db.adminAudit.iter()].sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
    this.adminAuditStats = [...conn.db.adminAuditStats.iter()];
    this.adminTeams.clear();
    for (const t of conn.db.adminTeams.iter()) this.adminTeams.set(t.teamId, t);
    this.adminChannels.clear();
    for (const ch of conn.db.adminChannels.iter()) this.adminChannels.set(ch.channelId, ch);
    for (const e of ['adminConfig', 'adminHealth', 'adminAudit', 'adminScope'] as StoreEvent[]) {
      this.#emit(e);
    }
  }

  #registerCallbacks(conn: DbConnection): void {
    conn.db.worldZones.onInsert((_ctx, row) => {
      this.zones.set(row.zoneId, row);
      this.#emit('zones');
    });
    conn.db.worldZones.onDelete((_ctx, row) => {
      this.zones.delete(row.zoneId);
      this.#emit('zones');
    });

    const roomIns = (_ctx: unknown, row: WorldRoom) => {
      this.#putRoom(row);
      this.#emit('rooms');
    };
    const roomDel = (_ctx: unknown, row: WorldRoom) => {
      this.rooms.delete(row.roomId);
      this.roomByChannel.delete(row.channelId);
      this.#emit('rooms');
    };
    conn.db.worldRooms.onInsert(roomIns);
    conn.db.worldRooms.onDelete(roomDel);
    conn.db.myPrivateRooms.onInsert(roomIns);
    conn.db.myPrivateRooms.onDelete(roomDel);

    conn.db.roomActivity.onInsert((_ctx, row) => {
      this.activity.set(activityKey(row), row);
      this.#feedActivity(row);
      this.#emit('activity');
    });
    conn.db.roomActivity.onDelete((_ctx, row) => {
      this.activity.delete(activityKey(row));
      this.#emit('activity');
    });

    conn.db.playerState.onInsert((_ctx, row) => {
      this.players.set(row.identity.toHexString(), row);
      this.#emit('players');
    });
    conn.db.playerState.onUpdate?.((_ctx, _old, row) => {
      this.players.set(row.identity.toHexString(), row);
      this.#emit('players');
    });
    conn.db.playerState.onDelete((_ctx, row) => {
      this.players.delete(row.identity.toHexString());
      this.#emit('players');
    });

    conn.db.user.onInsert((_ctx, row) => {
      this.users.set(row.userId, row);
      this.#emit('users');
    });
    conn.db.user.onUpdate?.((_ctx, _old, row) => {
      this.users.set(row.userId, row);
      this.#emit('users');
    });
    conn.db.user.onDelete((_ctx, row) => {
      this.users.delete(row.userId);
      this.#emit('users');
    });

    conn.db.worldState.onInsert((_ctx, row) => {
      this.worldState = row;
      this.#emit('worldState');
    });
    conn.db.worldState.onUpdate?.((_ctx, _old, row) => {
      this.worldState = row;
      this.#emit('worldState');
    });

    conn.db.worldPolicy.onInsert((_ctx, row) => {
      this.policy = row;
      this.#emit('policy');
    });
    conn.db.worldPolicy.onDelete((_ctx, _row) => {
      this.#emit('policy');
    });

    conn.db.presencePublic.onInsert((_ctx, row) => {
      this.presence.set(row.userId, row);
      this.#emit('presence');
    });
    conn.db.presencePublic.onDelete((_ctx, row) => {
      this.presence.delete(row.userId);
      this.#emit('presence');
    });

    conn.db.staffPresence.onInsert((_ctx, row) => {
      this.staff.set(row.userId, row);
      this.#emit('staff');
    });
    conn.db.staffPresence.onDelete((_ctx, row) => {
      this.staff.delete(row.userId);
      this.#emit('staff');
    });

    conn.db.myQuests.onInsert((_ctx, row) => {
      this.quests.set(row.questId, row);
      this.#emit('quests');
    });
    conn.db.myQuests.onDelete((_ctx, row) => {
      this.quests.delete(row.questId);
      this.#emit('quests');
    });

    conn.db.meetingPortals.onInsert((_ctx, row) => {
      this.portals = [...this.portals, row];
      this.#emit('portals');
    });
    conn.db.meetingPortals.onDelete((_ctx, row) => {
      this.portals = this.portals.filter(p => p.eventId !== row.eventId);
      this.#emit('portals');
    });

    // Event table: insert-only, transient burst signal.
    conn.db.evtRoomBurst.onInsert((_ctx, row) => {
      this.#feedBurst(row);
      this.#emit('activity');
      this.#emit('burst', row);
    });

    const resyncCallStats = () => {
      this.callStats = [...conn.db.callStatsAgg.iter()];
      this.#emit('callStats');
    };
    conn.db.callStatsAgg.onInsert(resyncCallStats);
    conn.db.callStatsAgg.onUpdate?.(resyncCallStats);
    conn.db.callStatsAgg.onDelete(resyncCallStats);

    const resyncBookings = () => {
      this.bookings = [...conn.db.bookingsAppointment.iter()];
      this.#emit('bookings');
    };
    conn.db.bookingsAppointment.onInsert(resyncBookings);
    conn.db.bookingsAppointment.onUpdate?.(resyncBookings);
    conn.db.bookingsAppointment.onDelete(resyncBookings);

    conn.db.decoration.onInsert((_ctx, row) => {
      this.decorations.set(row.id.toString(), row);
      this.#emit('decorations');
    });
    conn.db.decoration.onUpdate?.((_ctx, _old, row) => {
      this.decorations.set(row.id.toString(), row);
      this.#emit('decorations');
    });
    conn.db.decoration.onDelete((_ctx, row) => {
      this.decorations.delete(row.id.toString());
      this.#emit('decorations');
    });

    // Admin views: re-snapshot the affected slice on any change.
    const adminSync = (events: StoreEvent[]) => () => {
      this.#snapshotAdminSlices(conn, events);
    };
    // These views have primary keys, so changes can arrive as updates too.
    for (const t of [conn.db.adminConfigView]) {
      t.onInsert(adminSync(['adminConfig']));
      t.onUpdate?.(adminSync(['adminConfig']));
      t.onDelete(adminSync(['adminConfig']));
    }
    for (const t of [conn.db.adminHealth]) {
      t.onInsert(adminSync(['adminHealth']));
      t.onUpdate?.(adminSync(['adminHealth']));
      t.onDelete(adminSync(['adminHealth']));
    }
    for (const t of [conn.db.adminAudit, conn.db.adminAuditStats]) {
      t.onInsert(adminSync(['adminAudit']));
      t.onUpdate?.(adminSync(['adminAudit']));
      t.onDelete(adminSync(['adminAudit']));
    }
    for (const t of [conn.db.adminTeams, conn.db.adminChannels]) {
      t.onInsert(adminSync(['adminScope']));
      t.onUpdate?.(adminSync(['adminScope']));
      t.onDelete(adminSync(['adminScope']));
    }
  }

  #snapshotAdminSlices(conn: DbConnection, events: StoreEvent[]): void {
    for (const e of events) {
      if (e === 'adminConfig') {
        this.adminConfig.clear();
        for (const c of conn.db.adminConfigView.iter()) this.adminConfig.set(c.key, c);
      } else if (e === 'adminHealth') {
        this.adminHealth.clear();
        for (const h of conn.db.adminHealth.iter()) this.adminHealth.set(h.graphSubscriptionId, h);
      } else if (e === 'adminAudit') {
        this.adminAudit = [...conn.db.adminAudit.iter()].sort((a, b) => (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
        this.adminAuditStats = [...conn.db.adminAuditStats.iter()];
      } else if (e === 'adminScope') {
        this.adminTeams.clear();
        for (const t of conn.db.adminTeams.iter()) this.adminTeams.set(t.teamId, t);
        this.adminChannels.clear();
        for (const ch of conn.db.adminChannels.iter()) this.adminChannels.set(ch.channelId, ch);
      }
      this.#emit(e);
    }
  }

  #rebuildFeed(): void {
    this.feed = [];
    for (const a of this.activity.values()) {
      if (a.windowKey === '1m') this.#feedActivity(a, false);
    }
    this.feed.sort((x, y) => (y.at < x.at ? -1 : y.at > x.at ? 1 : 0));
    this.feed = this.feed.slice(0, ACTIVITY_FEED_MAX);
  }

  #feedActivity(row: RoomActivity, trim = true): void {
    if (row.windowKey !== '1m') return;
    const key = `a|${activityKey(row)}`;
    if (this.feed.some(f => f.key === key)) return;
    this.feed.unshift({
      key,
      kind: 'activity',
      channelId: row.channelId,
      at: row.windowStart,
      msgCount: row.msgCount,
      reactCount: row.reactCount,
    });
    if (trim && this.feed.length > ACTIVITY_FEED_MAX) this.feed.length = ACTIVITY_FEED_MAX;
  }

  #feedBurst(row: RoomBurst): void {
    this.feed.unshift({
      key: `b|${row.id.toString()}`,
      kind: 'burst',
      channelId: row.channelId,
      at: BigInt(Date.now()) * 1000n,
      msgCount: 0,
      reactCount: 0,
      magnitude: row.magnitude,
      burstKind: row.kind,
    });
    if (this.feed.length > ACTIVITY_FEED_MAX) this.feed.length = ACTIVITY_FEED_MAX;
  }

  // ---- reducers ---------------------------------------------------------

  movePlayer(x: number, y: number, z: number, heading: number, zoneId: number, animation: string): void {
    this.conn?.reducers
      .movePlayer({ x, y, z, heading, zoneId, animation })
      .catch(err => console.warn('[stdb] move_player failed', err));
  }

  setEmote(emote: string | undefined): void {
    this.conn?.reducers
      .setEmote({ emote })
      .catch(err => console.warn('[stdb] set_emote failed', err));
  }

  /**
   * Toggle the personal overlay opt-in. Resolves to 'ok' on success,
   * 'needs-link' when the module rejects because no M365 identity is linked,
   * or an error message string for any other failure.
   */
  async setPersonalOptIn(optIn: boolean): Promise<'ok' | 'needs-link' | string> {
    if (!this.conn) return 'not connected';
    try {
      await this.conn.reducers.setPersonalOptIn({ optIn });
      return 'ok';
    } catch (err) {
      if (err instanceof SenderError && /link your account/i.test(String(err.message))) {
        return 'needs-link';
      }
      console.warn('[stdb] set_personal_opt_in failed', err);
      return err instanceof Error ? err.message : String(err);
    }
  }

  async debugLinkSelf(userId: string): Promise<string | null> {
    if (!this.conn) return 'not connected';
    try {
      await this.conn.reducers.debugLinkSelf({ userId });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  dismissQuest(questId: string): void {
    this.conn?.reducers
      .dismissQuest({ questId })
      .catch(err => console.warn('[stdb] dismiss_quest failed', err));
  }

  /** Place a decoration prop. Resolves to an error message or null. */
  async placeDecoration(
    zoneId: number,
    propKind: string,
    x: number,
    y: number,
    z: number,
    rotation: number
  ): Promise<string | null> {
    if (!this.conn) return 'not connected';
    try {
      await this.conn.reducers.placeDecoration({ zoneId, propKind, x, y, z, rotation });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Remove one of your own decorations. Resolves to an error message or null. */
  async removeDecoration(decorationId: bigint): Promise<string | null> {
    if (!this.conn) return 'not connected';
    try {
      await this.conn.reducers.removeDecoration({ decorationId });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Enable/disable a team or channel in the world. Resolves to an error message or null. */
  async adminSetScope(kind: 'team' | 'channel', id: string, enabled: boolean): Promise<string | null> {
    if (!this.conn) return 'not connected';
    try {
      await this.conn.reducers.adminSetScope({ kind, id, enabled });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Update a config key. Resolves to an error message or null. */
  async adminUpdateConfig(key: string, value: string): Promise<string | null> {
    if (!this.conn) return 'not connected';
    try {
      await this.conn.reducers.adminUpdateConfig({ key, value });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  // ---- derived helpers --------------------------------------------------

  zoneName(zoneId: number): string {
    return this.zones.get(zoneId)?.name ?? `Zone ${zoneId}`;
  }

  channelName(channelId: string): string {
    const roomId = this.roomByChannel.get(channelId);
    return (roomId !== undefined && this.rooms.get(roomId)?.name) || channelId;
  }

  /** Sum msg counts over recent windows of the given key for a channel. */
  windowCount(channelId: string, windowKey: '1m' | '5m' | '1h'): { msgs: number; reacts: number; users: number } {
    let msgs = 0;
    let reacts = 0;
    let users = 0;
    for (const a of this.activity.values()) {
      if (a.channelId === channelId && a.windowKey === windowKey) {
        msgs += a.msgCount;
        reacts += a.reactCount;
        users = Math.max(users, a.activeUserEstimate);
      }
    }
    return { msgs, reacts, users };
  }
}

export function activityKey(a: RoomActivity): string {
  return `${a.channelId}|${a.windowKey}|${a.windowStart.toString()}`;
}

/** micros-since-epoch bigint -> Date */
export function microsToDate(us: bigint): Date {
  return new Date(Number(us / 1000n));
}

export const stdb = new Stdb();
