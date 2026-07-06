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
  | 'burst';

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
          ]);
        // room_activity is subscribed separately: the current published module
        // can panic evaluating this view (multi-column index filter bug), and
        // an isolated subscription keeps the rest of the world live if it does.
        conn
          .subscriptionBuilder()
          .onApplied(() => this.#emit('activity'))
          .onError(ctx => console.warn('[stdb] room_activity subscription error', ctx))
          .subscribe([tables.roomActivity]);
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
    this.#rebuildFeed();
    for (const e of [
      'zones', 'rooms', 'activity', 'players', 'users',
      'worldState', 'policy', 'presence', 'quests', 'portals', 'staff',
    ] as StoreEvent[]) {
      this.#emit(e);
    }
  }

  #putRoom(r: WorldRoom): void {
    this.rooms.set(r.roomId, r);
    this.roomByChannel.set(r.channelId, r.roomId);
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
