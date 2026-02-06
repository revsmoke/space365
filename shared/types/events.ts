import { createHash } from "node:crypto";

export const CURRENT_SCHEMA_VERSION = 1;

const EVENT_TYPES = new Set([
  "channel.message.created",
  "channel.message.updated",
  "channel.message.deleted",
  "channel.message.reaction",
  "presence.changed",
  "meeting.starting_soon",
  "team.created",
  "team.updated",
  "channel.created",
  "channel.updated",
  "channel.deleted",
] as const);

const CHANGE_TYPES = new Set(["created", "updated", "deleted"] as const);

export type EventType = (typeof EVENT_TYPES extends Set<infer T> ? T : never) & string;
export type ChangeType =
  (typeof CHANGE_TYPES extends Set<infer T> ? T : never) & string;

export type EventSource = {
  subscription_id: string;
  resource: string;
  change_type: ChangeType;
  resource_id: string;
  etag?: string;
  last_modified?: string;
};

export type EventContext = {
  team_id?: string;
  channel_id?: string;
  user_id?: string;
};

export type CanonicalEvent = {
  schema_version: number;
  event_type: EventType;
  occurred_at: string;
  source: EventSource;
  context: EventContext;
  payload?: Record<string, unknown>;
};

export function createEventId(source: EventSource): string {
  const components = [
    source.subscription_id,
    source.resource,
    source.change_type,
    source.resource_id,
    source.etag ?? source.last_modified ?? "",
  ];

  return createHash("sha256").update(components.join("|")).digest("hex");
}

export function parseCanonicalEvent(input: unknown): CanonicalEvent {
  if (!isRecord(input)) {
    throw new Error("Canonical event must be an object");
  }

  const schema_version = input.schema_version;
  const event_type = input.event_type;
  const occurred_at = input.occurred_at;
  const source = input.source;
  const context = input.context;
  const payload = input.payload;

  if (schema_version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported schema_version: ${String(schema_version)}`);
  }

  if (!isString(event_type) || !EVENT_TYPES.has(event_type as EventType)) {
    throw new Error(`Invalid event_type: ${String(event_type)}`);
  }

  if (!isIsoTimestamp(occurred_at)) {
    throw new Error("occurred_at must be an ISO timestamp");
  }

  if (!isRecord(source)) {
    throw new Error("source must be an object");
  }

  const parsedSource: EventSource = {
    subscription_id: asRequiredString(source.subscription_id, "source.subscription_id"),
    resource: asRequiredString(source.resource, "source.resource"),
    change_type: asChangeType(source.change_type),
    resource_id: asRequiredString(source.resource_id, "source.resource_id"),
    etag: asOptionalString(source.etag, "source.etag"),
    last_modified: asOptionalString(source.last_modified, "source.last_modified"),
  };

  if (!isRecord(context)) {
    throw new Error("context must be an object");
  }

  const parsedContext: EventContext = {
    team_id: asOptionalString(context.team_id, "context.team_id"),
    channel_id: asOptionalString(context.channel_id, "context.channel_id"),
    user_id: asOptionalString(context.user_id, "context.user_id"),
  };

  const parsedPayload =
    payload === undefined
      ? undefined
      : isRecord(payload)
        ? payload
        : (() => {
            throw new Error("payload must be an object");
          })();

  return {
    schema_version,
    event_type: event_type as EventType,
    occurred_at,
    source: parsedSource,
    context: parsedContext,
    payload: parsedPayload,
  };
}

function asChangeType(value: unknown): ChangeType {
  if (!isString(value) || !CHANGE_TYPES.has(value as ChangeType)) {
    throw new Error(`Invalid source.change_type: ${String(value)}`);
  }
  return value as ChangeType;
}

function asRequiredString(value: unknown, field: string): string {
  if (!isString(value)) {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isString(value)) {
    throw new Error(`${field} must be a string when provided`);
  }
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isString(value)) {
    return false;
  }
  const parsed = new Date(value).toISOString();
  return parsed === value;
}
