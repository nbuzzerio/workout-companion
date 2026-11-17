import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { deploymentAllowed } from '../../scripts/deployment_policy.mjs';
import { checkRelease, previousRelease } from '../../scripts/release_health.mjs';
import { requireStorage, DEFAULT_RESERVE_BYTES, MAX_RELEASE_BYTES, MAX_MANIFEST_BYTES, SAFETY_BYTES } from '../storage_guard.mjs';
import { fixture, repository, linux } from './fixtures.mjs';

test('missing or inexact opt-in never deploys', () => {
  for (const enabled of [null, '', 'false', 'TRUE', 'True', ' true', 'true ', '1']) {
    for (const event of ['push', 'pull_request', 'workflow_dispatch']) assert.equal(deploymentAllowed(enabled, event, 'refs/heads/main'), false);
  }
});
test('explicit opt-in still requires event and production branch', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    assert.equal(deploymentAllowed('true', event, 'refs/heads/main'), true);
    assert.equal(deploymentAllowed('true', event, 'refs/heads/release', 'release'), true);
    assert.equal(deploymentAllowed('true', event, 'refs/heads/other'), false);
  }
  assert.equal(deploymentAllowed('true', 'pull_request', 'refs/heads/main'), false);
  assert.equal(deploymentAllowed('true', 'push', 'refs/tags/main'), false);
});
test('workflow gates deployment without gating CI', () => {
  const workflow = fs.readFileSync(path.join(repository, '.github/workflows/ci-deploy.yml'), 'utf8');
  assert.ok(workflow.includes('ENABLE_DEPLOYMENT: ${{ vars.ENABLE_DEPLOYMENT }}'));
  assert.ok(workflow.includes('node scripts/deployment_policy.mjs'));
  const [check, deploy] = workflow.split('  deploy:\n');
  assert.ok(!check.includes('\n    if:'));
  for (const expected of ["needs.check.outputs.deploy_allowed == 'true' &&", "github.ref == format('refs/heads/{0}'", 'node scripts/activate_checked.mjs', 'environment: production']) assert.ok(deploy.includes(expected), expected);
  assert.ok(deploy.indexOf('actions/setup-node@') < deploy.indexOf('node scripts/verify_host_key.mjs'));
});
function check(root, available, phase = 'upload', inodes = 1000000, policy = path.join(root, 'missing-policy'), extra = {}) {
  return requireStorage(root, phase, policy, { ...fs, statfsSync: () => ({ bavail: BigInt(available), bsize: 1n, ffree: BigInt(inodes) }), ...extra });
}
test('upload accounts for two copies, overhead and non-reserved blocks', t => {
  const { root } = fixture(t); const required = DEFAULT_RESERVE_BYTES + 2 * (MAX_RELEASE_BYTES + MAX_MANIFEST_BYTES) + SAFETY_BYTES;
  assert.throws(() => check(root, required - 1), /Insufficient/); assert.equal(check(root, required).requiredBytes, required);
  assert.throws(() => requireStorage(root, 'upload', path.join(root, 'missing'), { ...fs, statfsSync: () => ({ bavail: 1n, bfree: BigInt(required), bsize: 1n, ffree: 1000000n }) }), /Insufficient/);
});
test('activation needs staging copy and reserve; inode admission', t => {
  const { root } = fixture(t); const required = DEFAULT_RESERVE_BYTES + MAX_RELEASE_BYTES + MAX_MANIFEST_BYTES + SAFETY_BYTES;
  assert.throws(() => check(root, required - 1, 'activation'), /activation/); assert.equal(check(root, required, 'activation').requiredBytes, required);
  assert.throws(() => check(root, 20 * 1024 ** 3, 'upload', 1));
  assert.throws(() => check(root, required, 'other'), /phase/);
});
test('configured reserve and invalid or legacy configuration fail closed', t => {
  const { root } = fixture(t); const policy = path.join(root, 'storage.json');
  const metadata = { lstatSync: (file, options) => file === policy ? { uid: 0, mode: 0o100644, isFile: () => true } : fs.lstatSync(file, options) };
  fs.writeFileSync(policy, JSON.stringify({ minFreeBytes: 4 * 1024 ** 3 }));
  assert.equal(check(root, 10 * 1024 ** 3, 'upload', 1000000, policy, metadata).minFreeBytes, 4 * 1024 ** 3);
  for (const invalid of [{ enabled: true }, { minFreeBytes: -1 }, { minFreeBytes: true }, { minFreeBytes: 1.5 }, { minFreeBytes: Number.MAX_SAFE_INTEGER + 1 }, null, []]) {
    fs.writeFileSync(policy, JSON.stringify(invalid)); assert.throws(() => check(root, 10 * 1024 ** 3, 'upload', 1000000, policy, metadata));
  }
});
test('untrusted policy ownership, mode and type are rejected', t => {
  const { root } = fixture(t); const policy = path.join(root, 'storage.json');
  for (const info of [{ uid: 1, mode: 0o100644, isFile: () => true }, { uid: 0, mode: 0o100666, isFile: () => true }, { uid: 0, mode: 0o120777, isFile: () => false }]) {
    assert.throws(() => check(root, 10 * 1024 ** 3, 'upload', 1000000, policy, { lstatSync: (p, options) => p === policy ? info : fs.lstatSync(p, options) }), /root-owned/);
  }
});
test('deployment filesystem mismatch fails closed', t => {
  const { root } = fixture(t);
  assert.throws(() => check(root, 10 * 1024 ** 3, 'upload', 1000000, undefined, { statSync: p => ({ dev: p === root ? 1 : 2 }) }), /filesystem/);
});
test('drop in space blocks activation before staging, preserving current', { skip: !linux }, t => {
  const { root, manager, artifact } = fixture(t); artifact('one'); manager.activate('workout', 'one'); artifact('two');
  manager.storage = (root, phase) => check(root, DEFAULT_RESERVE_BYTES, phase);
  assert.throws(() => manager.activate('workout', 'two'), /Insufficient/);
  assert.equal(manager.current('workout'), 'one'); assert.ok(!fs.existsSync(path.join(root, 'releases/workout/two')));
  assert.deepEqual(fs.readdirSync(path.join(root, 'releases/workout')).filter(name => name.startsWith('.staging-')), []);
});
test('healthy space permits normal activation', { skip: !linux }, t => {
  const { manager, artifact } = fixture(t); artifact('healthy');
  manager.storage = (root, phase) => check(root, 10 * 1024 ** 3, phase);
  assert.equal(manager.activate('workout', 'healthy').active, 'healthy');
});
test('public release identity and previous-release extraction fail closed', () => {
  checkRelease({ appId: 'workout', release: 'one' }, 'workout', 'one');
  for (const manifest of [null, {}, { appId: 'other', release: 'one' }, { appId: 'workout', release: 'old' }]) assert.throws(() => checkRelease(manifest, 'workout', 'one'));
  assert.equal(previousRelease({ previous: null }), ''); assert.equal(previousRelease({ previous: 'one' }), 'one');
  for (const activation of [{}, { previous: '../bad' }, { previous: false }]) assert.throws(() => previousRelease(activation));
});
