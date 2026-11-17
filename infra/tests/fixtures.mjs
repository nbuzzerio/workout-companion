import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Releases } from '../deploy_static.mjs';

export const repository = path.resolve(import.meta.dirname, '../..');
export const linux = process.platform === 'linux';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workout-infra-'));
  for (const name of ['apps', 'releases', 'incoming']) fs.mkdirSync(path.join(root, name));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new Releases(root, { storage: () => {}, ...options });
  const artifact = (release = 'one', slug = 'workout') => {
    const folder = path.join(root, 'incoming', slug, release);
    const files = {
      'index.html': `<script src="/apps/${slug}/assets/app.js"></script>`,
      'assets/app.js': 'console.log("static")', 'sw.js': '// scoped worker',
      'manifest.webmanifest': JSON.stringify({ scope: `/apps/${slug}/`, start_url: `/apps/${slug}/` }),
      'icon-192.png': 'test', 'icon-512.png': 'test',
    };
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
      fs.writeFileSync(path.join(folder, name), content);
    }
    const manifest = { formatVersion: 1, appId: slug, basePath: `/apps/${slug}/`, release,
      files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256(content)])) };
    fs.writeFileSync(path.join(folder, 'release.json'), JSON.stringify(manifest));
    return folder;
  };
  return { root, manager, artifact };
}
export function rewrite(folder, name, content) {
  fs.writeFileSync(path.join(folder, name), content);
  const manifestFile = path.join(folder, 'release.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.files[name] = sha256(content);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}
