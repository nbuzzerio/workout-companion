/** Real Nginx in a disposable Docker container or isolated local prefix. No Droplet access. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { Releases } from '../deploy_static.mjs';

const repository = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--nginx')) throw new Error('Usage: pnpm test:nginx [--nginx /path/to/nginx]');
if (process.platform !== 'linux') throw new Error('Nginx integration requires Linux (local Nginx or Docker), including real release symlinks/flock. Run in WSL or CI.');
const binary = args[1];
const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'dist/release.json'), 'utf8'));
const slug = manifest.appId;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workout-nginx-'));
let container, processHandle, processExit;
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 120000 });
try {
  fs.chmodSync(root, 0o755);
  for (const name of ['apps', 'incoming', 'releases']) fs.mkdirSync(path.join(root, name));
  fs.cpSync(path.join(repository, 'dist'), path.join(root, 'incoming', slug, manifest.release), { recursive: true });
  // Validate and activate the real build through the production symlink layout.
  new Releases(root).activate(slug, manifest.release);
  fs.copyFileSync(path.join(repository, 'infra/nginx/personal-apps.conf'), path.join(root, 'apps.conf'));
  const securityHeaders = {
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
  };
  const headerText = Object.entries(securityHeaders).map(([name, value]) => `add_header ${name} "${value}" always;`).join('\n');
  fs.writeFileSync(path.join(root, 'security.conf'), headerText);
  fs.writeFileSync(path.join(root, 'default.conf'), `server { listen 80; server_name localhost; ${headerText} include /etc/nginx/personal-apps.conf; location / { return 200 "existing site"; } }`);
  let port;
  if (binary) {
    const config = path.join(root, 'apps.conf');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replaceAll('/srv/personal-apps', root).replaceAll('/etc/nginx/snippets/personal-apps-security-headers.conf', path.join(root, 'security.conf')));
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const tempPaths = ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map(kind => `${kind}_temp_path ${root}/${kind};`).join(' ');
    const mimeTypes = 'types { text/html html; text/css css; application/javascript js; image/png png; application/manifest+json webmanifest; application/json json; }';
    fs.writeFileSync(path.join(root, 'nginx.conf'), `pid ${root}/nginx.pid; error_log stderr; events {} http { ${tempPaths} ${mimeTypes} access_log off; default_type application/octet-stream; server { listen 127.0.0.1:${port}; ${headerText} include ${root}/apps.conf; location / { return 200 "existing site"; } } }`);
    const options = ['-p', `${root}/`, '-c', path.join(root, 'nginx.conf')];
    run(binary, ['-t', ...options]);
    processHandle = spawn(binary, [...options, '-g', 'daemon off;'], { stdio: 'inherit' });
    processExit = once(processHandle, 'exit');
  } else {
    container = run('docker', ['run', '--rm', '-d', '-p', '127.0.0.1::80',
      '-v', `${root}:/srv/personal-apps:ro`, '-v', `${root}/security.conf:/etc/nginx/snippets/personal-apps-security-headers.conf:ro`,
      '-v', `${root}/apps.conf:/etc/nginx/personal-apps.conf:ro`, '-v', `${root}/default.conf:/etc/nginx/conf.d/default.conf:ro`, 'nginx:1.28.0-alpine']).trim();
    run('docker', ['exec', container, 'nginx', '-t']);
    port = run('docker', ['port', container, '80/tcp']).trim().split(':').at(-1);
  }
  const request = async route => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.text(), headers: response.headers };
  };
  for (let attempt = 0; ; attempt++) {
    try { await request('/'); break; }
    catch (error) { if (attempt === 29) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.equal((await request('/')).body, 'existing site');
  const base = `/apps/${slug}/`;
  const html = await request(base);
  assert.equal(html.status, 200); assert.ok(html.body.includes('<div id="root">'));
  assert.equal(html.headers.get('Cache-Control'), 'no-cache'); assert.equal(html.headers.get('Content-Type'), 'text/html');
  assert.equal((await request(base + 'settings')).body, html.body); assert.equal((await request(base + 'deep/nested/path')).body, html.body);
  const asset = Object.keys(manifest.files).find(name => name.startsWith('assets/') && name.endsWith('.js')); assert.ok(asset);
  const js = await request(base + asset); assert.equal(js.status, 200); assert.ok(['application/javascript', 'text/javascript'].includes(js.headers.get('Content-Type')));
  assert.equal((await request(base + 'sw.js')).status, 200);
  for (const route of ['/apps/', `/apps/missing-${slug}/settings`, '/apps/Bad/settings', '/apps/bad--slug/', '/apps/' + 'a'.repeat(49) + '/', base + 'assets/missing.js', base + 'missing.png', base + '.env', base + 'folder/.secret', base.slice(0, -1)]) assert.equal((await request(route)).status, 404, route);
  for (const route of ['/', base, base + 'settings', base + asset, base + 'sw.js', base + 'assets/missing.js']) {
    const response = await request(route);
    for (const [name, value] of Object.entries(securityHeaders)) assert.equal(response.headers.get(name), value, `${route} ${name}`);
  }
  console.log('Nginx: configuration, existing site, SPA deep links, static assets, cache headers, unknown apps, invalid paths and security headers passed.');
} finally {
  try {
    if (container) run('docker', ['rm', '-f', container]);
    if (processHandle) {
      processHandle.kill('SIGTERM');
      const timer = setTimeout(() => processHandle.kill('SIGKILL'), 10000);
      try { await processExit; } finally { clearTimeout(timer); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
