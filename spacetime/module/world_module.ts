export type ChannelMessageEventType =
  | "channel.message.created"
  | "channel.message.updated"
  | "channel.message.deleted"
  | "channel.message.reaction";

export type ChannelMessageEvent = {
  event_id: string;
  event_type: ChannelMessageEventType;
  occurred_at: string;
  context: {
    channel_id: string;
    team_id: string;
  };
};

export type RoomState = {
  channel_id: string;
  team_id: string;
  msg_count: number;
  react_count: number;
  last_activity_at: string;
};

type RoomSubscriber = (state: RoomState) => void;

export function createWorldModule() {
  const roomStates = new Map<string, RoomState>();
  const subscribers = new Map<string, Set<RoomSubscriber>>();
  const seenEvents = new Set<string>();

  function ingestChannelMessageEvent(event: ChannelMessageEvent): void {
    if (seenEvents.has(event.event_id)) {
      return;
    }

    seenEvents.add(event.event_id);

    const current = roomStates.get(event.context.channel_id) ?? {
      channel_id: event.context.channel_id,
      team_id: event.context.team_id,
      msg_count: 0,
      react_count: 0,
      last_activity_at: event.occurred_at,
    };

    const next: RoomState = {
      ...current,
      msg_count:
        event.event_type === "channel.message.created"
          ? current.msg_count + 1
          : current.msg_count,
      react_count:
        event.event_type === "channel.message.reaction"
          ? current.react_count + 1
          : current.react_count,
      last_activity_at: event.occurred_at,
    };

    roomStates.set(event.context.channel_id, next);
    emitRoomUpdate(event.context.channel_id, next);
  }

  function subscribeRoom(
    channelId: string,
    callback: RoomSubscriber,
  ): () => void {
    const roomSubscribers = subscribers.get(channelId) ?? new Set<RoomSubscriber>();
    roomSubscribers.add(callback);
    subscribers.set(channelId, roomSubscribers);

    const current = roomStates.get(channelId);
    if (current) {
      callback(current);
    }

    return () => {
      const existing = subscribers.get(channelId);
      if (!existing) {
        return;
      }
      existing.delete(callback);
      if (existing.size === 0) {
        subscribers.delete(channelId);
      }
    };
  }

  function getRoomState(channelId: string): RoomState | undefined {
    return roomStates.get(channelId);
  }

  function emitRoomUpdate(channelId: string, state: RoomState): void {
    const roomSubscribers = subscribers.get(channelId);
    if (!roomSubscribers) {
      return;
    }

    for (const callback of roomSubscribers.values()) {
      callback(state);
    }
  }

  return {
    ingestChannelMessageEvent,
    subscribeRoom,
    getRoomState,
  };
}
