/**
 * Parity smoke (sim T0/T2 setup contract): fresh publish + admin bootstrap +
 * upsert team/channel -> world_zones/world_rooms deliver rows to a subscribed
 * client within 1s.
 */
import { test, expect, afterAll } from "bun:test";
import { Harness, tables, waitFor } from "./harness.ts";

const h = new Harness();
afterAll(() => h.dispose());

const TEAM = "smoke-team-1";
const CHANNEL = "smoke-channel-1";

test(
  "smoke: admin bootstrap + upserts reach a live subscriber within 1s",
  async () => {
    const admin = await h.admin(); // bootstraps (or reuses) the admin role
    const client = await h.connect(); // plain anonymous viewer

    await h.subscribe(client.conn, [tables.worldZones, tables.worldRooms]);

    await admin.conn.reducers.upsertTeam({
      teamId: TEAM,
      name: "Smoke Team",
      zoneId: 9101,
      isEnabled: true,
    });
    await admin.conn.reducers.upsertChannel({
      channelId: CHANNEL,
      teamId: TEAM,
      name: "smoke-general",
      roomId: 9102,
      visibility: "standard",
      isEnabled: true,
    });

    // Hard requirement: rows visible on the subscribed client within 1s.
    await waitFor(
      () => [...client.conn.db.worldZones.iter()].some((z) => z.teamId === TEAM),
      1000,
      "world_zones row for smoke team"
    );
    await waitFor(
      () => [...client.conn.db.worldRooms.iter()].some((r) => r.channelId === CHANNEL),
      1000,
      "world_rooms row for smoke channel"
    );

    const zone = [...client.conn.db.worldZones.iter()].find((z) => z.teamId === TEAM)!;
    expect(zone.name).toBe("Smoke Team");
    expect(zone.zoneId).toBe(9101);

    const room = [...client.conn.db.worldRooms.iter()].find((r) => r.channelId === CHANNEL)!;
    expect(room.teamId).toBe(TEAM);
    expect(room.roomId).toBe(9102);
    expect(room.isPrivate).toBe(false);
    expect(room.glow).toBe(0);
  },
  15000
);
