/**
 * P4.2 @mention quest extraction (ingest/src/mention_quests.ts).
 *
 * Mock Graph payloads only; the privacy-critical assertions verify the
 * mapper never sees or emits a message body.
 */
import { describe, expect, test } from "bun:test";
import { GraphError } from "../ingest/src/graph_client";
import {
  buildMentionQuests,
  mentionMessagePath,
  processMentionNotification,
  stdbChannelNameResolver,
  summarizeMentionMessage,
  type MentionQuestArgs,
} from "../ingest/src/mention_quests";
import type { GraphNotification } from "../ingest/src/webhook";

const CHANNEL_ID = "19:chan@thread.tacv2";

const NOTIFICATION: GraphNotification = {
  subscription_id: "sub-1",
  client_state: "secret",
  change_type: "created",
  resource: `teams('team-1')/channels('${CHANNEL_ID}')/messages('1750000000000')`,
  resource_id: "1750000000000",
};

/** Realistic Graph chatMessage payload — including the body we must drop. */
function rawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1750000000000",
    etag: "1750000000000",
    messageType: "message",
    webUrl: "https://teams.microsoft.com/l/message/19%3Achan/1750000000000",
    from: { user: { id: "sender-1", displayName: "Ada Lovelace" } },
    body: { contentType: "html", content: "<div>SECRET-BODY <at id=\"0\">Bob</at></div>" },
    mentions: [
      {
        id: 0,
        mentionText: "Bob",
        mentioned: { user: { id: "user-bob", displayName: "Bob Builder" } },
      },
      {
        id: 1,
        mentionText: "Team",
        // channel/team mention — no `user`, must be ignored
        mentioned: { conversation: { id: CHANNEL_ID, displayName: "General" } },
      },
      {
        id: 2,
        mentionText: "Bob",
        // duplicate user mention — must dedupe
        mentioned: { user: { id: "user-bob", displayName: "Bob Builder" } },
      },
      {
        id: 3,
        mentionText: "Carol",
        mentioned: { user: { id: "user-carol", displayName: "Carol Danvers" } },
      },
    ],
    ...overrides,
  };
}

function stubDeps(raw: unknown) {
  const written: MentionQuestArgs[] = [];
  const fetched: string[] = [];
  const logs: string[] = [];
  return {
    written,
    fetched,
    logs,
    deps: {
      graph: {
        get: async (path: string) => {
          fetched.push(path);
          if (raw instanceof Error) throw raw;
          return raw;
        },
      },
      createOrUpdateQuest: async (args: MentionQuestArgs) => {
        written.push(args);
      },
      log: (line: string) => logs.push(line),
    },
  };
}

describe("summarizeMentionMessage (privacy boundary)", () => {
  test("extracts only user mentions, deduped", () => {
    const summary = summarizeMentionMessage(rawMessage());
    expect(summary.mentionedUserIds).toEqual(["user-bob", "user-carol"]);
    expect(summary.fromDisplayName).toBe("Ada Lovelace");
    expect(summary.messageId).toBe("1750000000000");
    expect(summary.webUrl).toContain("teams.microsoft.com");
  });

  test("summary carries no body field and no body content", () => {
    const summary = summarizeMentionMessage(rawMessage());
    // The mapper's output shape must not have a body property at all…
    expect(Object.keys(summary).sort()).toEqual([
      "fromDisplayName",
      "mentionedUserIds",
      "messageId",
      "webUrl",
    ]);
    expect("body" in summary).toBe(false);
    // …and no body content may leak through any retained string.
    expect(JSON.stringify(summary)).not.toContain("SECRET-BODY");
  });

  test("tolerates missing/odd fields", () => {
    expect(summarizeMentionMessage(null)).toEqual({
      messageId: undefined,
      webUrl: undefined,
      fromDisplayName: undefined,
      mentionedUserIds: [],
    });
    expect(summarizeMentionMessage({ mentions: null }).mentionedUserIds).toEqual([]);
    expect(
      summarizeMentionMessage({ mentions: [{ mentioned: null }, {}] }).mentionedUserIds,
    ).toEqual([]);
  });
});

describe("buildMentionQuests", () => {
  const summary = summarizeMentionMessage(rawMessage());

  test("one quest per mentioned user with the required shape", () => {
    const quests = buildMentionQuests(summary, {
      channelId: CHANNEL_ID,
      channelName: "General",
    });
    expect(quests).toHaveLength(2);
    expect(quests[0]).toEqual({
      questId: "mention-1750000000000-user-bob",
      userId: "user-bob",
      kind: "mention",
      title: "Mentioned by Ada Lovelace in General",
      sourceRef: CHANNEL_ID,
      deeplink: "https://teams.microsoft.com/l/message/19%3Achan/1750000000000",
      status: "open",
    });
  });

  test("quest ids are stable across repeated deliveries", () => {
    const again = summarizeMentionMessage(rawMessage());
    const a = buildMentionQuests(summary, { channelId: CHANNEL_ID });
    const b = buildMentionQuests(again, { channelId: CHANNEL_ID });
    expect(a.map((q) => q.questId)).toEqual(b.map((q) => q.questId));
  });

  test("falls back to 'a channel' and 'someone' when names are unknown", () => {
    const anonymous = summarizeMentionMessage(rawMessage({ from: null }));
    const [quest] = buildMentionQuests(anonymous, {
      channelId: CHANNEL_ID,
      channelName: null,
    });
    expect(quest.title).toBe("Mentioned by someone in a channel");
  });

  test("quests never contain body content", () => {
    const quests = buildMentionQuests(summary, {
      channelId: CHANNEL_ID,
      channelName: "General",
    });
    expect(JSON.stringify(quests)).not.toContain("SECRET-BODY");
    for (const quest of quests) {
      expect("body" in quest).toBe(false);
    }
  });
});

