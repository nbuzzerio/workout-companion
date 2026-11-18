# Workout synchronization contract (implemented V1)

The authoritative transport is the sibling Personal Sync Service's `docs/SYNC_PROTOCOL.md`, `docs/API.md`, `src/contracts.ts`, and `src/sync/exchange.ts`. Workout remains a static React/TypeScript/Vite application. Production uses credentialed, same-origin `/api/v1/...` requests. No backend or secrets ship in `dist/`.

## Compatibility changes from the former interface

The former `SyncAdapter` was a declaration only and was not wire-compatible. It nested `record: {kind,value}` and lacked protocol version, Space, operation type, schema version, associations, resurrection, per-operation results, and pagination. `src/sync.ts` now defines and validates the actual V1 envelopes. Session expiry is a numeric epoch timestamp, not an ISO string. Server revisions are positive decimal strings, never `Session.revision`.

Requests contain `protocolVersion:1`, `appId:"workout"`, persistent device UUID, selected personal Space UUID, opaque cursor, limit 25, and at most 16 operations/750 KB. Puts include `operationId`, `type`, `kind`, `recordId`, `schemaVersion:1`, `baseServerVersion`, full value, People associations, and explicit `resurrect`. Deletes contain only the five required operation fields. Unknown compatible payload metadata stays intact.

## Local database and outbox

IndexedDB `workout-companion` upgrades additively from version 1 to 2. Original `plans` and `sessions` stores and IDs are unchanged. New stores hold settings/device identity, per-record server metadata, outbox, conflicts, staged remote records, preserved backups, People, and Spaces. All writes request strict transaction durability. Version-change handlers close old connections; blocked upgrades fail with a retry instruction, never a reset.

Confirmed local saves and outbox insertions share one transaction. Every queued intent receives an immutable UUID and a full saved snapshot. A record's first operation is materialized immediately; subsequent intents wait for their predecessor's accepted result to establish its exact base version. Once materialized, every retry uses the same structure, UUID, device and Space. No existing operation's base or payload is rewritten. Resolutions archive the superseded queue and create a new UUID.

`Session.revision` remains local optimistic concurrency. When downloaded state replaces an existing session, its local revision advances to invalidate stale open editors; the exact wire snapshot is retained separately. Migration and fresh downloads do not rewrite historic revisions. Completed payload changes and remote deletions of local records require review.

The existing localStorage recovery draft is never queued. Only an explicit workout save/complete confirms a draft. Export may include the raw draft for independent recovery.

## Consent and reconciliation

Build configuration defaults to `enabled:false`; it cannot opt a browser in. Login alone does not exchange workout records. A user must download/check a fresh local backup, explicitly choose an active personal Space, and confirm consent. Existing shared Spaces are excluded. Connecting first stages a complete remote snapshot without uploading. The user reviews local/remote counts and chooses reconciliation; divergent identities become durable conflicts. Unmatched local records are queued, and remote-only records are installed. Empty server results never clear local history.

This V1 browser database binds to one owner and Space. Disconnect pauses; it does not unbind or delete. Reconnection uses the same binding and requires another export/confirmation. Use a separate browser profile for a different Space; automatic Space switching/moving data is intentionally unsupported.

## Exchange, conflict and restore rules

Acknowledgements, outbox updates, metadata, downloaded snapshots and cursor commit atomically. Acknowledgements advance server versions independently from downloaded progress. Older snapshots cannot downgrade acknowledged versions. Pending local edits prevent remote payload replacement. A full page ceiling is followed by a catch-up exchange; interrupted pagination resumes from the committed cursor.

Conflicts retain the entire queue and show the latest available server snapshot and local record, People, changed top-level fields and server device. Keep-server and keep-local require confirmation and preserve a downloadable copy first. Local choice uses a fresh UUID and the displayed server base; a new intervening change causes another conflict. Server-deleted records require explicit resurrection. Closing settings leaves conflicts unresolved. Invalid/oversized records remain local and blocked without blocking independent uploads.

`CURSOR_RESET_REQUIRED` starts recovery, retaining records, operations and acknowledged information. Fresh server pages go into `syncRemote`. The user explicitly reconciles the complete snapshot; missing or differing previously known records become review items, including writes acknowledged after a restored backup. No old queue is replayed against the new baseline before review. Each resolution archives the old queue and metadata. Common-directory cursors reset independently; cached labels absent from an older restore remain available for inspection, not silently erased.

## Scheduling and authentication

Web Locks serialize whole sync passes across tabs. IndexedDB transactions serialize local saves; BroadcastChannel refreshes other tabs and triggers catch-up. Browsers without Web Locks fail closed for sync while local storage remains available.

Login/session/logout use the browser's HttpOnly cookie. Passwords are cleared from the form immediately and never stored. CSRF exists only in the API client's memory and is reacquired from `/auth/session` after reload. Requests reject redirects and use `cache:'no-store'`. No mutable API/auth response is service-worker cached.

Each pass bounds common pages to 8 and workout pages to 12, uses 20-second request timeouts, and resumes via app opening, foreground, connectivity, local saves or a roughly 60-second foreground timer. Exponential retry delay grows from 4 seconds to 5 minutes, honoring longer Retry-After. Hidden tabs do not poll automatically. Authentication failure, logout, offline state and HTTP failure retain pending data. A closed app synchronizes when reopened; Background Sync is not required.

See [local setup](SYNC_DEVELOPMENT.md) and [implementation report](SYNC_IMPLEMENTATION_REPORT.md).

## Targeted hardening: notifications, pause and recovery exports

Storage notices distinguish committed local upload work (`local`), explicit enable/pause controls (`control`) and view refresh (`refresh`). Sync metadata/ACK/cursor/common-directory/export writes never schedule another tab's sync. A local mutation during an active pass retains a follow-up wake. UI subscribers continue receiving cross-tab refreshes.

`controlVersion` is an additive optional settings field, initialized on first enable/pause without a database-version upgrade. Every pass captures it; pre-dispatch checks and transactional response application reject a paused or obsolete generation. Pause notifications abort requests across tabs, but cannot recall a request already accepted by the backend. Its immutable pending operation remains available for idempotent replay on explicit resume. A durable generation guard also works when a tab misses a notification.

Export format 2 adds cached People/Spaces and staged snapshots to the existing record/outbox/conflict/draft evidence. The local `scripts/recover-workout.mjs` helper validates an export and recovers confirmed records into a newly created, local-only database. It refuses all existing databases and preserves old sync evidence without reactivating it. See the tested procedure in `SYNC_DEVELOPMENT.md`; this helper is not included in the production static artifact.
