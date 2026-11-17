import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { activateChecked } from '../../scripts/activate_checked.mjs';
import { runGateway } from '../ssh_gateway.mjs';
import { fixture, linux, repository } from './fixtures.mjs';

test('newer finishes first; older run and rerun rejected', async () => {
  const active = [];
  await activateChecked('B', () => 'B', () => active.push('B'));
  for (let i = 0; i < 2; i++) await assert.rejects(activateChecked('A', () => 'B', () => active.push('A')), /Stale/);
  assert.deepEqual(active, ['B']);
});
test('HEAD read immediately before activation; network errors fail closed', async () => {
  const called = [];
  await assert.rejects(activateChecked('A', () => { throw new Error('API unavailable'); }, () => called.push('activated')), /API unavailable/);
  assert.deepEqual(called, []);
  await activateChecked('A', async () => { called.push('head'); return 'A'; }, () => called.push('activate'));
  assert.deepEqual(called, ['head', 'activate']);
});
test('conditional rollback cannot override owner or newer deployment', { skip: !linux }, t => {
  const { manager, artifact } = fixture(t);
  for (const version of ['p', 'a', 'b']) artifact(version);
  manager.activate('workout', 'p'); assert.equal(manager.activate('workout', 'a').previous, 'p');
  manager.activate('workout', 'b');
  assert.equal(manager.rollbackIfCurrent('workout', 'p', 'a').rolledBack, false);
  assert.equal(manager.current('workout'), 'b');
  manager.rollback('workout', 'p');
  assert.equal(manager.rollbackIfCurrent('workout', 'b', 'a').rolledBack, false);
  assert.equal(manager.current('workout'), 'p');
  manager.rollback('workout', 'a');
  assert.equal(manager.rollbackIfCurrent('workout', 'p', 'a').rolledBack, true);
});
test('retention preserves active and actual previous after old manual rollback', { skip: !linux }, t => {
  const { root, manager, artifact } = fixture(t);
  for (let i = 0; i < 7; i++) { artifact(`r${i}`); manager.activate('workout', `r${i}`); }
  const parent = path.join(root, 'releases/workout');
  const versions = () => fs.readdirSync(parent, { withFileTypes: true }).filter(p => p.isDirectory());
  assert.equal(versions().length, 5);
  manager.rollback('workout', 'r2'); artifact('r7');
  assert.equal(manager.activate('workout', 'r7').previous, 'r2'); manager.cleanup();
  assert.ok(fs.existsSync(path.join(parent, 'r2'))); assert.equal(versions().length, 5);
  assert.equal(manager.rollbackIfCurrent('workout', 'r2', 'r7').rolledBack, true);
});
test('stale cleanup leaves fresh uploads and does not follow links', { skip: !linux }, t => {
  const { root, manager, artifact } = fixture(t);
  const stale = artifact('stale'), fresh = artifact('fresh'); fs.utimesSync(stale, 1, 1);
  fs.symlinkSync(path.join(root, 'apps'), path.join(root, 'incoming/workout/escape'));
  manager.cleanup(); assert.ok(!fs.existsSync(stale)); assert.ok(fs.existsSync(fresh)); assert.ok(fs.existsSync(path.join(root, 'apps')));
});

function contender(root) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
import { Releases } from ${JSON.stringify(pathToFileURL(path.join(repository, 'infra/deploy_static.mjs')).href)};
console.log('started'); new Releases(${JSON.stringify(root)}).cleanup(); console.log('done');
`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const exit = once(child, 'exit');
  return { child, exit, stdout: () => stdout, stderr: () => stderr };
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Timed out waiting for child readiness');
}
test('gateway holds upload lock, cleanup waits, receiver inherits descriptor and timeout', { skip: !linux, timeout: 10000 }, async t => {
  const { root, manager } = fixture(t);
  const destination = `${root}/incoming/workout/upload/`;
  let cleaner;
  const result = runGateway(`rsync --server -tre.iLsfxCIvu --delete . ${destination}`, { manager, storage: () => {}, receive: (command, args, options) => {
    assert.equal(command, '/usr/bin/rsync'); assert.ok(args.includes('--timeout=300'));
    assert.equal(options.timeout, 300000); assert.equal(options.killSignal, 'SIGKILL');
    assert.ok(Number.isInteger(options.stdio[3]));
    const probe = spawnSync('/usr/bin/flock', ['-n', path.join(root, '.deploy.lock'), 'true']);
    assert.equal(probe.status, 1, 'independent process must be excluded during upload');
    cleaner = contender(root);
    return { status: 0 };
  } });
  assert.equal(result, 0); assert.ok(fs.existsSync(destination));
  t.after(() => cleaner.child.kill());
  const [code] = await cleaner.exit; assert.equal(code, 0, cleaner.stderr()); assert.match(cleaner.stdout(), /done/);
});
test('storage refusal precedes upload mkdir and receiver', { skip: !linux }, t => {
  const { root, manager } = fixture(t); const destination = `${root}/incoming/workout/denied/`;
  let called = false;
  assert.throws(() => runGateway(`rsync --server -tre.iLsfxCIvu --delete . ${destination}`, {
    manager, storage: () => { throw new Error('Insufficient free space'); }, receive: () => { called = true; },
  }), /Insufficient/);
  assert.equal(called, false); assert.ok(!fs.existsSync(destination));
});
test('real rsync inherited lock survives gateway lock context exit', { skip: !linux, timeout: 10000 }, async t => {
  const { root, manager } = fixture(t); const destination = `${root}/incoming/workout/receiver/`;
  fs.mkdirSync(destination, { recursive: true });
  const receiver = manager.lock(fd => spawn('/usr/bin/rsync', ['--timeout=300', '--server', '-tre.iLsfxCIvu', '--delete', '.', destination], { stdio: ['pipe', 'pipe', 'pipe', fd] }));
  t.after(() => receiver.kill('SIGKILL'));
  const receiverExit = once(receiver, 'exit');
  // Give rsync time to start and prove the lock is still held after parent close.
  assert.equal(spawnSync('/usr/bin/flock', ['-n', path.join(root, '.deploy.lock'), 'true']).status, 1);
  const cleaner = contender(root); t.after(() => cleaner.child.kill());
  await waitFor(() => cleaner.stdout().includes('started'));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(!cleaner.stdout().includes('done'));
  receiver.stdin.end(); await receiverExit;
  const [code] = await cleaner.exit; assert.equal(code, 0, cleaner.stderr()); assert.match(cleaner.stdout(), /done/);
});
test('cleanup error after switch returns committed activation', { skip: !linux }, t => {
  const { root, manager, artifact } = fixture(t); artifact();
  manager.remove = (target, options) => {
    if (target === path.join(root, 'incoming/workout/one')) throw Object.assign(new Error('cleanup failed'), { code: 'EACCES' });
    fs.rmSync(target, options);
  };
  const result = manager.activate('workout', 'one');
  assert.equal(result.active, 'one'); assert.match(result.cleanupWarning, /cleanup failed/); assert.equal(manager.current('workout'), 'one');
});
