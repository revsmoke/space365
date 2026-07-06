# SpacetimeDB Capabilities — Research Digest (July 2026)

- Researched: 2026-07-06 against SpacetimeDB **v2.6.1** (docs line 2.0.0)
- Purpose: architecture-decision input for Space365. SpacetimeDB is the heart of the stack.
- Sources: spacetimedb.com/docs, GitHub clockworklabs/SpacetimeDB releases, official blog.

## What it is

SpacetimeDB collapses the game server and the database into one thing: you publish a **module**
(schema + all server logic) into the database, clients connect over WebSocket, subscribe to
queries, and receive incremental row updates into a local client cache. All state lives in
memory, durably persisted via an append-only commitlog. BitCraft (production MMORPG, thousands
of concurrent players) runs its entire backend as one SpacetimeDB module —
github.com/clockworklabs/BitCraftPublic is open source and a direct reference for us.

## Version landscape

| Item | Status |
|---|---|
| Current stable | **v2.6.1** (July 2026) |
| 2.0 launch | Feb/Mar 2026 (1.0 was Mar 2025) |
| License | BSL 1.1 → AGPLv3 **with linking exception** (our module/app code stays private; self-hosting permitted) |
| Maincloud pricing | Free: 2,500 TeV/mo (~3M reducer calls). Pro: $25/mo, ~120M calls + replication. Storage $1/GB/mo. Billing live since Jan 2026. |

## Features we will build on

### Module language: TypeScript (STABLE, and fastest)
- TS modules stable in 2.0, run on **V8** (not WASM); benchmarked ~304k TPS — currently faster
  than Rust modules in vendor benchmarks. Rust/C# also mature; C++ newer.
- One npm package `spacetimedb` contains both server library (`spacetimedb/server`) and client SDK.
- **Decision: TypeScript module** — shared types with client + ingest, fast iteration, stable.

### Tables, reducers, transactions
- Tables declared in module code; `public` tables are client-subscribable, private are module-only.
- **Reducers** = exported functions; each is one atomic transaction (error ⇒ full rollback). No network I/O inside reducers.
- **Event tables** (2.0): transient rows that exist only within a transaction — pub/sub signals
  that never accumulate storage. Perfect for burst VFX events (message spike, reaction storm).
- 2.0 gotchas: `schema({ ... })` wrapper required; `.update()` only via primary key;
  global reducer callbacks removed (use event tables); confirmed reads on by default
  (subscription updates only after durable commit; can disable per connection for latency).

### Procedures (stable in TS as of 2.5)
- Like reducers but manage their own transactions (`withTx`) and **can make outbound HTTP
  requests** (`ctx.http`, ≤180s, cannot span an open transaction).
- Means the module itself can call Microsoft Graph directly for pull-based sync, driven by
  schedule tables. We keep the external ingestion service for webhooks (Graph must POST to a
  public HTTPS endpoint), but procedures give us an in-module fallback/reconciliation path.

### Views (2.0, production-ready) — our access-control mechanism
- Read-only exported functions, subscribable in real time.
- `AnonymousViewContext`: materialized once, shared by all subscribers (cheap — use for world/ambient data).
- `ViewContext`: per-caller identity, computed per subscriber (expensive — reserve for personal
  quests/overlays and membership-gated rooms).
- Views must use indexed access (`.find()`/`.filter()`); full scans (`.iter()`) are banned.
- **Official guidance: prefer views over RLS.** RLS is still experimental with known
  subscription-join bugs (issue #2810). Space365 privacy guarantees (private-channel non-leak,
  personal quest isolation) will be enforced with views.

### Schedule tables — the game loop
- A table with a `ScheduleAt` column (Time or Interval) triggers a designated reducer.
  Insert row = schedule, delete = cancel; scheduling is transactional.
- Canonical game-tick pattern: insert one interval row in `init`.
- Space365 uses: aggregate-window rollover (1m/5m/1h), EMA glow decay tick, retention pruning,
  subscription-renewal watchdog signal, ambient world events (day/night), quest expiry.
- Note: scheduled functions private by default in 2.0.

### Subscriptions & client cache
- Clients subscribe with typed query builders (`tables.channel.where(...)`) or raw SQL;
  server sends matching rows then deltas; SDK maintains local cache with
  `onInsert/onUpdate/onDelete` — this cache **is** our three.js scene state source.
