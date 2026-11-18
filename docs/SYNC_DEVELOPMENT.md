# Local Personal Sync Service integration

All commands below run from Workout Companion. On Windows PowerShell with script execution disabled, use `pnpm.cmd` instead of `pnpm`. Only pnpm is supported.

## Requirements

- Repository-pinned Node and pnpm versions (`.node-version`, `package.json`).
- Workout dependencies installed with `pnpm install --frozen-lockfile`.
- The reviewed sibling `../personal-sync-service` with its dependencies and compiled `dist/src/` already prepared by its owner. This integration reads those modules; it does not build or modify the sibling repository.
- Chromium installed for Playwright (`pnpm exec playwright install chromium`).

If the sibling build is absent, the integration harness fails explicitly. Do not substitute production URLs, credentials, or SQLite files. Its fixed fixture path is a new directory beneath Workout's ignored `.dev/sync-tests/`, never the sibling's data directory. The backend migrations run only on these new disposable databases. Fixtures intentionally remain on disk for diagnosis; they contain synthetic data only.

## Run the app with the real disposable backend

Terminal 1:

```powershell
pnpm dev:sync-service
```

Terminal 2:

```powershell
pnpm dev --port 5174 --strictPort
```

Open `http://127.0.0.1:5174/apps/workout/` in a dedicated test profile. The synthetic owner is `synthetic-owner` and its synthetic password is `synthetic-workout-passphrase-only`. These are fixture credentials, not production credentials. Every harness launch creates a new SQLite database/owner. Retain the same harness process while testing two devices/contexts. Stop it when done.

The harness sets `NODE_ENV=test`, `PUBLIC_ORIGIN=http://127.0.0.1:5174`, binds backend port 4317 to loopback, migrates the fresh SQLite database, and invokes the actual backend HTTP app. Vite proxies `/api/v1` to `http://127.0.0.1:4317` without changing Origin. Development cookies therefore work through the frontend origin and the backend's real CSRF/Origin checks remain enabled.

Do not open `localhost:5174` with this fixture: the Origin must match exactly. The normal `pnpm dev` port 5173 requires an independently configured local backend with matching `PUBLIC_ORIGIN=http://127.0.0.1:5173`. A frontend on localhost must not authenticate directly to production. No CORS workaround is provided.

Production uses relative `/api/v1` URLs from the HTTPS page, with the existing `/apps/workout/` base, static build and service worker. The development/test service is not included in `dist/`.

## Shared interaction pattern

Family Calendar and Cookbook can use the same interaction with their own records,
consent rules and conflict comparisons. Keep one runner per app tab, mounted
whether advanced settings are open or closed.

| Header state | Meaning and action |
| --- | --- |
| Synced | The last completed pass caught up with the server and there are no queued edits or conflicts. Show its local date and time. |
| Syncing | A bounded pass is in progress. Coalesce repeated taps. |
| Changes pending | A confirmed edit is queued or catch-up still needs confirmation. The user can keep working or select **Sync**. |
| Offline | Edits stay on this device. Keep the last confirmed time visible and retry when the network returns. |
| Sign in required | Offer setup for a new browser or sign-in for an expired session. Keep the device binding and pending edits through expiry. |
| Attention needed | Link directly to the relevant setup, conflict, recovery or error details. Leave both versions available until an explicit decision. |

A confirmed save commits its outbox entry in the same local transaction. On
commit, opening the app, foreground visibility or reconnecting, wake the same
runner with a short debounce (1.5 seconds in Workout). Visible tabs also check
about once a minute. Serialize network passes across tabs under a Web Lock.
Consult the shared last confirmation before an idle poll. Cursor, directory and
acknowledgement writes refresh the UI without scheduling another pass.

**Sync** requests an immediate bounded upload and download through that runner.
It works with an empty outbox, waits up to 20 seconds for an occupied lock, and leaves conflicted
records blocked while unrelated records transfer. For each pass, Workout reads
up to eight directory pages and twelve workout exchanges. Retain the durable
cursor at a page limit. Advance the displayed success time only after a final
exchange with no outgoing writes, both streams caught up and no pending edits
or unresolved conflicts. Draft edits and local-save messages have their own
meaning and never advance that time.

Keep backup, consent, Space selection and first reconciliation in setup. An
already-connected browser restores its session on opening. Reauthentication
resumes the existing connection. An explicit pause or logout retains the
existing fresh-backup and consent requirement for reconnecting. Keep exports,
People associations, recovery, detailed comparisons and diagnostics behind the
collapsed advanced settings control. Test the pattern with independent local
devices, interrupted requests and a held clock before adopting it in another app.

## Exercise the owner workflow

1. Save a synthetic workout locally; confirm no workout exchange occurs before consent.
2. Open **Set up sync** and sign in. Create or select a personal Space.
3. Download the local JSON backup, inspect its plans/sessions, then check the consent box. The download contains a separately labelled raw recovery draft if one exists; that draft never enters the sync outbox.
4. Connect, review the downloaded counts, then reconcile. Review any same-ID collisions, including independently created sample plans.
5. Repeat in another independent browser context. Select the same existing personal Space.
6. Save offline on both, reconnect, and explicitly resolve a same-record conflict. Confirm pending data survives refresh and failed authentication.
7. Use People to create a synthetic label online and associate it with a saved plan/session. Existing multi-role associations remain intact.
8. Logout/disconnect and verify all local data remains. A paused browser needs a fresh export/confirmation to resume.

