/**
 * Parity for sim T8: ingest_channel_message_event is idempotent on event_id and
 * replay order does not matter.
 *  - the same event sent 3x counts once
 *  - a shuffled replay (with duplicates) of 10 distinct events produces the
 *    exact same aggregate counts as the ordered replay
 *
 * Aggregate state is asserted server-side via `spacetime sql` over
 * channel_activity_agg — the source of truth for counts. (The room_activity
 * view is also live-tested in parity_aggregates.test.ts since the 2026-07-06
 * multi-column index filter fix.)
 */
import { test, expect, afterAll, beforeAll } from "bun:test";
import {
  Harness,
  sql,
  cells,
  nowMicros,
  MICROS_PER_MIN,
  seededShuffle,
  RUN_ID,
} from "./harness.ts";

const h = new Harness();
afterAll(() => h.dispose());

// RUN_ID keeps ids unique per run so the suite is re-runnable without republish.
const TEAM = "idem-team";
const CH_DUPE = `idem-dupe-ch-${RUN_ID}`;
const CH_ORDERED = `idem-ordered-ch-${RUN_ID}`;
const CH_SHUFFLED = `idem-shuffled-ch-${RUN_ID}`;

// All events in one fixed 1m window so 1m/5m/1h aggregates are directly comparable.
const WINDOW_START = (nowMicros() / MICROS_PER_MIN) * MICROS_PER_MIN;

let service: Awaited<ReturnType<Harness["service"]>>;

beforeAll(async () => {
  service = await h.service();
  for (const [channelId, roomId] of [
    [CH_DUPE, 9201],
    [CH_ORDERED, 9202],
    [CH_SHUFFLED, 9203],
  ] as const) {
    await service.conn.reducers.upsertChannel({
      channelId,
      teamId: TEAM,
      name: channelId,
      roomId,
      visibility: "standard",
      isEnabled: true,
    });
  }
});

function msgEvent(channelId: string, eventId: string, offsetMicros: bigint) {
  return {
    eventId,
    eventType: "channel.message.created",
    occurredAtMicros: WINDOW_START + offsetMicros,
    teamId: TEAM,
    channelId,
    actorUserId: `idem-actor-${eventId}`,
    messageId: `msg-${eventId}`,
    threadId: undefined,
  };
}

/** msg_count of the 1m aggregate window for a channel, read server-side. */
function msgCount1m(channelId: string): number {
  const rows = sql(
    `SELECT msg_count FROM channel_activity_agg WHERE channel_id = '${channelId}' AND window_key = '1m' AND window_start = ${WINDOW_START}`
  );
  if (rows.length === 0) return 0;
  expect(rows.length).toBe(1);
  return Number(cells(rows[0])[0]);
}

test(
  "idempotency: the same event sent 3x counts exactly once",
  async () => {
    const ev = msgEvent(CH_DUPE, `${CH_DUPE}-evt-1`, 1000n);
    await service.conn.reducers.ingestChannelMessageEvent(ev);
    await service.conn.reducers.ingestChannelMessageEvent(ev);
    await service.conn.reducers.ingestChannelMessageEvent(ev);

    expect(msgCount1m(CH_DUPE)).toBe(1);
    const evtRows = sql(
      `SELECT event_id FROM activity_event WHERE channel_id = '${CH_DUPE}'`
    );
    expect(evtRows.length).toBe(1);
  },
  15000
);

test(
  "idempotency: shuffled replay with duplicates matches ordered replay",
  async () => {
    // 10 distinct logical events, mirrored across two channels (event_id is a
    // global primary key, so each channel gets its own id set with identical
    // occurred_at timestamps -> identical windows).
    const offsets = Array.from({ length: 10 }, (_, i) => BigInt(i) * 100_000n);

    const ordered = offsets.map((off, i) => msgEvent(CH_ORDERED, `${CH_ORDERED}-evt-${i}`, off));
    const shuffledBase = offsets.map((off, i) => msgEvent(CH_SHUFFLED, `${CH_SHUFFLED}-evt-${i}`, off));
    // Shuffle and re-append 5 duplicates: order-independence AND idempotency.
    const shuffled = [
      ...seededShuffle(shuffledBase),
      shuffledBase[3],
      shuffledBase[7],
      shuffledBase[0],
      shuffledBase[9],
      shuffledBase[5],
    ];

    for (const ev of ordered) await service.conn.reducers.ingestChannelMessageEvent(ev);
    for (const ev of shuffled) await service.conn.reducers.ingestChannelMessageEvent(ev);

    expect(msgCount1m(CH_ORDERED)).toBe(10);
    expect(msgCount1m(CH_SHUFFLED)).toBe(10);

    // Compare across every window key (1m/5m/1h): duplicate replays must not
    // double-count in ANY window.
    for (const key of ["1m", "5m", "1h"]) {
      const a = sql(
        `SELECT msg_count, react_count FROM channel_activity_agg WHERE channel_id = '${CH_ORDERED}' AND window_key = '${key}'`
      ).map(cells);
      const b = sql(
        `SELECT msg_count, react_count FROM channel_activity_agg WHERE channel_id = '${CH_SHUFFLED}' AND window_key = '${key}'`
      ).map(cells);
      expect(b).toEqual(a);
      expect(a.length).toBe(1);
      expect(cells(sql(
        `SELECT msg_count FROM channel_activity_agg WHERE channel_id = '${CH_ORDERED}' AND window_key = '${key}'`
      )[0])[0]).toBe("10");
    }

    // Exactly 10 distinct activity_event rows per channel despite 15 sends.
    const shufEvents = sql(
      `SELECT event_id FROM activity_event WHERE channel_id = '${CH_SHUFFLED}'`
    );
    expect(shufEvents.length).toBe(10);
  },
  20000
);
