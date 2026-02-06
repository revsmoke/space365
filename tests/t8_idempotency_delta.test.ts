import { test, expect } from "bun:test";
import { createWorldModule, type ChannelMessageEvent } from "../spacetime/module/world_module";
import {
  replayChannelEvents,
  createDeltaCursorStore,
} from "../ingest/src/reconcile";

test("T8 replay is order-stable with idempotent event IDs", () => {
  const ordered: ChannelMessageEvent[] = [
    {
      event_id: "evt-1",
      event_type: "channel.message.created",
      occurred_at: "2026-02-06T00:00:00.000Z",
      context: { team_id: "team-1", channel_id: "channel-1" },
    },
    {
      event_id: "evt-2",
      event_type: "channel.message.created",
      occurred_at: "2026-02-06T00:00:01.000Z",
      context: { team_id: "team-1", channel_id: "channel-1" },
    },
  ];

  const shuffledWithDuplicate: ChannelMessageEvent[] = [
    ordered[1],
    ordered[0],
    ordered[1],
  ];

  const worldA = createWorldModule();
  const worldB = createWorldModule();

  replayChannelEvents(worldA, ordered);
  replayChannelEvents(worldB, shuffledWithDuplicate);

  expect(worldA.getRoomState("channel-1")?.msg_count).toBe(2);
  expect(worldB.getRoomState("channel-1")?.msg_count).toBe(2);
});

test("T8 delta cursor store keeps latest cursor per resource", () => {
  const store = createDeltaCursorStore();
  store.set("teams/team-1/channels", "cursor-1");
  store.set("teams/team-1/channels", "cursor-2");

  expect(store.get("teams/team-1/channels")).toBe("cursor-2");
});
