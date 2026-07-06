/**
 * Parity for sim T11 allowlist control:
 *  - admin_set_scope channel disabled -> world_rooms drops the room for a LIVE
 *    subscriber (and re-enable brings it back)
 *  - a non-admin connection calling admin_set_scope fails; the SDK surfaces the
 *    reducer failure as a rejected promise carrying the SenderError message
 */
import { test, expect, afterAll, beforeAll } from "bun:test";
import { Harness, tables, waitFor } from "./harness.ts";

const h = new Harness();
afterAll(() => h.dispose());

const TEAM = "scope-team";
const CHANNEL = "scope-channel-1";

let admin: Awaited<ReturnType<Harness["admin"]>>;

beforeAll(async () => {
  admin = await h.admin();
  await admin.conn.reducers.upsertTeam({
    teamId: TEAM,
    name: "Scope Team",
    zoneId: 9501,
    isEnabled: true,
  });
  await admin.conn.reducers.upsertChannel({
    channelId: CHANNEL,
    teamId: TEAM,
    name: "scope-general",
    roomId: 9502,
    visibility: "standard",
    isEnabled: true,
  });
});

test(
  "admin scope: disabling a channel drops it from world_rooms live",
  async () => {
    const client = await h.connect();
    await h.subscribe(client.conn, [tables.worldRooms, tables.worldZones]);

    const roomVisible = () =>
      [...client.conn.db.worldRooms.iter()].some((r) => r.channelId === CHANNEL);

    await waitFor(() => roomVisible(), 3000, "room visible while enabled");

    await admin.conn.reducers.adminSetScope({
      kind: "channel",
      id: CHANNEL,
      enabled: false,
    });
    await waitFor(() => !roomVisible(), 3000, "room dropped after disable");

    // Re-enable restores it for the same live subscriber.
    await admin.conn.reducers.adminSetScope({
      kind: "channel",
      id: CHANNEL,
      enabled: true,
    });
    await waitFor(() => roomVisible(), 3000, "room restored after re-enable");
  },
  20000
);

test(
  "admin scope: team scope also gates world_zones",
  async () => {
    const client = await h.connect();
    await h.subscribe(client.conn, [tables.worldZones]);

    const zoneVisible = () =>
      [...client.conn.db.worldZones.iter()].some((z) => z.teamId === TEAM);

    await waitFor(() => zoneVisible(), 3000, "zone visible while enabled");
    await admin.conn.reducers.adminSetScope({ kind: "team", id: TEAM, enabled: false });
    await waitFor(() => !zoneVisible(), 3000, "zone dropped after team disable");
    await admin.conn.reducers.adminSetScope({ kind: "team", id: TEAM, enabled: true });
    await waitFor(() => zoneVisible(), 3000, "zone restored after re-enable");
  },
  20000
);

test(
  "admin scope: non-admin caller gets a surfaced reducer failure",
  async () => {
    const rando = await h.connect();

    // The typed reducer call returns a Promise that REJECTS with the module's
    // SenderError message when the reducer throws.
    let error: Error | null = null;
    try {
      await rando.conn.reducers.adminSetScope({
        kind: "channel",
        id: CHANNEL,
        enabled: false,
      });
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain("requires role in [admin]");

    // And the failed call must not have changed anything.
    const client = await h.connect();
    await h.subscribe(client.conn, [tables.worldRooms]);
    await waitFor(
      () => [...client.conn.db.worldRooms.iter()].some((r) => r.channelId === CHANNEL),
      3000,
      "channel still enabled after rejected non-admin call"
    );

    // Bad kind also surfaces as an error, even for the admin.
    let kindError: Error | null = null;
    try {
      await admin.conn.reducers.adminSetScope({ kind: "bogus", id: "x", enabled: true });
    } catch (e) {
      kindError = e as Error;
    }
    expect(kindError).not.toBeNull();
    expect(kindError!.message).toContain("kind must be team|channel");
  },
  20000
);
