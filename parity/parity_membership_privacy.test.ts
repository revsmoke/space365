/**
 * Parity for sim T4 + the non-leak hard requirement:
 *  - world_rooms NEVER contains a private channel, for anyone (testable today)
 *  - a connection not a member of any private channel sees an empty
 *    my_private_rooms (testable today)
 *  - a private channel shows up in my_private_rooms for a member identity —
 *    (Module bug fixed 2026-07-06: sync_channel_membership works; member test live.)
 */
import { test, expect, afterAll, beforeAll } from "bun:test";
import { Harness, tables, waitFor, assertNever } from "./harness.ts";

const h = new Harness();
afterAll(() => h.dispose());

const TEAM = "priv-team";
const PRIVATE_CH = "priv-secret-ch";
const PUBLIC_CH = "priv-public-ch";
const MEMBER_USER = "priv-user-member";
const OUTSIDER_USER = "priv-user-outsider";

let service: Awaited<ReturnType<Harness["service"]>>;

beforeAll(async () => {
  service = await h.service();
  await service.conn.reducers.upsertTeam({
    teamId: TEAM,
    name: "Privacy Team",
    zoneId: 9401,
    isEnabled: true,
  });
  await service.conn.reducers.upsertChannel({
    channelId: PRIVATE_CH,
    teamId: TEAM,
    name: "privacy-secret",
    roomId: 9402,
    visibility: "private",
    isEnabled: true,
  });
  await service.conn.reducers.upsertChannel({
    channelId: PUBLIC_CH,
    teamId: TEAM,
    name: "privacy-general",
    roomId: 9403,
    visibility: "standard",
    isEnabled: true,
  });
});

test(
  "membership privacy: world_rooms never leaks the private channel; non-member my_private_rooms stays empty",
  async () => {
    const outsider = await h.connect();
    await outsider.conn.reducers.debugLinkSelf({ userId: OUTSIDER_USER });
    await h.subscribe(outsider.conn, [tables.worldRooms, tables.myPrivateRooms]);

    const unlinked = await h.connect();
    await h.subscribe(unlinked.conn, [tables.worldRooms, tables.myPrivateRooms]);

    // Positive control: the PUBLIC channel of the same team IS visible.
    for (const c of [outsider, unlinked]) {
      await waitFor(
        () => [...c.conn.db.worldRooms.iter()].some((r) => r.channelId === PUBLIC_CH),
        3000,
        "world_rooms contains public channel"
      );
    }

    // Hard requirement: the private channel never appears in world_rooms...
    for (const c of [outsider, unlinked]) {
      await assertNever(
        () => [...c.conn.db.worldRooms.iter()].some((r) => r.channelId === PRIVATE_CH),
        1000,
        "world_rooms must never contain the private channel"
      );
      // ...and every world_rooms row is explicitly non-private.
      for (const r of [...c.conn.db.worldRooms.iter()]) {
        expect(r.isPrivate).toBe(false);
      }
    }

    // Neither a linked non-member nor an unlinked identity sees private rooms.
    for (const c of [outsider, unlinked]) {
      await assertNever(
        () => [...c.conn.db.myPrivateRooms.iter()].length > 0,
        1000,
        "non-member my_private_rooms must stay empty"
      );
    }
  },
  20000
);

// Module bug fixed 2026-07-06: sync_channel_membership / sync_team_membership
// now use the array prefix form for multi-column index filters.
test(
  "membership privacy: my_private_rooms shows the private channel to a linked member",
  async () => {
    const member = await h.connect();
    await member.conn.reducers.debugLinkSelf({ userId: MEMBER_USER });
    await h.subscribe(member.conn, [tables.myPrivateRooms]);

    await service.conn.reducers.syncChannelMembership({
      channelId: PRIVATE_CH,
      userIds: [MEMBER_USER],
      roles: ["member"],
    });

    await waitFor(
      () =>
        [...member.conn.db.myPrivateRooms.iter()].some(
          (r) => r.channelId === PRIVATE_CH && r.isPrivate
        ),
      3000,
      "member my_private_rooms contains the private channel"
    );

    // Revocation empties the view again.
    await service.conn.reducers.syncChannelMembership({
      channelId: PRIVATE_CH,
      userIds: [],
      roles: [],
    });
    await waitFor(
      () => [...member.conn.db.myPrivateRooms.iter()].length === 0,
      3000,
      "member my_private_rooms empties after revocation"
    );
  }
);
