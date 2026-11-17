/** Offline tests: synthetic PUBLIC host keys and the existing fake GitHub API. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { discover, verifiedKnownHosts, validateTarget } from '../../scripts/verify_host_key.mjs';
import { fixture, repository } from './fixtures.mjs';

const publicBlob = (byte = 1) => Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, byte)]);
const fingerprint = blob => 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
const entry = (host = 'example.com', port = '22', blob = publicBlob()) => `${port === '22' ? host : `[${host}]:${port}`} ssh-ed25519 ${blob.toString('base64')}\n`;
test('authenticated key, duplicates and scan comments', () => {
  for (const [host, port] of [['example.com', '22'], ['192.0.2.1', '2222']]) {
    const line = entry(host, port); assert.equal(verifiedKnownHosts('# banner\n' + line.repeat(3), host, port, fingerprint(publicBlob())), line);
  }
});
test('wrong pin and multiple distinct keys rejected even if one matches', () => {
  assert.throws(() => verifiedKnownHosts(entry(), 'example.com', '22', fingerprint(publicBlob(2))), /does not match/);
  assert.throws(() => verifiedKnownHosts(entry() + entry('example.com', '22', publicBlob(2)), 'example.com', '22', fingerprint(publicBlob())), /ambiguous/);
});
test('missing, injected, malformed, truncated and non-ED25519 entries fail closed', () => {
  for (const scan of ['', '# only a banner\n', 'a'.repeat(65537), entry('other.example.com'), entry('example.com', '2222'),
    entry().replace('ssh-ed25519 ', 'ssh-rsa '), entry() + 'invalid line\n', entry().trim() + ' comment\n',
    'example.com ssh-ed25519 !!!\n', entry('example.com', '22', publicBlob().subarray(0, -1)),
    entry('example.com', '22', Buffer.concat([publicBlob(), Buffer.from('extra')])), entry('example.com', '22', Buffer.from('not an SSH key')),
    entry().replace('example.com', 'example.com,evil.example')]) {
    assert.throws(() => verifiedKnownHosts(scan, 'example.com', '22', fingerprint(publicBlob())), scan.slice(0, 80));
  }
});
test('target input validation and canonical pin', () => {
  const pin = fingerprint(publicBlob());
  for (const [host, port, value] of [['', '22', pin], ['-x', '22', pin], ['x;echo', '22', pin], ['user@host', '22', pin],
    ['https://host', '22', pin], ['::1', '22', pin], ['host', '', pin], ['host', '0', pin], ['host', '65536', pin], ['host', '022', pin],
    ['host', '22', ''], ['host', '22', pin + '='], ['host', '22', 'SHA256:' + 'A'.repeat(42) + 'B'], ['host\n', '22', pin], ['host', '22\n', pin]]) assert.throws(() => validateTarget(host, port, value));
});
test('bounded discovery; failures never replace trusted file; atomic private output', t => {
  const { root } = fixture(t); const destination = path.join(root, 'known_hosts'); fs.writeFileSync(destination, 'existing trust\n');
  for (const code of ['ENOENT', 'ETIMEDOUT', 'EXIT_1']) {
    assert.throws(() => discover('example.com', '22', fingerprint(publicBlob()), destination, () => { throw Object.assign(new Error(code), { code }); }), { code });
    assert.equal(fs.readFileSync(destination, 'utf8'), 'existing trust\n');
  }
  const scan = (command, args, options) => {
    assert.equal(command, 'ssh-keyscan'); assert.deepEqual(args, ['-T', '10', '-p', '22', '-t', 'ed25519', 'example.com']);
    assert.equal(options.timeout, 30000); assert.equal(options.maxBuffer, 65536); return entry();
  };
  assert.throws(() => discover('example.com', '22', fingerprint(publicBlob(2)), destination, scan));
  assert.equal(fs.readFileSync(destination, 'utf8'), 'existing trust\n');
  discover('example.com', '22', fingerprint(publicBlob()), destination, scan); assert.equal(fs.readFileSync(destination, 'utf8'), entry());
  if (process.platform !== 'win32') assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.known-hosts-')));
});
test('configuration and security protocol remain wired', () => {
  const workflow = fs.readFileSync(path.join(repository, '.github/workflows/ci-deploy.yml'), 'utf8');
  for (const name of ['DEPLOY_HOST', 'DEPLOY_PORT', 'DEPLOY_USER', 'DEPLOY_HOST_FINGERPRINT', 'PUBLIC_ORIGIN', 'PRODUCTION_BRANCH', 'ENABLE_DEPLOYMENT']) {
    assert.ok(workflow.includes('vars.' + name)); assert.ok(!workflow.includes('secrets.' + name));
  }
  assert.equal(workflow.split('secrets.').length - 1, 1); assert.ok(workflow.includes('secrets.DEPLOY_SSH_KEY'));
  assert.ok(!workflow.includes('DEPLOY_KNOWN_HOSTS')); assert.ok(!workflow.includes('DEPLOY_PORT:-22'));
  assert.ok(workflow.indexOf('node scripts/verify_host_key.mjs') < workflow.indexOf('rsync -rt --delete'));
  for (const source of [workflow, fs.readFileSync(path.join(repository, 'scripts/activate_checked.mjs'), 'utf8')]) {
    for (const option of ['StrictHostKeyChecking=yes', 'HostKeyAlgorithms=ssh-ed25519', 'GlobalKnownHostsFile=/dev/null', 'UserKnownHostsFile=', 'IdentitiesOnly=yes']) assert.ok(source.includes(option), option);
  }
  for (const safeguard of ['environment: production', 'cancel-in-progress: false', 'node scripts/activate_checked.mjs', 'rollback-if-current', 'pnpm test:e2e', 'pnpm test:nginx', 'persist-credentials: false', 'shell: powershell', 'needs: onboarding']) assert.ok(workflow.includes(safeguard), safeguard);
  assert.ok(!/python|\.py\b/i.test(workflow));
});
const windows = process.platform === 'win32';
const shell = windows ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'pwsh';
test('PowerShell mock API suite', t => {
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repository, 'scripts/tests/onboarding.tests.ps1')], { encoding: 'utf8', timeout: 60000 });
  if (!windows && result.error?.code === 'ENOENT') { t.skip('PowerShell suite runs on Windows'); return; }
  assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /All onboarding tests passed/);
});
test('entry points reject invalid or missing endpoint before authentication', { skip: !windows }, () => {
  const common = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'];
  const script = path.join(repository, 'scripts/Initialize-GitHubDeployment.ps1');
  const args = ['-Repository', 'nbuzzerio/workout-companion', '-AppSlug', 'workout', '-HostFingerprint', 'SHA256:n7iJc5pZSQW+qDGbDpkIOL0ipHwNSyWoujgL3+YE3y0', '-PublicOrigin', 'https://www.nickbuzzerio.com'];
  for (const endpoint of [[], ['-DeployHost', 'bad@host', '-DeployPort', '22'], ['-DeployHost', 'example.com', '-DeployPort', '0']]) {
    const result = spawnSync(shell, [...common, script, ...args, ...endpoint], { encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error); assert.notEqual(result.status, 0); assert.ok(!result.stdout.includes('GitHub API token (masked'));
  }
  const wrapper = path.join(repository, 'scripts/Initialize-WorkoutDeployment.ps1');
  for (const expected of ["-Repository 'nbuzzerio/workout-companion'", "-AppSlug 'workout'", "-ProductionBranch 'main'", "-PublicOrigin 'https://www.nickbuzzerio.com'", "-DeployUser 'personal-deploy'", "-HostFingerprint 'SHA256:n7iJc5pZSQW+qDGbDpkIOL0ipHwNSyWoujgL3+YE3y0'"]) assert.ok(fs.readFileSync(wrapper, 'utf8').includes(expected));
  const result = spawnSync(shell, [...common, wrapper, '-DeployHost', 'bad@host', '-DeployPort', '22'], { encoding: 'utf8', timeout: 20000 });
  assert.ifError(result.error); assert.notEqual(result.status, 0); assert.ok(!result.stdout.includes('GitHub API token (masked'));
});
