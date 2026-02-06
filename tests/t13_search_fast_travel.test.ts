import { test, expect } from "bun:test";
import { createMembershipStore } from "../spacetime/module/membership_sync";
import { createAdminConfigStore } from "../spacetime/module/admin_config";
import {
  createFastTravelLinkStore,
  createSearchFastTravelService,
} from "../web/client/search_fast_travel";

test("T13 search returns only authorized channels", () => {
  const membership = createMembershipStore();
  membership.syncFromSnapshot({
    teams: [{ team_id: "team-1", name: "Team 1", is_enabled: true }],
    channels: [
      { channel_id: "channel-1", team_id: "team-1", name: "general", visibility: "public" },
      { channel_id: "channel-2", team_id: "team-1", name: "private", visibility: "private" },
    ],
    team_members: [
      { team_id: "team-1", user_id: "user-a", role: "member" },
      { team_id: "team-1", user_id: "user-b", role: "member" },
    ],
    channel_members: [{ channel_id: "channel-2", user_id: "user-a", role: "member" }],
  });

  const config = createAdminConfigStore();
  config.setAllowlistedChannels(["channel-1", "channel-2"]);

  const serviceA = createSearchFastTravelService({
    userId: "user-a",
    membership,
    config,
    channels: [
      { channel_id: "channel-1", name: "general" },
      { channel_id: "channel-2", name: "private" },
    ],
  });

  const serviceB = createSearchFastTravelService({
    userId: "user-b",
    membership,
    config,
    channels: [
      { channel_id: "channel-1", name: "general" },
      { channel_id: "channel-2", name: "private" },
    ],
  });

  const resultsA = serviceA.searchChannels("pri");
  const resultsB = serviceB.searchChannels("pri");

  expect(resultsA.map((result) => result.channel_id)).toEqual(["channel-2"]);
  expect(resultsB.length).toBe(0);
});

test("T13 shareable links do not leak private channels to unauthorized users", () => {
  const membership = createMembershipStore();
  membership.syncFromSnapshot({
    teams: [{ team_id: "team-1", name: "Team 1", is_enabled: true }],
    channels: [{ channel_id: "channel-2", team_id: "team-1", name: "private", visibility: "private" }],
    team_members: [
      { team_id: "team-1", user_id: "user-a", role: "member" },
      { team_id: "team-1", user_id: "user-b", role: "member" },
    ],
    channel_members: [{ channel_id: "channel-2", user_id: "user-a", role: "member" }],
  });

  const config = createAdminConfigStore();
  config.setAllowlistedChannels(["channel-2"]);
  const links = createFastTravelLinkStore();

  const ownerService = createSearchFastTravelService({
    userId: "user-a",
    membership,
    config,
    channels: [{ channel_id: "channel-2", name: "private" }],
    linkStore: links,
  });

  const otherService = createSearchFastTravelService({
    userId: "user-b",
    membership,
    config,
    channels: [{ channel_id: "channel-2", name: "private" }],
    linkStore: links,
  });

  const link = ownerService.createLocationLink("channel-2");
  expect(link).toBeDefined();

  const ownerResolution = ownerService.resolveLocationLink(link!);
  const otherResolution = otherService.resolveLocationLink(link!);

  expect(ownerResolution?.channel_id).toBe("channel-2");
  expect(otherResolution).toBeNull();
});
