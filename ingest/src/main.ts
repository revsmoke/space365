/**
 * Space365 Graph ingestion service entrypoint (P1.6 + P0.1 + P4).
 *
 *   bun run ingest/src/main.ts --validate        # cert-assertion auth check (real call)
 *   bun run ingest/src/main.ts --sync-once       # full sync + users delta, then exit
 *   bun run ingest/src/main.ts --serve           # webhook + subscriptions + presence + provisioning
 *   bun run ingest/src/main.ts --surfaces-once   # one pass over the P4 surfaces, then exit
 *   bun run ingest/src/main.ts --surfaces-serve  # poll the P4 surfaces on their intervals
 *   bun run ingest/src/main.ts --provision-once  # drain the provisioning queue, then exit
 *
 * Surface modifiers: --dry-run (fetch + map, no reducer writes) and
 * --only=meetings,bookings,calls,planner,audit (subset).
 *
 * Env flags (--serve): MENTION_QUESTS=1 (default) turns "created" channel
 * message notifications into @mention quests (P4.2) — one Graph fetch per
 * message, body discarded at the boundary. Set MENTION_QUESTS=0 to disable.
 */
import { decodeJwtPayload } from "./graph_credentials";
import { GraphTokenProvider, loadCertCredentialConfig } from "./graph_auth";
import { GraphClient } from "./graph_client";
import { connectStdb, StdbWriter } from "./stdb_writer";
import { runFullSync } from "./full_sync";
import { runUsersDelta } from "./delta_sync";
import { startWebhookServer } from "./webhook_server";
import { stdbChannelNameResolver } from "./mention_quests";
import { SubscriptionManager } from "./subscription_manager";
import { PresencePoller } from "./presence_poller";
import { stdbSql } from "./stdb_sql";
import { surfaceReducers } from "./surfaces/common";
import { MEETINGS_INTERVAL_MS, runMeetingsOnce } from "./surfaces/meetings";
import { BOOKINGS_INTERVAL_MS, runBookingsOnce } from "./surfaces/bookings";
import { CALL_STATS_INTERVAL_MS, runCallStatsOnce } from "./surfaces/call_stats";
import { PLANNER_INTERVAL_MS, runPlannerQuestsOnce } from "./surfaces/planner_quests";
import { AUDIT_INTERVAL_MS, runAuditTickerOnce } from "./surfaces/audit_ticker";
import {
  ProvisioningWorker,
  provisionReducers,
  runProvisionOnce,
  startProvisioning,
} from "./provisioning";

const argv = process.argv.slice(2);
const args = new Set(argv);
const mode = args.has("--serve")
  ? "serve"
  : args.has("--sync-once")
    ? "sync-once"
    : args.has("--surfaces-once")
      ? "surfaces-once"
      : args.has("--surfaces-serve")
        ? "surfaces-serve"
        : args.has("--provision-once")
          ? "provision-once"
          : args.has("--validate")
            ? "validate"
            : null;

if (!mode) {
  console.error(
    "Usage: bun run ingest/src/main.ts --validate | --sync-once | --serve | " +
      "--surfaces-once | --surfaces-serve | --provision-once " +
      "[--dry-run] [--only=meetings,bookings,calls,planner,audit]",
  );
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

if (mode === "provision-once") {
  const worker = new ProvisioningWorker({
    graph,
    reducers: provisionReducers(writer),
  });
  const handled = await runProvisionOnce(stdb.conn, worker);
  console.log(`provision.once done handled=${handled}`);
  stdb.disconnect();
  process.exit(0);
}

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

// --- surfaces (P4) -----------------------------------------------------------
if (mode === "surfaces-once" || mode === "surfaces-serve") {
  const dryRun = args.has("--dry-run");
  const onlyArg = argv.find((arg) => arg.startsWith("--only="));
  const only = onlyArg
    ? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean))
    : null;

  const reducers = surfaceReducers(writer);
  const surfaces = [
    {
      name: "meetings",
      intervalMs: MEETINGS_INTERVAL_MS,
      run: () => runMeetingsOnce(graph, reducers, { dryRun }),
    },
    {
      name: "bookings",
      intervalMs: BOOKINGS_INTERVAL_MS,
      run: () => runBookingsOnce(graph, reducers, { dryRun }),
    },
    {
      name: "calls",
      intervalMs: CALL_STATS_INTERVAL_MS,
      run: () => runCallStatsOnce(graph, reducers, { dryRun }),
    },
    {
      name: "planner",
      intervalMs: PLANNER_INTERVAL_MS,
      run: () => runPlannerQuestsOnce(graph, reducers, { dryRun }),
    },
    {
      name: "audit",
      intervalMs: AUDIT_INTERVAL_MS,
      run: () => runAuditTickerOnce(graph, reducers, { dryRun }),
    },
  ].filter((surface) => !only || only.has(surface.name));

  // Initial pass for every selected surface; one failing surface must not
  // block the others.
  let failures = 0;
  for (const surface of surfaces) {
    try {
      await surface.run();
    } catch (error) {
      failures++;
      console.log(`surface.${surface.name}.error ${(error as Error).message}`);
    }
  }

  if (mode === "surfaces-once") {
    console.log(`surfaces.once done count=${surfaces.length} failures=${failures}`);
    stdb.disconnect();
    process.exit(failures === surfaces.length && surfaces.length > 0 ? 1 : 0);
  }

  const timers = surfaces.map((surface) =>
    setInterval(() => {
      surface.run().catch((error) =>
        console.log(`surface.${surface.name}.loop_error ${(error as Error).message}`),
      );
    }, surface.intervalMs),
  );
  console.log(
    `surfaces.serve ready count=${surfaces.length} ` +
      surfaces.map((s) => `${s.name}=${s.intervalMs / 1000}s`).join(" "),
  );
  process.on("SIGINT", () => {
    for (const timer of timers) clearInterval(timer);
    stdb.disconnect();
    process.exit(0);
  });
} else {
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

// P4.2 @mention quests: default ON in --serve; MENTION_QUESTS=0 disables.
const mentionQuestsEnabled = (process.env.MENTION_QUESTS ?? "1") !== "0";
const questReducers = surfaceReducers(writer);
console.log(`mention_quests.enabled=${mentionQuestsEnabled}`);

const server = startWebhookServer({
  port,
  path: process.env.GRAPH_WEBHOOK_PATH ?? "/api/graph/webhook",
  clientState,
  knownSubscriptions,
  writer,
  mentionQuests: mentionQuestsEnabled
    ? {
        graph,
        createOrUpdateQuest: (args) => questReducers.createOrUpdateQuest(args),
        resolveChannelName: stdbChannelNameResolver(),
      }
    : undefined,
});

const poller = new PresencePoller({ graph, writer });
await poller.pollOnce();
poller.start(60_000);

// Provisioning worker: executes admin channel requests from service_queue.
const provisioningWorker = new ProvisioningWorker({
  graph,
  reducers: provisionReducers(writer),
});
await startProvisioning(stdb.conn, provisioningWorker);

console.log(`serve.ready port=${port}`);

process.on("SIGINT", () => {
  poller.stop();
  manager.stop();
  server.stop();
  stdb.disconnect();
  process.exit(0);
});
} // end --serve
