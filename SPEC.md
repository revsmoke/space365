# Space365 ("Minecraft meets the Office") - Technical Specification (SPEC)

- Doc version: 0.3
- Date: 2026-07-06 (v0.2: 2026-02-05)
- Source: `PRD.md` (v0.5) + `PLAN.md` v1.0 + `docs/SPACETIMEDB/CAPABILITIES.md` + `docs/GRAPH_PERMISSIONS.md`
- Priority: SPECs and tests are first-class deliverables
- Runtime preference: Bun (tests, ingest, scripts); SpacetimeDB v2.6+ TypeScript module
- v0.3 changes: SpacetimeDB 2.x reality (TS modules stable, views-not-RLS, schedule tables,
  event tables, procedures), renderer decision three.js, expanded M365 surface (calendar,
  Bookings, call records, audit), avatar multiplayer tables, concrete deployment

## 1) Scope and assumptions

### In scope (v1)
- Teams-first signals: teams/channels, channel message metadata (no bodies), presence, mentions, meetings
- SpaceTimeDB for authoritative world state and real-time subscriptions
- Browser-based 3D client with dashboard overlays
- Admin console for scope/privacy/ops
- Strong privacy guarantees (private channel non-leak, personal overlays server-enforced)

### Out of scope (v1)
- Full message content storage
- Private chat ingestion by default
- Individual performance metrics
- Non-M365 data sources

### Assumptions
- Single-tenant deployment for the first production pilot
- SpaceTimeDB Cloud for pilot, with migration path to Azure self-host
- Tiered Graph permissions strategy (Tier A/B can ship while Tier C/D approvals are pending)
- Microsoft Graph is the source of truth for org structure, membership, and activity signals

## 2) Tech stack

### Decided (PLAN.md v1.0 decision log D1–D10)
- SpacetimeDB module: **TypeScript** (stable since STDB 2.0, V8 runtime, fastest vendor
  benchmark; npm package `spacetimedb`, server lib `spacetimedb/server`)
- Ingestion gateway: Bun + TypeScript (`Bun.serve`), writes via STDB TS SDK over WebSocket
  with a service identity
- Web client: **three.js** (world) + React (overlay UI) + Vite; STDB typed bindings via
  `spacetime generate`; the SDK client cache is the scene-state source
- Admin console: React route in the same client app (`web/admin` folder merges into client)
- Auth: Microsoft Entra ID (OIDC/MSAL) → SpacetimeDB Identity (iss+sub); P0.4 spike,
  fallback SpacetimeAuth or token-exchange service

### Acceptable alternatives
- Babylon.js if three.js scene tooling proves insufficient (same SDK state layer)
- Unity 6 WebGL / Godot as later native surfaces — no backend changes required
- UI runtime stays web-browser-first regardless

## 3) Repo and package layout (proposed)

```
/spacetime
  /module            # SpaceTimeDB module (tables, reducers, auth)
/ingest
  /src               # webhook receiver + queue workers
/web
  /client            # 3D world + UI
  /admin             # admin console
/shared
  /types             # shared event/types schema (TS)
```

## 4) System architecture (concrete)

### Components (minimal-first)
1. Web client (3D + UI overlays)
2. SpaceTimeDB module (tables + reducers + auth + real-time subscriptions)
3. Graph ingestion gateway (webhooks + normalization)
4. Admin console (can be a protected route within the same web app)
5. Telemetry (minimal, expand only if needed)

### Data flow (summary)
Graph change notifications -> Ingestion receiver -> SpaceTimeDB reducers -> subscriptions -> clients

If throughput demands it, insert a queue between receiver and reducers. Default path is direct-to-reducer for simplicity.

## 5) Identity, roles, and authorization

### Roles
- Admin: manage scope, privacy, retention, safe mode
- User: view world in policy, opt-in/out personal overlays
- Kiosk: read-only ambient display, no personal overlays

### Enforcement (server-side)
- Private channels never visible to non-members
- Non-member visibility policy: hide by default; optional anonymized mode (explicit admin enable)
- Personal tables (quests) are row-restricted to the owner identity
- Admin-only tables (config/audit) require admin role

### Entra ID mapping
- Roles mapped from AAD groups/claims
- OIDC JWT (issuer+subject) is authoritative identity in SpacetimeDB: the server validates any
  standards-compliant OIDC ID token against the issuer's JWKS. Entra acceptance is unverified
  upstream → **P0.4 spike**; fallbacks: SpacetimeAuth (managed OIDC) or a thin token-exchange
  service. Module rejects identities whose `iss` is not our tenant in `client_connected`.
