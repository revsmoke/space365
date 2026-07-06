type ChannelMessageEventType =
  | "channel.message.created"
  | "channel.message.updated"
  | "channel.message.deleted"
  | "channel.message.reaction";

export type AggregateEvent = {
  channel_id: string;
  event_type: ChannelMessageEventType;
  occurred_at: string;
};

export type AggregateSnapshot = {
  channel_id: string;
  msg_count_1m: number;
  msg_count_5m: number;
  msg_count_1h: number;
  react_count_1m: number;
  react_count_5m: number;
  react_count_1h: number;
  heat_ema: number;
  last_updated: string;
};

type ChannelState = {
  msg_events: number[];
  react_events: number[];
  heat_ema: number;
  last_updated: string;
};

type ChannelAggregatorConfig = {
  alpha: number;
};

export function createChannelAggregator(config: ChannelAggregatorConfig) {
  const channels = new Map<string, ChannelState>();
  const alpha = clampAlpha(config.alpha);

  function ingest(event: AggregateEvent): AggregateSnapshot {
    const now = toMs(event.occurred_at);
    const state = getOrCreateState(event.channel_id, event.occurred_at);

    if (event.event_type === "channel.message.created") {
      state.msg_events.push(now);
    } else if (event.event_type === "channel.message.reaction") {
      state.react_events.push(now);
    }

    pruneOlderThan(state.msg_events, now - HOUR_MS);
    pruneOlderThan(state.react_events, now - HOUR_MS);

    const snapshot = buildSnapshot(event.channel_id, state, now, event.occurred_at);

    const intensity = snapshot.msg_count_5m + snapshot.react_count_5m * 0.5;
    state.heat_ema = alpha * intensity + (1 - alpha) * state.heat_ema;
    state.last_updated = event.occurred_at;

    return {
      ...snapshot,
      heat_ema: state.heat_ema,
      last_updated: state.last_updated,
    };
  }

  function getSnapshot(
    channelId: string,
    atIsoTimestamp: string,
  ): AggregateSnapshot | undefined {
    const state = channels.get(channelId);
    if (!state) {
      return undefined;
    }

    const now = toMs(atIsoTimestamp);
    pruneOlderThan(state.msg_events, now - HOUR_MS);
    pruneOlderThan(state.react_events, now - HOUR_MS);

    return buildSnapshot(channelId, state, now, atIsoTimestamp);
  }

  function getOrCreateState(channelId: string, occurredAt: string): ChannelState {
    const existing = channels.get(channelId);
    if (existing) {
      return existing;
    }
    const created: ChannelState = {
      msg_events: [],
      react_events: [],
      heat_ema: 0,
      last_updated: occurredAt,
    };
    channels.set(channelId, created);
    return created;
  }

  return {
    ingest,
    getSnapshot,
  };
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function buildSnapshot(
  channelId: string,
  state: ChannelState,
  nowMs: number,
  atIsoTimestamp: string,
): AggregateSnapshot {
  const msg_count_1m = countSince(state.msg_events, nowMs - MINUTE_MS);
  const msg_count_5m = countSince(state.msg_events, nowMs - 5 * MINUTE_MS);
  const msg_count_1h = countSince(state.msg_events, nowMs - HOUR_MS);

  const react_count_1m = countSince(state.react_events, nowMs - MINUTE_MS);
  const react_count_5m = countSince(state.react_events, nowMs - 5 * MINUTE_MS);
  const react_count_1h = countSince(state.react_events, nowMs - HOUR_MS);

  return {
    channel_id: channelId,
    msg_count_1m,
    msg_count_5m,
    msg_count_1h,
    react_count_1m,
    react_count_5m,
    react_count_1h,
    heat_ema: state.heat_ema,
    last_updated: atIsoTimestamp,
  };
}

function countSince(events: number[], lowerBoundInclusive: number): number {
  let count = 0;
  for (const eventMs of events) {
    if (eventMs >= lowerBoundInclusive) {
      count += 1;
    }
  }
  return count;
}

function pruneOlderThan(events: number[], thresholdExclusive: number): void {
  while (events.length > 0 && events[0] < thresholdExclusive) {
    events.shift();
  }
}

function clampAlpha(alpha: number): number {
  if (Number.isNaN(alpha)) {
    return 0.3;
  }
  if (alpha < 0) {
    return 0;
  }
  if (alpha > 1) {
    return 1;
  }
  return alpha;
}

function toMs(isoTimestamp: string): number {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid timestamp: ${isoTimestamp}`);
  }
  return parsed;
}
