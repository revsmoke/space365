/**
 * Space365 Graph ingestion service entrypoint (P1.6 + P0.1).
 *
 *   bun run ingest/src/main.ts --validate    # cert-assertion auth check (real call)
 *   bun run ingest/src/main.ts --sync-once   # full sync + users delta, then exit
 *   bun run ingest/src/main.ts --serve       # webhook + subscriptions + presence
 */
import { decodeJwtPayload } from "./graph_credentials";
import { GraphTokenProvider, loadCertCredentialConfig } from "./graph_auth";
import { GraphClient } from "./graph_client";
import { connectStdb, StdbWriter } from "./stdb_writer";
import { runFullSync } from "./full_sync";
import { runUsersDelta } from "./delta_sync";
import { startWebhookServer } from "./webhook_server";
import { SubscriptionManager } from "./subscription_manager";
import { PresencePoller } from "./presence_poller";
import { stdbSql } from "./stdb_sql";

const args = new Set(process.argv.slice(2));
const mode = args.has("--serve")
  ? "serve"
  : args.has("--sync-once")
    ? "sync-once"
    : args.has("--validate")
      ? "validate"
      : null;

if (!mode) {
  console.error("Usage: bun run ingest/src/main.ts --validate | --sync-once | --serve");
  process.exit(2);
}

const config = loadCertCredentialConfig();
const tokenProvider = new GraphTokenProvider(config);
const graph = new GraphClient({ getToken: () => tokenProvider.getToken() });

if (mode === "validate") {
  const token = await tokenProvider.getToken();
  const payload = decodeJwtPayload(token);
  console.log(`appToken.aud=${payload?.aud ?? "missing"}`);
  console.log(
    `appToken.role.count=${Array.isArray(payload?.roles) ? payload.roles.length : 0}`,
  );
  const teams = (await graph.get("/teams?$top=1&$select=id")) as {
    value?: unknown[];
  };
  console.log(`graph.teams.readable=${Array.isArray(teams.value)}`);
  console.log("token OK");
  process.exit(0);
}

const stdb = await connectStdb();
console.log(`stdb.identity=${stdb.identityHex}`);
const writer = new StdbWriter(stdb.conn);

if (mode === "sync-once") {
  const sync = await runFullSync(graph, writer);
  const delta = await runUsersDelta(graph, writer);
  console.log(
    `done teams=${sync.teams} channels=${sync.channels} users=${sync.users} ` +
      `delta_upserted=${delta.upserted}`,
  );
  stdb.disconnect();
  process.exit(0);
}

// --- serve -----------------------------------------------------------------
const port = Number(process.env.PORT ?? "8787");
const clientState = process.env.GRAPH_CLIENT_STATE ?? "space365-dev-client-state";
const dryRun = (process.env.GRAPH_SUBSCRIPTIONS_DRY_RUN ?? "1") !== "0";
const notificationUrl =
  (process.env.GRAPH_WEBHOOK_BASE_URL ?? "https://space365.tpgarchitecture.com") +
  (process.env.GRAPH_WEBHOOK_PATH ?? "/api/graph/webhook");

const knownSubscriptions = new Set<string>();
// Recover known subscription ids from the module's health table (survives restarts).
for (const [id] of await stdbSql("SELECT graph_subscription_id FROM subscription_health")) {
  if (id) knownSubscriptions.add(id);
}

const manager = new SubscriptionManager({
  graph,
  writer,
  notificationUrl,
  clientState,
  dryRun,
});
const created = await manager.ensureSubscriptions();
for (const record of created) knownSubscriptions.add(record.id);
for (const id of manager.knownSubscriptionIds) knownSubscriptions.add(id);
console.log(
  `subscriptions.ready count=${manager.subscriptions.size} dry_run=${dryRun} known=${knownSubscriptions.size}`,
);
manager.startRenewalLoop(60_000);

const server = startWebhookServer({
  port,
  path: process.env.GRAPH_WEBHOOK_PATH ?? "/api/graph/webhook",
  clientState,
  knownSubscriptions,
  writer,
});

const poller = new PresencePoller({ graph, writer });
await poller.pollOnce();
poller.start(60_000);

console.log(`serve.ready port=${port}`);

process.on("SIGINT", () => {
  poller.stop();
  manager.stop();
  server.stop();
  stdb.disconnect();
  process.exit(0);
});
