// Imports the reviewed sibling build read-only. All databases are created here.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const backend = resolve(root, '../personal-sync-service/dist/src');
const load = name => import(pathToFileURL(join(backend, name)).href);
export const password = 'synthetic-workout-passphrase-only';
export async function fixture(origin = 'http://127.0.0.1:5174', port = 0) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw Error('Tests require a loopback origin');
  const [{ openDatabase, migrate }, { bootstrapOwner }, { createApp }, { configFromEnv }, directory, sync, backups] = await Promise.all([load('db/database.js'), load('auth/auth.js'), load('http/app.js'), load('config.js'), load('domain/directory.js'), load('sync/exchange.js'), load('db/backup.js')]);
  const parent = join(root, '.dev', 'sync-tests'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'isolated-')); const path = join(dir, 'sync.sqlite');
  let db = openDatabase(path); migrate(db); const owner = await bootstrapOwner(db, 'synthetic-owner', password);
  const config = configFromEnv({ NODE_ENV: 'test', PUBLIC_ORIGIN: origin, DATABASE_PATH: path, BACKUP_DIR: join(dir, 'backups') });
  let server;
  const listen = async () => { server = await new Promise(resolve => { const s = createApp(db, config, () => {}).listen(port, '127.0.0.1', () => resolve(s)); }); return `http://127.0.0.1:${server.address().port}`; };
  let url = await listen();
  return {
    get url() { return url; }, get db() { return db; }, owner, dir, path,
    space(name = 'Synthetic workouts') { return directory.createSpace(db, owner, { id: crypto.randomUUID(), name, kind: 'personal' }); },
    person(name = 'Synthetic Person') { return directory.createPerson(db, owner, { id: crypto.randomUUID(), displayName: name }); },
    exchange(spaceId, changes = [], extra = {}) { return sync.exchange(db, owner, 'workout', { protocolVersion: 1, appId: 'workout', deviceId: crypto.randomUUID(), spaceId, cursor: null, changes, ...extra }); },
    backup() { return backups.backup(db, join(dir, 'backups')); },
    async restore(source) {
      server.closeAllConnections(); await new Promise(r => server.close(r)); db.close();
      const destination = join(dir, `restored-${crypto.randomUUID()}.sqlite`); backups.restoreBackup(source, destination, path); db = openDatabase(destination, true); url = await listen();
    },
    async close() { server.closeAllConnections(); await new Promise(r => server.close(r)); if (db.open) db.close(); },
    clientFetch() {
      let cookie = '';
      return async (path, init = {}) => {
        if (typeof path !== 'string' || !path.startsWith('/api/v1/')) throw Error('Production/external request blocked in tests');
        const headers = new Headers(init.headers); headers.set('Origin', origin); if (cookie) headers.set('Cookie', cookie);
        const response = await fetch(url + path, { ...init, headers });
        const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0];
        return response;
      };
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const f = await fixture('http://127.0.0.1:5174', 4317);
  const vite = process.argv.includes('--frontend') ? await (await import('vite')).createServer({ server: { port: 5174, strictPort: true, host: '127.0.0.1' } }) : undefined;
  if (vite) await vite.listen();
  console.log('Disposable synthetic Personal Sync Service listening on loopback port 4317.');
  // The Playwright process owns this disposable service's lifetime. Do not
  // intercept termination: committed SQLite WAL transactions are crash-safe.
}
