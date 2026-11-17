/** Conservative admission checks for trusted uploads, not a quota or transfer cap. */
import * as fs from 'node:fs';
import path from 'node:path';

export const POLICY = '/etc/personal-apps/storage.json';
export const DEFAULT_RESERVE_BYTES = 3 * 1024 ** 3;
export const MAX_RELEASE_BYTES = 100 * 1024 ** 2;
export const MAX_MANIFEST_BYTES = 2 * 1024 ** 2;
export const MAX_RELEASE_FILES = 10000;
export const SAFETY_BYTES = 64 * 1024 ** 2;

export function requireStorage(root, phase = 'upload', policyPath = POLICY, io = fs) {
  if (!['upload', 'activation'].includes(phase)) throw new Error('Unknown storage check phase');
  let reserve = DEFAULT_RESERVE_BYTES;
  const info = io.lstatSync(policyPath, { throwIfNoEntry: false });
  if (info) {
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022)) {
      throw new Error('Storage policy must be a root-owned regular file, not group/world writable');
    }
    const policy = JSON.parse(io.readFileSync(policyPath, 'utf8'));
    if (!policy || Array.isArray(policy) || Object.keys(policy).join() !== 'minFreeBytes') {
      throw new Error('Expected storage policy with minFreeBytes only');
    }
    reserve = policy.minFreeBytes;
    if (!Number.isSafeInteger(reserve) || reserve <= 0) throw new Error('minFreeBytes must be a positive integer byte count');
  }
  for (const name of ['apps', 'releases', 'incoming']) {
    const directory = path.join(root, name);
    if (io.lstatSync(directory).isSymbolicLink() || io.statSync(directory).dev !== io.statSync(root).dev) {
      throw new Error('Deployment directories must use the checked filesystem');
    }
  }
  // Linux statfs bavail excludes root-reserved blocks; ffree is Linux's free inode count.
  const space = io.statfsSync(root, { bigint: true });
  const available = space.bavail * space.bsize;
  const copies = phase === 'upload' ? 2 : 1;
  const required = BigInt(reserve) + BigInt(copies * (MAX_RELEASE_BYTES + MAX_MANIFEST_BYTES) + SAFETY_BYTES);
  const requiredInodes = BigInt(10000 + copies * (MAX_RELEASE_FILES + 1));
  if (available < required || space.ffree < requiredInodes) {
    throw new Error(`Insufficient free space for ${phase}: available=${available}, required=${required}, freeInodes=${space.ffree}, requiredInodes=${requiredInodes}`);
  }
  return { phase, availableBytes: Number(available), requiredBytes: Number(required), minFreeBytes: reserve };
}
