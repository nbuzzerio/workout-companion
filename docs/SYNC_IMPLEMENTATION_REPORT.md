# Personal Sync Service V1 implementation report

Date: November 17, 2026 (America/New_York).

## Readiness

| Status | Result |
| --- | --- |
| IMPLEMENTED | Yes: opt-in authentication, personal Space setup, durable local outbox, two-way exchange, conflict/recovery review, People associations, exports, foreground retries and multi-tab coordination. Details and limitations below. |
| TESTED LOCALLY | Yes: 42 unit/component tests, 11 actual HTTP/SQLite integration tests, 7 sync browser scenarios, 4 existing production/PWA browser scenarios, and 26 infrastructure tests passed. 13 existing infrastructure tests are platform-skipped on Windows. |
| HUMAN QA PENDING | Yes: physical PC/phone usability, Safari/iOS installation and lifecycle, actual owner workflows and large histories. |
| READY TO COMMIT | Locally verified and prepared for owner review/commit. All source changes remain unstaged and uncommitted. |
| READY TO DEPLOY | Not approved. Complete owner review and the human checklist before the owner uses the existing deployment workflow. |
| READY TO ENABLE REAL-DATA SYNC | Not yet. Explicit owner consent, a successfully downloaded/checked real backup, and owner verification of conflict/restore behavior remain required. No existing browser is automatically opted in. |

No Git commands, staging, commits, branches, worktrees, merges, pushes or deployment operations were performed. The sibling backend was read only. No Droplet, Nginx, production database or production API changes were made. No real workout data was accessed or uploaded. Existing-history preservation was verified with populated V1 fixtures; no real browser history was opened or migrated by this implementation session.

## Targeted hardening findings (November 17, 2026)

This section supersedes the earlier unmeasured multi-tab traffic assumption and the earlier claim that exports already contained all directory recovery context.

**Confirmed defects:**

1. Every readwrite transaction broadcast the same notice. Two idle tabs woke each other after cursor/ACK/common-directory writes. A real Chromium/real local backend test recorded **17 requests in 12 seconds** after startup settling: 8 workout exchanges, 8 common-directory calls and 1 session lookup, repeating about every 1.5 seconds. Web Locks prevented overlap but did not prevent this sequential loop.
2. Export snapshots omitted cached People/Spaces and staged reconciliation state. Association IDs were present but Person names could be lost. No explicit tested recovery procedure had been supplied.
3. Pause only aborted the initiating tab's API client. A different tab could process a late accepted response because page application did not check paused state. There was also an asynchronous gap between batch preparation and dispatch.

**Focused corrections:**

- Transaction-scoped `local`, `control` and `refresh` notices. Enqueue marks a meaningful local mutation; aborted transactions emit nothing. Views still refresh across tabs, while the engine ignores bookkeeping notifications. Local saves, foreground/reconnect catch-up, normal minute polling and Web Locks remain.
- Persistent `controlVersion`, incremented on pause/enable, with a durable pre-dispatch check and transactional checks when applying ACKs, staged snapshots and common pages. Other listening tabs abort their requests on pause. Old-generation responses cannot consume pending edits even if a notification is missed or the user reconnects immediately. Cancellation does not produce a misleading retry error. Signing back in explicitly resumes an already-consented connection; login without consent remains inactive.
- Export format 2 includes full cached People and Spaces (including compatible extra fields), staged snapshots, existing records/associations/queues/conflicts/settings and the separately labelled raw draft. Older exports are accepted by the recovery helper, with explicit warnings for association IDs lacking labels. Previously saved preserved copies are separate snapshots: download any additional historical copy needed; the current export does not recursively bundle the entire backup store.
- `scripts/recover-workout.mjs` validates the input without normalizing its payloads and serves a private recovery page plus the existing built runner on a fresh loopback origin. It has no API proxy, no CORS and no production connection. Recovery atomically creates a new database only, preserves confirmed payloads/IDs/revisions and People associations, allocates a fresh device UUID, disables sync, and leaves old operations/cursors/consent/drafts in a preserved source artifact rather than activating them. Existing databases, including V1 and empty V2 databases, are refused. Partial creation rolls back. The input file and original browser remain unchanged. Detailed tested commands are in `SYNC_DEVELOPMENT.md`.

