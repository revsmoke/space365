# Space365 — Use Cases, User Stories & Capability Roadmap

- Date: 2026-07-06 · Companion to `PRD.md` v0.5, `docs/AUTH_PLAN.md`
- Direction (Bryan, 2026-07-06): Space365 should grow into a **full office application** with
  the capabilities of **Microsoft Teams** and **Microsoft 365 Groups** in particular — the
  game world is the primary UI for real work, not just a visualization.

## 1) World legend (what each element represents)

| World element | Data source | Meaning |
|---|---|---|
| Plaza (blue disc + ring) | — | Neutral hub; world origin; org-wide objects live around it |
| Zone platform + label | Teams (Graph) | One real Team; color hashed from team id (stable forever) |
| Room building + signage | Channels | One channel; position deterministic |
| Room glow / particles | Channel message metadata | Live activity; glow decays ~2min; burst = spike/reaction storm |
| **Comms Tower ring stack** | Call records (24h) | One ring per hour; size/brightness = call minutes; hue = audio (blue) vs video (orange) |
| **Meeting portal tori** (stacked per zone) | Calendars (+OnlineMeetings) | One torus per real meeting in the organizer's team zone; faint=upcoming, pulsing=soon, spinning+beam=live |
| **Availability ring** (at feet) | Presence (live) | teal Available · orange Busy · red DND/Presenting · violet In meeting/call · gray Away |
| Standing staff figures | Directory + presence | Whole org, placed in primary team zone; disappears when that person is playing |
| Walking avatars + name plates | player_state (SpacetimeDB) | Signed-in players, real identities |
| Front Desk + ticker | Bookings | Today's appointments (idle message when none) |
| Decorative props | decoration table | Player-placed voxel props (budget 20/user) |
| Sky / lighting / motes | world_state | Real office time of day; mote density = org activity "mood" |
| Minimap dots + heat | zones + room glow | Click to fast travel; white dot = you |
| Quest board (🗒️) | mentions, meetings, Planner | Private, opt-in, server-enforced owner-only |
| Activity feed (left) | 1m aggregate windows | Real counts; click row = teleport |
| Room panel Messages | Graph delegated, on click | Ephemeral read + send AS YOU (admin-gated) |

## 2) User stories — shipping today

### Employee (P1)
- As an employee, I sign in with my Microsoft account and I *am* my avatar — my name, my
  team's zone, my quests. (MSAL → SpacetimeDB identity, auto-linked server-side)
- As an employee, I glance at the world and see **where the org is busy right now** —
  glowing rooms, burst effects, heat on the minimap — without reading a single message.
- As an employee, I walk into a hot room, read the last few real messages **on click**
  (never stored), and **reply into the actual Teams channel** without leaving the world.
- As an employee, I opt into quests and my real @mentions and next meetings appear on my
  private board with deep links that open the exact Teams thread / calendar item.
- As an employee, I see a meeting portal pulsing in my zone — starting soon — and (with
  OnlineMeetings) click through to join.
- As an employee, I see whether a colleague is Available/Busy/In-a-meeting before walking
  over (availability rings on every staff figure — live Graph presence).
- As an employee, I decorate my team's zone with props; teammates see them instantly
  (multiplayer state in SpacetimeDB).
- As a remote employee, the office still exists for me: same world, same presence, same
  activity — geography for a distributed company.

### Team lead / manager (P2)
- As a lead, I watch my team's channels as buildings: which threads burst, when the team
  goes quiet, our activity vs the neighboring zones — **momentum at a glance, zero
  individual surveillance** (aggregates only, by design).
- As a lead, the daily `most_active_zone` banner gamifies **team-level** energy
  (achievements are never individual — PRD principle).
- As a lead, I check the Comms Tower after a launch day: how much did we actually meet vs
  work? (24h call-minutes rings by modality).

### IT / security admin (P3)
- As an admin, I open `#/admin` and reshape the world live: allowlist teams/channels,
  toggle presence/aggregates/content-on-click, safe mode, pause ingest — no redeploys
  (server-gated views; verified: presence toggle removed all 188 staff avatars live).
