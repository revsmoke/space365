import { test, expect } from "bun:test";
import {
  CURRENT_SCHEMA_VERSION,
  parseCanonicalEvent,
  createEventId,
} from "../shared/types/events";

test("T1 schema exposes current version", () => {
  expect(CURRENT_SCHEMA_VERSION).toBe(1);
});

test("T1 schema parses minimal canonical event", () => {
  const parsed = parseCanonicalEvent({
    schema_version: 1,
    event_type: "channel.message.created",
    occurred_at: "2026-02-06T00:00:00.000Z",
    source: {
      subscription_id: "sub-1",
      resource: "teams/team-1/channels/channel-1/messages/msg-1",
      change_type: "created",
      resource_id: "msg-1",
      etag: "W/\"abc\"",
    },
    context: {
      team_id: "team-1",
      channel_id: "channel-1",
    },
  });

  expect(parsed.event_type).toBe("channel.message.created");
  expect(parsed.context.team_id).toBe("team-1");
});

test("T1 createEventId is deterministic", () => {
  const input = {
    subscription_id: "sub-1",
    resource: "teams/team-1/channels/channel-1/messages/msg-1",
    change_type: "created",
    resource_id: "msg-1",
    etag: "W/\"abc\"",
  };

  expect(createEventId(input)).toBe(createEventId(input));
});