- Tokenless (anonymous) connections: dev only; rejected by policy in pilot/prod.

### Membership model (source of truth + sync)
- **Source of truth:** Microsoft Graph for team and channel membership.
- **Storage:** Membership stored in SpaceTimeDB tables for fast authorization and filtering.
- **Sync strategy:**
  - Full sync on initial allowlist enablement (teams/channels + members).
  - Incremental sync via Graph change notifications or delta queries where available.
  - Periodic reconciliation using delta tokens (daily or on mismatch); no bespoke ETL.
  - On authz mismatch, fall back to on-demand Graph check and reconcile.

## 6) Data model (tables and fields)

### Core tables
- `users`: `user_id`, `display_name`, `dept`, `title`, `avatar_seed`, `opt_in_personal`
- `teams`: `team_id`, `name`, `zone_id`, `is_enabled`
- `channels`: `channel_id`, `team_id`, `name`, `room_id`, `is_enabled`, `visibility`
- `team_members`: `team_id`, `user_id`, `role`, `synced_at`
- `channel_members`: `channel_id`, `user_id`, `role`, `synced_at`
- `room_state`: `room_id`, `last_activity_at`, `glow_level`, `heat_level`
- `presence`: `user_id`, `availability`, `activity`, `last_updated`, `source` (`graph` | `calendar_fallback`)
- `activity_events`: `event_id`, `event_type`, `occurred_at`, `team_id`, `channel_id`, `actor_user_id?`, `message_id?`, `thread_id?`, `counts_delta?`
- `channel_activity_agg`: `channel_id`, `window_start`, `msg_count`, `react_count`, `active_user_estimate`
- `quests`: `quest_id`, `user_id`, `kind`, `title`, `source_ref`, `deeplink`, `created_at`, `status`
- `config`: JSON blob for allowlists, thresholds, privacy toggles, retention
- `audit_log`: `audit_id`, `actor_user_id`, `action`, `timestamp`, `payload_redacted`
- `graph_cursors`: `resource`, `delta_link`, `updated_at`
- `ingest_dedup`: `event_id`, `seen_at`, `ttl_expires_at` (pruned by schedule table)

### Multiplayer / game tables (P3+)
- `player_state`: `identity` (STDB Identity, pk), `user_id`, `x`, `y`, `z`, `heading`, `zone_id`,
  `animation`, `emote?`, `updated_at` — written only by `move_player`/`set_emote` reducers;
  subscribed zone-scoped (interest management)
- `decorations`: `decoration_id`, `zone_id`, `owner_user_id`, `prop_kind`, `x`, `y`, `z`,
  `rotation`, `placed_at` — per-user placement budget enforced in reducer
- `achievements`: `achievement_id`, `team_id`, `kind`, `earned_at`, `window_ref` — team-level only

### Expanded M365 surface tables (P4)
- `meetings`: `event_id`, `organizer_team_id?`, `zone_id?`, `subject_redacted`, `starts_at`,
  `ends_at`, `join_url?`, `state` (`upcoming`/`soon`/`live`/`ended`)
- `bookings_appointments`: `appointment_id`, `business_id`, `service_name`, `starts_at`, `status`
- `call_stats_agg`: `window_start`, `bucket` (hour), `call_count`, `total_minutes`, `modality`
  — aggregates only; no participant lists in ambient tables
- `subscription_health`: `graph_subscription_id`, `resource`, `expires_at`, `last_renewed_at`,
  `state` (`active`/`expiring`/`failed`) — powers admin health board + stale-mode badge

### Schedule tables (STDB-native timers; see docs/SPACETIMEDB/CAPABILITIES.md)
- `tick_agg_windows` (interval 60s): window rollover for 1m/5m/1h aggregates
- `tick_glow_decay` (interval ~5s): EMA decay for `room_state.glow_level`
- `tick_retention` (interval 1h): prune `activity_events`, `ingest_dedup`, expired quests
- `tick_ambient` (interval 60s): day/night + org-mood world params
- `tick_subscription_watchdog` (interval 5m): flag `subscription_health` rows nearing expiry

### Event tables (transient, in-transaction pub/sub — never stored)
- `evt_room_burst`: `room_id`, `kind` (`spike`/`reaction_storm`/`new_thread`), `magnitude`
  — drives client VFX without accumulating rows

