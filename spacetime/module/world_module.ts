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

export type PresenceChangedEvent = {
  event_id: string;
  occurred_at: string;
  user_id: string;
  availability: string;
  activity: string;
};

export type PresenceState = {
  user_id: string;
  availability: string;
  activity: string;
  last_updated: string;
};

type PresenceSubscriber = (state: PresenceState) => void;

export function createWorldModule() {
  const roomStates = new Map<string, RoomState>();
  const subscribers = new Map<string, Set<RoomSubscriber>>();
  const presenceStates = new Map<string, PresenceState>();
  const presenceSubscribers = new Map<string, Set<PresenceSubscriber>>();
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

  function ingestPresenceChanged(event: PresenceChangedEvent): void {
    if (seenEvents.has(event.event_id)) {
      return;
    }

    seenEvents.add(event.event_id);

    const next: PresenceState = {
      user_id: event.user_id,
      availability: event.availability,
      activity: event.activity,
      last_updated: event.occurred_at,
    };

    presenceStates.set(event.user_id, next);
    emitPresenceUpdate(event.user_id, next);
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

  function subscribePresence(
    userId: string,
    callback: PresenceSubscriber,
  ): () => void {
    const userSubscribers =
      presenceSubscribers.get(userId) ?? new Set<PresenceSubscriber>();
    userSubscribers.add(callback);
    presenceSubscribers.set(userId, userSubscribers);

    const current = presenceStates.get(userId);
    if (current) {
      callback(current);
    }

    return () => {
      const existing = presenceSubscribers.get(userId);
      if (!existing) {
        return;
      }
      existing.delete(callback);
      if (existing.size === 0) {
        presenceSubscribers.delete(userId);
      }
    };
  }

  function getPresence(userId: string): PresenceState | undefined {
    return presenceStates.get(userId);
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

  function emitPresenceUpdate(userId: string, state: PresenceState): void {
    const userSubscribers = presenceSubscribers.get(userId);
    if (!userSubscribers) {
      return;
    }

    for (const callback of userSubscribers.values()) {
      callback(state);
    }
  }

  return {
    ingestChannelMessageEvent,
    ingestPresenceChanged,
    subscribeRoom,
    subscribePresence,
    getRoomState,
    getPresence,
  };
}
