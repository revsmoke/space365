/**
 * Graph webhook receiver (SPEC §9): Bun.serve, validationToken echo <10s,
 * clientState + subscriptionId validation (ingest/src/webhook.ts), then
 * chatMessage notifications map to ingest_channel_message_event.
 */
import type { StdbWriter } from "./stdb_writer";
import {
  handleGraphWebhook,
  type GraphWebhookRequest,
} from "./webhook";
import {
  mapChannelMessageNotification,
  type RawResourceData,
} from "./notifications";
import {
  processMentionNotification,
  type MentionQuestsDeps,
} from "./mention_quests";

export type WebhookServerOptions = {
  port: number;
  path?: string;
  clientState: string;
  knownSubscriptions: Set<string>;
  writer: StdbWriter;
  log?: (line: string) => void;
  /**
   * P4.2 @mention quests: when set, each "created" chatMessage notification
   * also triggers a Graph message fetch + mention→quest extraction (in the
   * same async post-ACK path). Wired from main.ts behind MENTION_QUESTS.
   */
  mentionQuests?: Omit<MentionQuestsDeps, "log">;
};

export function startWebhookServer(options: WebhookServerOptions) {
  const path = options.path ?? "/api/graph/webhook";
  const log = options.log ?? console.log;
  const context = {
    clientState: options.clientState,
    knownSubscriptions: options.knownSubscriptions,
  };

  const server = Bun.serve({
    port: options.port,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (url.pathname === "/healthz") {
        return Response.json({
          ok: true,
          known_subscriptions: options.knownSubscriptions.size,
        });
      }

      if (url.pathname !== path) {
        return new Response("Not found", { status: 404 });
      }

      // Subscription validation handshake: echo the token as text/plain
      // immediately (Graph requires a response within 10 seconds).
      const validationToken = url.searchParams.get("validationToken");
      if (validationToken) {
        return new Response(validationToken, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      if (request.method !== "POST" && request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body: unknown = request.method === "POST"
        ? await request.json().catch(() => null)
        : null;

      const webhookRequest: GraphWebhookRequest = {
        method: request.method as "GET" | "POST",
        query: Object.fromEntries(url.searchParams.entries()),
        headers: Object.fromEntries(request.headers.entries()),
        body,
      };

      const result = handleGraphWebhook(webhookRequest, context);

      if (result.status === 202 && result.notifications.length > 0) {
        // ACK first, ingest asynchronously — never risk the Graph timeout.
        const rawValues = extractRawValues(body);
        queueMicrotask(() =>
          ingestNotifications(
            result.notifications,
            rawValues,
            options.writer,
            log,
            options.mentionQuests,
          ),
        );
      }

      return new Response(result.body, { status: result.status });
    },
  });

  log(`webhook.listening port=${options.port} path=${path}`);
  return server;
}

function extractRawValues(body: unknown): Record<string, unknown>[] {
  if (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as { value?: unknown }).value)
  ) {
    return (body as { value: Record<string, unknown>[] }).value;
  }
  return [];
}

async function ingestNotifications(
  notifications: { subscription_id: string; resource: string; change_type: string; resource_id: string; client_state: string }[],
  rawValues: Record<string, unknown>[],
  writer: StdbWriter,
  log: (line: string) => void,
  mentionQuests?: Omit<MentionQuestsDeps, "log">,
): Promise<void> {
  for (let i = 0; i < notifications.length; i++) {
    const notification = notifications[i];
    const resourceData = (rawValues[i]?.resourceData ?? {}) as RawResourceData;
    const args = mapChannelMessageNotification(notification, resourceData);
    if (!args) {
      log(`webhook.skip resource=${notification.resource.slice(0, 80)}`);
    } else {
      try {
        await writer.ingestChannelMessageEvent(args);
        log(`webhook.ingested event=${args.eventType} channel=${args.channelId}`);
      } catch (error) {
        // Never log message content — ids and error class only (SPEC §9).
        log(`webhook.ingest_error channel=${args.channelId} error=${(error as Error).message}`);
      }
    }

    // P4.2: after the metadata ingest, extract @mention quests (created only;
    // the handler itself skips chat-only resources and 404s). Failures here
    // must never break the ingest loop — log ids/error class only.
    if (mentionQuests && notification.change_type === "created") {
      try {
        await processMentionNotification({ ...mentionQuests, log }, notification);
      } catch (error) {
        log(
          `mention_quests.error resource=${notification.resource.slice(0, 80)} ` +
            `error=${(error as Error).message}`,
        );
      }
    }
  }
}
