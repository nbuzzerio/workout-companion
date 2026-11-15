# Deployment status and rollback

These are owner-operated examples for the existing restricted SSH identity.
Replace HOST, PORT and release IDs; use its verified known_hosts and dedicated
key through your established secure process. Do not paste keys into this repo.

```sh
ssh -p PORT personal-deploy@HOST 'deploy-static status workout'
ssh -p PORT personal-deploy@HOST 'deploy-static rollback workout PREVIOUS_RELEASE'
```

The gateway accepts these helper commands, not an interactive shell. A manual
rollback validates the retained artifact and atomically switches the app symlink.
It restores static application files; it does not roll back or clear browser data.

When CI's public health check fails, read the activation result and conditional
rollback result in the Actions summary. Automatic rollback compares the failing
release to the active one under lock. If a newer deployment or manual rollback
already changed it, the automatic rollback skips rather than overwriting it.
With no previous release, inspect Nginx/TLS and the first release. If SSH is
unavailable, restore connectivity and inspect status before retrying.

For a rejected stale run, start from current production HEAD. Do not bypass the
freshness check. For storage admission failure, the owner should investigate
filesystem usage; do not lower the 3 GiB reserve as a workaround. Existing
cleanup obeys retention and protects the active/previous releases.

Nginx deep links must serve the runner while missing assets and unknown apps
return 404. `infra/nginx/personal-apps.conf` is the tested reference for the
already-installed generic routing and explicit host security-header include.
It must not replace the existing HTTPS server block. No live routing change is
part of this task.

A browser with an installed PWA may retain the old shell after a server rollback.
Reconnect and use the offered update after saving/discarding edits, or close all
Workout tabs and reopen. Do not clear site data to refresh an app: that removes
workouts and recovery drafts. Service-worker caches and IndexedDB are separate.