**New evidence:**

- The same idle test now records **0 requests in 12 seconds**, followed by prompt automatic upload after a confirmed save, cross-tab UI refresh, and **0 requests in a further 6-second post-save idle window**. These windows deliberately exclude the intended roughly minute-long polling cadence.
- Browser login and restored authentication without consent: zero common/workout exchanges; durable pending operations unchanged.
- The real backend accepts a held write from tab A; tab B pauses. The pending UUID/content survives cancellation, page reload and resume, and the server version remains `1` after replay. A separate real HTTP/SQLite test deliberately omits the abort listener to prove the durable generation guard alone protects late responses.
- A persistent Chromium browser process closes and restarts with offline edits. The same outbox survives restart and a revoked/expired session, then uploads after sign-in. Existing offline reload/reconnection tests remain.
- A real downloaded JSON export is recovered on a separate origin: plans, sessions, completed status, People labels and associations match; original source evidence is retained; old queue/consent/device identity is not activated; a second recovery attempt refuses the existing database. The recovered runner works and makes no API requests. Unit tests additionally prove V1 refusal, interrupted-creation rollback and old-export label warnings.

**Files changed in this hardening pass (only):**

- `src/database.ts`, `src/sync-engine.ts`, `src/sync-store.ts`, `src/sync-api.ts`, `src/SyncPanel.tsx`, `src/sync.test.ts`
- `tests/integration/sync.test.ts`, `tests/sync-browser/sync.spec.ts`
- Added `scripts/recover-workout.mjs`, `scripts/recover-workout.d.mts`
- `docs/SYNC_IMPLEMENTATION_REPORT.md`, `docs/SYNC_DEVELOPMENT.md`, `docs/sync-contract.md`

**Final hardening verification:** `pnpm verify`, `pnpm test:sync` and `pnpm test:sync:browser` all passed: 42 unit/component, 11 real HTTP/SQLite, 7 sync browser, 4 original PWA browser and 26 infrastructure tests (90 passes total); 13 existing Windows platform skips. Typecheck/lint were also rechecked after the final helper/test adjustment.

**Ready for Human QA:** Yes, following the successful verification below. Close/reload older-version tabs before review. This is not approval to deploy or enable real-data sync. Pause cannot undo an operation already accepted by the server; it preserves the pending retry identity. Recovery creates an isolated review copy, not an automatic merge into a live database. Physical-phone/Safari QA, the legacy shared draft slot, large-history/quota testing and hosted-CI provisioning remain open. No Git operations, backend changes, production access or real-data uploads occurred in this pass.

## 1. Existing architecture inspected

The application was a static React + TypeScript + Vite frontend deployed under `/apps/workout/`. `SessionStore` opened IndexedDB `workout-companion` version 1, with `plans` and `sessions` keyed by stable `id`. Saves enforced local optimistic `Session.revision`, immutable plan/date identity during edits and completed-session read-only behavior. Plans and sessions contain complete exercise/set snapshots, including weight, machine-position and timed-hold performance.

`App.tsx` presented a demo Monday runner with explicit save/complete confirmation, date/history selection, previous completed performance and a separate localStorage draft under `workout-companion-draft-v1`. There was no usable data export/import or implemented network transport. `src/sync.ts` was a future interface only. The PWA used scoped precaching and no runtime API cache. Existing tests covered deterministic transformations, IndexedDB behavior, runner controls, native V1 preservation, offline navigation and update deferral for unsaved drafts.

Backend references inspected: `docs/SYNC_PROTOCOL.md`, `docs/API.md`, `docs/NEXT_STEPS.md`, `docs/DATABASE.md`, `src/contracts.ts`, `src/sync/exchange.ts`, `src/http/app.ts`, configuration/database/auth implementations and relevant sync/database/HTTP fixture tests. The actual existing compiled backend was used read-only in isolated integration tests.

## 2. Additive IndexedDB migration

`src/database.ts` opens schema version 2. The version-change transaction retains original stores, records, IDs and payloads, and adds:

