// Supervised, loopback-only recovery. Never writes a source file, existing
// database, or server record. This helper is not included in the static release.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { planSchema, sessionSchema, associationsSchema, personSchema, spaceSchema } from '../src/sync.ts';

export function validateRecoveryExport(raw) {
  z.object({
    formatVersion: z.literal(2).optional(), plans: z.array(planSchema), sessions: z.array(sessionSchema),
    metadata: z.array(z.object({ id: z.string(), people: associationsSchema }).passthrough()),
    people: z.array(personSchema).optional(), spaces: z.array(spaceSchema).optional(),
  }).passthrough().parse(raw);
  for (const rows of [raw.plans, raw.sessions, raw.metadata, raw.people ?? [], raw.spaces ?? []]) {
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error('Duplicate identities in export; supervised review required.');
  }
  const known = new Set((raw.people ?? []).map(p => p.id));
  const missingPeople = [...new Set(raw.metadata.flatMap(m => m.people.map(p => p.personId)))].filter(id => !known.has(id));
  return { plans: raw.plans.length, sessions: raw.sessions.length, people: known.size, missingPeople };
}

// Self-contained so the exact tested function can run in the offline browser.
// Data has already been validated on the local Node process before being served.
export function restoreNewDatabase(data, factory = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    let created = false, failure;
    const opening = factory.open('workout-companion', 2);
    opening.onblocked = () => { failure = new Error('Existing database is open. Recovery refused; use a fresh browser profile.'); reject(failure); };
    opening.onupgradeneeded = event => {
      if (failure || event.oldVersion !== 0) { failure ??= new Error('An existing database was found. Recovery refused.'); opening.transaction.abort(); return; }
      created = true;
      try {
        const db = opening.result;
        for (const name of ['plans', 'sessions', 'syncSettings', 'syncMeta', 'syncOutbox', 'syncConflicts', 'syncRemote', 'syncBackups', 'syncPeople', 'syncSpaces']) db.createObjectStore(name, { keyPath: 'id' });
        const tx = opening.transaction;
        for (const row of data.plans) tx.objectStore('plans').add(row);
        for (const row of data.sessions) tx.objectStore('sessions').add(row);
        for (const row of data.people ?? []) tx.objectStore('syncPeople').add(row);
        for (const row of data.spaces ?? []) tx.objectStore('syncSpaces').add(row);
        for (const kind of ['plan', 'session']) for (const row of data[kind === 'plan' ? 'plans' : 'sessions']) {
          const id = `${kind}:${row.id}`;
          tx.objectStore('syncMeta').add({ id, version: null, people: data.metadata.find(m => m.id === id)?.people ?? [] });
        }
        // The old UUID, consent, server cursors and operation queue are evidence,
        // not live state. Replaying them on another device would violate V1.
        tx.objectStore('syncSettings').add({ id: 'settings', deviceId: crypto.randomUUID(), enabled: false, phase: 'local', cursor: null, commonCursor: null, failures: 0, nextRetry: 0 });
        tx.objectStore('syncBackups').add({ ...data, id: crypto.randomUUID(), createdAt: new Date().toISOString(), reason: 'Original recovery export (evidence only)', source: data });
      } catch (error) { failure = error; opening.transaction.abort(); }
    };
    opening.onerror = () => reject(failure ?? opening.error);
    opening.onsuccess = () => {
      opening.result.close();
      if (!created) reject(new Error('An existing database was found. Recovery refused.'));
      else resolve({ database: 'workout-companion', plans: data.plans.length, sessions: data.sessions.length, syncEnabled: false });
    };
  });
}

export async function startRecoveryServer(data) {
  const summary = validateRecoveryExport(data);
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  await readFile(resolve(dist, 'index.html')); // Require an existing verified build.
  const encoded = JSON.stringify(data).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Workout supervised recovery</title>
<style>body{font:16px system-ui;max-width:740px;margin:40px auto;padding:16px}button,a{padding:12px;display:inline-block}pre{white-space:pre-wrap;overflow-wrap:anywhere}[hidden]{display:none!important}</style>
<h1>Recover an isolated Workout copy</h1><p>This local-only tool refuses every existing Workout database, even an empty one. Use a fresh dedicated browser profile. It never merges, clears, uploads, or restores old consent.</p>
<p>Original operation history, conflicts, staged snapshots and the raw draft remain in a preserved copy. The draft is never promoted to a confirmed session. Compare IDs, sets, People labels and completed status before any later supervised migration.</p>
<pre id="summary"></pre><button id="restore">Recover into new local database</button><pre id="result" aria-live="polite"></pre><a href="/apps/workout/" id="open" hidden>Inspect recovered workouts</a>
<script id="data" type="application/json">${encoded}</script><script>
const restoreNewDatabase = ${restoreNewDatabase.toString()};
const summary = ${JSON.stringify(summary)};
document.getElementById('summary').textContent = JSON.stringify(summary, null, 2) + (summary.missingPeople.length ? '\\nWARNING: These older/uncached Person IDs have no exported labels. Recover labels from an independent source; do not guess.' : '');
document.getElementById('restore').onclick = async () => {
  if (!confirm('Recover confirmed records into a NEW local database? Existing databases will be refused. Sync stays disabled.')) return;
  try { const result = await restoreNewDatabase(JSON.parse(document.getElementById('data').textContent)); document.getElementById('result').textContent = JSON.stringify(result, null, 2); document.getElementById('open').hidden = false; }
  catch (error) { document.getElementById('result').textContent = error.message; }
};</script></html>`;
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  const server = createServer(async (req, res) => {
    // Restrict Host as well as bind address; there is no API proxy and no CORS.
    if (req.headers.host !== `127.0.0.1:${server.address().port}` || req.method !== 'GET') { res.writeHead(403).end(); return; }
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    if (!path.startsWith('/apps/workout/')) { res.writeHead(404).end(); return; }
    try {
      const relative = decodeURIComponent(path.slice('/apps/workout/'.length)) || 'index.html';
      const file = resolve(dist, relative);
      if (!file.startsWith(dist.endsWith(sep) ? dist : dist + sep)) { res.writeHead(403).end(); return; }
      const extension = file.slice(file.lastIndexOf('.'));
      res.setHeader('Content-Type', types[extension] ?? 'application/octet-stream'); res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Usage: pnpm exec node scripts/recover-workout.mjs <export.json>');
  const raw = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
  const server = await startRecoveryServer(raw);
  console.log(`Open ${server.url}/ in a fresh dedicated browser profile. No API is connected. Keep this terminal open while inspecting; Ctrl+C stops it. Original export is unchanged.`);
}