- As an admin, I watch Graph subscription health chips (active/expiring/failed) and audit
  activity bars (Security Wing) in the same console.
- As an admin, I know private channels **cannot leak** — non-members never receive the
  rows at all (server-side views, covered by the parity suite).

### Front desk / operations
- As reception, the Front Desk ticker shows today's Bookings appointments; a kiosk in the
  lobby runs the ambient world all day with zero personal data (kiosk mode).

### New hire
- As a new hire, the onboarding tour walks me through the world, and the org chart is a
  *place*: my team is a zone I can walk to, my teammates are visible with their real names
  and availability.

## 3) Capability roadmap — "full Teams + Groups application"

Legend: ✅ shipped · 🟡 permission held, build next · 🔒 needs new permission/consent

### Teams parity
| Capability | Status | Notes |
|---|---|---|
| Browse teams/channels (spatially) | ✅ | zones/rooms |
| Live channel activity | ✅ | aggregates + glow |
| Read channel messages | ✅ | on-click ephemeral, delegated, admin-gated |
| Send channel message | ✅ | as the signed-in user |
| Reply to specific thread | 🟡 | same delegated scope; UI: thread picker in room panel |
| Reactions | 🟡 | `ChannelMessage.Send`/messages API; add react buttons to message list |
| 1:1 / group chats | 🟡 | `Chat.ReadWrite` delegated already consented-able; UI: "walk up to a person → chat" |
| Presence (read) | ✅ | org-wide rings |
| Set my presence/status message | 🔒 | `Presence.ReadWrite` delegated |
| Meetings: see/join | ✅ portals / 🟡 join links wired, needs interactive verify |
| Create meeting ("open a portal") | 🔒 | `Calendars.ReadWrite` delegated |
| Calls (start) | 🔒 | delegated calling scopes + Teams client handoff deep links (pragmatic path) |
| Notifications back into Teams | 🟡 | `TeamsActivity.Send` held (app) — achievement/quest pings |
| Team/channel creation from the world | 🔒 | `Team.Create`/`Channel.Create` held (app!) — admin "build a new wing" flow |

### Groups (M365 Groups) parity — the requested focus
| Capability | Status | Notes |
|---|---|---|
| Group directory as world geography | ✅ (teams-backed) | full Groups list needs `Group.Read.All` 🔒 |
| Group membership visibility | ✅ | rendered as zone population + access control |
| Group calendar → zone events board | 🟡 | `Calendars.Read` app-held; render zone event board next to portals |
| Group Planner → team quest board | ✅ personal / 🟡 zone-level shared board | `Tasks.Read.All` held |
| Group files/SharePoint → "library" building | 🔒 | `Files.Read.All` + `Sites.Read.All` — reserved lot exists in layout |
| Group mailbox → zone mailroom (metadata) | 🔒 | `Mail.Read` held but **group** mailbox needs `Group.Read.All`; privacy review first |
| Join/leave group from the world | 🔒 | `GroupMember.ReadWrite.All` delegated + admin policy |
| Group creation (found a new zone) | 🔒 | `Group.ReadWrite.All`; admin-gated ceremony |

### Permissions shopping list for full Groups parity (next admin-consent batch)
`Group.Read.All` (app+delegated), `GroupMember.Read.All`, `Files.Read.All`, `Sites.Read.All`,
`Presence.ReadWrite` (delegated), `Calendars.ReadWrite` (delegated), and later
`Group.ReadWrite.All`/`GroupMember.ReadWrite.All` for write flows. Each write capability gets
an admin policy toggle and an audit trail, same pattern as content-on-click.

## 4) Build order proposal (post sign-in verification)

1. **Chats** — walk up to a person → 1:1 chat panel (`Chat.ReadWrite`, already in manifest);
   the single most "full office app" feature we can ship with zero new consent.
2. **Thread replies + reactions** in the room Messages panel.
3. **Zone event board** (group calendar) + verified portal **join** links.
4. **Groups permission batch** → full group directory, files "library" buildings, shared
   zone quest boards.
5. **Write ceremonies** (create channel/team/group, join/leave) as admin-gated world
   interactions with audit.