- Perf guidance: precise filters; group subscriptions by lifetime; subscribe-new-before-
  unsubscribe-old (zero-copy handoff); avoid overlapping result sets; prefer shared/anonymous
  views + coarse interest regions (zone-based) over per-user "near me" queries.

### Client SDKs
- **TypeScript SDK**: flagship. Browser (Vite), Node 22+, Bun, Deno, workers. Typed bindings via
  `spacetime generate`. React/Vue/Svelte hooks exist. **three.js needs no special integration —
  the TS SDK is the state layer; three.js renders from the client cache.** This is our client stack.
- Unity/C# (incl. Unity 6 WebGL), Unreal/C++, Godot SDKs all exist — native/engine clients are a
  possible later surface without backend changes.

### Auth & identity — the Entra ID question
- SpacetimeDB Identity = hash of OIDC `iss` + `sub`. Any standards-compliant OIDC ID token is
  accepted (server fetches issuer JWKS).
- **Entra ID should work as a standard OIDC issuer but is not explicitly documented** — some
  providers have had JWKS friction (issue #2600). **This is our Phase-0 spike**: validate an
  Entra `v2.0` ID token end-to-end. Fallbacks: SpacetimeAuth (their managed OIDC provider) or a
  small token-exchange service (Entra token in → local OIDC token out).
- Module must validate `ctx.sender`'s issuer/tenant in `client_connected` and reducers.
- Tokenless connections get anonymous identities — acceptable in dev, rejected in prod policy.

### External writes (ingestion service → SpacetimeDB)
1. **TS SDK over WebSocket** with a service-account identity, calling reducers — the optimized
   path; our default for webhook-driven ingestion.
2. HTTP API: `POST /v1/database/:name/call/:reducer` — fine for low-rate calls and ops scripts.
3. SQL over HTTP: `POST /v1/database/:name/sql` — queries/ops only; writes must go through reducers.
4. Custom module HTTP routes (2.4+) — module can expose bespoke endpoints.

### Hosting
- **Local dev on macOS**: `curl -sSf https://install.spacetimedb.com | sh`, then
  `spacetime start` (port 3000). Docker: `docker run -p 3000:3000 clockworklabs/spacetime start`.
- **Self-host prod**: single binary or Docker on Linux (official guide: Ubuntu 24.04 + Nginx +
  Let's Encrypt + systemd; Azure VM guide exists). RAM is the capacity dimension (whole dataset
  in memory). No self-hosted replication/HA — DR = filesystem snapshots of the data volume.
- **Maincloud**: managed, free tier generous enough for a pilot; Pro adds replication.
- Module updates hot-swap without disconnecting clients.

### Migrations
- `spacetime publish` auto-migrates compatible changes (add tables/indexes/reducers, etc.).
- Incompatible changes: `--delete-data` (dev only) or the documented incremental-migration
  pattern (new table + lazy row migration; see clockworklabs/incr-migration-demo).

## CLI crib sheet

```bash
curl -sSf https://install.spacetimedb.com | sh   # install (macOS/Linux)
spacetime start                                   # local server :3000
spacetime login                                   # Maincloud auth
spacetime init --lang typescript spacetime/module # scaffold module
spacetime publish space365 [--delete-data]        # deploy module
spacetime generate --lang typescript --out-dir web/client/src/bindings
spacetime logs space365
spacetime sql space365 "SELECT * FROM channel"
spacetime call space365 reducer_name '[args]'
spacetime lock space365                           # delete protection (2.2+)
```

## Key limits / gotchas checklist

- [ ] Whole DB in RAM — budget Graph-derived dataset size; keep bodies/blobs out (policy aligns).
- [ ] One module per database — all backend logic ships as one unit (BitCraft proves scale).
- [ ] RLS experimental — use **views**.
- [ ] Per-identity views cost per subscriber — keep personal views narrow (quests only).
- [ ] Confirmed reads add commit latency — measure; disable per connection if needed.
- [ ] No self-host replication — snapshot backups + documented restore runbook.
- [ ] Entra OIDC acceptance unverified — Phase-0 spike, with SpacetimeAuth/token-exchange fallback.
