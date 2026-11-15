# Deployment setup and release protocol

Production: **https://www.nickbuzzerio.com/apps/workout/**. The validated
`config/app.ts` supplies `workout`, `/apps/workout/`, and the existing database
name. The frontend is static; GitHub builds it and the Droplet serves `dist/`.
Nothing in this integration changes the live Droplet or its existing site.

## Owner-controlled GitHub setup

1. Review and commit the integration, then run the workflow with deployment
   disabled. Require the `check` job in branch protection.
2. Create the **production** environment and restrict it to the production
   branch. Add required reviewers if appropriate.
3. Set repository variable `PUBLIC_ORIGIN` to `https://www.nickbuzzerio.com`
   without a trailing slash or path. `PRODUCTION_BRANCH` defaults to `main`;
   set it only if the intended production branch differs.
4. Supply the existing dedicated deployment credentials as production
   **environment secrets** using the table below. Keep keys out of source,
   frontend variables, logs and artifacts.
5. Only after CI and owner review, opt in by setting repository variable
   `ENABLE_DEPLOYMENT` to exactly `true`. Keep it absent/false until then; this
   task does not inspect or change GitHub variables or settings.

| Secret | Required value |
| --- | --- |
| `DEPLOY_HOST` | Droplet DNS name or IPv4 address, without protocol/user/path |
| `DEPLOY_PORT` | SSH port; empty defaults to `22` |
| `DEPLOY_USER` | Exactly `personal-deploy` |
| `DEPLOY_SSH_KEY` | Existing dedicated restricted private key |
| `DEPLOY_KNOWN_HOSTS` | Independently verified OpenSSH known_hosts entry for the host/port |

Do not configure these secrets during this task. Verify host keys through a
trusted existing administrative channel; an unauthenticated `ssh-keyscan`
result alone is insufficient. A nonstandard port needs `[HOST]:PORT` format.
IPv6 literals are unsupported by the workflow; use a DNS hostname.

Missing, empty, `false`, `True`, `TRUE`, whitespace and all other opt-in values
disable the deploy job. The Python policy is deliberately case-sensitive.
Push, pull request and manual runs always run CI. Only pushes and manual runs
on the exact production branch may deploy; PRs never receive deployment secrets.
Opt-in does not bypass CI, environment protection or branch freshness. Removing
the variable prevents future jobs; it does not cancel an already-running job.

## Checks and immutable artifact

The hosted Ubuntu `check` job installs frozen pnpm dependencies, lints,
typechecks, tests Workout and the deployment helpers, builds and validates the
release, runs Chromium against the production PWA, and exercises actual Nginx
routing in a disposable Docker container. The `deploy` job downloads that exact
artifact and never rebuilds it. Node 24.18.0 and pnpm 11.9.0 are pinned.

`release.json` contains format version 1, app ID, base path, release ID and
SHA-256 hashes for every other file. CI release IDs combine commit SHA, run ID
and attempt; local builds use `local`. The unchanged server validator checks
identity, exact inventory, hashes, HTML asset prefixes and PWA scope. It rejects
dotfiles, special files, symlinks, more than 10,000 files or releases over 100 MiB.
This authenticates integrity over trusted SSH; it is not code signing.

## Existing deployment protocol

Only `dist/` is uploaded with `rsync -rt --delete` to the restricted
`/srv/personal-apps/incoming/workout/RELEASE/` path. The forced-command gateway
permits only the existing rsync/helper command forms. Strict host-key checking
and the dedicated identity are required; neither arbitrary shell nor sudo is used.

After upload, inside serialized deployment concurrency, the workflow queries
the remote production branch HEAD immediately before activation. Mismatches
and API errors fail closed, including reruns. The helper snapshots and validates
the upload, publishes an immutable release, then atomically switches the app
symlink. A global server lock coordinates uploads, activation, rollback and
cleanup across repositories. The server never executes the frontend build.

The existing reserve remains 3 GiB plus conservative operation headroom and
free-inode admission checks. It is admission control, not a hard upload quota.
Retention remains five releases, protecting the active and actual previous
releases. Existing release IDs cannot be overwritten. These policies and the
restricted SSH parser are copied unchanged from the local template.

The HTTPS health check must return the exact app ID and release ID from public
`release.json`. On failure, CI attempts `rollback-if-current` to the previous
release. The helper compares the current release under its lock and skips the
rollback if another activation or owner rollback intervened. A first deployment
has no previous release and stays active for diagnosis. An SSH disconnect can
leave activation uncertain; inspect status before taking further action.

See [status and rollback](troubleshooting.md). The `infra/` copies are testable
protocol references, not instructions to reinstall or change the live host.