| Store | Purpose |
| --- | --- |
| `syncSettings` | Stable device UUID, consent/enabled state, bound owner/Space, app/common/staging cursors, retry status, last exchange time and durable directory-create intents |
| `syncMeta` | Record-kind/ID key, server version, exact downloaded snapshot, associations and deletion metadata |
| `syncOutbox` | Immutable operation/intent UUIDs, complete local snapshots and predecessor links |
| `syncConflicts` | Durable local/server comparison, cause, associations and a comparison-generation token |
| `syncRemote` | Separate complete-snapshot reconstruction for first connection and cursor recovery |
| `syncBackups` | Exportable copies before opt-in, reconciliation, deletion and conflict resolution |
| `syncPeople`, `syncSpaces` | Cached replicated directory entities |

The device UUID and initial disabled settings commit with the schema upgrade. Records are not rewritten or preemptively uploaded during migration. Existing V1 records without outbox entries are discovered during explicit initial reconciliation. Upgrade failure rolls back both DDL and data. Repeated initialization retains identity. Open connections close on version change; blocked upgrades explain that other tabs must close and retry. No failure path deletes the database.

Confirmed saves and their outbox entries commit together, requesting strict IndexedDB durability. The same applies to association changes and explicit deletions. Full-page application and cursor advancement are one transaction. Storage failure therefore retains both pending data and the old cursor. Transactions contain IndexedDB work only, never network awaits.

## 3. Backend protocol mapping and actual mismatches

The old nested `record:{kind,value}` interface was not wire-compatible. The implementation replaces it with protocol V1, explicit `type`, `kind`, `recordId`, schema version, personal Space, People list, resurrection flag, ordered results, bounded pages and `hasMore`.

- Production requests use `/api/v1/...`, not an absolute production host or Droplet IP.
- Exchange is `POST /api/v1/apps/workout/exchange`, with `protocolVersion:1`, `appId:"workout"`, persistent device UUID, selected Space, opaque cursor and limit 25.
- Puts contain all required payload/association fields. Deletes contain only required deletion fields.
- Server versions are positive decimal strings; local session revisions never become server bases.
- Runtime schemas reject unsupported protocol/schema or malformed downloaded known fields before applying a page. Compatible unknown nested payload metadata remains intact.
- Auth `expiresAt` is a numeric epoch timestamp in the actual implementation, not an ISO date string.
- A write acknowledged during a continuing fixed-ceiling page may be absent from that page. Accepted versions and download progress are handled separately, with an additional catch-up cycle.
- Frozen conflict/rejection results remain immutable; subsequent choices receive new operation UUIDs.

`config/app.ts` still prohibits build-time opt-in and no longer contains the legacy absolute endpoint value. Consent is browser-local persistent state, not a Vite secret or deployment flag.

## 4. Authentication

`SyncApi` implements login, session restoration and logout using same-origin browser cookies. CSRF is held in memory, reacquired after reload and attached to mutations. Forms clear password input immediately after submission; passwords are never written to IndexedDB, localStorage, sessionStorage, configuration or logs. There is no registration or account-management system.

Fetch uses credentials, no-store caching, redirect rejection and a 20-second abort timeout. Invalid credentials, expired sessions, CSRF failure and unavailable services produce visible feedback without deleting history or outbox entries. Logout first pauses this browser's sync; a failed server logout is reported and cannot be mistaken for successful server revocation. A database already bound to an owner cannot connect to another owner or Space.

## 5. Offline outbox

Each confirmed mutation stores a full immutable intent snapshot and UUID. The first operation for an identity is materialized against the known server version. Later intents wait behind their predecessor: after its acknowledgement they are materialized exactly once against that acknowledgement's version. This prevents assigning later saves a guessed base or modifying an operation already submitted.

Retries reuse identical operation structures, UUIDs, device and Space. The queued chain survives refresh, HTTP failure, logout, session expiry and cursor reset. A durable control generation plus transactional response checks protects it when an in-flight response arrives after pause or pause/reconnect. Pause aborts requests across listening tabs; requests already dispatched may still have been accepted by the server, so pending UUIDs are retained for idempotent replay on explicit resume. Accepted operations alone leave the active queue; explicit conflict choices preserve superseded queues in backups. Oversized legacy payloads stay local with an actionable review item and do not block unrelated records.

