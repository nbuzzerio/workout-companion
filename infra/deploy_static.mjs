#!/usr/bin/env node
/** Static release validator/activator. Never builds or runs application code. */
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { requireStorage, MAX_RELEASE_BYTES, MAX_MANIFEST_BYTES, MAX_RELEASE_FILES } from './storage_guard.mjs';

export const ROOT = '/srv/personal-apps';
// Use a true end-of-input assertion: JS `$` also matches before a final newline.
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\s\S])/;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}(?![\s\S])/;
const FILE = /^[A-Za-z0-9_@+-][A-Za-z0-9_@+./-]*(?![\s\S])/;
const HASH = /^[a-f0-9]{64}(?![\s\S])/;
export function validateSlug(value) {
  if (typeof value !== 'string' || value.length > 48 || !SLUG.test(value)) throw new Error('Invalid app slug');
  return value;
}
export function validateRelease(value) {
  if (typeof value !== 'string' || !RELEASE.test(value)) throw new Error('Invalid release ID');
  return value;
}
export function* walk(folder, prefix = '') {
  for (const name of fs.readdirSync(path.join(folder, prefix))) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const info = fs.lstatSync(path.join(folder, relative));
    yield { relative, info };
    if (info.isDirectory() && !info.isSymbolicLink()) yield* walk(folder, relative);
  }
}
export class Releases {
  constructor(root = ROOT, { retention = 5, staleSeconds = 86400, storage = requireStorage, remove = fs.rmSync } = {}) {
    this.root = fs.realpathSync(root);
    if (!Number.isInteger(retention) || retention < 2 || !Number.isFinite(staleSeconds) || staleSeconds < 1) {
      throw new Error('Retain at least two releases and a positive upload lifetime');
    }
    Object.assign(this, { retention, staleSeconds, storage, remove });
  }
  safeDir(...parts) {
    let current = this.root;
    for (const part of parts) {
      // Only single directory components are accepted, including internal staging names.
      if (typeof part !== 'string' || !part || part === '.' || part === '..' || /[/\\]/.test(part)) throw new Error('Path escaped deployment root');
      current = path.join(current, part);
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Symlink directory forbidden');
    }
    return current;
  }
  lock(action) {
    if (process.platform !== 'linux') throw new Error('Release operations require Linux flock');
    const fd = fs.openSync(path.join(this.root, '.deploy.lock'), 'a');
    try {
      // util-linux flock locks the shared open-file description. The parent keeps
      // it alive after flock exits; fd 3 is also inherited by the rsync receiver.
      const result = spawnSync('/usr/bin/flock', ['--exclusive', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Cannot acquire deployment lock: ${result.stderr}`);
      return action(fd);
    } finally { fs.closeSync(fd); }
  }
  validate(folder, slug, release) {
    validateSlug(slug); validateRelease(release);
    const folderInfo = fs.lstatSync(folder);
    if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) throw new Error('Release directory missing or symlinked');
    const manifestFile = path.join(folder, 'release.json');
    const info = fs.lstatSync(manifestFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) throw new Error('Invalid release manifest');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest?.formatVersion !== 1 || manifest.appId !== slug || manifest.basePath !== `/apps/${slug}/` || manifest.release !== release) {
      throw new Error('Release identity/base path mismatch');
    }
    const files = manifest.files;
    if (!files || Array.isArray(files) || typeof files !== 'object' || Object.keys(files).length < 1 || Object.keys(files).length > MAX_RELEASE_FILES) throw new Error('Invalid inventory');
    if (!['index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'].every(name => Object.hasOwn(files, name))) throw new Error('Missing required PWA files');
    const actual = new Set();
    let total = 0;
    for (const { relative, info } of walk(folder)) {
      if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) throw new Error('Special files and symlinks forbidden');
      if (relative.split('/').some(part => part.startsWith('.'))) throw new Error('Hidden paths forbidden');
      if (info.isDirectory() || relative === 'release.json') continue;
      if (!FILE.test(relative) || relative.split('/').includes('..')) throw new Error('Invalid artifact path');
      actual.add(relative);
      total += info.size;
      if (total > MAX_RELEASE_BYTES) throw new Error('Release exceeds 100 MiB');
      const expected = Object.hasOwn(files, relative) && files[relative];
      if (typeof expected !== 'string' || !HASH.test(expected)) throw new Error('Invalid or missing file hash');
      if (createHash('sha256').update(fs.readFileSync(path.join(folder, relative))).digest('hex') !== expected) throw new Error('Artifact checksum mismatch');
    }
    if (actual.size !== Object.keys(files).length || !Object.keys(files).every(name => actual.has(name))) throw new Error('Artifact inventory mismatch');
    const html = fs.readFileSync(path.join(folder, 'index.html'), 'utf8');
    if (!html.includes(`/apps/${slug}/assets/`) || /(?:src|href)=["']\/assets\//.test(html)) throw new Error('HTML has an incorrect asset base path');
    const pwa = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.webmanifest'), 'utf8'));
    if (pwa?.scope !== `/apps/${slug}/` || pwa.start_url !== `/apps/${slug}/`) throw new Error('Manifest scope mismatch');
    return manifest;
  }
  current(slug) {
    validateSlug(slug);
    const link = path.join(this.safeDir('apps'), slug);
    const info = fs.lstatSync(link, { throwIfNoEntry: false });
    if (!info) return null;
    if (!info.isSymbolicLink()) throw new Error('App path exists and is not a managed symlink');
    const target = fs.realpathSync(link);
    if (path.dirname(target) !== this.safeDir('releases', slug)) throw new Error('Current release points outside app releases');
    return validateRelease(path.basename(target));
  }
  switch(slug, release) {
    validateSlug(slug); validateRelease(release);
    const destination = this.safeDir('releases', slug, release);
    this.validate(destination, slug, release);
    const previous = this.current(slug);
    const history = path.join(this.safeDir('releases', slug), '.previous');
    fs.writeFileSync(`${history}.tmp`, previous ?? '');
    fs.renameSync(`${history}.tmp`, history);
    const apps = this.safeDir('apps');
    const temporary = path.join(apps, `.${slug}-${process.pid}`);
    try {
      fs.symlinkSync(`../releases/${slug}/${release}`, temporary, 'dir');
      fs.renameSync(temporary, path.join(apps, slug));
    } finally { fs.rmSync(temporary, { force: true }); }
    return { app: slug, active: release, previous };
  }
  cleanupLocked() {
    const cutoff = Date.now() - this.staleSeconds * 1000;
    for (const category of ['incoming', 'releases']) {
      const parent = this.safeDir(category);
      for (const app of fs.readdirSync(parent, { withFileTypes: true })) {
        if (app.isSymbolicLink() || !app.isDirectory() || !SLUG.test(app.name)) continue;
        validateSlug(app.name);
        const appPath = this.safeDir(category, app.name);
        const active = category === 'releases' ? this.current(app.name) : null;
        const versions = [];
        for (const entry of fs.readdirSync(appPath, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
          const directory = this.safeDir(category, app.name, entry.name);
          const modified = fs.statSync(directory).mtimeMs;
          if (category === 'incoming' || entry.name.startsWith('.staging-')) {
            if (modified < cutoff) this.remove(directory, { recursive: true });
          } else if (RELEASE.test(entry.name)) versions.push({ name: entry.name, modified });
        }
        if (category === 'releases') {
          versions.sort((a, b) => b.modified - a.modified || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
          const keep = new Set(active ? [active] : []);
          const history = path.join(appPath, '.previous');
          const info = fs.lstatSync(history, { throwIfNoEntry: false });
          if (info?.isFile() && !info.isSymbolicLink()) {
            const previous = fs.readFileSync(history, 'utf8');
            if (previous) {
              validateRelease(previous);
              if (versions.some(v => v.name === previous)) keep.add(previous);
            }
          }
          for (const version of versions) if (keep.size < this.retention) keep.add(version.name);
          for (const version of versions) if (!keep.has(version.name)) this.remove(this.safeDir('releases', app.name, version.name), { recursive: true });
        }
      }
    }
  }
  cleanup() { return this.lock(() => { this.cleanupLocked(); return { cleaned: true }; }); }
  activate(slug, release) {
    validateSlug(slug); validateRelease(release);
    return this.lock(() => {
      this.cleanupLocked();
      const incoming = this.safeDir('incoming', slug, release);
      this.validate(incoming, slug, release);
      this.storage(this.root, 'activation');
      const parent = this.safeDir('releases', slug);
      fs.mkdirSync(parent, { recursive: true });
      const destination = path.join(parent, release);
      if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error('Release already exists; use a new release ID or rollback');
      const staging = fs.mkdtempSync(path.join(parent, '.staging-'));
      let result;
      try {
        fs.cpSync(incoming, staging, { recursive: true, verbatimSymlinks: true });
        this.validate(staging, slug, release);
        for (const { relative, info } of walk(staging)) fs.chmodSync(path.join(staging, relative), info.isDirectory() ? 0o755 : 0o644);
        fs.chmodSync(staging, 0o755);
        fs.renameSync(staging, destination);
        const now = new Date(); fs.utimesSync(destination, now, now);
        result = this.switch(slug, release);
      } finally { if (fs.existsSync(staging)) this.remove(staging, { recursive: true }); }
      try {
        this.remove(incoming, { recursive: true });
        this.cleanupLocked();
      } catch (error) {
        if (!error.code) throw error;
        result.cleanupWarning = error.message;
      }
      return result;
    });
  }
  rollback(slug, release) {
    validateSlug(slug); validateRelease(release);
    return this.lock(() => this.switch(slug, release));
  }
  rollbackIfCurrent(slug, release, expected) {
    validateSlug(slug); validateRelease(release); validateRelease(expected);
    return this.lock(() => {
      const current = this.current(slug);
      if (current !== expected) return { app: slug, active: current, rolledBack: false };
      return { ...this.switch(slug, release), rolledBack: true };
    });
  }
  status(slug) {
    validateSlug(slug);
    return this.lock(() => {
      const parent = this.safeDir('releases', slug);
      const releases = fs.existsSync(parent) ? fs.readdirSync(parent, { withFileTypes: true }).filter(p => p.isDirectory() && RELEASE.test(p.name)).map(p => p.name).sort() : [];
      return { app: slug, active: this.current(slug), releases };
    });
  }
}
export function main(args = process.argv.slice(2), manager = new Releases()) {
  if (args.length === 3 && ['activate', 'rollback'].includes(args[0])) return manager[args[0]](...args.slice(1));
  if (args.length === 4 && args[0] === 'rollback-if-current') return manager.rollbackIfCurrent(...args.slice(1));
  if (args.length === 1 && args[0] === 'cleanup') return manager.cleanup();
  if (args.length === 2 && args[0] === 'status') return manager.status(args[1]);
  throw new Error('Usage: deploy-static {activate|rollback} SLUG RELEASE | rollback-if-current SLUG RELEASE EXPECTED | status SLUG | cleanup');
}
if (import.meta.main) {
  try { console.log(JSON.stringify(main())); }
  catch (error) { console.error(`deploy-static: ${error.message}`); process.exitCode = 1; }
}
