/**
 * Parity for the game-state contract (sim T9-adjacent):
 *  - move_player from two connections -> both see each other's player_state rows
 *  - disconnecting one connection flips its row to online=false for the other
 *    (with reconnect/disconnect timing tolerance)
 */
import { test, expect, afterAll } from "bun:test";
import { Harness, tables, waitFor } from "./harness.ts";

const h = new Harness();
afterAll(() => h.dispose());

test(
  "player: two connections see each other move; disconnect flips online=false",
  async () => {
    const p1 = await h.connect();
    const p2 = await h.connect();
    const p1Hex = p1.identity.toHexString();
    const p2Hex = p2.identity.toHexString();
    expect(p1Hex).not.toBe(p2Hex);

    await h.subscribe(p1.conn, [tables.playerState]);
    await h.subscribe(p2.conn, [tables.playerState]);

    await p1.conn.reducers.movePlayer({
      x: 1.5,
      y: 0,
      z: -2.5,
      heading: 90,
      zoneId: 9601,
      animation: "walk",
    });
    await p2.conn.reducers.movePlayer({
      x: -4,
      y: 0,
      z: 7,
      heading: 180,
      zoneId: 9601,
      animation: "run",
    });

    const findOn = (viewer: typeof p1, hex: string) =>
      [...viewer.conn.db.playerState.iter()].find(
        (p) => p.identity.toHexString() === hex
      );

    // Both clients see BOTH rows.
    await waitFor(
      () => !!findOn(p1, p2Hex) && !!findOn(p2, p1Hex),
      3000,
      "each connection sees the other player's row"
    );

    const p2SeenByP1 = findOn(p1, p2Hex)!;
    expect(p2SeenByP1.x).toBeCloseTo(-4);
    expect(p2SeenByP1.z).toBeCloseTo(7);
    expect(p2SeenByP1.animation).toBe("run");
    expect(p2SeenByP1.online).toBe(true);

    const p1SeenByP2 = findOn(p2, p1Hex)!;
    expect(p1SeenByP2.x).toBeCloseTo(1.5);
    expect(p1SeenByP2.animation).toBe("walk");
    expect(p1SeenByP2.online).toBe(true);

    // Movement updates propagate live.
    await p1.conn.reducers.movePlayer({
      x: 10,
      y: 0,
      z: 10,
      heading: 0,
      zoneId: 9601,
      animation: "idle",
    });
    await waitFor(
      () => Math.abs((findOn(p2, p1Hex)?.x ?? 0) - 10) < 0.001,
      3000,
      "p2 sees p1's updated position"
    );

    // Disconnect p2 -> module's clientDisconnected flips online=false and
    // resets animation to idle. Allow generous timing tolerance.
    p2.conn.disconnect();
    await waitFor(
      () => findOn(p1, p2Hex)?.online === false,
      10000,
      "p2's row flips online=false after disconnect"
    );
    expect(findOn(p1, p2Hex)!.animation).toBe("idle");
  },
  30000
);
