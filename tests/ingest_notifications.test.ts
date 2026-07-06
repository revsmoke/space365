import { describe, expect, test } from "bun:test";
import {
  eventTypeForChange,
  isoToMicros,
  mapChannelMessageNotification,
  parseChannelMessageResource,
} from "../ingest/src/notifications";
import type { GraphNotification } from "../ingest/src/webhook";

const BASE_NOTIFICATION: GraphNotification = {
  subscription_id: "sub-123",
  client_state: "secret",
  change_type: "created",
  resource: "teams('team-1')/channels('19:chan@thread.tacv2')/messages('1750000000000')",
  resource_id: "1750000000000",
};

describe("channel message notification mapping", () => {
  test("parses team/channel/message ids from the resource path", () => {
    const parsed = parseChannelMessageResource(BASE_NOTIFICATION.resource);
    expect(parsed).toEqual({
      teamId: "team-1",
      channelId: "19:chan@thread.tacv2",
      messageId: "1750000000000",
      replyId: undefined,
    });
  });

  test("parses reply resources and maps reply as message, parent as thread", () => {
    const resource =
      "teams('t')/channels('c')/messages('parent-1')/replies('reply-9')";
    const args = mapChannelMessageNotification(
      { ...BASE_NOTIFICATION, resource },
      {},
      1_750_000_000_000,
    );
    expect(args?.messageId).toBe("reply-9");
    expect(args?.threadId).toBe("parent-1");
  });

  test("maps changeType to canonical event types", () => {
    expect(eventTypeForChange("created")).toBe("channel.message.created");
    expect(eventTypeForChange("updated")).toBe("channel.message.updated");
    expect(eventTypeForChange("deleted")).toBe("channel.message.deleted");
    expect(eventTypeForChange("weird")).toBeNull();
  });

  test("produces stable event ids across duplicate deliveries", () => {
    const first = mapChannelMessageNotification(BASE_NOTIFICATION, {
      lastModifiedDateTime: "2026-07-06T12:00:00Z",
    });
    const duplicate = mapChannelMessageNotification(BASE_NOTIFICATION, {
      lastModifiedDateTime: "2026-07-06T12:00:00Z",
    });
    expect(first?.eventId).toBe(duplicate!.eventId);
    expect(first?.eventId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("event id changes when the message version (etag) changes", () => {
    const v1 = mapChannelMessageNotification(BASE_NOTIFICATION, { "@odata.etag": "1" });
    const v2 = mapChannelMessageNotification(
      { ...BASE_NOTIFICATION, change_type: "updated" },
      { "@odata.etag": "2" },
    );
    expect(v1?.eventId).not.toBe(v2?.eventId);
  });

  test("uses lastModifiedDateTime for occurred_at, falls back to now", () => {
    const args = mapChannelMessageNotification(BASE_NOTIFICATION, {
      lastModifiedDateTime: "2026-07-06T12:00:00.000Z",
    });
    expect(args?.occurredAtMicros).toBe(BigInt(Date.parse("2026-07-06T12:00:00.000Z")) * 1000n);

    const fallback = mapChannelMessageNotification(BASE_NOTIFICATION, {}, 1_700_000_000_123);
    expect(fallback?.occurredAtMicros).toBe(1_700_000_000_123n * 1000n);
  });

  test("returns null for non channel-message resources", () => {
    const args = mapChannelMessageNotification({
      ...BASE_NOTIFICATION,
      resource: "communications/presences/user-1",
    });
    expect(args).toBeNull();
  });

  test("never invents an actor for app-only notifications", () => {
    const args = mapChannelMessageNotification(BASE_NOTIFICATION);
    expect(args?.actorUserId).toBeUndefined();
  });

  test("isoToMicros handles invalid input via fallback", () => {
    expect(isoToMicros("not-a-date", 1000)).toBe(1_000_000n);
  });
});
