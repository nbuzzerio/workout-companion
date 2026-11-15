import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from deployment_policy import deployment_allowed
from storage_guard import require_storage, DEFAULT_RESERVE_BYTES, MAX_RELEASE_BYTES, MAX_MANIFEST_BYTES, SAFETY_BYTES
import test_deploy


def space(available, inodes=1000000):
    return SimpleNamespace(f_bavail=available, f_frsize=1, f_favail=inodes)


class DeploymentOptIn(unittest.TestCase):
    def test_missing_or_inexact_opt_in_never_deploys(self):
        for enabled in (None, '', 'false', 'TRUE', 'True', ' true', 'true ', '1'):
            for event in ('push', 'pull_request', 'workflow_dispatch'):
                self.assertFalse(deployment_allowed(enabled, event, 'refs/heads/main'))

    def test_explicit_opt_in_still_requires_event_and_production_branch(self):
        for event in ('push', 'workflow_dispatch'):
            self.assertTrue(deployment_allowed('true', event, 'refs/heads/main'))
            self.assertTrue(deployment_allowed('true', event, 'refs/heads/release', 'release'))
            self.assertFalse(deployment_allowed('true', event, 'refs/heads/other'))
        self.assertFalse(deployment_allowed('true', 'pull_request', 'refs/heads/main'))
        self.assertFalse(deployment_allowed('true', 'push', 'refs/tags/main'))

    def test_workflow_wires_policy_output_into_deploy_job_without_gating_ci(self):
        workflow = (Path(__file__).resolve().parents[2] / '.github/workflows/ci-deploy.yml').read_text()
        self.assertIn('ENABLE_DEPLOYMENT: ${{ vars.ENABLE_DEPLOYMENT }}', workflow)
        self.assertIn('python3 scripts/deployment_policy.py', workflow)
        check, deploy = workflow.split('  deploy:\n')
        self.assertNotIn('\n    if:', check)
        self.assertIn("needs.check.outputs.deploy_allowed == 'true' &&", deploy)
        self.assertIn("github.ref == format('refs/heads/{0}'", deploy)
        self.assertIn('python3 scripts/activate_checked.py', deploy)
        self.assertIn('environment: production', deploy)


class DiskReserve(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ('apps', 'incoming', 'releases'): (self.root / name).mkdir()
        self.policy = self.root / 'not-configured.json'

    def check(self, available, phase='upload', inodes=1000000):
        with patch('storage_guard.os.statvfs', return_value=space(available, inodes), create=True):
            return require_storage(self.root, phase, self.policy)

    def test_upload_accounts_for_both_copies_and_overhead_and_excludes_root_reserved_blocks(self):
        required = DEFAULT_RESERVE_BYTES + 2 * (MAX_RELEASE_BYTES + MAX_MANIFEST_BYTES) + SAFETY_BYTES
        with self.assertRaisesRegex(ValueError, 'Insufficient'): self.check(required - 1)
        self.assertEqual(self.check(required)['requiredBytes'], required)

    def test_activation_needs_a_staging_copy_and_reserve(self):
        required = DEFAULT_RESERVE_BYTES + MAX_RELEASE_BYTES + MAX_MANIFEST_BYTES + SAFETY_BYTES
        with self.assertRaisesRegex(ValueError, 'activation'): self.check(required - 1, 'activation')
        self.assertEqual(self.check(required, 'activation')['requiredBytes'], required)
        with self.assertRaises(ValueError): self.check(20 * 1024**3, inodes=1)

    def test_configured_reserve_and_invalid_or_legacy_config_fail_closed(self):
        self.policy.write_text(json.dumps({'minFreeBytes': 4 * 1024**3}))
        original = Path.lstat
        def metadata(path, *args, **kwargs):
            if path == self.policy: return SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o644)
            return original(path, *args, **kwargs)
        with patch.object(Path, 'lstat', metadata):
            self.assertEqual(self.check(10 * 1024**3)['minFreeBytes'], 4 * 1024**3)
            for invalid in ({'enabled': True}, {'minFreeBytes': -1}, {'minFreeBytes': True}):
                self.policy.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError): self.check(10 * 1024**3)


@unittest.skipIf(os.name == 'nt', 'Linux activation requires flock/symlinks')
class ActivationReserve(unittest.TestCase):
    setUp = test_deploy.DeployTests.setUp
    tearDown = test_deploy.DeployTests.tearDown
    artifact = test_deploy.DeployTests.artifact

    def test_drop_in_space_blocks_activation_before_staging_preserving_current(self):
        self.artifact('one'); self.manager.activate('workout', 'one')
        self.artifact('two')
        self.storage_check.side_effect = lambda root, phase: require_storage(root, phase, self.root / 'missing-policy')
        with patch('storage_guard.os.statvfs', return_value=space(DEFAULT_RESERVE_BYTES)):
            with self.assertRaisesRegex(ValueError, 'Insufficient'): self.manager.activate('workout', 'two')
        self.assertEqual(self.manager.current('workout'), 'one')
        self.assertFalse((self.root / 'releases/workout/two').exists())
        self.assertEqual(list((self.root / 'releases/workout').glob('.staging-*')), [])

    def test_healthy_space_permits_normal_activation(self):
        self.artifact('healthy')
        self.storage_check.side_effect = lambda root, phase: require_storage(root, phase, self.root / 'missing-policy')
        with patch('storage_guard.os.statvfs', return_value=space(10 * 1024**3)):
            self.assertEqual(self.manager.activate('workout', 'healthy')['active'], 'healthy')
