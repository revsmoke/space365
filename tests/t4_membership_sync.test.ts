import { test, expect } from "bun:test";
import {
  createMembershipStore,
  type MembershipSnapshot,
} from "../spacetime/module/membership_sync";

test("T4 sync stores team/channel membership from snapshot", () => {
  const store = createMembershipStore();

  const snapshot: MembershipSnapshot = {
    teams: [
      { team_id: "team-1", name: "Team 1", is_enabled: true },
      { team_id: "team-2", name: "Team 2", is_enabled: true },
    ],
    channels: [
      { channel_id: "channel-1", team_id: "team-1", name: "general", visibility: "public" },
      { channel_id: "channel-2", team_id: "team-1", name: "private-sec", visibility: "private" },
    ],
    team_members: [
      { team_id: "team-1", user_id: "user-a", role: "member" },
      { team_id: "team-1", user_id: "user-b", role: "member" },
    ],
    channel_members: [{ channel_id: "channel-2", user_id: "user-a", role: "owner" }],
  };

  store.syncFromSnapshot(snapshot);

  expect(store.getTeamMemberCount("team-1")).toBe(2);
  expect(store.getChannelMemberCount("channel-2")).toBe(1);
});

test("T4 private channel non-member access is denied", () => {
  const store = createMembershipStore();
  const snapshot: MembershipSnapshot = {
    teams: [{ team_id: "team-1", name: "Team 1", is_enabled: true }],
    channels: [{ channel_id: "channel-2", team_id: "team-1", name: "private-sec", visibility: "private" }],
    team_members: [{ team_id: "team-1", user_id: "user-a", role: "member" }],
    channel_members: [{ channel_id: "channel-2", user_id: "user-a", role: "member" }],
  };

  store.syncFromSnapshot(snapshot);

  expect(store.canAccessChannel("user-a", "channel-2")).toBe(true);
  expect(store.canAccessChannel("user-b", "channel-2")).toBe(false);
});
