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
