# Space365 production deploy runbook (PLAN P6.3–P6.4)

Target: single Linux host (Docker) serving `space365.tpgarchitecture.com` behind Nginx
with the existing wildcard cert. SpacetimeDB self-hosted (decision D7).

## First deploy

```bash
# 1. Host prep
#    - DNS: space365.tpgarchitecture.com -> this host
#    - Copy ssl_certs/wildcard_tpgarchitecture.{crt,key,ca} to /etc/ssl/space365/
#    - Install deploy/nginx.conf into /etc/nginx/sites-enabled/, nginx -t && reload

# 2. Bring up the stack
cd deploy && docker compose up -d --build

# 3. Publish the module (from a checkout with the spacetime CLI)
spacetime server add prod --url https://space365.tpgarchitecture.com
cd spacetime/module && spacetime publish space365 --server prod --yes
spacetime lock space365 --server prod          # delete protection

# 4. Bootstrap roles (FIRST grant_role call wins admin — do this immediately
#    after first publish, before exposing the URL)
spacetime call space365 grant_role '"<your-identity-hex>"' '"admin"' --server prod
bun run scripts/setup-ingest-identity.ts        # grants 'service' to the ingest identity
spacetime call space365 admin_seed_schedules --server prod
spacetime call space365 admin_update_config '"dev_mode"' '"false"' --server prod

# 5. Build + ship the client
cd web/client-app && VITE_STDB_URI=wss://space365.tpgarchitecture.com VITE_STDB_DB=space365 bunx vite build
rsync -a dist/ host:/var/www/space365/

# 6. Initial data + real Graph subscriptions
docker compose exec ingest bun run ingest/src/main.ts --sync-once
# subscriptions: unset GRAPH_SUBSCRIPTIONS_DRY_RUN (compose file) so --serve creates real ones
```

## Verification checklist (each deploy)

- [ ] `curl https://space365.tpgarchitecture.com/healthz` → 200
- [ ] Browser loads the world; connection badge shows Live
- [ ] `spacetime logs space365 --server prod -n 50` — no PANIC lines
- [ ] `subscription_health` rows show `active` (not dry_run/failed) in the admin console
- [ ] Post a message in an allowlisted Teams channel → room glows within seconds
- [ ] Privacy spot-check: private channel absent from world for a non-member account

## Backups (P6.4) — no self-host replication exists; snapshots are the DR story

```bash
# nightly cron on the host:
docker compose stop spacetimedb    # commitlog is append-only; stop for a clean copy
tar czf /backups/stdb-$(date +%F).tgz -v /var/lib/docker/volumes/deploy_stdb-data
docker compose start spacetimedb
# retain 14 days; test restore quarterly by untarring into a scratch volume and
# running `spacetime start` against it, then `spacetime sql space365 "SELECT ..."`.
```

## Module updates

`spacetime publish` hot-swaps compatible changes without disconnecting clients.
After any update that adds schedule tables: `spacetime call space365 admin_seed_schedules --server prod`.
Incompatible schema changes: use the incremental-migration pattern
(docs/SPACETIMEDB/CAPABILITIES.md) — never `--delete-data` in prod (DB is locked anyway).

## Cert renewal (Jan 2027)

The wildcard cert is used TWICE: Nginx TLS and Graph client-credential assertion.
After renewal: replace files in /etc/ssl/space365/ AND upload the new cert to the
Entra app registration (Certificates & secrets), then update the thumbprint env/config
consumed by ingest (`ssl_certs/` mount) and restart the ingest container.