Notes:
- `activity_events` is optional for audit/debug; disable if not needed to minimize storage.
- Prefer aggregates + room_state for rendering to keep client updates small.
- `graph_cursors` stores delta tokens/links to avoid external state.
- `ingest_dedup` is only required if running multiple ingestion workers.

### Indexes
- `activity_events` by `(channel_id, occurred_at)`
- `channel_activity_agg` by `(channel_id, window_start)`
- `quests` by `(user_id, status)`

## 7) Event model and schema versioning

### Canonical event types (v1)
- `channel.message.created`
- `channel.message.updated`
- `channel.message.deleted`
- `channel.message.reaction`
- `presence.changed`
- `meeting.starting_soon`
- `team.created/updated`
- `channel.created/updated/deleted`

### Schema versioning
- Each event payload includes `schema_version`
- Ingestion gateway performs version normalization before reducers
- Backward compatibility for at least 1 prior schema version (expand only if required)

### Idempotency
- Stable `event_id` derived from:
  - `subscriptionId` + `resource` + `changeType` + `resourceData.id` + `resourceData.@odata.etag` (or lastModifiedDateTime)
- Dedupe window at least 24h (configurable)

## 8) Graph integration details

### Subscription list (initial target)
Teams message change notifications (metadata only):
- `teams/{team-id}/channels/{channel-id}/messages`
- `teams/{team-id}/channels/getAllMessages` (if policy/approval allows)
  - Change types: `created`, `updated`, `deleted`
  - Mentions are derived from message events; no separate subscription is required.

Teams + channels structure:
- `teams/{team-id}`
- `teams/{team-id}/channels`
  - Change types: `created`, `updated`, `deleted`

Presence updates:
- `communications/presences/{user-id}`
  - Change types: `updated`

Meetings:
- `users/{user-id}/events` (meeting soon window)
  - Change types: `created`, `updated`, `deleted`

### Renewal
- Renewal job runs continuously; renew before expiration
- Failed renewal triggers alert and stale-mode UI badge

### Encrypted resource data
- If using message notifications with encrypted payloads, implement decryption
- Store only necessary metadata; discard body immediately (default)

### Tokens
- Ambient mode: application permissions (admin consent)
- Personal overlays: delegated permissions
- Content-on-click (if enabled): delegated tokens only

### Token handling model (required)
- **Default:** server-side proxy (OBO) for delegated calls to avoid CORS/CSP issues and enforce policy.
- **Client-direct** Graph calls allowed only if required by Teams SDK or specific endpoints; keep off by default.

### Permission tiers (implementation contract)
- Tier A: teams/channels structure
- Tier B: presence
- Tier C: channel message metadata
- Tier D: personal overlays (mentions, meetings)

## 9) Ingestion gateway specification (minimal-first)

### Webhook receiver
- Must validate Graph challenge requests
- Must validate `validationToken` on subscription creation
- Must validate `clientState` and `subscriptionId` on notifications
- Must ACK within platform timeout (<10s)

### Queueing and workers
Default (pilot):
- Receiver validates + normalizes, then calls SpaceTimeDB reducers directly.
- Keep processing stateless and fast; rely on SpaceTimeDB for fanout.
- Dedupe store: in-memory TTL cache (single instance).

Scale-up (only if needed):
- Add durable queue (Azure Service Bus / Storage Queue).
- Receiver only enqueues; worker processes async.
- Retry policy: exponential backoff, max retries, DLQ for poison messages.
- Dedupe store moves to `ingest_dedup` in SpaceTimeDB for multi-worker safety.

### Normalization and aggregation
- Transform raw notifications into canonical event format
- Batch reducer calls for efficiency
- Aggregate per-channel metrics in SpaceTimeDB reducers; avoid per-message fanout
  - Default windows: 1m, 5m, 1h
  - Smoothing: exponential moving average (EMA) per room
  - `active_user_estimate`: approximate count using distinct authors in the last 5m window (no raw author lists persisted beyond window)

### Error handling
- All errors logged without message content
- Ingestion failures increment metrics and trigger alerts

## 10) SpacetimeDB module specification (v2.6+, TypeScript)

One module = the whole backend (BitCraft pattern). All writes go through reducers; all reads
reach clients through views/subscriptions. Module structure: `schema({...})` wrapper, tables
above, plus:

