# Workout Companion

A local-first React + TypeScript workout runner, deployed as static files at
**https://www.nickbuzzerio.com/apps/workout/**. No runtime Node server or paid API
is required. W-01 and W01-02 are already integrated on `main`.

The existing Monday DEMO plan, typed weight/reps, machine positions, timed sets,
date-based sessions, previous completed performance, draft recovery, explicit
save/completion confirmation, saved history and responsive styling are retained.
Other weekdays currently show no plan. Imports and cloud backup are not implemented.

## Local development

Use Node **24.18.0** and pnpm **11.9.0**. Only pnpm is used for dependencies
and scripts; no Python installation is required.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:5173/apps/workout/`. The development server does not enable
service workers. `config/app.ts` validates the app ID, production base path,
existing database identity and local-first defaults.

```sh
pnpm exec playwright install chromium
pnpm verify
pnpm preview --host 127.0.0.1
```

Open `http://127.0.0.1:4173/apps/workout/` to test the built PWA. `pnpm verify`
runs typechecking, lint, unit/component/storage tests, infrastructure tests,
production build, SHA-256 artifact validation and Chromium workflows. Linux
release-operation tests skip on Windows; run `pnpm test:infra` under Linux with
rsync and util-linux `flock` to cover them. These are deployment tools, not app servers.
`pnpm test:nginx` additionally needs Linux and Docker, or use
`pnpm test:nginx --nginx /path/to/nginx` with an isolated local Nginx binary.
It exercises the actual Nginx include with the built artifact. CI runs both
on GitHub-hosted Ubuntu. Optional GitHub onboarding uses Windows PowerShell;
its offline suite runs inside `test:infra` on Windows.

Other commands: `pnpm app:config`, `pnpm test`, `pnpm test:e2e`, `pnpm build`.
Build first when running `test:e2e` separately. `pnpm validate:artifact` rechecks
an existing build. The output is exclusively `dist/`.
See [Node-only migration and verification](docs/NODE_ONLY_MIGRATION.md) for the
coverage comparison, environment proof and Studio follow-up.

## Offline and local data

IndexedDB **workout-companion**, version **2**, holds confirmed plans, sessions
and the durable sync outbox. Draft recovery uses `workout-companion-draft-v1`.
Only confirmed saves enter synchronization.

Storage belongs to the browser profile and origin, so localhost, another browser,
and the production HTTPS origin do not share records. Moving to the production
URL cannot automatically transfer data from another origin. Clearing browser
storage, private browsing, eviction or device loss can remove local data. Download
a local backup from **Advanced sync settings** to keep a copy outside the browser.

After one successful online installation the service worker caches the app shell
under `/apps/workout/`. Offline deep links load the same existing runner; this
integration does not add route-specific screens. Workouts can be edited and saved
offline. Updates wait for an explicit reload; save or discard edits first.

## Deployment

The GitHub workflow defaults to **CI only**. Deployment requires the repository
variable `ENABLE_DEPLOYMENT` to be exactly the case-sensitive text `true`, the
production branch, a supported event, successful checks and the production
environment. This task does not set that variable or enable deployment.

See [deployment setup and release protocol](docs/deployment.md),
[status and rollback](docs/troubleshooting.md), and
[integration decisions and verification](docs/deployment-integration.md).
The server infrastructure is already provisioned; do not rerun bootstrap.

## Synchronization

Workout restores the shared household session automatically. If sign-in is needed, enter the household password in **Advanced sync settings**. The backend must be released first. [Household authentication release report](docs/HOUSEHOLD_AUTH_V1.md)

Use **Set up sync** in the header to choose a personal Space, check a
backup and review the first download. Once connected, confirmed saves, opening
the app, returning to it and reconnecting trigger automatic two-way sync.
The header **Sync** button runs a pass immediately. **Review conflicts** leads
to the saved copies that need a decision. Setup, account controls, People,
downloads and diagnostics are in **Advanced sync settings**.

See the [interaction pattern for personal apps](docs/SYNC_DEVELOPMENT.md#shared-interaction-pattern)
and the [implemented exchange contract](docs/sync-contract.md).

The owner controls Git staging, commits, merges and pushes. Future ideas in
[the product brief](docs/PRODUCT_BRIEF.md) are outside this integration's scope.

[Windows GitHub deployment onboarding](docs/github-onboarding.md) configures
repository variables and an exact production-branch environment with deployment
disabled. Add only `DEPLOY_SSH_KEY` manually, then separately opt in after review.
