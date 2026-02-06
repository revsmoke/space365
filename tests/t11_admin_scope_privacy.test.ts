import { test, expect } from "bun:test";
import { createMembershipStore } from "../spacetime/module/membership_sync";
import { createAdminConfigStore } from "../spacetime/module/admin_config";

test("T11 allowlist changes channel visibility", () => {
  const config = createAdminConfigStore();
  config.setAllowlistedChannels(["channel-1"]);
  expect(config.isChannelAllowlisted("channel-1")).toBe(true);

  config.setAllowlistedChannels(["channel-2"]);
  expect(config.isChannelAllowlisted("channel-1")).toBe(false);
  expect(config.isChannelAllowlisted("channel-2")).toBe(true);
});

test("T11 visibility guard prevents private channel leakage", () => {
  const membership = createMembershipStore();
  membership.syncFromSnapshot({
    teams: [{ team_id: "team-1", name: "Team 1", is_enabled: true }],
    channels: [
      { channel_id: "channel-1", team_id: "team-1", name: "general", visibility: "public" },
      { channel_id: "channel-2", team_id: "team-1", name: "private", visibility: "private" },
    ],
    team_members: [{ team_id: "team-1", user_id: "user-a", role: "member" }],
    channel_members: [{ channel_id: "channel-2", user_id: "user-a", role: "member" }],
  });

  const config = createAdminConfigStore();
  config.setAllowlistedChannels(["channel-1", "channel-2"]);

  expect(config.canViewChannel({ userId: "user-a", channelId: "channel-2", membership })).toBe(
    true,
  );
  expect(config.canViewChannel({ userId: "user-b", channelId: "channel-2", membership })).toBe(
    false,
  );
});
