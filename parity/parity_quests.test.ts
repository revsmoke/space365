/**
 * Parity for sim T12 personal overlays:
 *  - create_or_update_quest for an opted-in linked user shows up in my_quests
 *    ONLY on the owner's connection; another user's my_quests stays empty
 *  - set_personal_opt_in(false) empties the owner's my_quests AND deletes the
 *    quest rows server-side (verified via SQL)
 *  - while opted out, new quests are silently dropped (sim T12 "blocks new")
 */
import { test, expect, afterAll, beforeAll } from "bun:test";
import { Harness, tables, waitFor, assertNever, sql } from "./harness.ts";

const h = new Harness();
afterAll(() => h.dispose());

const OWNER = "quest-user-a";
const OTHER = "quest-user-b";
const QUEST_ID = "quest-parity-1";

let service: Awaited<ReturnType<Harness["service"]>>;

beforeAll(async () => {
  service = await h.service();
  for (const userId of [OWNER, OTHER]) {
    await service.conn.reducers.upsertUser({
      userId,
      displayName: userId,
      dept: "QA",
      title: "Tester",
      isActive: true,
    });
  }
});

test(
  "quests: my_quests is owner-only and opt-out deletes quest rows",
  async () => {
    const owner = await h.connect();
    const other = await h.connect();

    await owner.conn.reducers.debugLinkSelf({ userId: OWNER });
    await other.conn.reducers.debugLinkSelf({ userId: OTHER });

    // Owner opts in (server enforces opt-in at write AND read).
    await owner.conn.reducers.setPersonalOptIn({ optIn: true });
    await other.conn.reducers.setPersonalOptIn({ optIn: true });

    await h.subscribe(owner.conn, [tables.myQuests]);
    await h.subscribe(other.conn, [tables.myQuests]);

    await service.conn.reducers.createOrUpdateQuest({
      questId: QUEST_ID,
      userId: OWNER,
      kind: "mention",
      title: "You were mentioned in #support",
      sourceRef: "msg-1",
      deeplink: "https://teams.microsoft.com/l/message/1",
      status: "open",
    });

    // Owner sees it...
    await waitFor(
      () => [...owner.conn.db.myQuests.iter()].some((q) => q.questId === QUEST_ID),
      3000,
      "owner my_quests contains the quest"
    );
    const q = [...owner.conn.db.myQuests.iter()].find((x) => x.questId === QUEST_ID)!;
    expect(q.userId).toBe(OWNER);
    expect(q.status).toBe("open");

    // ...the second user never does.
    await assertNever(
      () => [...other.conn.db.myQuests.iter()].length > 0,
      1000,
      "other user's my_quests must stay empty"
    );

    // Opt-out: view empties live AND rows are deleted server-side.
    await owner.conn.reducers.setPersonalOptIn({ optIn: false });
    await waitFor(
      () => [...owner.conn.db.myQuests.iter()].length === 0,
      3000,
      "owner my_quests empties after opt-out"
    );
    const serverRows = sql(`SELECT quest_id FROM quest WHERE user_id = '${OWNER}'`);
    expect(serverRows.length).toBe(0);

    // While opted out, new quests are dropped silently (reducer succeeds, no row).
    await service.conn.reducers.createOrUpdateQuest({
      questId: "quest-parity-blocked",
      userId: OWNER,
      kind: "mention",
      title: "Should be dropped",
      sourceRef: "msg-2",
      deeplink: "https://example.invalid",
      status: "open",
    });
    const blocked = sql(
      `SELECT quest_id FROM quest WHERE quest_id = 'quest-parity-blocked'`
    );
    expect(blocked.length).toBe(0);
    await assertNever(
      () => [...owner.conn.db.myQuests.iter()].length > 0,
      500,
      "opted-out owner must not receive new quests"
    );
  },
  20000
);