Recovery drafts are never included in the outbox. Export includes a separately identified raw draft only for independent recovery.

## 6. Synchronization algorithm and scheduling

A Web Lock coordinates whole passes across tabs. The engine checks durable enabled state, selected Space, backoff and session/owner identity, then replicates common directory changes and exchanges workout operations. A pass is bounded to 8 common pages and 12 workout pages, with at most 16 operations/approximately 750 KB per request. More work resumes from durable progress.

Accepted results, queued successors, monotonic server metadata, ordered downloaded changes and the resulting cursor commit atomically. Older downloaded versions cannot overwrite a later acknowledgement. Remote payloads cannot replace pending local edits. Exact server snapshots remain separate from local revision counters. When a downloaded session replaces an existing one, its local concurrency revision advances so a stale open editor cannot silently save over it. Completed payload changes require review.

Foreground polling is approximately once per minute, with debounced local-save/online/visibility triggers. Only committed local outbox mutations and explicit enable controls wake upload scheduling. Cursor, acknowledgement, directory, retry and export bookkeeping sends UI refresh notices only; it cannot cause a cross-tab echo. Local work arriving during a pass retains a follow-up wake request. Exponential backoff grows from 4 seconds to 5 minutes, honoring a longer Retry-After. Hidden tabs do not automatically poll. App restart reacquires authentication and resumes durable work. Closed browsers do not make network progress; their work resumes on reopening. No Background Sync dependency exists.

## 7. Conflicts and deletion

The Settings panel displays local/server JSON, changed top-level fields, record date/name, associations, server device and conflict cause. A comparison-generation token prevents acting on a stale UI after another local save/download changes the comparison.

Keep server and keep local each require confirmation and archive a complete copy first. Keep local submits a new UUID against the displayed server version, with explicit resurrection for tombstones. If the server changes again, the new operation conflicts again rather than overwriting a newer revision. Leaving the item unresolved is the cancel/revisit path. Other records continue synchronizing.

Explicit deletion is available for a selected saved record, with confirmation and a preserved copy. Deleting a plan never cascades to sessions. Remote deletion of a locally present record requires review. Demo initialization cannot recreate a known deleted plan. Completed workout performance remains read-only in the runner; People associations can be edited separately.

No automatic last-write-wins or manual field-level merge is implemented.

## 8. Server restore / cursor recovery

`CURSOR_RESET_REQUIRED` preserves local records, old metadata and the entire pending queue, creates a backup and starts fresh download into `syncRemote`. Only complete staged state can be reconciled, after an explicit review action.

Previously acknowledged records absent from the restored database, pending changes and divergent values become individual conflict/recovery items. Absence never triggers automatic local deletion. Keep local creates a new operation with the restored base; keep server archives the local copy before replacement/removal. The old acknowledgement evidence is retained in preserved copies. Common-directory cursors reset independently.

The integration suite performs a real backend SQLite backup and isolated restore, proves session revocation/cursor invalidation, retains an acknowledged record missing from the restore plus an unsent completed session, and explicitly reissues both. This is not a production restore test. Off-server backend backups remain deferred and were not changed.

## 9. People and Spaces

The UI browses paginated People/Spaces, creates People online, and chooses only active personal Spaces. Shared Family Calendar Spaces are excluded. Selected Space and owner persist across reconnects; login alone never uploads workouts.

Directory-create intent UUIDs are allocated transactionally across tabs. Lost create responses are recovered by UUID lookup, including ID_EXISTS races. The initial Space-create intent remains persistent so repeated setup does not silently create duplicate Spaces. People are domain labels, not authenticated accounts. Multiple existing role associations round-trip; the modest UI can add a subject and remove individual associations without clearing other roles.

Common changes replicate People and Space updates across devices. Membership changes advance the common cursor but have no Workout roster UI. Offline directory creation is not falsely queued; only already-known record associations can be edited offline.

## 10. UI and existing features preserved

A compact expandable Settings / Synchronization panel provides status, counts, signed-in state, connected Space, last exchange, backup export, retry, pause/logout, setup/reconciliation and conflict controls. Initial/recovery review shows downloaded counts including tombstones. Labels, native controls, confirmation dialogs and mobile wrapping are used throughout. The 390-pixel screenshot was visually inspected and no horizontal overflow was detected.