describe("mentionMessagePath", () => {
  test("builds the channel message fetch path with encoding", () => {
    expect(
      mentionMessagePath({ teamId: "team-1", channelId: CHANNEL_ID, messageId: "42" }),
    ).toBe("/teams/team-1/channels/19%3Achan%40thread.tacv2/messages/42");
  });

  test("targets the reply resource when present", () => {
    expect(
      mentionMessagePath({
        teamId: "t",
        channelId: "c",
        messageId: "parent",
        replyId: "reply-9",
      }),
    ).toBe("/teams/t/channels/c/messages/parent/replies/reply-9");
  });
});

describe("processMentionNotification", () => {
  test("created channel message → fetch + quests written", async () => {
    const { deps, written, fetched } = stubDeps(rawMessage());
    const result = await processMentionNotification(deps, NOTIFICATION);
    expect(result).toEqual({ outcome: "processed", mentions: 2, questsWritten: 2 });
    expect(fetched).toEqual([
      "/teams/team-1/channels/19%3Achan%40thread.tacv2/messages/1750000000000",
    ]);
    expect(written.map((q) => q.userId)).toEqual(["user-bob", "user-carol"]);
  });

  test("uses the channel name resolver when provided", async () => {
    const { deps, written } = stubDeps(rawMessage());
    const result = await processMentionNotification(
      { ...deps, resolveChannelName: async () => "Design Reviews" },
      NOTIFICATION,
    );
    expect(result.outcome).toBe("processed");
    expect(written[0].title).toBe("Mentioned by Ada Lovelace in Design Reviews");
  });

  test("skips non-created notifications without fetching", async () => {
    const { deps, fetched, written } = stubDeps(rawMessage());
    const result = await processMentionNotification(deps, {
      ...NOTIFICATION,
      change_type: "updated",
    });
    expect(result).toEqual({ outcome: "skipped", reason: "change_type" });
    expect(fetched).toEqual([]);
    expect(written).toEqual([]);
  });

  test("skips pure chat messages with a debug log", async () => {
    const { deps, fetched, logs } = stubDeps(rawMessage());
    const result = await processMentionNotification(deps, {
      ...NOTIFICATION,
      resource: "chats('19:meeting@thread.v2')/messages('99')",
    });
    expect(result).toEqual({ outcome: "skipped", reason: "chat_message" });
    expect(fetched).toEqual([]);
    expect(logs.some((line) => line.startsWith("mention_quests.skip_chat"))).toBe(true);
  });

  test("404 from Graph → skip, no quests, no throw", async () => {
    const { deps, written } = stubDeps(new GraphError(404, "NotFound", "gone"));
    const result = await processMentionNotification(deps, NOTIFICATION);
    expect(result).toEqual({ outcome: "skipped", reason: "not_found" });
    expect(written).toEqual([]);
  });

  test("non-404 Graph errors propagate (retry handled in GraphClient)", async () => {
    const { deps } = stubDeps(new GraphError(500, "InternalServerError", "boom"));
    await expect(processMentionNotification(deps, NOTIFICATION)).rejects.toThrow(
      "Graph 500",
    );
  });

  test("message without mentions writes nothing", async () => {
    const { deps, written } = stubDeps(rawMessage({ mentions: [] }));
    const result = await processMentionNotification(deps, NOTIFICATION);
    expect(result).toEqual({ outcome: "processed", mentions: 0, questsWritten: 0 });
    expect(written).toEqual([]);
  });

  test("reply notifications fetch the reply and key quests on the reply id", async () => {
    const { deps, written, fetched } = stubDeps(rawMessage({ id: "reply-9" }));
    const result = await processMentionNotification(deps, {
      ...NOTIFICATION,
      resource: `teams('team-1')/channels('${CHANNEL_ID}')/messages('parent-1')/replies('reply-9')`,
      resource_id: "reply-9",
    });
    expect(result.outcome).toBe("processed");
    expect(fetched[0]).toBe(
      "/teams/team-1/channels/19%3Achan%40thread.tacv2/messages/parent-1/replies/reply-9",
    );
    expect(written[0].questId).toBe("mention-reply-9-user-bob");
  });

  test("never logs body content or quest titles", async () => {
    const { deps, logs } = stubDeps(rawMessage());
    await processMentionNotification(deps, NOTIFICATION);
    const joined = logs.join("\n");
    expect(joined).not.toContain("SECRET-BODY");
    expect(joined).not.toContain("Ada Lovelace");
    expect(joined).not.toContain("Bob Builder");
  });
});

describe("stdbChannelNameResolver", () => {
  test("reads the channel name and escapes quotes", async () => {
    const queries: string[] = [];
    const resolve = stdbChannelNameResolver(async (query) => {
      queries.push(query);
      return [["General"]];
    });
    expect(await resolve("19:it's@thread")).toBe("General");
    expect(queries[0]).toBe(
      "SELECT name FROM channel WHERE channel_id = '19:it''s@thread'",
    );
  });

  test("returns null when the channel is unknown or the read fails", async () => {
    expect(await stdbChannelNameResolver(async () => [])("c")).toBeNull();
    expect(
      await stdbChannelNameResolver(async () => {
        throw new Error("stdb down");
      })("c"),
    ).toBeNull();
  });
});
