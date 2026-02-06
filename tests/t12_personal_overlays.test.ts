import { test, expect } from "bun:test";
import {
  createPersonalOverlayStore,
  type PersonalQuest,
} from "../spacetime/module/personal_overlays";
import {
  createGraphOBOProxy,
  type GraphFetchResponse,
} from "../ingest/src/graph_proxy";
import { createPersonalOverlayClient } from "../web/client/personal_overlays";

function buildQuest(overrides?: Partial<PersonalQuest>): PersonalQuest {
  return {
    quest_id: "quest-1",
    user_id: "user-a",
    kind: "mention",
    title: "You were mentioned in #support",
    source_ref: "msg-1",
    deeplink: "https://teams.microsoft.com/l/message/1",
    created_at: "2026-02-06T16:00:00.000Z",
    status: "open",
    ...overrides,
  };
}

test("T12 personal quests are visible only to owner", () => {
  const store = createPersonalOverlayStore();
  store.setOptIn("user-a", true);
  store.upsertQuest(buildQuest());

  const ownerView = store.listQuestsForViewer({
    ownerUserId: "user-a",
    viewerUserId: "user-a",
  });
  const otherView = store.listQuestsForViewer({
    ownerUserId: "user-a",
    viewerUserId: "user-b",
  });

  expect(ownerView.map((q) => q.quest_id)).toEqual(["quest-1"]);
  expect(otherView).toEqual([]);
});

test("T12 opt-out hides existing quests and blocks new quests", () => {
  const store = createPersonalOverlayStore();
  store.setOptIn("user-a", true);
  store.upsertQuest(buildQuest());
  store.setOptIn("user-a", false);

  const ownerViewAfterOptOut = store.listQuestsForViewer({
    ownerUserId: "user-a",
    viewerUserId: "user-a",
  });
  expect(ownerViewAfterOptOut).toEqual([]);

  const accepted = store.upsertQuest(
    buildQuest({ quest_id: "quest-2", source_ref: "msg-2" }),
  );
  expect(accepted).toBe(false);
});

test("T12 OBO proxy sends delegated token and enforces route allowlist", async () => {
  const calls: Array<{ url: string; authHeader: string | undefined }> = [];
  const proxy = createGraphOBOProxy({
    allowPersonalOverlays: (userId) => userId === "user-a",
    getAccessTokenForUser: async () => "token-abc",
    fetchGraph: async (url, init): Promise<GraphFetchResponse> => {
      calls.push({
        url,
        authHeader: init.headers?.Authorization as string | undefined,
      });
      return {
        status: 200,
        json: async () => ({ value: [{ id: "evt-1" }] }),
      };
    },
  });

  const ok = await proxy.fetchUserOverlay({
    userId: "user-a",
    route: "meetingsSoon",
  });

  expect(ok.status).toBe(200);
  expect(calls.length).toBe(1);
  expect(calls[0]?.url.includes("/me/calendarView")).toBe(true);
  expect(calls[0]?.authHeader).toBe("Bearer token-abc");

  const badRoute = await proxy.fetchUserOverlay({
    userId: "user-a",
    route: "invalid.route" as "mentions",
  });
  expect(badRoute.status).toBe(400);
  expect(calls.length).toBe(1);

  const blocked = await proxy.fetchUserOverlay({
    userId: "user-b",
    route: "mentions",
  });
  expect(blocked.status).toBe(403);
});

test("T12 client sync creates owner quests only when opted in", async () => {
  const store = createPersonalOverlayStore();
  const proxy = createGraphOBOProxy({
    allowPersonalOverlays: () => true,
    getAccessTokenForUser: async () => "token-abc",
    fetchGraph: async (): Promise<GraphFetchResponse> => ({
      status: 200,
      json: async () => ({
        value: [
          {
            id: "m-1",
            subject: "Mention in #support",
            webLink: "https://teams.microsoft.com/l/message/m-1",
          },
        ],
      }),
    }),
  });

  const client = createPersonalOverlayClient({
    userId: "user-a",
    store,
    proxy,
  });

  client.setOptIn(false);
  const skipped = await client.syncFromGraph("mentions");
  expect(skipped.created).toBe(0);
  expect(
    client.getMyOpenQuests().map((quest) => quest.quest_id),
  ).toEqual([]);

  client.setOptIn(true);
  const synced = await client.syncFromGraph("mentions");
  expect(synced.created).toBe(1);
  expect(
    client.getMyOpenQuests().map((quest) => quest.quest_id),
  ).toEqual(["mention:m-1"]);
});
