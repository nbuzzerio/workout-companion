# Shared household authentication V1 - Workout Companion release report

Verified locally on Windows on November 18, 2026. The static release is ready to follow the compatible backend release.

## Implementation and API

Workout checks `GET /api/v1/auth/session` at startup, on foreground and on reconnect, even when Workout sync is paused or has never been configured. A valid session from any participating app on the canonical origin supplies the existing owner ID, CSRF token and absolute expiry. Settings shows a password form after an unauthenticated response. Submitting clears the field immediately and sends exactly `{"password":"<entered password>"}` to `POST /api/v1/auth/household-login`. A wrong password produces an explicit message. Service or network failures leave local workouts available.

The API client uses relative URLs, same-origin credentials, no-store and redirect rejection. It holds CSRF in memory, coalesces overlapping session reads and discards superseded reads. A successful account change signals other tabs through a credential-free BroadcastChannel. Each receiving tab checks the server. Logout pauses Workout and uses the existing CSRF-protected endpoint. A late pause notification can cancel sync traffic without cancelling logout. A failed network logout can be retried.

## Local data and consent

No IndexedDB, export, outbox, cursor, payload or service-worker migration is required. Only existing consent and an enabled Workout connection allow the sync runner to exchange records. Login in a fresh or paused browser can read directory data for setup. The owner still chooses the Space, exports a backup and confirms consent. An expired login on a connected device can resume its queue using its existing binding. Pausing or logging out preserves the device's data. The supervised recovery preview remains local-only.

The header retains its single Sync control. Offline saves, Web Locks, conflict resolution, People associations, backup/export and the last-confirmed-sync rules use the existing engine. Family Calendar and Cookbook can restore the same cookie and obtain their own in-memory CSRF value with the same session GET. Each needs its own local database, sync implementation and consent. No shared package is required.

## Verification

| Local command | Result |
| --- | --- |
| `pnpm.cmd verify` | Passed typecheck, lint, 45 unit/component tests, 26 infrastructure checks, static build and artifact validation, and all 4 PWA Playwright regressions. The infrastructure suite skipped 13 platform-specific cases on Windows. |
| `pnpm.cmd test:sync` | All 12 integrations passed using the actual sibling Express service, disposable SQLite and independent client storage. |
| `pnpm.cmd test:sync:browser` | All 9 Chromium scenarios passed against the built frontend and fresh loopback backend per test. |

The browser checks cover incorrect-password feedback and cleared input, session restoration from a sibling app path, cross-tab logout, independent devices, offline saves through a full browser restart and expiry, zero workout exchanges without consent, retained pending operations, automatic and manual exchanges, conflicts, People, 320/390-pixel layouts, and supervised recovery. The separate static-only PWA suite also exercises an unavailable API. Mobile coverage used Chromium viewports. Live deployment and physical-phone behavior still require owner QA.

## Files modified

- `src/SyncPanel.tsx`, `src/sync-api.ts`, `src/sync-engine.ts` implement session presentation, transport and scoped pause cancellation.
- `scripts/recover-workout.mjs` identifies the offline recovery preview.
- `src/sync.test.ts`, `tests/integration/sync.test.ts`, `tests/sync-browser/sync.spec.ts`, `tests/support/browser-setup.mjs`, `tests/e2e/workout.spec.ts` cover the API, consent, shared sessions, browser coordination and offline regressions.
- `README.md`, `docs/SYNC_DEVELOPMENT.md`, `docs/sync-contract.md` and this report describe setup and release behavior.

## Deployment and rollback

1. Deploy Personal Sync Service separately. Verify both password-only and legacy username/password login on the canonical HTTPS origin.
2. Deploy the Workout static build after the new route is available. A static release cannot install backend changes.
3. Verify shared sessions and Workout synchronization on the PC and phone. Adopt the contract in subsequent applications after these checks.
4. For rollback, restore the previous static release and allow the PWA to update. Keep both backend routes available for cached clients. If a backend rollback is necessary, revert its code after the frontend rollback. Keep the existing database, browser storage, session cookie and outbox.

The apex-to-www redirect is a separate infrastructure change. The backend deployment guide specifies an HTTPS canonical destination, path/query preservation, valid apex TLS, and handling of unsafe API methods. Workout always uses the current same-origin API and the server requires the exact canonical Origin.

## Owner QA checklist

- Open Workout in the existing signed-in PC profile and on the phone. Confirm each keeps its selected Space and last confirmed time. Each device signs in separately when needed.
- In a fresh profile, sign in with the household password and reload. Check that the password field stays hidden, the local records remain available, and sync waits for explicit setup.
- On a connected device, save an agreed test workout offline. Reconnect and confirm the edit appears on the other device. Press Sync and check the confirmed time.
- Sign out from Advanced settings with two tabs open. Verify the other tab requests the password, local history and pending work remain available, and the independent device session still works.
