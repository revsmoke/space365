/**
 * Parity for sim T7: a burst of N created + M reaction events produces correct
 * 1m/5m/1h aggregate windows, and room glow rises above 0 but is capped at 1.
 *
 * Window counts are asserted server-side via `spacetime sql`; glow is asserted
 * through a live world_rooms subscription. The room_activity client view is
 * NOT subscribed to — see the KNOWN MODULE BUG test.todo at the bottom.
 */
import { test, expect, afterAll, beforeAll } from "bun:test";
import {
  Harness,
  tables,
  waitFor,
  sql,
  cells,
  nowMicros,
  MICROS_PER_MIN,
  MICROS_PER_HOUR,
  RUN_ID,
} from "./harness.ts";

const h = new Harness();
afterAll(() => h.dispose());

// RUN_ID keeps ids unique per run so the suite is re-runnable without republish.
const TEAM = "agg-team";
const CHANNEL = `agg-channel-${RUN_ID}`;
const N_MSGS = 12;
const M_REACTS = 5;

// Pin every event into a single 1m window (offsets < 60s from the window start),
// derived from occurred_at so wall-clock boundaries don't matter.
const BASE = (nowMicros() / MICROS_PER_MIN) * MICROS_PER_MIN;
const WIN_1M = BASE;
const WIN_5M = (BASE / (5n * MICROS_PER_MIN)) * (5n * MICROS_PER_MIN);
const WIN_1H = (BASE / MICROS_PER_HOUR) * MICROS_PER_HOUR;

let service: Awaited<ReturnType<Harness["service"]>>;

beforeAll(async () => {
  service = await h.service();
  await service.conn.reducers.upsertTeam({
    teamId: TEAM,
    name: "Agg Team",
    zoneId: 9301,
    isEnabled: true,
  });
  await service.conn.reducers.upsertChannel({
    channelId: CHANNEL,
    teamId: TEAM,
    name: "agg-general",
    roomId: 9302,
    visibility: "standard",
    isEnabled: true,
  });
});

test(
  "aggregates: burst yields correct 1m/5m/1h windows and glow in (0, 1]",
  async () => {
    const client = await h.connect();
    await h.subscribe(client.conn, [tables.worldRooms]);

    for (let i = 0; i < N_MSGS; i++) {
      await service.conn.reducers.ingestChannelMessageEvent({
        eventId: `agg-msg-${RUN_ID}-${i}`,
        eventType: "channel.message.created",
        occurredAtMicros: BASE + BigInt(i) * 50_000n,
        teamId: TEAM,
        channelId: CHANNEL,
        actorUserId: `agg-user-${i % 3}`,
        messageId: `agg-m-${i}`,
        threadId: undefined,
      });
    }
    for (let i = 0; i < M_REACTS; i++) {
      await service.conn.reducers.ingestChannelMessageEvent({
        eventId: `agg-react-${RUN_ID}-${i}`,
        eventType: "channel.message.reaction",
        occurredAtMicros: BASE + 30_000_000n + BigInt(i) * 50_000n,
        teamId: TEAM,
        channelId: CHANNEL,
        actorUserId: `agg-user-${i % 3}`,
        messageId: `agg-m-${i}`,
        threadId: undefined,
      });
    }

    // Server-side window assertions (reducer promises resolved => committed).
    const agg = (key: string, start: bigint): { msg: number; react: number } => {
      const rows = sql(
        `SELECT msg_count, react_count FROM channel_activity_agg WHERE channel_id = '${CHANNEL}' AND window_key = '${key}' AND window_start = ${start}`
      );
      expect(rows.length).toBe(1);
      const [msg, react] = cells(rows[0]).map(Number);
      return { msg, react };
    };

    for (const [key, start] of [
      ["1m", WIN_1M],
      ["5m", WIN_5M],
      ["1h", WIN_1H],
    ] as const) {
      const { msg, react } = agg(key, start);
      expect(msg).toBe(N_MSGS);
      expect(react).toBe(M_REACTS);
    }

    // Exactly one 1m row for this channel (no split/duplicate windows).
    const oneMinRows = sql(
      `SELECT window_start FROM channel_activity_agg WHERE channel_id = '${CHANNEL}' AND window_key = '1m'`
    );
    expect(oneMinRows.length).toBe(1);

    // Glow: 12 * 0.15 + 5 * 0.08 saturates well above 1, so the cap must hold,
    // and decay (x0.97 every 5s) cannot have reached 0 within this test.
    await waitFor(
      () => {
        const room = [...client.conn.db.worldRooms.iter()].find(
          (r) => r.channelId === CHANNEL
        );
        return !!room && room.glow > 0;
      },
      3000,
      "world_rooms glow > 0 after burst"
    );
    const room = [...client.conn.db.worldRooms.iter()].find(
      (r) => r.channelId === CHANNEL
    )!;
    expect(room.glow).toBeGreaterThan(0);
    expect(room.glow).toBeLessThanOrEqual(1);

    // Server-side room_state agrees on the cap.
    const glowRow = sql(`SELECT glow FROM room_state WHERE channel_id = '${CHANNEL}'`);
    const serverGlow = Number(cells(glowRow[0])[0]);
    expect(serverGlow).toBeGreaterThan(0);
    expect(serverGlow).toBeLessThanOrEqual(1);
  },
  20000
);

// Module bug fixed 2026-07-06: multi-column index prefix filters now use the
// array form ([x] as any) in src/index.ts (tick_agg, both membership syncs,
// room_activity view).
test(
  "aggregates: room_activity view delivers window rows to subscribers",
  async () => {
    const client = await h.connect();
    await h.subscribe(client.conn, [tables.roomActivity]);
    await waitFor(
      () =>
        [...client.conn.db.roomActivity.iter()].some(
          (r) => r.channelId === CHANNEL && r.windowKey === "1m" && r.msgCount === N_MSGS
        ),
      3000,
      "room_activity 1m row"
    );
  }
);