### Reducers (each = one atomic transaction; idempotent where fed by ingest)
Ingest-facing (service identity only — enforced by identity allowlist in each reducer):
- `upsert_user_profile`, `upsert_team`, `upsert_channel`, `sync_membership`
- `ingest_presence` (accepts `source`: graph or calendar_fallback)
- `ingest_channel_message_event` (dedup via unique `event_id` insert; emits `evt_room_burst`
  event-table rows on spike detection)
- `upsert_meeting`, `upsert_booking_appointment`, `ingest_call_record_agg`
- `update_subscription_health`
Client-facing:
- `move_player`, `set_emote`, `place_decoration`, `remove_decoration` (budget + zone checks)
- `set_personal_opt_in`, `dismiss_quest`
- `create_or_update_quest` (OBO proxy path, owner-scoped)
Admin-facing (role check via Entra group claim mapping in `config`):
- `admin_update_config`, `admin_pause_ingest`, `admin_safe_mode`
Lifecycle:
- `init` (seed config, insert schedule-table rows), `client_connected` (validate token issuer =
  our tenant; upsert `player_state` shell), `client_disconnected` (mark avatar away)
Scheduled (private by default in 2.x):
- `on_tick_agg_windows`, `on_tick_glow_decay`, `on_tick_retention`, `on_tick_ambient`,
  `on_tick_subscription_watchdog`

### Views — THE authorization mechanism (RLS is experimental; do not use)
- `ambient_world` (AnonymousViewContext — materialized once, shared): enabled public
  teams/channels/room_state/aggregates per allowlist + privacy toggles. Cheap at any client count.
- `visible_rooms` (ViewContext — per identity): adds member-gated private channels for members
  only. Non-members receive no row (existence non-leak).
- `my_quests` (ViewContext): quests where `user_id = caller`. The only other per-identity view;
  keep narrow for fanout cost.
- `admin_ops` (ViewContext, role-gated): config, audit_log, subscription_health, call/PSTN
  detail, audit-wing data.
- `players_in_zone` (parameterized subscription on `player_state` by zone): interest management.
- Views must use indexed access only (full scans banned by STDB).

### Procedures (stable in TS; manual transactions, outbound HTTP allowed)
- `reconcile_resource(resource)`: pull-based Graph delta fetch via `ctx.http` as fallback when
  the ingest service is down (≤180s; commits via `withTx`). Scheduled sparsely; primary path
  remains the external ingest service.

### Real-time fanout (let SpacetimeDB do the work)
- No custom WebSocket layer anywhere; STDB subscriptions carry all client updates.
- Confirmed reads are on by default (updates after durable commit); measure latency in P6.1 and
  optionally disable per connection for the kiosk/game feel.
- Client subscription hygiene: precise filters, subscribe-new-before-unsubscribe-old, no
  overlapping result sets.

## 11) Client specification

### Subscriptions
- World map (teams/channels)
- Zone activity aggregates (visible zones only)
- Presence LOD (nearby or global for small orgs)
- Personal quests (user-only)

### World layout (deterministic)
- Stable ID -> coordinate mapping
- New teams/channels added without reshuffling existing geography
- Admin pin/override support stored in `config`
  - Proposed algorithm: hash(team_id) -> zone grid slot; hash(channel_id) -> room slot within zone
  - Collision resolution: open-addressing within a bounded zone grid
  - Layout version stored in `config` for deterministic client/server agreement

Simplify where possible:
- Use a single deterministic layout algorithm across client and server (shared lib in `/shared/types`).
- Avoid storing per-room geometry; derive from IDs + layout version.

### UI/UX
- 3D world + overlays (activity feed, room details, filters)
- Search and fast travel
- Privacy/data panel
- Kiosk mode (read-only)

## 12) Admin console specification

- Scope control (allowlist/denylist)
- Signal toggles and privacy controls
- Retention and aggregation window settings
- Subscription health dashboard (minimal: status + last renewal time)
- Safe mode + pause ingestion

## 13) Kiosk mode specification

- Full-screen, minimal UI
- No personal overlays
- No deep links by default
- Optional QR-based handoff to Teams

## 14) Teams tab embedding (optional)

- Teams app manifest + tab integration
- SSO support
- Deep links open inside Teams when embedded

## 15) Deployment and environments

### Environments
- Dev, staging, prod
- Feature flags for Tier C/D features

### Hosting (concrete; PLAN D7)
- Dev: local `spacetime start` (:3000) on macOS; Vite dev server; webhook via dev tunnel
  (cloudflared) to local ingest.
