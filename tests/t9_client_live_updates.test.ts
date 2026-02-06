import { test, expect } from "bun:test";
import { createWorldModule } from "../spacetime/module/world_module";
import { createMembershipStore } from "../spacetime/module/membership_sync";
import { createLiveClient } from "../web/client/live_client";

test("T9 client receives live room updates for authorized channel", async () => {
  const world = createWorldModule();
  const membership = createMembershipStore();
  membership.syncFromSnapshot({
    teams: [{ team_id: "team-1", name: "Team 1", is_enabled: true }],
    channels: [{ channel_id: "channel-1", team_id: "team-1", name: "general", visibility: "public" }],
    team_members: [{ team_id: "team-1", user_id: "user-a", role: "member" }],
    channel_members: [],
  });

  const client = createLiveClient({ world, membership, userId: "user-a" });
  expect(client.watchChannel("channel-1")).toBe(true);

  world.ingestChannelMessageEvent({
    event_id: "evt-live-1",
    event_type: "channel.message.created",
    occurred_at: "2026-02-06T00:00:00.000Z",
    context: { team_id: "team-1", channel_id: "channel-1" },
  });

  await Bun.sleep(20);
  expect(client.getViewState("channel-1")?.msg_count).toBe(1);
});

test("T9 client cannot watch private channel when not a member", () => {
  const world = createWorldModule();
  const membership = createMembershipStore();
  membership.syncFromSnapshot({
    teams: [{ team_id: "team-1", name: "Team 1", is_enabled: true }],
    channels: [{ channel_id: "channel-2", team_id: "team-1", name: "private", visibility: "private" }],
    team_members: [{ team_id: "team-1", user_id: "user-b", role: "member" }],
    channel_members: [{ channel_id: "channel-2", user_id: "user-b", role: "member" }],
  });

  const client = createLiveClient({ world, membership, userId: "user-a" });
  expect(client.watchChannel("channel-2")).toBe(false);
});
