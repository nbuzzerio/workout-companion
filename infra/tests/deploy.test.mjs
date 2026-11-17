import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Releases, validateSlug, validateRelease } from '../deploy_static.mjs';
import { parseCommand, splitCommand } from '../ssh_gateway.mjs';
import { MAX_MANIFEST_BYTES, MAX_RELEASE_BYTES, MAX_RELEASE_FILES } from '../storage_guard.mjs';
import { fixture, rewrite, repository, linux } from './fixtures.mjs';

test('slug and release validation', () => {
  for (const slug of ['../a', 'A', 'a/b', 'a--b', '-a', 'a'.repeat(49), 'a;id', 'a\n', null, 1]) assert.throws(() => validateSlug(slug));
  for (const release of ['../a', '/tmp/x', 'a;id', 'x'.repeat(101), 'a\n', null, 1]) assert.throws(() => validateRelease(release));
  assert.equal(validateSlug('workout-2'), 'workout-2');
  assert.equal(validateRelease('Ab_2-3'), 'Ab_2-3');
});
test('release validation and tampering', t => {
  const { manager, artifact } = fixture(t); const folder = artifact();
  manager.validate(folder, 'workout', 'one');
  fs.writeFileSync(path.join(folder, 'assets/app.js'), 'tampered');
  assert.throws(() => manager.validate(folder, 'workout', 'one'), /checksum/);
});
test('manifest identity, hidden paths and extra files', t => {
  const { manager, artifact } = fixture(t); const folder = artifact();
  assert.throws(() => manager.validate(folder, 'another', 'one'), /identity/);
  assert.throws(() => manager.validate(folder, 'workout', 'another'), /identity/);
  fs.writeFileSync(path.join(folder, '.env'), 'secret');
  assert.throws(() => manager.validate(folder, 'workout', 'one'), /Hidden/);
  fs.unlinkSync(path.join(folder, '.env'));
  fs.writeFileSync(path.join(folder, 'extra.txt'), 'extra');
  assert.throws(() => manager.validate(folder, 'workout', 'one'));
});
test('bad HTML and PWA scope fail even with matching hashes', t => {
  const { manager, artifact } = fixture(t); const folder = artifact();
  for (const [name, content] of [['index.html', '<script src="/assets/app.js"></script>'], ['manifest.webmanifest', '{"scope":"/","start_url":"/"}']]) {
    const original = fs.readFileSync(path.join(folder, name), 'utf8');
    rewrite(folder, name, content);
    assert.throws(() => manager.validate(folder, 'workout', 'one'));
    rewrite(folder, name, original);
  }
});
test('activation, rollback and failures preserve current', { skip: !linux }, t => {
  const { root, manager, artifact } = fixture(t);
  artifact('one'); artifact('two');
  manager.activate('workout', 'one'); manager.activate('workout', 'two');
  assert.equal(manager.current('workout'), 'two');
  manager.rollback('workout', 'one');
  assert.equal(manager.current('workout'), 'one');
  assert.ok(fs.statSync(path.join(root, 'releases/workout/two/index.html')).isFile());
  const bad = artifact('bad'); fs.writeFileSync(path.join(bad, 'index.html'), 'bad');
  assert.throws(() => manager.activate('workout', 'bad'));
  assert.equal(manager.current('workout'), 'one');
  assert.throws(() => manager.rollback('workout', 'missing'));
  assert.equal(manager.current('workout'), 'one');
  artifact('one'); assert.throws(() => manager.activate('workout', 'one'), /already exists/);
  assert.equal(manager.current('workout'), 'one');
  assert.deepEqual(manager.status('workout'), { app: 'workout', active: 'one', releases: ['one', 'two'] });
  assert.equal(fs.statSync(path.join(root, 'releases/workout/one/index.html')).mode & 0o777, 0o644);
});
test('symlink artifacts and upload paths rejected', { skip: !linux }, t => {
  const { root, manager, artifact } = fixture(t); const folder = artifact();
  fs.symlinkSync('/etc/passwd', path.join(folder, 'escape'));
  assert.throws(() => manager.validate(folder, 'workout', 'one'), /symlink/);
  fs.symlinkSync('/tmp', path.join(root, 'incoming/other'));
  assert.throws(() => parseCommand(`rsync --server -tre.iLsfxCIvu --delete . ${root}/incoming/other/one/`, root));
});
test('forced command allowlist', t => {
  const { root } = fixture(t);
  const destination = `${root.replaceAll('\\', '/')}/incoming/workout/one/`;
  assert.equal(parseCommand(`rsync --server -tre.iLsfxCIvu --delete . '${destination}'`, root)[0], '/usr/bin/rsync');
  for (const suffix of ['activate workout one', 'rollback workout one', 'status workout', 'rollback-if-current workout one two', 'cleanup']) {
    assert.ok(parseCommand(`deploy-static ${suffix}`).includes(suffix.split(' ')[0]));
  }
  for (const command of ['bash', 'deploy-static activate ../x one', 'deploy-static status workout; id',
    'deploy-static rollback-if-current workout one ../two', 'deploy-static cleanup extra',
    'rsync --server --sender . /etc/', 'rsync --server -ltre.iLsfxCIvu --delete . /srv/personal-apps/incoming/workout/one/',
    'rsync --server -tre.iLsfxCIvu --delete . /etc/', 'rsync --server -tre.iLsfxCIvu --delete . /srv/personal-apps/incoming/../one/']) assert.throws(() => parseCommand(command), command);
  assert.deepEqual(splitCommand(`a 'b c' "d e" f\\ g ''`), ['a', 'b c', 'd e', 'f g', '']);
  assert.throws(() => splitCommand("'unterminated")); assert.throws(() => splitCommand('trailing\\'));
});
test('actual rsync protocol passes gateway', { skip: !linux }, t => {
  const { root } = fixture(t);
  const source = path.join(root, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'index.html'), 'test upload');
  const transport = path.join(root, 'transport.mjs');
  fs.writeFileSync(transport, `import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
import { parseCommand } from ${JSON.stringify(pathToFileURL(path.join(repository, 'infra/ssh_gateway.mjs')).href)};
const args = parseCommand(process.argv.slice(3).map(s => JSON.stringify(s)).join(' '), process.env.TEST_ROOT);
fs.mkdirSync(args.at(-1), { recursive: true });
const result = spawnSync(args[0], ['--timeout=300', ...args.slice(1)], { stdio: 'inherit' });
if (result.error) throw result.error; process.exitCode = result.status ?? 1;
`);
  execFileSync('rsync', ['-rt', '--delete', '-e', `'${process.execPath}' '${transport}'`, `${source}/`, `dummy:${root}/incoming/workout/upload/`], { env: { ...process.env, TEST_ROOT: root }, timeout: 15000 });
  assert.equal(fs.readFileSync(path.join(root, 'incoming/workout/upload/index.html'), 'utf8'), 'test upload');
});
test('manifest types, required files, exact inventory and hash format', t => {
  const { manager, artifact } = fixture(t); const folder = artifact();
  const file = path.join(folder, 'release.json'); const original = fs.readFileSync(file, 'utf8');
  for (const mutate of [m => { m.formatVersion = true; }, m => { m.basePath = '/'; },
    m => { m.files = []; }, m => { m.files = {}; }, m => { delete m.files['sw.js']; },
    m => { m.files['assets/app.js'] = 'a'.repeat(64) + '\n'; }, m => { m.files['missing.txt'] = 'a'.repeat(64); },
    m => { m.files['../escape'] = 'a'.repeat(64); }, m => { for (let i = 0; i < MAX_RELEASE_FILES; i++) m.files[`file${i}`] = 'a'.repeat(64); }]) {
    const manifest = JSON.parse(original); mutate(manifest); fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => manager.validate(folder, 'workout', 'one'));
  }
  fs.writeFileSync(file, ' '.repeat(MAX_MANIFEST_BYTES + 1));
  assert.throws(() => manager.validate(folder, 'workout', 'one'), /manifest/);
  fs.writeFileSync(file, original);
  fs.truncateSync(path.join(folder, 'assets/app.js'), MAX_RELEASE_BYTES + 1);
  assert.throws(() => manager.validate(folder, 'workout', 'one'), /100 MiB/);
});
test('special files, manifest links and unmanaged current paths fail closed', { skip: !linux }, t => {
  const { root, manager, artifact } = fixture(t); const folder = artifact();
  execFileSync('mkfifo', [path.join(folder, 'pipe')]);
  assert.throws(() => manager.validate(folder, 'workout', 'one'), /Special/);
  fs.unlinkSync(path.join(folder, 'pipe'));
  fs.renameSync(path.join(folder, 'release.json'), path.join(root, 'manifest.json'));
  fs.symlinkSync(path.join(root, 'manifest.json'), path.join(folder, 'release.json'));
  assert.throws(() => manager.validate(folder, 'workout', 'one'), /manifest/);
  fs.mkdirSync(path.join(root, 'apps/workout')); assert.throws(() => manager.current('workout'), /managed/);
  fs.rmdirSync(path.join(root, 'apps/workout')); fs.symlinkSync(root, path.join(root, 'apps/workout'));
  assert.throws(() => manager.current('workout'), /outside/);
});
test('safeDir and retention arguments reject invalid values', t => {
  const { root, manager } = fixture(t);
  for (const part of ['..', '../escape', '/tmp', 'a\\b', '']) assert.throws(() => manager.safeDir(part));
  assert.throws(() => new Releases(root, { retention: 1 }));
  assert.throws(() => new Releases(root, { staleSeconds: 0 }));
});
