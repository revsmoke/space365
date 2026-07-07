# Space365 Teams app package (T14 + TeamsActivity.Send enabler)

Packaging Space365 as a Teams app unlocks two parity-matrix items:

1. **Teams tab embedding** — the world inside Teams (static personal tab pointing at prod).
2. **`TeamsActivity.Send` back-propagation** — the sendActivityNotification API requires the
   Teams app to be installed for the recipient (team or user). Once this package is uploaded
   and installed, the ingest service can push achievement/quest pings into the Teams
   activity feed (app role already consented).

## Build the package

```bash
# icons: color.png (192x192) and outline.png (32x32, transparent) are required by Teams.
# Placeholder generation (solid brand-blue square + simple outline):
python3 deploy/teams-app/make_icons.py
cd deploy/teams-app && zip space365-teams-app.zip manifest.json color.png outline.png
```

## Install (tenant admin)

Teams admin center → Teams apps → Manage apps → Upload new app → `space365-teams-app.zip`,
then add it to the pilot team(s). For tab SSO later: the `webApplicationInfo.resource`
URI (`api://space365.tpgarchitecture.com/<clientid>`) must also be added to the Entra app's
Application ID URIs and the `access_as_user` scope exposed — tracked in docs/AUTH_PLAN.md.

Note: the tab requires the production URL to be live (Teams cannot load localhost).
