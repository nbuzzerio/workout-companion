# Workout deployment onboarding and release protocol

Production remains **https://www.nickbuzzerio.com/apps/workout/**. App identity
stays `workout`, `/apps/workout/`, and IndexedDB `workout-companion`. No frontend,
storage, migration, or live Droplet changes are part of onboarding.

Follow the [Windows onboarding guide](github-onboarding.md) for the exact
`Initialize-WorkoutDeployment.ps1` command. It requires the confirmed SSH hostname
and port, prompts for a temporary GitHub API token, configures the production
environment and repository variables, and leaves `ENABLE_DEPLOYMENT=false`.
The wrapper pins repository `nbuzzerio/workout-companion`, slug `workout`, origin
`https://www.nickbuzzerio.com`, branch `main`, user `personal-deploy`, and the
owner-verified ED25519 fingerprint
`SHA256:n7iJc5pZSQW+qDGbDpkIOL0ipHwNSyWoujgL3+YE3y0`.

## Configuration and owner review

Use repository **variables** `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`,
`DEPLOY_HOST_FINGERPRINT`, `PUBLIC_ORIGIN`, `PRODUCTION_BRANCH` and
`ENABLE_DEPLOYMENT`. Port has no default; the web hostname does not establish
the SSH hostname. Only `DEPLOY_SSH_KEY` remains a deployment **secret**, entered
manually by the owner under the production environment. The script never reads,
prints, stores or uploads a private key and never accesses the secrets API.

The workflow discovers only the public ED25519 host key and compares its SHA256
fingerprint against the independently established pin. Missing, incorrect,
malformed or ambiguous results fail before upload. No stored known_hosts secret
is used. SSH, rsync and activation/rollback use `StrictHostKeyChecking=yes`,
ED25519 only and the verified known_hosts file; global trust files are disabled.

The production environment permits exactly `main` as a branch, without wildcard
or tag policies. Existing reviewers, timers and custom rules are preserved.
Protect the branch and require `check`. After owner review, a commit/push and
passing CI, use the separate `-EnableDeployment` command in the guide. This task
does not configure GitHub, add secrets, enable deployment, commit or push.

Missing, empty, `false`, `True`, `TRUE`, whitespace and every value other than
exact lowercase `true` disable the deploy job. Rerunning setup always disables
deployment. Push, PR and manual runs still run CI; only a push or manual run on
the exact production ref can deploy. Opt-in never bypasses CI, environment
protection or branch freshness. Disabling does not cancel already-admitted jobs.

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