The runner retains its save/complete confirmation, performance units, previous-completed-session comparison, stable IDs, active sessions, completed read-only display and recovery key. Saved downloaded plans can be selected without changing their weekday/payload semantics. Storage/BroadcastChannel notifications refresh saved history while preserving unsaved active edits. The static base path, PWA scope, installation assets, offline navigation and update deferral remain intact. API/auth responses are excluded from service-worker caches and fetch uses no-store.

## 11. Tests added and extended

- `src/sync.test.ts`: 22 deterministic tests covering populated V1/aborted upgrades, draft separation, identity, atomic save/outbox rollback, immutable retries and predecessor bases, newer-ACK/older-page behavior, concurrent local saves, whole-page rollback, export freshness, durable conflicts/stale choices, schema rejection, auth request options, tombstones/resurrection, stale editors, completed history, deletion initialization, concurrent create intents, oversized records, timeout cleanup and persistent rate-limit backoff/no requests while disabled.
- `tests/integration/sync.test.ts`: 11 tests using the actual Express app/SQLite backend, independent IndexedDB databases and cookie jars. Covers auth/CSRF/expiry/logout, two-device edits and conflicts, People, lost response idempotency, fixed-ceiling pagination, real isolated restore, delete/resurrection, independent offline records, legacy completed metadata, duplicate directory-create recovery and restartable staged/common pagination.
- `tests/sync-browser/sync.spec.ts`: 7 end-to-end scenarios on the production build, with independent Chromium contexts, backup/consent, personal Space creation/selection, offline save and offline reload with pending changes, restart/auth restore, device conflict, People replication, no API cache entries, mobile layout, no persisted password, logout and simultaneous tabs/coordinator closure.
- Existing storage/config/native-browser assertions were updated for additive schema V2/default-disabled configuration while retaining their preservation checks. Existing runner/PWA regressions remain in place; the injected test store now exposes saved plans.

## 12. Verification results

| Command/check | Final result |
| --- | --- |
| `pnpm verify` | Passed: typecheck, lint, unit/components, infrastructure, production build/artifact and original browser tests. Rerun successfully for the targeted hardening pass. |
| `pnpm typecheck` | Passed after final test/config changes |
| `pnpm lint` | Passed after final test/config changes |
| `pnpm test` | 42 passed |
| `pnpm test:sync` | 11 passed, real local HTTP/SQLite |
| `pnpm test:sync:browser` | 7 passed, production build/real local backend, including offline reload |
| `pnpm test:e2e` | 4 passed, original production/PWA regressions |
| `pnpm test:infra` | 26 passed, 13 existing Windows platform skips, no failures |
| Production build + artifact validation | Passed, correct `/apps/workout/` paths and PWA artifacts |
| Mobile screenshot/overflow inspection | Passed at 390 x 844 Chromium viewport |
| Linux-only Nginx/rsync/activation checks | Not run locally on Windows; platform skips are not counted as passes |
| Live production / real data | Not attempted |

Initial development failures included a Windows source-encoding issue, accessible select naming, transaction-abort error normalization and test-service teardown permissions. These were corrected. Concurrent browser-suite artifact collisions were corrected by separate sync outputs (`test-results-sync`) and watch exclusions. The final suites passed with explicit lifecycle-managed local services. No failing test was removed or disabled to obtain a pass.

## 13. Remaining limitations and risks

