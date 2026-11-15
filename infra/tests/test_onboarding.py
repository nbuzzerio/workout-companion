"""Offline tests: synthetic PUBLIC host keys and a fake GitHub API only."""
import base64
import hashlib
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from verify_host_key import discover, verified_known_hosts, validate_target


def public_blob(byte=1):
    return struct.pack('>I', 11) + b'ssh-ed25519' + struct.pack('>I', 32) + bytes([byte]) * 32


def fingerprint(blob):
    return 'SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip('=')


def entry(host='example.com', port='22', blob=None):
    target = host if port == '22' else f'[{host}]:{port}'
    return f'{target} ssh-ed25519 {base64.b64encode(blob or public_blob()).decode()}\n'


class FingerprintVerification(unittest.TestCase):
    def test_authenticated_key_and_identical_duplicates_with_scan_comments(self):
        for host, port in [('example.com', '22'), ('192.0.2.1', '2222')]:
            line = entry(host, port)
            self.assertEqual(verified_known_hosts('# banner\n' + line * 3, host, port,
                                                 fingerprint(public_blob())), line)

    def test_wrong_pin_or_multiple_distinct_keys_are_rejected_even_if_one_matches(self):
        with self.assertRaisesRegex(ValueError, 'does not match'):
            verified_known_hosts(entry(), 'example.com', '22', fingerprint(public_blob(2)))
        with self.assertRaisesRegex(ValueError, 'ambiguous'):
            verified_known_hosts(entry() + entry(blob=public_blob(2)), 'example.com', '22', fingerprint(public_blob()))

    def test_missing_injected_malformed_truncated_and_non_ed25519_entries_fail_closed(self):
        for scan in ['', '# only a banner\n', 'a' * 65537, entry(host='other.example.com'),
                     entry(port='2222'), entry().replace('ssh-ed25519 ', 'ssh-rsa '),
                     entry() + 'invalid line\n', entry().strip() + ' comment\n',
                     'example.com ssh-ed25519 !!!\n', entry(blob=public_blob()[:-1]),
                     entry(blob=public_blob() + b'extra'), entry(blob=b'not an SSH key'),
                     entry().replace('example.com', 'example.com,evil.example')]:
            with self.subTest(scan=scan[:80]), self.assertRaises(ValueError):
                verified_known_hosts(scan, 'example.com', '22', fingerprint(public_blob()))

    def test_input_validation_and_canonical_pin(self):
        pin = fingerprint(public_blob())
        for host, port, value in [('', '22', pin), ('-x', '22', pin), ('x;echo', '22', pin),
                                 ('user@host', '22', pin), ('https://host', '22', pin),
                                 ('::1', '22', pin), ('host', '', pin), ('host', '0', pin),
                                 ('host', '65536', pin), ('host', '022', pin),
                                 ('host', '22', ''), ('host', '22', pin + '='),
                                 ('host', '22', 'SHA256:' + 'A' * 42 + 'B')]:
            with self.subTest(host=host, port=port, pin=value), self.assertRaises(ValueError):
                validate_target(host, port, value)

    def test_discovery_is_bounded_and_failure_never_replaces_trusted_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'known_hosts'
            path.write_text('existing trust\n')
            for error in [subprocess.CalledProcessError(1, 'ssh-keyscan'),
                          subprocess.TimeoutExpired('ssh-keyscan', 30), OSError('unavailable')]:
                with patch('verify_host_key.subprocess.run', side_effect=error), self.assertRaises(type(error)):
                    discover('example.com', '22', fingerprint(public_blob()), path)
                self.assertEqual(path.read_text(), 'existing trust\n')
            result = subprocess.CompletedProcess([], 0, stdout=entry(), stderr='banner')
            with patch('verify_host_key.subprocess.run', return_value=result) as scan:
                with self.assertRaises(ValueError):
                    discover('example.com', '22', fingerprint(public_blob(2)), path)
                self.assertEqual(path.read_text(), 'existing trust\n')
                discover('example.com', '22', fingerprint(public_blob()), path)
                self.assertEqual(path.read_text(), entry())
                self.assertEqual(scan.call_args.args[0], ['ssh-keyscan', '-T', '10', '-p', '22', '-t', 'ed25519', 'example.com'])
                self.assertEqual(scan.call_args.kwargs['timeout'], 30)
                self.assertTrue(scan.call_args.kwargs['check'])
                if os.name != 'nt':
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class WorkflowConfiguration(unittest.TestCase):
    def test_configuration_and_security_protocol_remain_wired(self):
        workflow = (ROOT / '.github/workflows/ci-deploy.yml').read_text()
        for name in ('DEPLOY_HOST', 'DEPLOY_PORT', 'DEPLOY_USER', 'DEPLOY_HOST_FINGERPRINT', 'PUBLIC_ORIGIN', 'PRODUCTION_BRANCH', 'ENABLE_DEPLOYMENT'):
            self.assertIn('vars.' + name, workflow)
            self.assertNotIn('secrets.' + name, workflow)
        self.assertEqual(workflow.count('secrets.'), 1)
        self.assertIn('secrets.DEPLOY_SSH_KEY', workflow)
        self.assertNotIn('DEPLOY_KNOWN_HOSTS', workflow)
        self.assertNotIn('DEPLOY_PORT:-22', workflow)
        self.assertLess(workflow.index('python3 scripts/verify_host_key.py'), workflow.index('rsync -rt --delete'))
        for source in (workflow, (ROOT / 'scripts/activate_checked.py').read_text()):
            for option in ('StrictHostKeyChecking=yes', 'HostKeyAlgorithms=ssh-ed25519', 'GlobalKnownHostsFile=/dev/null', 'UserKnownHostsFile=', 'IdentitiesOnly=yes'):
                self.assertIn(option, source)
        for safeguard in ('environment: production', 'cancel-in-progress: false', 'python3 scripts/activate_checked.py', 'rollback-if-current', 'pnpm test:e2e', 'nginx_integration.py', 'persist-credentials: false'):
            self.assertIn(safeguard, workflow)
        self.assertIn('shell: powershell', workflow)
        self.assertIn('needs: onboarding', workflow)

    def test_powershell_mock_api_suite(self):
        # WSL may expose powershell.exe but its POSIX paths are not Windows paths.
        shell = shutil.which('powershell.exe') if os.name == 'nt' else shutil.which('pwsh')
        if not shell:
            self.skipTest('PowerShell suite runs on Windows with built-in Windows PowerShell')
        result = subprocess.run([shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
                                 str(ROOT / 'scripts/tests/onboarding.tests.ps1')],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('All onboarding tests passed', result.stdout)

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell entry points run on Windows')
    def test_entry_points_reject_invalid_or_missing_endpoint_before_authentication(self):
        shell = shutil.which('powershell.exe')
        common = [shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']
        script = ROOT / 'scripts/Initialize-GitHubDeployment.ps1'
        arguments = ['-Repository', 'nbuzzerio/workout-companion', '-AppSlug', 'workout',
                     '-HostFingerprint', 'SHA256:n7iJc5pZSQW+qDGbDpkIOL0ipHwNSyWoujgL3+YE3y0',
                     '-PublicOrigin', 'https://www.nickbuzzerio.com']
        for endpoint in ([], ['-DeployHost', 'bad@host', '-DeployPort', '22'],
                         ['-DeployHost', 'example.com', '-DeployPort', '0']):
            result = subprocess.run(common + [str(script)] + arguments + endpoint,
                                    capture_output=True, text=True, timeout=20)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn('GitHub API token (masked', result.stdout)
        wrapper = ROOT / 'scripts/Initialize-WorkoutDeployment.ps1'
        if wrapper.exists():
            for expected in ("-Repository 'nbuzzerio/workout-companion'", "-AppSlug 'workout'",
                             "-ProductionBranch 'main'", "-PublicOrigin 'https://www.nickbuzzerio.com'",
                             "-DeployUser 'personal-deploy'", "-HostFingerprint 'SHA256:n7iJc5pZSQW+qDGbDpkIOL0ipHwNSyWoujgL3+YE3y0'"):
                self.assertIn(expected, wrapper.read_text())
            result = subprocess.run(common + [str(wrapper), '-DeployHost', 'bad@host', '-DeployPort', '22'],
                                    capture_output=True, text=True, timeout=20)
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn('GitHub API token (masked', result.stdout)
