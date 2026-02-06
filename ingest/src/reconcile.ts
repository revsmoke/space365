import type { ChannelMessageEvent } from "../../spacetime/module/world_module";

type WorldLike = {
  ingestChannelMessageEvent: (event: ChannelMessageEvent) => void;
};

export function replayChannelEvents(
  world: WorldLike,
  events: ChannelMessageEvent[],
): void {
  const ordered = [...events].sort((a, b) =>
    a.occurred_at.localeCompare(b.occurred_at),
  );

  for (const event of ordered) {
    world.ingestChannelMessageEvent(event);
  }
}

export function createDeltaCursorStore() {
  const store = new Map<string, string>();

  return {
    get(resource: string): string | undefined {
      return store.get(resource);
    },
    set(resource: string, cursor: string): void {
      store.set(resource, cursor);
    },
  };
}

export function reconcileFromDelta(input: {
  world: WorldLike;
  resource: string;
  cursorStore: ReturnType<typeof createDeltaCursorStore>;
  nextCursor: string;
  events: ChannelMessageEvent[];
}): void {
  replayChannelEvents(input.world, input.events);
  input.cursorStore.set(input.resource, input.nextCursor);
}
