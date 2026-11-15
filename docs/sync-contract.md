# Future Workout exchange contract

Sync is disabled by validated literal `false` in `config/app.ts`. `src/sync.ts`
defines only a TypeScript boundary, adapted from the template to existing
`Plan` and `Session` records. No adapter, fetch, polling, mock sync, credentials,
server database or API reverse proxy is implemented. Offline writes continue
through `SessionStore` to the existing IndexedDB schema.

The proposed separately managed Express/SQLite endpoint is
`POST /api/v1/apps/workout/exchange`. Its declaration is metadata and triggers
no requests. The future request contains app/device identity, opaque cursor and
changes with immutable operation UUIDs, base server versions and typed record
envelopes. Responses contain accepted operation IDs, server-versioned changes,
conflicts and the next cursor. The plan/session discriminator preserves their
existing IDs and keeps the stores' namespaces distinct.

Before implementing transport, design and test an additive IndexedDB migration
for stable device identity, an outbox, server versions and cursor state. Each
repository edit and outbox insertion must commit in the same local transaction.
Existing per-session revisions remain optimistic local concurrency counters;
they are neither server versions nor global cursors. No current record is
silently rewritten to the template's journal model. Deletion/tombstone support
also needs a deliberate domain and migration design; Workout has no delete API.

The future client must validate responses and atomically apply accepted changes
and cursor state, retain unacknowledged operations, bound retries/batches, handle
offline operation and expose explicit consent and conflict resolution. Never
resolve conflicts by wall-clock timestamps or silently discard unsent edits on
cursor expiry. Backups, once implemented, must be independent of credentials.

The separate backend must authenticate/authorize owner/app/device, deduplicate
operation IDs, compare base server versions transactionally, and maintain a
monotonic SQLite change log. Plan for cursor expiry, concurrent changes, durable
deletions, pagination and tested backup/restore. Use HTTPS, bounded requests,
strict origin/CSRF policy as appropriate, and no private frontend API secrets.
Backend lifecycle and Nginx `/api/` routing are outside this static deployment.
