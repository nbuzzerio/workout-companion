/** Authenticate a discovered public ED25519 host key before writing trust. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export function validateTarget(host, port, fingerprint) {
  if (typeof host !== 'string' || host.length > 253 || !host.split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?![\s\S])/.test(label))) throw new Error('DEPLOY_HOST must be a DNS hostname or IPv4 address');
  if (!/^[1-9][0-9]{0,4}(?![\s\S])/.test(String(port)) || Number(port) > 65535) throw new Error('DEPLOY_PORT must be explicitly set to 1..65535');
  if (typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}(?![\s\S])/.test(fingerprint)) throw new Error('DEPLOY_HOST_FINGERPRINT must be an unpadded SHA256 fingerprint');
  if (Buffer.from(fingerprint.slice(7), 'base64').toString('base64').replace(/=+$/, '') !== fingerprint.slice(7)) throw new Error('Noncanonical SHA256 fingerprint');
}
export function verifiedKnownHosts(scan, host, port, fingerprint) {
  validateTarget(host, port, fingerprint);
  if (typeof scan !== 'string' || scan.length > 65536) throw new Error('Invalid or oversized host-key discovery response');
  const target = Number(port) === 22 ? host : `[${host}]:${port}`;
  const keys = new Map();
  const prefix = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32])]);
  for (const line of scan.split(/\r?\n/)) {
    if (line.startsWith('#') || !line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || fields[0] !== target || fields[1] !== 'ssh-ed25519') throw new Error('Malformed or unexpected host-key entry');
    const blob = Buffer.from(fields[2], 'base64');
    if (blob.length !== prefix.length + 32 || !blob.subarray(0, prefix.length).equals(prefix) || blob.toString('base64') !== fields[2]) throw new Error('Malformed ED25519 public host-key blob');
    keys.set(fields[2], blob);
  }
  if (keys.size !== 1) throw new Error('Missing or ambiguous ED25519 host key');
  const blob = keys.values().next().value;
  const actual = 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  if (!timingSafeEqual(Buffer.from(actual), Buffer.from(fingerprint))) throw new Error('Discovered host key does not match the pinned SHA256 fingerprint');
  return `${target} ssh-ed25519 ${blob.toString('base64')}\n`;
}
export function discover(host, port, fingerprint, destination, run = execFileSync) {
  validateTarget(host, port, fingerprint);
  const scan = run('ssh-keyscan', ['-T', '10', '-p', String(port), '-t', 'ed25519', host], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 });
  const verified = verifiedKnownHosts(scan, host, port, fingerprint);
  const temporary = path.join(path.dirname(destination), `.known-hosts-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, verified, { encoding: 'ascii', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}
if (import.meta.main) {
  try { discover(process.env.DEPLOY_HOST, process.env.DEPLOY_PORT, process.env.DEPLOY_HOST_FINGERPRINT, path.join(os.homedir(), '.ssh/known_hosts')); }
  catch (error) { console.error(`Host-key verification failed: ${error.message}`); process.exitCode = 1; }
}