## Verification commands

```powershell
pnpm verify
pnpm test:sync
pnpm test:sync:browser
```

- `verify`: typecheck, lint, unit/component tests, infrastructure tests, production artifact/build validation and existing production PWA browser regressions.
- `test:sync`: isolated actual Express/SQLite HTTP integration tests, with independent fake IndexedDB instances and cookie jars; includes a real backup/isolated restore.
- `test:sync:browser`: starts the actual disposable backend and Vite production preview in a managed test lifecycle (run the build first); exercises independent Chromium contexts, offline edits, login/consent, conflicts, People, mobile width, service-worker offline reload/cache exclusion, and Web Locks across tabs. Both services close explicitly, avoiding Windows process-tree termination requirements.

Tests reject external transport URLs. The browser fixture reserves ports 4317 and 5174; stop manual development processes first. The production PWA regression suite uses 4173.

The existing hosted CI runs the repository-only `verify` components and never needs a live backend or production credentials. The two real-backend suites require the reviewed sibling build as a CI workspace input. This change does not add cross-repository checkout credentials, secrets or deployment steps; the owner must provision that input before adding these suites to hosted CI. They can run in an offline CI workspace once both repos and dependencies are supplied.

## Recovery and backups

Keep JSON exports outside browser storage. Settings also offers preserved copies made before reconciliation, deletion and conflict resolution. No automatic pruning is performed. A full storage device aborts the transaction instead of losing the original data.

A focused supervised recovery helper is now available below. There is no in-place merge/import UI. New exports include cached People labels, Spaces and staged snapshots; old exports may lack labels, which the helper reports. Never copy an exported device UUID/outbox into another browser to simulate a second device. New devices create their own UUID and reconcile through the service.

After a server restore, sign in again if required, let recovery download finish, then reconcile and review each missing/differing record. Keep local reissues it with a new UUID/current restored base. Keep server archives the local copy before replacement/removal. Directory labels absent from an old backup may need associations removed and a Person recreated online. Never clear IndexedDB to repair authentication or cursors.

## Tested supervised recovery from a JSON export

This procedure creates an isolated local copy for inspection. It never opens the production origin, accesses the sync backend, modifies the input export or merges into any existing database. No sibling backend is needed. Use synthetic exports for the first rehearsal.

1. Keep the original export untouched and retain an extra copy outside browser storage. A current backup contains confirmed plans/sessions, associations, directory labels, pending operations, conflicts and staged state. Older preserved snapshots may omit People labels. Download any separate preserved historical copies you also need; the current export does not recursively contain the backup store.
2. From Workout Companion, build the current static runner and start the helper:

   ```powershell
   pnpm build
   pnpm exec node scripts/recover-workout.mjs "C:\path\to\workout-backup.json"
   ```

   Use `pnpm.cmd` in Windows PowerShell if script execution is disabled. This command reads the supplied file only; it does not write that file or put its contents in `dist/`. It starts a temporary `127.0.0.1` listener on a fresh port and prints the exact local URL. It has no API proxy. Do not expose that port to a network or sign in from the recovery copy.
3. Open the printed root URL in a **fresh dedicated browser profile**, before visiting the app path. Review the record counts and any missing-Person-ID warnings. Existing databases are always refused, even empty ones; there is no force/overwrite option. If refused, use another clean profile, not a database-clear command.
4. Select **Recover into new local database** and confirm. Creation and all recovered record writes are one IndexedDB version-change transaction. A failure rolls back the whole creation; the original browser/database and file remain untouched.
5. Select **Inspect recovered workouts**. Compare the exported IDs, exercise/set values, dates, completed status and People associations with the recovered copy. Completed records remain read-only. Unknown compatible metadata and local revisions are retained. The built runner may add its normal demo plan if absent from the export; recovery itself installs only the supplied confirmed records.
6. In Settings, use **Show preserved copies** to download the original recovery source/evidence. Its raw draft, pending operations, conflicts, old device ID and cursors are retained for supervised review, but are not activated or uploaded. Drafts are never promoted into saved sessions. The live recovery database has a new device UUID, no pending server operations, no bound Space, no consent and sync disabled.
7. Download a fresh local backup after inspection and keep it outside the browser. Leave the helper terminal open while reviewing; Ctrl+C stops it. The temporary port is part of this isolated origin, so a later launch may use another origin. Retain the original export and the newly checked copy rather than relying on a temporary preview address.

This is a tested route to recover and inspect data, not an automatic route to replace a live PC/phone database. Moving reviewed data into a live profile or combining divergent exports remains a separate supervised decision. Do not paste old cursors/outbox UUIDs/device identity into live sync state. Labels absent from an older export cannot be guessed: recover them from another trusted export/directory copy before deciding on associations.

Verification exercises a genuine downloaded export, native Chromium IndexedDB, existing-database refusal, read-only completed history and zero API calls from the recovered runner. Unit tests additionally cover V1 refusal without upgrade, rollback after interrupted creation and warnings for legacy exports without directory labels.
