# Space365 Live Task Tracker

- Last updated: 2026-07-06
- Source of truth for sequencing: `PLAN.md` v1.0 (Master Plan)
- Execution rule: no task starts before dependencies are `DONE`.
- Verification rule: tests written first, passing tests, atomic commit — every task.

## Status legend
`PENDING` · `IN_PROGRESS` · `BLOCKED` · `DONE`

## Historical note (v0.2 ladder)
The former T0–T13 tasks were completed 2026-02 as an **in-memory simulation** (audit 2026-07-06:
no SpacetimeDB bindings, no UI, no HTTP server; see PLAN.md §0). They are preserved below as the
blueprint they are, and their tests become the P1.5 parity suite. Statuses corrected from `DONE`
to `SIM-DONE` — logic proven, infrastructure not.

| Old task | Corrected status |
|---|---|
| T0 scaffold, T1 schema | `DONE` (real) |
| T2 STDB smoke, T4 membership, T6 presence, T7 aggregates, T8 idempotency/delta, T9 client updates, T10 kiosk, T11 admin, T12 overlays, T13 search | `SIM-DONE` (port in P1/P2) |
| T3 webhook validation | `SIM-DONE` (real public validation pending → P1.7) |
| T5 encrypted payloads, T14 Teams tab SSO | `PENDING` (optional, unscheduled) |