- Pilot: SpacetimeDB Maincloud free tier (2,500 TeV/mo ≈ 3M reducer calls); ingest container +
  static client on the tpgarchitecture server behind Nginx with the existing wildcard cert
  (`ssl_certs/`); webhook at `https://space365.tpgarchitecture.com/api/graph/webhook`.
- Prod: self-hosted SpacetimeDB via Docker (`clockworklabs/spacetime`) on the same host —
  RAM-sized to dataset (all state in memory), `spacetime lock` enabled, systemd-managed;
  nightly data-volume snapshots as backup (no self-host replication exists — restore drill
  required, PLAN P6.4).
- Client: Nginx static + optional CDN.

## 16) Observability, security, compliance

### Metrics
- Ingestion latency, queue depth, subscription renewal status
- Reducer throughput and subscription fanout
- Client FPS and error rate

### SLO targets
- Event-to-visual latency: p50 < 3s, p95 < 10s (subscription-backed signals)
- Presence update latency: p50 < 10s
- Client FPS: 60fps target (medium settings), 30fps minimum (low)

### Security
- Secrets in Key Vault
- Logs redacted by default
- Strict access checks for private channels and personal data

## 17) Test strategy (required)

### Unit tests
- Reducer logic (state transitions)
- Event normalization
- Idempotency key generation

### Integration tests
- Webhook validation flow
- Queue -> worker -> reducer pipeline
- Auth and membership gating

### End-to-end tests
- Synthetic activity drives world updates
- Personal quest isolation
- Kiosk mode does not leak personal data

### Performance tests
- Burst message handling with bounded update rates
- Subscription fanout under target concurrency

### Test harness and commands
- Each POC must include a runnable test script:
  - `bun test` for unit/integration tests where applicable
  - `bun run poc:<id>` for POC demo harnesses
- If Bun is not viable for a component, define equivalent `npm test` or language-native test command.

## 18) Proof-of-concept (POC) ladder and tests

Each POC is isolated, produces a demo artifact, and ends with a passing test. Each POC is an atomic commit.

### POC-1: SpaceTimeDB local module smoke test
- Goal: reducer + subscription works with synthetic events
- Test: inject events, client receives updates within 1s
- Success: deterministic state updates, no auth leakage

### POC-2: Graph webhook validation
- Goal: handle validation and change notification ACK
- Test: validate `validationToken`, `clientState`, and `subscriptionId`; respond within timeout
- Success: Graph subscription confirms successfully

### POC-3: Encrypted resource data handling
- Goal: decrypt Graph payloads (if enabled)
- Test: decrypt sample payload and discard body
- Success: only metadata persists

### POC-4: Presence subscription
- Goal: presence notifications flow into SpaceTimeDB
- Test: presence change triggers reducer and client update
- Success: p50 latency < 10s

### POC-5: Channel message metadata ingestion
- Goal: channel message events -> aggregates
- Test: simulated burst updates heatmap without flooding client; EMA smoothing verified
- Success: bounded update rates and accurate counts

### POC-6: Idempotency and replay
- Goal: duplicate/out-of-order events do not corrupt state
- Test: replay event set in shuffled order
- Success: identical final state

### POC-7: Delta reconciliation
- Goal: missed notifications recovered via delta
- Test: simulate downtime, then reconcile
- Success: aggregates match expected totals

### POC-8: Client subscription -> rendering update
- Goal: live updates change room glow
- Test: synthetic event updates glow within 1s
- Success: no frame drops under moderate load

### POC-9: Kiosk mode
- Goal: read-only ambient display
- Test: kiosk cannot access personal overlays or deep links
- Success: runs unattended for 8h without errors

### POC-10: Teams tab SSO (optional)
- Goal: SSO login within Teams tab
- Test: user opens Space365 tab without extra login
- Success: access granted with delegated scopes

### POC-11: Admin console scope control
- Goal: allowlist changes reshape world without redeploy
- Test: add/remove channel, world updates within 60s
- Success: no private channel leakage

## 19) Atomic commits policy

- Each POC is a standalone atomic commit with tests included.
- Commit message format: `POC-x: <short description>`
- No commit mixes unrelated changes.
- Tests must pass before merge to main.
- Integration occurs incrementally after each POC passes (baby steps).

## 20) Open decisions (blocking)

- Non-member visibility policy (hide vs anonymized)
- Presence granularity policy
- Retention windows
- Graph permissions approvals and any legal/HR constraints
- Production hosting (SpaceTimeDB Cloud vs Azure self-host)
