# Microsoft Sign-In & User Participation Plan (P2.6 + P4.9)

- Date: 2026-07-06 · Status: EXECUTING
- Goal: users sign in with their Microsoft account, exist in the world as themselves,
  and participate — read channel context and send Teams messages as their own identity.

## Spike results (verified today, before design was locked)

1. **SpacetimeDB accepts Entra-issued JWTs.** A real token minted by
   `login.microsoftonline.com` for our app (aud = our client id) was accepted by the local
   SpacetimeDB server on a reducer call (HTTP 200; garbage tokens get 401). STDB validates
   via the issuer's JWKS. No token-exchange service, no SpacetimeAuth needed.
2. **The module can read JWT claims.** `ctx.senderAuth.jwt.fullPayload` (spacetimedb 2.6 TS
   server API) exposes the full payload — including Entra's `oid` (user object id) and
   `tid` (tenant). So identity linking is automatic and server-verified.
3. **App registration updated for SPA auth** (via our own Graph Application.ReadWrite.All):
   `identifierUris = api://c0c22d69-…`, `spa.redirectUris = [http://localhost:5173,
   https://space365.tpgarchitecture.com]`, `api.requestedAccessTokenVersion = 2`.

## Architecture (one sign-in, three powers)

```
MSAL (PKCE popup) ──> Entra ID token (aud=app, iss=login.microsoftonline.com/<tid>/v2.0)
        │
        ├─ 1. SpacetimeDB connection token (DbConnection.withToken(idToken))
        │      → STDB Identity = hash(iss+sub): stable per user
        │      → module client_connected reads claims: tid must equal our tenant,
        │        oid → identity_link upsert (auto-link, server-side, unforgeable)
        │      → player avatar, quests, decorations now belong to the real person
        │
        ├─ 2. Delegated Graph access tokens (acquireTokenSilent per scope)
        │      → client-direct Graph calls (Graph supports SPA CORS):
        │        read recent channel messages on click (ephemeral, never persisted),
        │        send channel messages / replies, read own chats
        │      → deviation from SPEC's server-OBO default, deliberate: user tokens
        │        never touch our servers; policy still enforced via world_policy flags
        │
        └─ 3. Profile (User.Read): display name/photo for the account chip
```

Anonymous (no sign-in) remains allowed only when `dev_mode=true`; production rejects
tokenless connections at the module (`client_connected` throws).

## Delegated scopes (incremental consent)

| Scope | Purpose | Admin consent? |
|---|---|---|
| `User.Read` | profile chip | no (already granted) |
| `Team.ReadBasic.All`, `Channel.ReadBasic.All` | validate deep links | no |
| `ChannelMessage.Send` | send messages to channels | no |
| `Chat.ReadWrite` | read/send own 1:1 & group chats | no |
| `ChannelMessage.Read.All` | content-on-click (read recent channel messages) | **YES — Bryan: one click in portal** |
| `Presence.Read` | own presence for self-view | no |

Added to the app's requiredResourceAccess so the portal shows a single consent surface.
Content-on-click additionally requires the admin toggle `allow_content_on_click=true`
(off by default per PRD; the UI hides the feature when off).

## Work items

1. **Module** — `client_connected`: tenant validation + auto-link from claims; config key
   `tenant_id`; keep dev anonymous path behind `dev_mode`. Parity-safe (test db uses
   anonymous identities with dev_mode on).
2. **App registration** — add the delegated scopes above to requiredResourceAccess (done
   via Graph); Bryan grants admin consent for `ChannelMessage.Read.All` in the portal.
3. **Client** — `@azure/msal-browser`; `src/auth.ts` (PCA, loginPopup, acquireTokenSilent,
   ID-token provider for STDB reconnects); stdb.ts uses the ID token when signed in;
   TopBar sign-in button + account chip; QuestPanel drops the dev-link input when signed
   in (auto-linked); RoomPanel gains **Messages**: on-click ephemeral fetch of the last ~10
   messages (only when `allow_content_on_click` and signed in) + composer to send into the
   channel via `ChannelMessage.Send`; consent errors surface as a "Grant access" button
   (popup re-consent).
4. **Verification** — build + typecheck headless; interactive sign-in E2E is Bryan's
   5-minute checklist at the bottom of this doc.

## Bryan's interactive checklist (the parts a headless agent cannot click)

- [ ] Entra portal → app → API permissions → **Grant admin consent** (covers ChannelMessage.Read.All)
- [ ] `http://localhost:5173` → Sign in with Microsoft → popup completes
- [ ] Your name appears in the top bar; your avatar name plate is your display name
- [ ] Quest board shows your real mentions (opt-in toggle on)
- [ ] Click a room → Messages → recent messages render (and are gone on reload — never stored)
- [ ] Type a message → Send → verify it lands in the real Teams channel as YOU
