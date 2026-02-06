import { test, expect } from "bun:test";
import {
  createChannelAggregator,
  type AggregateEvent,
} from "../spacetime/module/channel_aggregates";
import { createWorldModule } from "../spacetime/module/world_module";

test("T7 computes 1m/5m/1h windows", () => {
  const agg = createChannelAggregator({ alpha: 0.5 });
  const events: AggregateEvent[] = [
    {
      channel_id: "channel-1",
      event_type: "channel.message.created",
      occurred_at: "2026-02-06T00:00:00.000Z",
    },
    {
      channel_id: "channel-1",
      event_type: "channel.message.created",
      occurred_at: "2026-02-06T00:04:00.000Z",
    },
    {
      channel_id: "channel-1",
      event_type: "channel.message.reaction",
      occurred_at: "2026-02-06T00:04:30.000Z",
    },
  ];

  for (const event of events) {
    agg.ingest(event);
  }

  const snapshot = agg.getSnapshot("channel-1", "2026-02-06T00:05:00.000Z");
  expect(snapshot?.msg_count_1m).toBe(1);
  expect(snapshot?.msg_count_5m).toBe(2);
  expect(snapshot?.react_count_1m).toBe(1);
  expect(snapshot?.react_count_5m).toBe(1);
});

test("T7 applies EMA smoothing to heat", () => {
  const agg = createChannelAggregator({ alpha: 0.5 });

  agg.ingest({
    channel_id: "channel-1",
    event_type: "channel.message.created",
    occurred_at: "2026-02-06T00:00:00.000Z",
  });
  const first = agg.getSnapshot("channel-1", "2026-02-06T00:00:00.000Z");

  agg.ingest({
    channel_id: "channel-1",
    event_type: "channel.message.created",
    occurred_at: "2026-02-06T00:00:10.000Z",
  });
  const second = agg.getSnapshot("channel-1", "2026-02-06T00:00:10.000Z");

  expect(first?.heat_ema).toBeLessThan(second?.heat_ema ?? 0);
  expect(second?.heat_ema).toBeLessThan(2);
});

test("T7 world reducer path updates channel aggregates", () => {
  const world = createWorldModule();

  world.ingestChannelMessageEvent({
    event_id: "agg-1",
    event_type: "channel.message.created",
    occurred_at: "2026-02-06T00:00:00.000Z",
    context: {
      team_id: "team-1",
      channel_id: "channel-1",
    },
  });

  const snapshot = world.getChannelAggregate(
    "channel-1",
    "2026-02-06T00:00:10.000Z",
  );
  expect(snapshot?.msg_count_1m).toBe(1);
});
