/**
 * Parity for sim T6 + T11 policy gating:
 *  - ingest_presence with allow_presence=true -> presence_public row appears
 *  - duplicate ingest for the same user upserts (single row, last write wins)
 *  - admin_update_config allow_presence=false -> the view empties for a LIVE
 *    subscriber; flipping back restores it
 */
import { test, expect, afterAll } from "bun:test";
import { Harness, tables, waitFor, RUN_ID } from "./harness.ts";

const h = new Harness();
afterAll(() => h.dispose());

// RUN_ID keeps the user unique per run: a stale presence row from a previous
// run would otherwise satisfy the first waitFor before the new write lands.
const USER = `presence-user-1-${RUN_ID}`;
const USER2 = `presence-user-2-${RUN_ID}`;

test(
  "presence: policy-gated presence_public updates live subscribers",
  async () => {
    const admin = await h.admin();
    const service = await h.service();
    const client = await h.connect();

    await h.subscribe(client.conn, [tables.presencePublic]);

    const rowsFor = (userId: string) =>
      [...client.conn.db.presencePublic.iter()].filter((p) => p.userId === userId);

    try {
      // allow_presence defaults to true -> row appears for a live subscriber.
      await service.conn.reducers.ingestPresence({
        userId: USER,
        availability: "Busy",
        activity: "InAMeeting",
        source: "graph",
      });
      await waitFor(
        () => rowsFor(USER).length > 0,
        3000,
        "presence_public row appears"
      );
      expect(rowsFor(USER)[0].availability).toBe("Busy");
      expect(rowsFor(USER)[0].source).toBe("graph");

      // Upsert semantics (sim T6 dedupe): same user again -> still one row.
      await service.conn.reducers.ingestPresence({
        userId: USER,
        availability: "Away",
        activity: "Away",
        source: "graph",
      });
      await waitFor(
        () => rowsFor(USER).some((p) => p.availability === "Away"),
        3000,
        "presence upsert reflects last write"
      );
      expect(rowsFor(USER).length).toBe(1);

      // Kill switch: allow_presence=false empties the view for live subscribers.
      await admin.conn.reducers.adminUpdateConfig({
        key: "allow_presence",
        value: "false",
      });
      await waitFor(
        () => [...client.conn.db.presencePublic.iter()].length === 0,
        5000,
        "presence_public empties after allow_presence=false"
      );

      // While disabled, ingest is dropped server-side (module returns early).
      await service.conn.reducers.ingestPresence({
        userId: USER2,
        availability: "Available",
        activity: "Available",
        source: "graph",
      });

      // Restore -> the original row comes back; user-2 was never written.
      await admin.conn.reducers.adminUpdateConfig({
        key: "allow_presence",
        value: "true",
      });
      await waitFor(
        () => rowsFor(USER).length === 1,
        5000,
        "presence_public restored after allow_presence=true"
      );
      expect(rowsFor(USER2).length).toBe(0);
    } finally {
      // Always restore global policy for the rest of the suite.
      await admin.conn.reducers.adminUpdateConfig({
        key: "allow_presence",
        value: "true",
      });
    }
  },
  20000
);