## Day-0 blockers (external / Bryan)
| ID | Item | Status |
|---|---|---|
| B-1 | Graph credentials — **DONE via certificate**: client-assertion auth with `ssl_certs/wildcard_tpgarchitecture.key` verified 2026-07-06 (token w/ 138 roles, `/teams` 200). Stale secret in `.env` to be removed in P0.1. | `DONE` |
| B-2 | Unknown consented API identified: **TPGGraphAdmin** (this tenant's own app). Confirm intentional. | `DONE` (confirm) |
| B-3 | Request `Presence.Read.All`, `OnlineMeetings.Read.All` (wave 2: Files/Sites/Tasks read) | `PENDING` |
| B-4 | Prune over-granted write permissions (Application.ReadWrite.All, AppRoleAssignment.ReadWrite.All, Teamwork.Migrate.All, Chat.ReadWrite.All, TeamsAppInstallation.ReadWrite*) | `PENDING` |
| B-5 | Confirm hosting: Maincloud pilot + self-host prod (PLAN D7) | `PENDING` |

## Task board (PLAN.md v1.0 phases)

### P0 — Unblock & foundations
| Task | Status | Depends on |
|---|---|---|
| P0.1 Switch tooling to certificate-assertion auth (creds verified working 2026-07-06) | `PENDING` | — |
| P0.2 Toolchain install (Bun, spacetime CLI), tests green | `PENDING` | — |
| P0.3 Hello-STDB publish + live subscription | `PENDING` | P0.2 |
| P0.4 Entra OIDC ↔ SpacetimeDB identity spike | `PENDING` | P0.3 |
| P0.5 CI pipeline | `PENDING` | P0.2 |
| P0.6 Permission requests filed | `PENDING` | B-3, B-4 |

### P1 — Real SpacetimeDB core
| Task | Status | Depends on |
|---|---|---|
| P1.1 Schema (tables + indexes) | `PENDING` | P0.3 |
| P1.2 Reducers + idempotency | `PENDING` | P1.1 |
| P1.3 Schedule tables (windows, EMA decay, retention) | `PENDING` | P1.1 |
| P1.4 Views + tenant-issuer validation | `PENDING` | P1.1, P0.4 |
| P1.5 Parity test harness (port 35 sim tests; delete sim) | `PENDING` | P1.2–P1.4 |
| P1.6 Ingest v1 (server, subscription mgr, full sync, delta, SDK writes) | `PENDING` | P0.1, P1.2 |
| P1.7 Public webhook endpoint (tunnel → prod URL) | `PENDING` | P1.6 |

### P2 — World client MVP
| Task | Status | Depends on |
|---|---|---|
| P2.1 Vite + three.js + React scaffold + bindings | `PENDING` | P0.3 |
| P2.2 Deterministic layout lib (shared) | `PENDING` | — |
| P2.3 Voxel campus renderer | `PENDING` | P2.1, P2.2 |
| P2.4 Live glow/particles/minimap | `PENDING` | P2.3, P1.3 |
| P2.5 Overlay UI (feed, drill-down, search/fast-travel, privacy page) | `PENDING` | P2.3 |
| P2.6 MSAL sign-in | `PENDING` | P0.4 |
| P2.7 Kiosk mode | `PENDING` | P2.4 |
| P2.8 Perf pass (60fps, reduced motion, palettes) | `PENDING` | P2.4 |

### P3 — Avatars & multiplayer
| Task | Status | Depends on |
|---|---|---|
| P3.1 Directory sync (all users) | `PENDING` | P1.6 |
| P3.2 player_state + movement reducers + interest mgmt | `PENDING` | P1.1, P2.3 |
| P3.3 Avatar renderer + emotes | `PENDING` | P3.2 |
| P3.4 Status ring (calendar/activity fallback) | `PENDING` | P3.1 |
| P3.5 Presence pipeline (feature-flagged) | `BLOCKED` | B-3 |
| P3.6 Multi-client soak (20+) | `PENDING` | P3.3 |

### P4 — Full M365 surface
| Task | Status | Depends on |
|---|---|---|
| P4.1 Meeting portals | `PENDING` | P1.6, P2.3 |
| P4.2 Personal quests (OBO, opt-in, my_quests view) | `PENDING` | P1.4, P2.5 |
| P4.3 Front Desk (Bookings) | `PENDING` | P1.6 |
| P4.4 Comms Tower (CallRecords viz) | `PENDING` | P1.6 |
| P4.5 Records Room (admin-only transcripts metadata) | `PENDING` | P4.4 |
| P4.6 Security Wing (admin-only audit viz) | `PENDING` | P1.4 |
| P4.7 Admin console | `PENDING` | P1.4, P2.5 |
| P4.8 Transparency page | `PENDING` | P4.7 |

### P5 — Playable & fun
| Task | Status | Depends on |
|---|---|---|
| P5.1 Team achievements (+ optional TeamsActivity.Send) | `PENDING` | P3, P4 |
| P5.2 Office decoration (voxel props) | `PENDING` | P3.2 |
| P5.3 Ambient life (day/night, org-mood weather) | `PENDING` | P2.4 |
| P5.4 Onboarding tour + dashboard mode | `PENDING` | P3, P4 |
| P5.5 Ambient sound (default muted) | `PENDING` | P5.3 |

### P6 — Hardening & ship
| Task | Status | Depends on |
|---|---|---|
| P6.1 Load/SLO report | `PENDING` | P1–P4 |
| P6.2 Chaos & recovery drills | `PENDING` | P6.1 |
| P6.3 Prod deploy (Docker STDB + ingest + Nginx, spacetime lock) | `PENDING` | B-5, P6.1 |
| P6.4 Backup + restore drill | `PENDING` | P6.3 |
| P6.5 Observability + alerts | `PENDING` | P6.3 |
| P6.6 Security/privacy sign-off (perm prune, cert auth, redaction, retention) | `PENDING` | B-4, P6.3 |
| P6.7 Pilot rollout | `PENDING` | P6.3–P6.6 |

## Checkpoint log
- (v0.2 history preserved in git: tags `checkpoint-2026-02-05-*` … `checkpoint-2026-07-02-043528`)
- 2026-07-06: project taken over; codebase + platform audit completed; PLAN v1.0 written;
  Graph client secret verified INVALID; permission inventory decoded to `docs/GRAPH_PERMISSIONS.md`;
  SpacetimeDB v2.6.1 research captured in `docs/SPACETIMEDB/CAPABILITIES.md`.
