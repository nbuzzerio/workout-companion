"""CI-only: reject obsolete runs immediately before SSH activation. No server build."""
import json
import os
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request


def activate_checked(candidate, get_head, activate):
    current_head = get_head()
    if current_head != candidate:
        raise ValueError('Stale deployment rejected: candidate is not current production branch HEAD')
    return activate()


def main():
    env = os.environ
    branch = urllib.parse.quote(env['PRODUCTION_BRANCH'], safe='')
    repository = env['GITHUB_REPOSITORY']
    def get_head():
        request = urllib.request.Request(
            f'https://api.github.com/repos/{repository}/git/ref/heads/{branch}',
            headers={'Authorization': f'Bearer {env["GH_TOKEN"]}', 'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28', 'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)['object']['sha']
    def activate():
        command = ['ssh', '-i', str(Path.home() / '.ssh/deploy_key'), '-p', env.get('DEPLOY_PORT') or '22',
                   '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
                   '-o', 'ConnectTimeout=15', f'{env["DEPLOY_USER"]}@{env["DEPLOY_HOST"]}',
                   f'deploy-static activate {env["SLUG"]} {env["RELEASE"]}']
        return json.loads(subprocess.check_output(command, text=True))
    print(json.dumps(activate_checked(env['GITHUB_SHA'], get_head, activate)))


if __name__ == '__main__':
    main()
