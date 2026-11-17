/** CI only: reject obsolete runs immediately before SSH activation. */
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export async function activateChecked(candidate, getHead, activate) {
  if (await getHead() !== candidate) throw new Error('Stale deployment rejected: candidate is not current production branch HEAD');
  return activate();
}
export async function main(env = process.env) {
  const getHead = async () => {
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/${encodeURIComponent(env.PRODUCTION_BRANCH)}`, {
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Cannot read production branch HEAD: HTTP ${response.status}`);
    const body = await response.json();
    if (typeof body?.object?.sha !== 'string') throw new Error('Missing production branch HEAD');
    return body.object.sha;
  };
  const activate = () => JSON.parse(execFileSync('ssh', [
    '-i', path.join(os.homedir(), '.ssh/deploy_key'), '-p', env.DEPLOY_PORT,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `UserKnownHostsFile=${path.join(os.homedir(), '.ssh/known_hosts')}`,
    '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15', `${env.DEPLOY_USER}@${env.DEPLOY_HOST}`,
    `deploy-static activate ${env.SLUG} ${env.RELEASE}`,
  ], { encoding: 'utf8' }));
  return activateChecked(env.GITHUB_SHA, getHead, activate);
}
if (import.meta.main) console.log(JSON.stringify(await main()));
