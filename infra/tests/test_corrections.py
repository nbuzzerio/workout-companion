import multiprocessing
import os
from pathlib import Path
import sys
import subprocess
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from activate_checked import activate_checked
import test_deploy
from deploy_static import Releases
from storage_guard import require_storage
import ssh_gateway


def cleanup_worker(root, started, done):
    started.set()
    Releases(root).cleanup()
    done.set()


class OrderingTests(unittest.TestCase):
    def test_newer_finishes_first_then_older_run_and_rerun_are_rejected(self):
        head = ['B']; active = []
        activate_checked('B', lambda: head[0], lambda: active.append('B'))
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, 'Stale'):
                activate_checked('A', lambda: head[0], lambda: active.append('A'))
        self.assertEqual(active, ['B'])

    def test_head_read_after_upload_and_network_errors_fail_closed(self):
        called = []
        def unavailable():
            raise OSError('API unavailable')
        with self.assertRaises(OSError):
            activate_checked('A', unavailable, lambda: called.append('activated'))
        self.assertEqual(called, [])



@unittest.skipIf(os.name == 'nt', 'POSIX lock and symlink regression tests run on Linux')
class ReleaseCorrections(unittest.TestCase):
    setUp = test_deploy.DeployTests.setUp
    tearDown = test_deploy.DeployTests.tearDown
    artifact = test_deploy.DeployTests.artifact
    def test_conditional_rollback_does_not_override_owner_or_new_deployment(self):
        for version in ('p', 'a', 'b'):
            self.artifact(version)
        self.manager.activate('workout', 'p')
        result = self.manager.activate('workout', 'a')
        self.assertEqual(result['previous'], 'p')
        self.manager.activate('workout', 'b')
        self.assertFalse(self.manager.rollback_if_current('workout', 'p', 'a')['rolledBack'])
        self.assertEqual(self.manager.current('workout'), 'b')
        self.manager.rollback('workout', 'p')
        self.assertFalse(self.manager.rollback_if_current('workout', 'b', 'a')['rolledBack'])
        self.assertEqual(self.manager.current('workout'), 'p')
        self.manager.rollback('workout', 'a')
        self.assertTrue(self.manager.rollback_if_current('workout', 'p', 'a')['rolledBack'])

    def test_retention_preserves_active_and_actual_previous_after_old_manual_rollback(self):
        for i in range(7):
            self.artifact(f'r{i}'); self.manager.activate('workout', f'r{i}')
        parent = self.root / 'releases/workout'
        self.assertEqual(len([p for p in parent.iterdir() if p.is_dir()]), 5)
        self.manager.rollback('workout', 'r2')
        self.artifact('r7'); self.assertEqual(self.manager.activate('workout', 'r7')['previous'], 'r2')
        self.manager.cleanup()
        self.assertTrue((parent / 'r2').exists())
        self.assertEqual(len([p for p in parent.iterdir() if p.is_dir()]), 5)
        self.assertTrue(self.manager.rollback_if_current('workout', 'r2', 'r7')['rolledBack'])

    def test_stale_cleanup_leaves_fresh_uploads_and_does_not_follow_symlinks(self):
        stale = self.artifact('stale'); fresh = self.artifact('fresh')
        os.utime(stale, (1, 1))
        (self.root / 'incoming/workout/escape').symlink_to(self.root / 'apps')
        self.manager.cleanup()
        self.assertFalse(stale.exists()); self.assertTrue(fresh.exists())
        self.assertTrue((self.root / 'apps').exists())

    def test_gateway_holds_lock_for_upload_and_cleanup_waits(self):
        destination = self.root / 'incoming/workout/upload'
        context = multiprocessing.get_context('spawn')
        started = context.Event(); done = context.Event()
        child = context.Process(target=cleanup_worker, args=(self.root, started, done))
        def receive(*args, **kwargs):
            self.assertTrue(kwargs['pass_fds'])
            self.assertIn('--timeout=300', args[0])
            child.start(); self.assertTrue(started.wait(5)); self.assertFalse(done.wait(0.2))
            return type('Result', (), {'returncode': 0})()
        try:
            with patch.object(ssh_gateway, 'parse_command', return_value=['/usr/bin/rsync', str(destination)]), \
                 patch.object(ssh_gateway, 'Releases', return_value=self.manager), \
                 patch('storage_guard.require_storage'), patch.object(ssh_gateway.subprocess, 'run', side_effect=receive):
                with self.assertRaises(SystemExit) as result: ssh_gateway.main()
                self.assertEqual(result.exception.code, 0)
            self.assertTrue(done.wait(5)); self.assertTrue(destination.exists())
        finally:
            if child.pid:
                child.join(5)
                if child.is_alive(): child.terminate(); child.join()

    def test_free_space_guard_refuses_upload_before_mkdir_or_rsync(self):
        destination = self.root / 'incoming/workout/denied'
        with patch.object(ssh_gateway, 'parse_command', return_value=['/usr/bin/rsync', str(destination)]), \
             patch.object(ssh_gateway, 'Releases', return_value=self.manager), \
             patch('storage_guard.require_storage', side_effect=ValueError('Insufficient free space')), \
             patch.object(ssh_gateway.subprocess, 'run') as receiver:
            with self.assertRaisesRegex(ValueError, 'Insufficient free space'): ssh_gateway.main()
        self.assertFalse(destination.exists()); receiver.assert_not_called()

    def test_receiver_inherited_lock_survives_gateway_lock_context_exit(self):
        context = multiprocessing.get_context('spawn')
        started = context.Event(); done = context.Event()
        cleaner = context.Process(target=cleanup_worker, args=(self.root, started, done))
        destination = self.root / 'incoming/workout/receiver'
        destination.mkdir(parents=True)
        with self.manager.lock() as handle:
            receiver = subprocess.Popen(['/usr/bin/rsync', '--timeout=300', '--server',
                                         '-tre.iLsfxCIvu', '--delete', '.', str(destination) + '/'],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, pass_fds=(handle.fileno(),))
        try:
            cleaner.start(); self.assertTrue(started.wait(5)); self.assertFalse(done.wait(0.2))
            receiver.communicate(timeout=5)
            self.assertTrue(done.wait(5))
        finally:
            if receiver.poll() is None: receiver.kill(); receiver.wait()
            cleaner.join(5)
            if cleaner.is_alive(): cleaner.terminate(); cleaner.join()

    def test_cleanup_failure_after_switch_returns_committed_activation(self):
        self.artifact('one')
        import shutil
        original = shutil.rmtree
        def fail_incoming(path, *args, **kwargs):
            if Path(path) == self.root / 'incoming/workout/one': raise OSError('cleanup failed')
            return original(path, *args, **kwargs)
        with patch('deploy_static.shutil.rmtree', side_effect=fail_incoming):
            result = self.manager.activate('workout', 'one')
        self.assertEqual(result['active'], 'one'); self.assertIn('cleanupWarning', result)
        self.assertEqual(self.manager.current('workout'), 'one')
