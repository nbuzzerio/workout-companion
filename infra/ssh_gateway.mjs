#!/usr/bin/env node
/** Forced SSH command: no shell evaluation, forwarding, arbitrary paths or sudo. */
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Releases, ROOT, validateSlug, validateRelease, main as deploy } from './deploy_static.mjs';
import { requireStorage } from './storage_guard.mjs';

// POSIX shlex-style tokenization only. Tokens are never evaluated by a shell.
export function splitCommand(command) {
  if (typeof command !== 'string') throw new Error('Invalid command');
  const args = [];
  let token = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && ['"', '\\'].includes(command[i + 1])) token += command[++i];
      else token += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === '\\') {
      if (++i === command.length) throw new Error('Unterminated escape');
      token += command[i]; started = true;
    } else if (/[ \t\r\n]/.test(c)) {
      if (started) { args.push(token); token = ''; started = false; }
    } else { token += c; started = true; }
  }
  if (quote) throw new Error('Unterminated quote');
  if (started) args.push(token);
  return args;
}
export function parseCommand(command, root = ROOT) {
  const args = splitCommand(command);
  if (args[0] === 'deploy-static') {
    if (args.length === 4 && ['activate', 'rollback'].includes(args[1])) {
      validateSlug(args[2]); validateRelease(args[3]);
    } else if (args.length === 3 && args[1] === 'status') validateSlug(args[2]);
    else if (args.length === 5 && args[1] === 'rollback-if-current') {
      validateSlug(args[2]); validateRelease(args[3]); validateRelease(args[4]);
    } else if (!(args.length === 2 && args[1] === 'cleanup')) throw new Error('Unsupported deployment command');
    return ['/usr/local/lib/personal-apps/deploy_static.mjs', ...args.slice(1)];
  }
  if (!(args.length === 6 && args[0] === 'rsync' && args[1] === '--server' && args[2] === '-tre.iLsfxCIvu' && args[3] === '--delete' && args[4] === '.')) {
    throw new Error('Only rsync -rt --delete uploads are accepted');
  }
  const prefix = `${root.replaceAll('\\', '/')}/incoming/`;
  const destination = args[5];
  if (!destination.startsWith(prefix)) throw new Error('Upload must target incoming/SLUG/RELEASE/');
  const parts = destination.slice(prefix.length).split('/');
  if (parts.length !== 3 || parts[2] !== '') throw new Error('Upload must target incoming/SLUG/RELEASE/');
  const slug = validateSlug(parts[0]), release = validateRelease(parts[1]);
  new Releases(root).safeDir('incoming', slug, release);
  return ['/usr/bin/rsync', ...args.slice(1)];
}
export function runGateway(command = process.env.SSH_ORIGINAL_COMMAND ?? '', { manager = new Releases(), storage = requireStorage, receive = spawnSync } = {}) {
  let args = parseCommand(command, manager.root);
  process.umask(0o022);
  if (args[0] !== '/usr/bin/rsync') return deploy(args.slice(1), manager);
  return manager.lock(fd => {
    manager.cleanupLocked();
    storage(manager.root, 'upload');
    args = parseCommand(command, manager.root);
    const destination = path.resolve(args.at(-1));
    fs.mkdirSync(destination, { recursive: true });
    try {
      const result = receive(args[0], ['--timeout=300', ...args.slice(1)], {
        timeout: 300000, killSignal: 'SIGKILL', stdio: ['inherit', 'inherit', 'inherit', fd],
      });
      if (result.error) throw result.error;
      if (result.status === null) throw new Error(`Receiver terminated: ${result.signal}`);
      return result.status;
    } finally { const now = new Date(); fs.utimesSync(destination, now, now); }
  });
}
if (import.meta.main) {
  try {
    const result = runGateway();
    if (typeof result === 'number') process.exitCode = result;
    else console.log(JSON.stringify(result));
  } catch (error) { console.error(`Deployment command rejected: ${error.message}`); process.exitCode = 1; }
}
