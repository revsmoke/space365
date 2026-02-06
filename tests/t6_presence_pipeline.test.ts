import { test, expect } from "bun:test";
import { createWorldModule } from "../spacetime/module/world_module";

test("T6 presence change emits presence subscription update", async () => {
  const world = createWorldModule();
  const updates: string[] = [];

  world.subscribePresence("user-1", (presence) => {
    updates.push(presence.availability);
  });

  world.ingestPresenceChanged({
    event_id: "presence-1",
    occurred_at: "2026-02-06T00:00:00.000Z",
    user_id: "user-1",
    availability: "Busy",
    activity: "InAMeeting",
  });

  await Bun.sleep(10);

  expect(updates.at(-1)).toBe("Busy");
});

test("T6 presence dedupe ignores duplicate event_id", () => {
  const world = createWorldModule();

  const event = {
    event_id: "presence-dupe",
    occurred_at: "2026-02-06T00:00:00.000Z",
    user_id: "user-1",
    availability: "Away",
    activity: "Away",
  };

  world.ingestPresenceChanged(event);
  world.ingestPresenceChanged(event);

  const current = world.getPresence("user-1");
  expect(current?.availability).toBe("Away");
});
