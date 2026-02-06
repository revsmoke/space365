import { test, expect } from "bun:test";
import {
  createWorldModule,
  type ChannelMessageEvent,
} from "../spacetime/module/world_module";

test("T2 reducer updates room state and emits subscription update", async () => {
  const world = createWorldModule();
  const updates: number[] = [];

  world.subscribeRoom("channel-1", (state) => {
    updates.push(state.msg_count);
  });

  const event: ChannelMessageEvent = {
    event_id: "evt-1",
    event_type: "channel.message.created",
    occurred_at: "2026-02-06T00:00:00.000Z",
    context: {
      channel_id: "channel-1",
      team_id: "team-1",
    },
  };

  world.ingestChannelMessageEvent(event);

  await Bun.sleep(10);

  expect(updates.at(-1)).toBe(1);
});

test("T2 idempotent reducer ignores duplicate event_id", () => {
  const world = createWorldModule();

  const event: ChannelMessageEvent = {
    event_id: "evt-dupe",
    event_type: "channel.message.created",
    occurred_at: "2026-02-06T00:00:00.000Z",
    context: {
      channel_id: "channel-1",
      team_id: "team-1",
    },
  };

  world.ingestChannelMessageEvent(event);
  world.ingestChannelMessageEvent(event);

  const room = world.getRoomState("channel-1");
  expect(room?.msg_count).toBe(1);
});
