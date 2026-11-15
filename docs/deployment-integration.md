# Personal App Template integration review

Reviewed on 2026-11-15. **READY for an owner-controlled integration commit**,
with hosted Nginx/Actions checks still required before production deployment.
No live deployment was attempted or enabled by this task.

## Inspection and decisions

The initial checkout was clean on `main`, commit `b452be8`. Git listed one local
branch and one registered worktree. History includes `9a3b231` (W-01 storage),
`5b5c3fe` (workout runner) and the subsequent owner-feedback fixes. W-01 is
present in this checkout; no merge or Studio worktree modification is needed.
The old README described the baseline and is now corrected. Historical W-01
checkpoint documents remain historical; the executed results below supersede
their earlier NOT_RUN verification notes.

Workout remains the authoritative app. Its model, runner, screens, existing
tests, styles, persistence methods, record validation, local drafts, confirmations
and read-only completed sessions are retained. The only runner integration is
the PWA status/update component. All existing preferences/storage keys are left
alone. The template's sample journal UI, Dexie database, backup implementation,
sample record schema and Tailwind styling are not imported.

The workflow, deployment policy/freshness scripts, release packager, restricted
SSH parser, release manager, storage guard, Nginx reference and Python deployment
tests are reused. All 13 copied protocol/workflow files were verified
byte-identical to the template. Configuration, Vite/PWA, toolchain scripts and browser tests
are adapted to Workout. No bootstrap script is added because the host already
has the shared infrastructure. Node/pnpm are pinned to the template toolchain;
existing React/TypeScript/Vite versions remain resolved by the Workout lockfile.

No data migration is needed: IndexedDB stays `workout-companion`, version 1,
with `plans`/`sessions` keyed by `id`. The existing draft key stays
`workout-companion-draft-v1`. The default opener now obtains the same database
name from validated central configuration. No stores or records are cleared,
renamed or converted. Legacy fixtures include non-demo completed history,
weights, positions, holds, revisions and raw muscle metadata. They reopen
unchanged in deterministic and native-browser tests. Existing ensurePlan
behavior does not overwrite an existing plan.

The deployment URL has a fixed `/apps/workout/` asset prefix and scoped manifest,
worker, offline fallback and cache identity. Deep links load the current runner;
there are no new route-specific product screens. The worker waits for explicit
update activation, and the runner blocks update reload while loading, saving,
holding unsaved edits or unable to recover a draft. Partial machine-position
text is included in that guard. Sync remains literal false with a type-only
future Plan/Session envelope; no network data transport or backend is added.

## Executed verification

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed |
| `pnpm verify` | Passed: typecheck, lint, 20 unit/component/storage tests, infrastructure suite, production build/integrity validation, 4 Chromium scenarios |
| Windows infrastructure suite | 25 discovered; 13 passed, 12 explicit POSIX skips |
| Local Ubuntu: `python3 -m unittest discover -s infra/tests -v` | All 25 passed, including actual rsync protocol, flock, atomic activation, conditional rollback, retention, storage failure and stale-run handling |
| Production artifact | `/apps/workout/` asset URLs; scoped PWA manifest; full inventory SHA-256 validation passed using unchanged server validator |
| Chromium | Native IDB reopen and legacy compatibility, save/reopen/complete, machine validation, weekday navigation, draft reload, fresh offline deep link, offline save/reload, sibling scope isolation, no API requests, actual waiting-worker update after save |
| Visual inspection | Generated desktop/mobile screenshots; existing runner styling retained and mobile overflow assertion passed |
| Source template | Left unchanged; Git status clean |

The preview host was made explicitly `127.0.0.1` to match the browser test URL;
the earlier localhost-bound startup timed out. The final full suite passes.
Vitest stubs service-worker registration in jsdom; real Chromium separately
tests native registration and a real waiting worker. IndexedDB deterministic
tests use test-only fake-indexeddb and no longer silently skip in jsdom.

## Remaining checks and limitations

Local Ubuntu has Python and rsync but no Nginx or Docker. The actual Nginx
container integration test could not run locally. The copied hosted workflow
requires it against the built artifact, testing deep links, asset/unknown-app
404s, cache policy and existing-site security headers. Hosted GitHub Actions
itself has not been run. No real SSH upload, public health-check failure or live
rollback is exercised; those protocols have local deterministic/Linux coverage.

Browser storage remains origin/profile-specific. Existing localhost or other
origin records do not transfer automatically to the production HTTPS origin.
There is no existing import/export or cloud backup feature to copy from the
template. This integration preserves records in place; it does not reset them
or pretend to provide cross-origin transfer/sync. Owner GitHub environment,
variables, verified secrets and a successful hosted CI run remain prerequisites
for production; see [deployment setup](deployment.md).

## Exact source file inventory

Modified:

```text
.gitignore
README.md
package.json
pnpm-lock.yaml
src/App.tsx
src/storage.test.ts
src/storage.ts
tsconfig.app.json
tsconfig.node.json
vite.config.ts
```

Added:

```text
.github/workflows/ci-deploy.yml
.node-version
.nvmrc
config/app.test.ts
config/app.ts
docs/deployment-integration.md
docs/deployment.md
docs/sync-contract.md
docs/troubleshooting.md
infra/deploy_static.py
infra/nginx/personal-apps.conf
infra/ssh_gateway.py
infra/storage_guard.py
infra/tests/nginx_integration.py
infra/tests/test_corrections.py
infra/tests/test_deploy.py
infra/tests/test_readiness.py
playwright.config.ts
public/icon-192.png
public/icon-512.png
scripts/activate_checked.py
scripts/config.ts
scripts/deployment_policy.py
scripts/release.ts
scripts/validate_artifact.py
src/PwaStatus.test.tsx
src/PwaStatus.tsx
src/sync.ts
tests/e2e/workout.spec.ts
tests/setup.ts
```

Generated `dist/`, test reports/screenshots, caches and dependencies are ignored.
All source changes are unstaged and uncommitted. No Git branch, worktree, remote,
secret, repository setting, SSH key or live Droplet configuration was changed.
