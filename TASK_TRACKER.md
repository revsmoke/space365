# Space365 Live Task Tracker

- Last updated: 2026-02-06
- Source of truth for sequencing: `PLAN.md`
- Execution rule: no task starts before dependencies are `DONE`.
- Verification rule: each task requires tests written first, passing tests, and an atomic commit.

## Status legend
- `PENDING`: not started
- `IN_PROGRESS`: active implementation
- `BLOCKED`: waiting on dependency or external prerequisite
- `DONE`: tests pass and atomic commit completed

## External prerequisites
- `P-1` Entra ID app registration and permissions
- `P-2` Tenant admin consent for Tier A/B (Tier C/D as approved)
- `P-3` Public HTTPS webhook endpoint reachable by Graph
- `P-4` Teams app configuration (for T14 only)

## Task board
| Task | Status | Depends on | Blocks |
|---|---|---|---|
| `T0` Repo scaffold + Bun toolchain | `DONE` | None | T1..T14 |
| `T1` Shared schema | `DONE` | T0 | T2,T3,T4,T5,T6,T7,T8,T9,T10,T11,T12,T13,T14 |
| `T2` STDB smoke | `DONE` | T0,T1 | T4,T6,T7,T8,T9,T10,T11,T12,T13,T14 |
| `T3` Graph webhook validation | `PENDING` | T0,T1,P-1,P-3 | T5,T6,T7,T8,T12 |
| `T4` Membership sync | `PENDING` | T2,P-1,P-2 | T6,T7,T9,T11,T12 |
| `T5` Encrypted payload handling (opt) | `PENDING` | T3 | T7 |
| `T6` Presence pipeline | `PENDING` | T2,T3,T4 | T9 |
| `T7` Message aggregates | `PENDING` | T2,T3,T4,T5(opt) | T9,T10,T11,T12 |
| `T8` Idempotency + delta reconcile | `PENDING` | T2,T3,T7 | I3 |
| `T9` Client live updates | `PENDING` | T2,T4,T6,T7 | T10,T11,T12,T13,T14 |
| `T10` Kiosk mode | `PENDING` | T9,T7 | T11 |
| `T11` Admin scope + privacy | `PENDING` | T2,T7,T9 | Integration |
| `T12` Personal overlays (Phase 2) | `PENDING` | T3,T4,T7,T9 | Phase 2 integration |
| `T13` Search + fast travel (Phase 2) | `PENDING` | T9 | Phase 2 integration |
| `T14` Teams tab SSO (optional) | `PENDING` | T9,P-4 | Optional release |

## Checkpoint log
- 2026-02-05 19:54:56 local: created and pushed tag `checkpoint-2026-02-05-195456`
- 2026-02-05 19:54:56 local: created and pushed branch `main-backup-2026-02-05-195456`
- 2026-02-05 19:55 local: created feature branch `codex/t0-repo-scaffold`
- 2026-02-05 local: completed `T1` with commit `2980d42`
