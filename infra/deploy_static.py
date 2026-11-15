#!/usr/bin/python3
"""Static release validator/activator. Python stdlib only; never builds or runs app code."""
import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import time
from storage_guard import require_storage, MAX_RELEASE_BYTES, MAX_MANIFEST_BYTES, MAX_RELEASE_FILES

ROOT = Path('/srv/personal-apps')
SLUG = re.compile(r'[a-z][a-z0-9]*(?:-[a-z0-9]+)*\Z')
RELEASE = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,99}\Z')
FILE = re.compile(r'[A-Za-z0-9_@+-][A-Za-z0-9_@+./-]*\Z')


def validate_slug(value):
    if not isinstance(value, str) or len(value) > 48 or not SLUG.fullmatch(value):
        raise ValueError('Invalid app slug')
    return value


def validate_release(value):
    if not isinstance(value, str) or not RELEASE.fullmatch(value):
        raise ValueError('Invalid release ID')
    return value


class Releases:
    def __init__(self, root=ROOT, retention=5, stale_seconds=86400):
        self.root = Path(root).resolve()
        if retention < 2 or stale_seconds < 1:
            raise ValueError('Retain at least two releases and a positive upload lifetime')
        self.retention = retention
        self.stale_seconds = stale_seconds

    def safe_dir(self, *parts):
        path = self.root
        for part in parts:
            path /= part
            if path.is_symlink():
                raise ValueError('Symlink directory forbidden')
        try:
            path.resolve().relative_to(self.root)
        except ValueError:
            raise ValueError('Path escaped deployment root') from None
        return path

    @contextlib.contextmanager
    def lock(self):
        # flock is server-side protection across different repositories/SSH keys.
        import fcntl
        with (self.root / '.deploy.lock').open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield handle

    def validate(self, folder, slug, release):
        if not folder.is_dir() or folder.is_symlink():
            raise ValueError('Release directory missing or symlinked')
        manifest_file = folder / 'release.json'
        if manifest_file.is_symlink() or manifest_file.stat().st_size > MAX_MANIFEST_BYTES:
            raise ValueError('Invalid release manifest')
        manifest = json.loads(manifest_file.read_text())
        if (manifest.get('formatVersion') != 1 or manifest.get('appId') != slug
                or manifest.get('basePath') != f'/apps/{slug}/' or manifest.get('release') != release):
            raise ValueError('Release identity/base path mismatch')
        files = manifest.get('files')
        if not isinstance(files, dict) or not 1 <= len(files) <= MAX_RELEASE_FILES:
            raise ValueError('Invalid inventory')
        required = {'index.html', 'sw.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'}
        if not required.issubset(files):
            raise ValueError('Missing required PWA files')
        actual = set()
        total = 0
        for path in folder.rglob('*'):
            mode = path.lstat().st_mode
            relative = path.relative_to(folder).as_posix()
            if path.is_symlink() or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise ValueError('Special files and symlinks forbidden')
            if any(part.startswith('.') for part in PurePosixPath(relative).parts):
                raise ValueError('Hidden paths forbidden')
            if path.is_dir():
                continue
            if relative == 'release.json':
                continue
            if not FILE.fullmatch(relative) or '..' in PurePosixPath(relative).parts:
                raise ValueError('Invalid artifact path')
            actual.add(relative)
            total += path.stat().st_size
            if total > MAX_RELEASE_BYTES:
                raise ValueError('Release exceeds 100 MiB')
            expected = files.get(relative)
            if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected):
                raise ValueError('Invalid or missing file hash')
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise ValueError('Artifact checksum mismatch')
        if actual != set(files):
            raise ValueError('Artifact inventory mismatch')
        html = (folder / 'index.html').read_text()
        if f'/apps/{slug}/assets/' not in html or re.search(r'(?:src|href)=["\']/assets/', html):
            raise ValueError('HTML has an incorrect asset base path')
        pwa = json.loads((folder / 'manifest.webmanifest').read_text())
        if pwa.get('scope') != f'/apps/{slug}/' or pwa.get('start_url') != f'/apps/{slug}/':
            raise ValueError('Manifest scope mismatch')
        return manifest

    def current(self, slug):
        link = self.root / 'apps' / slug
        if not link.is_symlink():
            if link.exists():
                raise ValueError('App path exists and is not a managed symlink')
            return None
        target = link.resolve(strict=True)
        parent = self.safe_dir('releases', slug)
        if target.parent != parent:
            raise ValueError('Current release points outside app releases')
        return validate_release(target.name)

    def switch(self, slug, release):
        destination = self.safe_dir('releases', slug, release)
        self.validate(destination, slug, release)
        previous = self.current(slug)
        history = self.safe_dir('releases', slug) / '.previous'
        pending_history = history.with_name('.previous.tmp')
        pending_history.write_text(previous or '')
        os.replace(pending_history, history)
        apps = self.safe_dir('apps')
        # Unique temporary name; atomic rename means readers see old or new release.
        temporary = apps / f'.{slug}-{os.getpid()}'
        try:
            temporary.symlink_to(f'../releases/{slug}/{release}', target_is_directory=True)
            os.replace(temporary, apps / slug)
        finally:
            temporary.unlink(missing_ok=True)
        return {'app': slug, 'active': release, 'previous': previous}

    def cleanup_locked(self):
        """Caller holds the same lock as uploads/activation. Never follow symlinks."""
        cutoff = time.time() - self.stale_seconds
        for category in ('incoming', 'releases'):
            parent = self.safe_dir(category)
            for app in parent.iterdir():
                if app.is_symlink() or not app.is_dir() or not SLUG.fullmatch(app.name):
                    continue
                validate_slug(app.name)
                active = self.current(app.name) if category == 'releases' else None
                versions = []
                for path in app.iterdir():
                    if path.is_symlink() or not path.is_dir():
                        continue
                    if category == 'incoming' or path.name.startswith('.staging-'):
                        if path.stat().st_mtime < cutoff:
                            shutil.rmtree(self.safe_dir(category, app.name, path.name))
                    elif RELEASE.fullmatch(path.name):
                        versions.append(path)
                if category == 'releases':
                    # Directory creation time (mtime), never rsync-preserved file timestamps.
                    versions.sort(key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)
                    keep = {active} if active else set()
                    history = app / '.previous'
                    if history.is_file() and not history.is_symlink():
                        previous = history.read_text()
                        if previous:
                            validate_release(previous)
                            if any(p.name == previous for p in versions):
                                keep.add(previous)
                    for path in versions:
                        if len(keep) < self.retention:
                            keep.add(path.name)
                    for path in versions:
                        if path.name not in keep:
                            shutil.rmtree(self.safe_dir('releases', app.name, path.name))

    def cleanup(self):
        with self.lock():
            self.cleanup_locked()
        return {'cleaned': True}

    def activate(self, slug, release):
        validate_slug(slug)
        validate_release(release)
        with self.lock():
            self.cleanup_locked()
            incoming = self.safe_dir('incoming', slug, release)
            self.validate(incoming, slug, release)
            require_storage(self.root, 'activation')
            parent = self.safe_dir('releases', slug)
            parent.mkdir(parents=True, exist_ok=True)
            destination = parent / release
            if destination.exists() or destination.is_symlink():
                raise ValueError('Release already exists; use a new release ID or rollback')
            # Copy into a private staging directory; validate the snapshot, not a live upload.
            staging = Path(tempfile.mkdtemp(prefix='.staging-', dir=parent))
            try:
                shutil.copytree(incoming, staging, dirs_exist_ok=True, symlinks=True)
                self.validate(staging, slug, release)
                for path in staging.rglob('*'):
                    path.chmod(0o755 if path.is_dir() else 0o644)
                staging.chmod(0o755)
                os.replace(staging, destination)
                os.utime(destination, None)
                result = self.switch(slug, release)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
            # Activation has committed. Cleanup failure must not disguise that outcome.
            try:
                shutil.rmtree(incoming)
                self.cleanup_locked()
            except OSError as error:
                result['cleanupWarning'] = str(error)
            return result

    def rollback(self, slug, release):
        validate_slug(slug)
        validate_release(release)
        with self.lock():
            return self.switch(slug, release)

    def rollback_if_current(self, slug, release, expected):
        validate_slug(slug); validate_release(release); validate_release(expected)
        with self.lock():
            current = self.current(slug)
            if current != expected:
                return {'app': slug, 'active': current, 'rolledBack': False}
            result = self.switch(slug, release)
            return {**result, 'rolledBack': True}

    def status(self, slug):
        validate_slug(slug)
        with self.lock():
            parent = self.safe_dir('releases', slug)
            versions = sorted(path.name for path in parent.iterdir() if path.is_dir() and RELEASE.fullmatch(path.name)) if parent.exists() else []
            print(json.dumps({'app': slug, 'active': self.current(slug), 'releases': versions}))


def main():
    args = sys.argv[1:]
    manager = Releases()
    if len(args) == 3 and args[0] in ('activate', 'rollback'):
        print(json.dumps(getattr(manager, args[0])(args[1], args[2])))
    elif len(args) == 4 and args[0] == 'rollback-if-current':
        print(json.dumps(manager.rollback_if_current(*args[1:])))
    elif args == ['cleanup']:
        print(json.dumps(manager.cleanup()))
    elif len(args) == 2 and args[0] == 'status':
        manager.status(args[1])
    else:
        raise ValueError('Usage: deploy-static {activate|rollback} SLUG RELEASE | rollback-if-current SLUG RELEASE EXPECTED | status SLUG | cleanup')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(f'deploy-static: {error}', file=sys.stderr)
        sys.exit(1)