1. Physical iPhone/Safari and Android background/installation behavior is unverified. Web Locks are required for sync; unsupported browsers retain local functionality and receive an error rather than using an unsafe in-memory lock.
2. This V1 binds one browser database to one owner/personal Space. In-place Space switching, data movement and unbinding are intentionally unsupported. Disconnect pauses only.
3. A tested loopback-only supervised recovery helper now restores confirmed records and People associations into a NEW database and refuses existing V1/V2 databases. There is still no in-place merge/import UI or field-level merge editor. Legacy exports made before this correction lack cached People labels; missing labels are reported and cannot be reconstructed by guessing. Oversized/invalid legacy records may need supervised correction.
4. Backups, outbox snapshots and metadata are retained without automatic pruning. Large-history performance and quota pressure are not load-tested. Some operations scan local stores. A quota failure aborts changes, but browser eviction or user-cleared site storage can still remove all browser-local copies; keep external exports.
5. The preexisting single localStorage draft key is unchanged. Multiple simultaneously unsaved tabs still share that legacy draft slot; confirmed saves/outbox processing are concurrency-protected. Avoid keeping separate unsaved workouts in multiple tabs until a dedicated per-tab draft design is reviewed.
6. Restore recovery may retain cached People/Spaces absent from an older server backup. Missing Person references are rejected rather than silently removed; users can remove those associations and create/select a valid Person online. Membership metadata has no roster UI.
7. Hosted CI has not run these changes. Existing repository-only CI stays independent of production. Real-backend suites need the owner to supply the reviewed sibling build/dependencies as a CI input; no new cross-repository secrets or checkout/deployment workflows were introduced.
8. Shared-origin XSS remains the backend's documented security boundary; HttpOnly cookies do not prevent malicious same-origin scripts from acting as the owner. No credentials are embedded in frontend configuration. Local JSON backups contain private workout data and public identity metadata, not password/cookie/CSRF secrets.
9. Backend off-Droplet backups remain deferred. Local recovery logic cannot reconstruct data lost from every device and every backup. Human verification of first real-data reconciliation remains mandatory.

## 14. Short human QA checklist

- [ ] On the real PC and phone, inspect/download each device's local export before connection; retain the files outside browser storage.
- [ ] Verify the chosen Space is the intended personal workout Space, sign-in feedback is understandable and login alone performs no workout transfer.
- [ ] Use synthetic records first: save offline, close/reopen the app, reconnect and verify both devices see the same complete sets.
- [ ] Make divergent edits, review both sides on a phone, cancel/revisit, then exercise both conflict choices and explicit resurrection.
- [ ] Rehearse restore recovery against the disposable local backend, including an acknowledged record missing from the older backup. Confirm preserved-copy export is usable.
- [ ] Check iOS Safari/PWA foregrounding, Android if applicable, keyboard navigation, mobile controls, People labels, logout and another tab closing during sync.
- [ ] Confirm completed history stays read-only, unsaved recovery remains local, and service-worker updates still defer during an unsaved workout.
- [ ] Owner reviews source and remaining limitations, supplies hosted-CI backend fixtures if desired, then controls commit/push/deployment.
- [ ] Only after those checks: owner explicitly approves first real-data sync and confirms a fresh successful export on each device.

## 15. Exact source/documentation files modified or added

Modified:

- `.gitignore`
- `config/app.ts`, `config/app.test.ts`
- `docs/sync-contract.md`
- `package.json`
- `src/App.tsx`, `src/App.css`, `src/App.test.tsx`
- `src/storage.ts`, `src/storage.test.ts`, `src/sync.ts`
- `tests/e2e/workout.spec.ts`
- `tsconfig.app.json`, `tsconfig.node.json`, `vite.config.ts`

Added:

- `docs/SYNC_DEVELOPMENT.md`, `docs/SYNC_IMPLEMENTATION_REPORT.md`
- `src/database.ts`, `src/sync-api.ts`, `src/sync-store.ts`, `src/sync-engine.ts`, `src/SyncPanel.tsx`, `src/sync.test.ts`
- `playwright.sync.config.ts`, `vitest.sync.config.ts`
- `tests/integration/sync.test.ts`
- `tests/support/local-service.mjs`, `tests/support/local-service.d.mts`, `tests/support/browser-setup.mjs`
- `tests/sync-browser/sync.spec.ts`

Generated local artifacts are confined to ignored `dist/`, `.dev/sync-tests/`, `.dev/browser-restart/`, test output/report directories and existing build caches. No dependency was added and `pnpm-lock.yaml` was retained unchanged. No backend repository, infrastructure configuration or Git metadata was modified.

## 16. Deployment boundary

This remains a static frontend: deploy only the existing `dist/` artifact through the owner's established workflow. The development fixtures are test tooling, not new production server infrastructure. Nothing has been staged, committed, pushed or deployed. Successful build/tests establish local evidence; they do not substitute for owner review, target-phone QA or consent to upload real data.
