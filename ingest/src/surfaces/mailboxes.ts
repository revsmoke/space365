/**
 * Groups batch surface: group mailbox activity — counts and times ONLY.
 *
 * For each ENABLED team/group: /groups/{id}/conversations (top 50).
 * thread_count_7d = conversations whose lastDeliveredDateTime falls within
 * the last 7 days; last_topic_at = max lastDeliveredDateTime.
 *
 * Privacy: NO topics, NO previews, NO senders — we $select only
 * id,lastDeliveredDateTime and never store anything but the aggregate.
 * Groups without a mailbox (or with access denied) return 404/403 — skipped.
 */
import { GraphError } from "../graph_client";
import { stdbSql } from "../stdb_sql";
import {
  msToMicros,
  parseGraphUtcMs,
  type GraphLike,
  type SurfaceReducers,
  type SurfaceRunOptions,
} from "./common";

export const MAILBOXES_INTERVAL_MS = 15 * 60_000;
export const MAILBOX_CONVERSATIONS_TOP = 50;
export const MAILBOX_RECENT_WINDOW_MS = 7 * 24 * 3_600_000;

export type GroupConversation = {
  id?: string;
  lastDeliveredDateTime?: string;
};

export type MailboxStats = {
  threadCount7d: number;
  lastTopicAtMs: number; // 0 when the mailbox is quiet / empty
};

export function computeMailboxStats(
  conversations: GroupConversation[],
  nowMs: number,
): MailboxStats {
  let threadCount7d = 0;
  let lastTopicAtMs = 0;
  for (const conversation of conversations) {
    const deliveredMs = parseGraphUtcMs(conversation.lastDeliveredDateTime);
    if (deliveredMs === null) continue;
    if (nowMs - deliveredMs <= MAILBOX_RECENT_WINDOW_MS) threadCount7d++;
    if (deliveredMs > lastTopicAtMs) lastTopicAtMs = deliveredMs;
  }
  return { threadCount7d, lastTopicAtMs };
}

export type MailboxesResult = {
  teamsPolled: number;
  teamsSkipped: number;
  conversationsSeen: number;
};

export async function runMailboxesOnce(
  graph: GraphLike,
  reducers: Pick<SurfaceReducers, "upsertZoneMailbox">,
  options: SurfaceRunOptions = {},
): Promise<MailboxesResult> {
  const log = options.log ?? console.log;
  const sql = options.sql ?? stdbSql;
  const nowMs = options.nowMs ?? Date.now();

  const teamIds = (await sql("SELECT team_id FROM team WHERE is_enabled = true"))
    .map((row) => row[0])
    .filter(Boolean);

  const result: MailboxesResult = {
    teamsPolled: 0,
    teamsSkipped: 0,
    conversationsSeen: 0,
  };

  for (const teamId of teamIds) {
    let conversations: GroupConversation[];
    const basePath = `/groups/${teamId}/conversations?$top=${MAILBOX_CONVERSATIONS_TOP}`;
    try {
      conversations = (await graph.getAll(
        `${basePath}&$select=id,lastDeliveredDateTime`,
        MAILBOX_CONVERSATIONS_TOP,
      )) as GroupConversation[];
    } catch (error) {
      if (error instanceof GraphError && error.status === 400) {
        // Some tenants reject $select on /conversations; retry plain. The
        // extra fields are dropped at this boundary either way.
        try {
          conversations = (await graph.getAll(
            basePath,
            MAILBOX_CONVERSATIONS_TOP,
          )) as GroupConversation[];
          log(`mailboxes.select_rejected team=${teamId} — fetched without $select`);
        } catch (retryError) {
          if (
            retryError instanceof GraphError &&
            (retryError.status === 400 ||
              retryError.status === 403 ||
              retryError.status === 404)
          ) {
            result.teamsSkipped++;
            log(`mailboxes.skip team=${teamId} status=${retryError.status} code=${retryError.code}`);
            continue;
          }
          throw retryError;
        }
      } else if (
        error instanceof GraphError &&
        (error.status === 403 || error.status === 404)
      ) {
        // 404: no group mailbox; 403: access denied. Both tolerated.
        result.teamsSkipped++;
        log(`mailboxes.skip team=${teamId} status=${error.status} code=${error.code}`);
        continue;
      } else {
        throw error;
      }
    }
    result.teamsPolled++;
    result.conversationsSeen += conversations.length;

    const stats = computeMailboxStats(conversations, nowMs);
    if (!options.dryRun) {
      await reducers.upsertZoneMailbox({
        teamId,
        threadCount7D: stats.threadCount7d,
        lastTopicAt: msToMicros(stats.lastTopicAtMs),
      });
    }
    log(
      `mailboxes.team team=${teamId} threads7d=${stats.threadCount7d} ` +
        `seen=${conversations.length}`,
    );
  }

  log(
    `mailboxes.done teams=${result.teamsPolled} skipped=${result.teamsSkipped} ` +
      `conversations=${result.conversationsSeen}` +
      (options.dryRun ? " dry_run=1" : ""),
  );
  return result;
}
