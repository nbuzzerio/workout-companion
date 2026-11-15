import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deploy_static import Releases, validate_slug, validate_release
from ssh_gateway import parse_command


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        for name in ('apps', 'releases', 'incoming'):
            (self.root / name).mkdir()
        self.manager = Releases(self.root)
        storage_patch = patch("deploy_static.require_storage")
        self.storage_check = storage_patch.start()
        self.addCleanup(storage_patch.stop)

    def tearDown(self):
        self.temporary.cleanup()

    def artifact(self, release='one', slug='workout'):
        directory = self.root / 'incoming' / slug / release
        directory.mkdir(parents=True)
        files = {
            'index.html': f'<script src="/apps/{slug}/assets/app.js"></script>',
            'assets/app.js': 'console.log("static")',
            'sw.js': '// scoped worker',
            'manifest.webmanifest': json.dumps({'scope': f'/apps/{slug}/', 'start_url': f'/apps/{slug}/'}),
            'icon-192.png': 'test', 'icon-512.png': 'test',
        }
        for name, content in files.items():
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        manifest = {'formatVersion': 1, 'appId': slug, 'basePath': f'/apps/{slug}/', 'release': release,
                    'files': {name: hashlib.sha256((directory / name).read_bytes()).hexdigest() for name in files}}
        (directory / 'release.json').write_text(json.dumps(manifest))
        return directory

    def test_slug_and_release_validation(self):
        for slug in ('../a', 'A', 'a/b', 'a--b', '-a', 'a' * 49, 'a;id', 'a\n'):
            with self.subTest(slug=slug), self.assertRaises(ValueError):
                validate_slug(slug)
        for release in ('../a', '/tmp/x', 'a;id', 'x' * 101):
            with self.assertRaises(ValueError):
                validate_release(release)
        self.assertEqual(validate_slug('workout-2'), 'workout-2')

    def test_release_validation_and_tampering(self):
        artifact = self.artifact()
        self.manager.validate(artifact, 'workout', 'one')
        (artifact / 'assets/app.js').write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.manager.validate(artifact, 'workout', 'one')

    def test_manifest_identity_scope_and_extra_files(self):
        artifact = self.artifact()
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.manager.validate(artifact, 'another', 'one')
        with self.assertRaisesRegex(ValueError, 'identity'):
            self.manager.validate(artifact, 'workout', 'another')
        (artifact / '.env').write_text('secret')
        with self.assertRaisesRegex(ValueError, 'Hidden'):
            self.manager.validate(artifact, 'workout', 'one')
        (artifact / '.env').unlink()
        (artifact / 'extra.txt').write_text('extra')
        with self.assertRaises(ValueError):
            self.manager.validate(artifact, 'workout', 'one')

    def test_rejects_bad_html_and_pwa_scope_even_with_matching_hashes(self):
        artifact = self.artifact()
        manifest = json.loads((artifact / 'release.json').read_text())
        for filename, content in [('index.html', '<script src="/assets/app.js"></script>'),
                                  ('manifest.webmanifest', '{"scope":"/","start_url":"/"}')]:
            original = (artifact / filename).read_text()
            (artifact / filename).write_text(content)
            manifest['files'][filename] = hashlib.sha256((artifact / filename).read_bytes()).hexdigest()
            (artifact / 'release.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                self.manager.validate(artifact, 'workout', 'one')
            (artifact / filename).write_text(original)
            manifest['files'][filename] = hashlib.sha256((artifact / filename).read_bytes()).hexdigest()

    @unittest.skipIf(os.name == 'nt', 'POSIX atomic symlinks/flock run in Linux CI')
    def test_activation_rollback_retention_and_failure_preserves_current(self):
        self.artifact('one'); self.artifact('two')
        with contextlib.redirect_stdout(io.StringIO()):
            self.manager.activate('workout', 'one')
            self.manager.activate('workout', 'two')
            self.assertEqual(self.manager.current('workout'), 'two')
            self.manager.rollback('workout', 'one')
        self.assertEqual(self.manager.current('workout'), 'one')
        self.assertTrue((self.root / 'releases/workout/two/index.html').is_file())
        self.artifact('bad'); (self.root / 'incoming/workout/bad/index.html').write_text('bad')
        with self.assertRaises(ValueError):
            self.manager.activate('workout', 'bad')
        self.assertEqual(self.manager.current('workout'), 'one')
        with self.assertRaises(ValueError):
            self.manager.rollback('workout', 'missing')
        self.assertEqual(self.manager.current('workout'), 'one')

    @unittest.skipIf(os.name == 'nt', 'POSIX symlink escape test runs in Linux CI')
    def test_symlink_artifacts_and_upload_paths_rejected(self):
        artifact = self.artifact()
        (artifact / 'escape').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):
            self.manager.validate(artifact, 'workout', 'one')
        (self.root / 'incoming/other').symlink_to('/tmp')
        with self.assertRaises(ValueError):
            parse_command(f'rsync --server -tre.iLsfxCIvu --delete . {self.root}/incoming/other/one/', self.root)

    def test_forced_command_allowlist(self):
        destination = f'{self.root.as_posix()}/incoming/workout/one/'
        command = f'rsync --server -tre.iLsfxCIvu --delete . {shlex.quote(destination)}'
        self.assertEqual(parse_command(command, Path(self.root.as_posix()))[0], '/usr/bin/rsync')
        self.assertIn('activate', parse_command('deploy-static activate workout one'))
        self.assertIn('status', parse_command('deploy-static status workout'))
        self.assertIn('rollback-if-current', parse_command('deploy-static rollback-if-current workout one two'))
        self.assertIn('cleanup', parse_command('deploy-static cleanup'))
        for command in ['bash', 'deploy-static activate ../x one', 'deploy-static status workout; id',
                        'deploy-static rollback-if-current workout one ../two', 'deploy-static cleanup extra',
                        'rsync --server --sender . /etc/',
                        'rsync --server -ltre.iLsfxCIvu --delete . /srv/personal-apps/incoming/workout/one/',
                        'rsync --server -tre.iLsfxCIvu --delete . /etc/',
                        'rsync --server -tre.iLsfxCIvu --delete . /srv/personal-apps/incoming/../one/']:
            with self.subTest(command=command), self.assertRaises(ValueError):
                parse_command(command)

    @unittest.skipIf(os.name == 'nt' or not shutil.which('rsync'), 'Requires Linux rsync; runs in CI')
    def test_actual_rsync_protocol_passes_gateway(self):
        source = self.root / 'source'; source.mkdir(); (source / 'index.html').write_text('test upload')
        transport = self.root / 'transport.py'
        transport.write_text('''import os,sys
from pathlib import Path
sys.path.insert(0, os.environ['TEST_INFRA'])
from ssh_gateway import parse_command
import shlex
args = parse_command(shlex.join(sys.argv[2:]), Path(os.environ['TEST_ROOT']))
Path(args[-1]).mkdir(parents=True, exist_ok=True)
os.execv(args[0], [args[0], '--timeout=300', *args[1:]])
''')
        environment = {**os.environ, 'TEST_ROOT': str(self.root), 'TEST_INFRA': str(Path(__file__).resolve().parents[1])}
        subprocess.run(['rsync', '-rt', '--delete', '-e', shlex.join([sys.executable, str(transport)]),
                        f'{source}/', f'dummy:{self.root}/incoming/workout/upload/'], check=True, env=environment, capture_output=True)
        self.assertEqual((self.root / 'incoming/workout/upload/index.html').read_text(), 'test upload')


if __name__ == '__main__':
    unittest.main()
