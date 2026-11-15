"""Case-sensitive template deployment opt-in; no secrets or network access."""
import os


def deployment_allowed(enabled, event, ref, production_branch='main'):
    return (enabled == 'true' and event in ('push', 'workflow_dispatch')
            and ref == f'refs/heads/{production_branch or "main"}')


if __name__ == '__main__':
    print('true' if deployment_allowed(os.environ.get('ENABLE_DEPLOYMENT', ''),
          os.environ.get('GITHUB_EVENT_NAME', ''), os.environ.get('GITHUB_REF', ''),
          os.environ.get('PRODUCTION_BRANCH', 'main')) else 'false')
