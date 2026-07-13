/**
 * P4.2: @mention → personal quest extraction from channel-message webhooks.
 *
 * When a chatMessage "created" notification arrives (after the metadata
 * ingest), we fetch the full message once from Graph and turn each
 * user @mention into a personal quest (questId 'mention-<messageId>-<userId>').
 *
 * PRIVACY INVARIANT (PRD hard rule): the fetched message carries `body`
 * (message content). We take ONLY id / webUrl / from.user.displayName /
 * mentions[].mentioned.user.id via summarizeMentionMessage and discard the
 * rest of the response immediately. The body is never logged, stored, or
 * passed to any other function. Quest titles contain the sender display
 * name — that is personal data, which is allowed because the module shows
 * quests only to their owner and silently drops writes for users without
 * opt_in_personal=true (server-enforced in create_or_update_quest).
 */
import { GraphError } from "./graph_client";
import { parseChannelMessageResource } from "./notifications";
import { stdbSql } from "./stdb_sql";
import type { GraphNotification } from "./webhook";

/** Minimal Graph reader so tests can stub the single message fetch. */
export type GraphGetter = {
  get(pathOrUrl: string): Promise<unknown>;
};

export type MentionQuestArgs = {
  questId: string;
  userId: string;
  kind: string;
  title: string;
  sourceRef: string;
  deeplink: string;
  status: string;
};

/**
 * The ONLY fields we keep from a fetched chatMessage. Deliberately has no
 * `body` property — see the privacy invariant in the module header.
 */
export type MentionMessageSummary = {
  messageId: string | undefined;
  webUrl: string | undefined;
  fromDisplayName: string | undefined;
  mentionedUserIds: string[];
};

type RawUserRef = { user?: { id?: string; displayName?: string } | null } | null;

type RawChatMessage = {
  id?: string;
  webUrl?: string;
  from?: RawUserRef;
  mentions?: { mentioned?: RawUserRef }[] | null;
};

/**
 * Reduce a raw Graph chatMessage response to the mention summary.
 *
 * PRIVACY INVARIANT: this is the boundary where the message body dies.
 * Only the whitelisted fields below are copied out; the raw object is not
 * retained, logged, or forwarded. Never add `body` (or `attachments`,
 * `summary`, ...) to the returned shape.
 */
export function summarizeMentionMessage(raw: unknown): MentionMessageSummary {
  const message = (typeof raw === "object" && raw !== null ? raw : {}) as RawChatMessage;
  const mentionedUserIds: string[] = [];
  for (const mention of Array.isArray(message.mentions) ? message.mentions : []) {
    // Only user mentions become quests; channel/team/tag/app mentions have
    // no `mentioned.user` and are skipped. Dedupe repeated mentions.
    const userId = mention?.mentioned?.user?.id;
    if (userId && !mentionedUserIds.includes(userId)) {
      mentionedUserIds.push(userId);
    }
  }
  return {
    messageId: typeof message.id === "string" ? message.id : undefined,
    webUrl: typeof message.webUrl === "string" ? message.webUrl : undefined,
    fromDisplayName: message.from?.user?.displayName ?? undefined,
    mentionedUserIds,
  };
}

/** One quest per mentioned user. Pure; takes only the body-free summary. */
export function buildMentionQuests(
  summary: MentionMessageSummary,
  options: {
    channelId: string;
    channelName?: string | null;
    /** Used when the fetched message somehow lacks `id` (resource id). */
    fallbackMessageId?: string;
  },
): MentionQuestArgs[] {
  const messageId = summary.messageId ?? options.fallbackMessageId;
  if (!messageId) return [];
  const where = options.channelName?.trim() || "a channel";
  const who = summary.fromDisplayName?.trim() || "someone";
  return summary.mentionedUserIds.map((userId) => ({
    questId: `mention-${messageId}-${userId}`,
    userId,
    kind: "mention",
    title: `Mentioned by ${who} in ${where}`,
    sourceRef: options.channelId,
    deeplink: summary.webUrl ?? "",
    status: "open",
  }));
}

