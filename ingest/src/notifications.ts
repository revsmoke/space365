/**
 * Graph change-notification → canonical ingest event mapping (SPEC §7).
 *
 * chatMessage notifications carry only resource ids (no body — metadata
 * only by design). The stable event_id comes from shared/types/events.ts
 * createEventId so replays and duplicate deliveries dedupe in the module.
 */
import { createEventId } from "../../shared/types/events";
import type { GraphNotification } from "./webhook";

export type ChannelMessageIngestArgs = {
  eventId: string;
  eventType: string;
  occurredAtMicros: bigint;
  teamId: string;
  channelId: string;
  actorUserId: string | undefined;
  messageId: string | undefined;
  threadId: string | undefined;
};

export type RawResourceData = {
  id?: string;
  "@odata.etag"?: string;
  lastModifiedDateTime?: string;
};

const RESOURCE_PATTERN =
  /teams\('([^']+)'\)\/channels\('([^']+)'\)\/messages\('([^']+)'\)(?:\/replies\('([^']+)'\))?/;

export function parseChannelMessageResource(resource: string): {
  teamId: string;
  channelId: string;
  messageId: string;
  replyId?: string;
} | null {
  const match = resource.match(RESOURCE_PATTERN);
  if (!match) return null;
  return {
    teamId: match[1],
    channelId: match[2],
    messageId: match[3],
    replyId: match[4],
  };
}

export function eventTypeForChange(changeType: string): string | null {
  switch (changeType) {
    case "created":
      return "channel.message.created";
    case "updated":
      return "channel.message.updated";
    case "deleted":
      return "channel.message.deleted";
    default:
      return null;
  }
}

export function isoToMicros(iso: string | undefined, fallbackMs: number): bigint {
  const ms = iso ? Date.parse(iso) : NaN;
  return BigInt(Math.round(Number.isFinite(ms) ? ms : fallbackMs)) * 1000n;
}

/**
 * Map a validated chatMessage notification to ingest reducer args.
 * Returns null for resources we do not ingest (non channel-message).
 */
export function mapChannelMessageNotification(
  notification: GraphNotification,
  resourceData: RawResourceData = {},
  nowMs: number = Date.now(),
): ChannelMessageIngestArgs | null {
  const parsed = parseChannelMessageResource(notification.resource);
  if (!parsed) return null;
  const eventType = eventTypeForChange(notification.change_type);
  if (!eventType) return null;

  const eventId = createEventId({
    subscription_id: notification.subscription_id,
    resource: notification.resource,
    change_type: notification.change_type as "created" | "updated" | "deleted",
    resource_id: notification.resource_id,
    etag: resourceData["@odata.etag"],
    last_modified: resourceData.lastModifiedDateTime,
  });

  return {
    eventId,
    eventType,
    occurredAtMicros: isoToMicros(resourceData.lastModifiedDateTime, nowMs),
    teamId: parsed.teamId,
    channelId: parsed.channelId,
    // App-only notifications don't reveal the author; the actor arrives via
    // delta/reconcile if needed. Never guess.
    actorUserId: undefined,
    messageId: parsed.replyId ?? parsed.messageId,
    threadId: parsed.replyId ? parsed.messageId : undefined,
  };
}
