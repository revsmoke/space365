# Space365 ("Minecraft meets Teams") - Technical Specification (SPEC)

- Doc version: 0.2 (draft)
- Date: 2026-02-05
- Source: `PRD.md`
- Priority: SPECs and tests are first-class deliverables
- Runtime preference: Bun (if practical); otherwise Node.js or alternative per component needs

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

### Preferred (default)
- SpaceTimeDB module: TypeScript
- Ingestion gateway: Bun + TypeScript
- Web client: React + Babylon.js + Vite (Bun for tooling)
- Admin console: React (same monorepo as client)
- Auth: Microsoft Entra ID (OIDC/MSAL)

### Acceptable alternatives
- Ingestion gateway in Node.js or Rust if required by Graph tooling
- UI runtime stays web-based regardless of backend choices

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
- OIDC JWT (issuer+subject) is authoritative identity in SpaceTimeDB

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
- `presence`: `user_id`, `availability`, `activity`, `last_updated`
- `activity_events`: `event_id`, `event_type`, `occurred_at`, `team_id`, `channel_id`, `actor_user_id?`, `message_id?`, `thread_id?`, `counts_delta?`
- `channel_activity_agg`: `channel_id`, `window_start`, `msg_count`, `react_count`, `active_user_estimate`
- `quests`: `quest_id`, `user_id`, `kind`, `title`, `source_ref`, `deeplink`, `created_at`, `status`
- `config`: JSON blob for allowlists, thresholds, privacy toggles, retention
- `audit_log`: `audit_id`, `actor_user_id`, `action`, `timestamp`, `payload_redacted`
- `graph_cursors` (optional): `resource`, `delta_link`, `updated_at`
- `ingest_dedup` (optional): `event_id`, `seen_at`, `ttl_expires_at`

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

## 10) SpaceTimeDB module specification

### Reducers
- `upsert_user_profile`
- `upsert_team`
- `upsert_channel`
- `ingest_presence`
- `ingest_channel_message_event`
- `emit_aggregate_deltas`
- `create_or_update_quest`
- `admin_update_config`

### Authorization
- Reducers enforce role checks and membership checks
- Subscriptions enforce row-level visibility

### Real-time fanout (let SpaceTimeDB do the work)
- No custom WebSocket layer; rely on SpaceTimeDB subscriptions for all client updates.
- Clients subscribe to aggregate views; reducers mutate tables and SpaceTimeDB handles diffing and fanout.

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

### Hosting
- Ingest + admin: Azure Container Apps or equivalent
- SpaceTimeDB: Cloud pilot, Azure self-host for production if required
- Web client: static hosting with CDN

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