/** Graph fetch path for the notification's message (handles replies). */
export function mentionMessagePath(parsed: {
  teamId: string;
  channelId: string;
  messageId: string;
  replyId?: string;
}): string {
  const base =
    `/teams/${encodeURIComponent(parsed.teamId)}` +
    `/channels/${encodeURIComponent(parsed.channelId)}` +
    `/messages/${encodeURIComponent(parsed.messageId)}`;
  return parsed.replyId ? `${base}/replies/${encodeURIComponent(parsed.replyId)}` : base;
}

/**
 * Channel display name from the local module (cheap: local stdb read).
 * Returns null on any failure — the quest title then says 'a channel'.
 */
export function stdbChannelNameResolver(
  sql: (query: string) => Promise<string[][]> = stdbSql,
): (channelId: string) => Promise<string | null> {
  return async (channelId: string) => {
    try {
      const escaped = channelId.replace(/'/g, "''");
      const rows = await sql(`SELECT name FROM channel WHERE channel_id = '${escaped}'`);
      return rows[0]?.[0] || null;
    } catch {
      return null;
    }
  };
}

export type MentionQuestsDeps = {
  graph: GraphGetter;
  createOrUpdateQuest(args: MentionQuestArgs): Promise<void>;
  resolveChannelName?: (channelId: string) => Promise<string | null>;
  log?: (line: string) => void;
};

export type MentionProcessResult =
  | { outcome: "skipped"; reason: "change_type" | "chat_message" | "unsupported_resource" | "not_found" }
  | { outcome: "processed"; mentions: number; questsWritten: number };

/**
 * Handle one validated chatMessage notification: fetch the message, extract
 * user mentions, write quests. Non-404 Graph errors propagate to the caller
 * (429/503 are already retried inside GraphClient).
 */
export async function processMentionNotification(
  deps: MentionQuestsDeps,
  notification: GraphNotification,
): Promise<MentionProcessResult> {
  const log = deps.log ?? console.log;

  if (notification.change_type !== "created") {
    return { outcome: "skipped", reason: "change_type" };
  }

  const parsed = parseChannelMessageResource(notification.resource);
  if (!parsed) {
    // Pure 1:1/group chat messages have a chats('...') resource — no
    // team+channel path, so no channel quest context. Skip for now (P4.2).
    if (/chats\(/.test(notification.resource)) {
      log(`mention_quests.skip_chat resource=${notification.resource.slice(0, 80)}`);
      return { outcome: "skipped", reason: "chat_message" };
    }
    return { outcome: "skipped", reason: "unsupported_resource" };
  }

  let raw: unknown;
  try {
    raw = await deps.graph.get(mentionMessagePath(parsed));
  } catch (error) {
    // Deleted before we fetched (or not visible) — nothing to do.
    if (error instanceof GraphError && error.status === 404) {
      log(`mention_quests.skip_404 channel=${parsed.channelId} message=${parsed.replyId ?? parsed.messageId}`);
      return { outcome: "skipped", reason: "not_found" };
    }
    throw error;
  }

  // PRIVACY INVARIANT: discard the body immediately — `raw` (which contains
  // it) must not escape this scope, be logged, or be stored anywhere.
  const summary = summarizeMentionMessage(raw);
  raw = null;

  if (summary.mentionedUserIds.length === 0) {
    return { outcome: "processed", mentions: 0, questsWritten: 0 };
  }

  const channelName = deps.resolveChannelName
    ? await deps.resolveChannelName(parsed.channelId).catch(() => null)
    : null;

  const quests = buildMentionQuests(summary, {
    channelId: parsed.channelId,
    channelName,
    fallbackMessageId: parsed.replyId ?? parsed.messageId,
  });

  let written = 0;
  for (const quest of quests) {
    // The module silently drops this unless the user has opt_in_personal.
    await deps.createOrUpdateQuest(quest);
    written++;
  }

  // Ids and counts only — never titles or display names (SPEC §9 logging).
  log(
    `mention_quests.done channel=${parsed.channelId} ` +
      `message=${summary.messageId ?? parsed.messageId} mentions=${summary.mentionedUserIds.length} quests=${written}`,
  );
  return { outcome: "processed", mentions: summary.mentionedUserIds.length, questsWritten: written };
}
