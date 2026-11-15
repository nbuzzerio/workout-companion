# GitHub deployment onboarding from Windows

`scripts/Initialize-GitHubDeployment.ps1` uses built-in Windows PowerShell 5.1
and GitHub REST. Git, GitHub CLI, Python, Node and OpenSSH are not required for
onboarding. It configures GitHub only; it never connects to the Droplet, reads
SSH private keys, uploads source, commits, pushes, or dispatches a workflow.

## Temporary authentication

Create a fine-grained personal access token at
<https://github.com/settings/personal-access-tokens/new>, scoped to the intended
owner and repository, with the shortest practical expiry (for example one day).
Give it these repository permissions:

- Administration: read and write (environment and deployment branch policies).
- Variables: read and write (repository Actions variables).
- Actions: read (environment/policy inspection).
- Environments: read (detect conflicting environment variables).
- Contents: read (verify source on the production branch when enabling).
- Metadata: read (included automatically).

The authenticated account must have repository admin access. For optional
repository creation, use a token allowed to create repositories under the
selected owner; an existing-repository-only token cannot access a new repository.
For a new repository, temporarily selecting all repositories for that resource
owner may be necessary. Organization approval/policy can also apply. Revoke the
token after use; do not grant Secrets or Contents write just for this script.

The script prompts for the token with a masked SecureString, converts it only
for the HTTPS request header, clears that header and unmanaged buffer, and
disposes the SecureString at exit. No token is accepted on the command line,
saved to disk, put in an environment variable, or retained in a credential store.
Use a normal PowerShell session without transcription, HTTP debugging, or tracing.
TLS 1.2, the fixed `api.github.com` endpoint and no redirects are enforced.

Private repository environments/branch restrictions require a GitHub plan that
supports them. Unsupported plans or insufficient permissions cause a clear
error; the script never falls back to an unprotected environment. See GitHub's
[environment API](https://docs.github.com/en/rest/deployments/environments),
[branch policy API](https://docs.github.com/en/rest/deployments/branch-policies),
and [Actions variables API](https://docs.github.com/en/rest/actions/variables).

## Configure Workout Companion, disabled

Run this exact command in Windows PowerShell. It prompts for the **confirmed SSH
hostname and port**, then the temporary GitHub API token. The web origin does not
establish the SSH endpoint; neither the host nor the port is assumed.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\nickb\Code\Repositories\workout-companion\scripts\Initialize-WorkoutDeployment.ps1' -DeployHost (Read-Host 'Confirmed SSH hostname or IPv4') -DeployPort ([int](Read-Host 'Confirmed SSH port'))
```

`-ExecutionPolicy Bypass` applies only to this new PowerShell process; it does not
change the machine/user execution policy. Review the scripts before running them.
If organizational policy requires signed scripts, follow that policy instead.

The Workout wrapper fixes these reviewed values:

| Setting                    | Value                                                |
| -------------------------- | ---------------------------------------------------- |
| Repository                 | `nbuzzerio/workout-companion`                        |
| Slug and base path         | `workout`, `/apps/workout/`                          |
| Origin                     | `https://www.nickbuzzerio.com`                       |
| App URL                    | `https://www.nickbuzzerio.com/apps/workout/`         |
| Production branch          | `main`                                               |
| SSH user                   | `personal-deploy`                                    |
| Pinned ED25519 fingerprint | `SHA256:n7iJc5pZSQW+qDGbDpkIOL0ipHwNSyWoujgL3+YE3y0` |
| Deployment opt-in          | `false`                                              |

The pin was independently verified by the owner. Onboarding does not fetch or
establish it. A host-key change must be independently verified before updating
the pin; never copy a failing workflow's newly discovered fingerprint as trust.

## Add the only deployment secret manually

Open <https://github.com/nbuzzerio/workout-companion/settings/environments>,
select **production**, and add environment secret **DEPLOY_SSH_KEY**. Enter the
dedicated restricted private key yourself, including its BEGIN/END lines. Never
pass it to these scripts, put it in a variable, or include it in source or logs.

The workflow uses no other deployment secret. Existing `DEPLOY_HOST`,
`DEPLOY_PORT`, `DEPLOY_USER` and `DEPLOY_KNOWN_HOSTS` secrets are no longer read;
after review, remove those obsolete secrets manually. Do not remove unrelated
secrets or protections. The automation never accesses the secrets API, including
secret names or values.

## Review and separately opt in

The setup command **always sets ENABLE_DEPLOYMENT=false**, including reruns of
previously enabled setups. It disables first and reads back every managed
variable. Do not reconfigure while a deployment is running: changing the flag
does not cancel jobs already admitted. API writes are not transactional; after a
failed setup, correct the reported problem and rerun. If disabling itself fails,
verify the flag manually before doing anything else.

After the owner reviews, commits and pushes these changes, passes CI, adds the
key, and reviews the environment protections, a **separate invocation** can opt
in. This is an owner action, not part of the implementation task:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'C:\Users\nickb\Code\Repositories\workout-companion\scripts\Initialize-WorkoutDeployment.ps1' -DeployHost (Read-Host 'Confirmed SSH hostname or IPv4') -DeployPort ([int](Read-Host 'Confirmed SSH port')) -EnableDeployment
```

Enable mode verifies all saved values and the exact environment branch policy;
it never repairs a mismatch. It also requires the branch and matching app identity
on GitHub, and compares the remote workflow, fingerprint verifier, opt-in policy
and activation helper to the locally reviewed copies (allowing CRLF/LF changes).
It never reads the key to check whether the owner added it. Enabling can admit a
concurrent push/manual run, so perform it only when ready. The script does not
trigger a deployment. Subsequent deployment still requires a production push or
manual workflow run and all CI/protection/freshness gates.

## Future applications

Copy the template source into an app checkout, edit `config/app.ts` with an unused
slug and matching `/apps/SLUG/` path, and verify the app locally. Onboarding checks
literal `id`/`basePath` declarations but does not change source or database names.
From the new checkout, configure an existing repository with confirmed inputs:

```powershell
$repository = Read-Host 'GitHub OWNER/NAME'
$slug = Read-Host 'App slug (matching config/app.ts)'
$sshHost = Read-Host 'Confirmed SSH hostname or IPv4'
$sshPort = [int](Read-Host 'Confirmed SSH port')
$fingerprint = Read-Host 'Independently verified ED25519 SHA256 fingerprint'
$origin = Read-Host 'HTTPS origin without trailing slash or path'
$branch = Read-Host 'Exact production branch (for example main)'
$onboarding = @{
    Repository = $repository
    AppSlug = $slug
    DeployHost = $sshHost
    DeployPort = $sshPort
    HostFingerprint = $fingerprint
    PublicOrigin = $origin
    ProductionBranch = $branch
}
& .\scripts\Initialize-GitHubDeployment.ps1 @onboarding
```

If scripts are disabled in that session, first run `powershell.exe -NoProfile
-ExecutionPolicy Bypass` to open a temporary shell and execute the block there.
Do not include a token in `$onboarding`. `ProductionBranch` may be omitted to use
`main`; SSH host/port and the independently established pin remain mandatory.

To create an empty private repository instead, replace the last command with:

```powershell
& .\scripts\Initialize-GitHubDeployment.ps1 @onboarding -CreateRepository -Visibility private
```

For an empty public repository, use `-CreateRepository -Visibility public`.
`-CreateRepository` reuses an existing accessible repository without changing its
visibility. Nothing is cloned, committed or pushed; the owner supplies source
and creates the production branch separately. Then add the environment key
manually, pass CI, review, and opt in in a separate call:

```powershell
& .\scripts\Initialize-GitHubDeployment.ps1 @onboarding -EnableDeployment
```

Each invocation prompts for temporary API authentication. Repository creation
and enabling cannot be combined. Keep the template repository disabled.

## Protection and failure behavior

The script creates `production` if missing, selects custom deployment policies,
and reconciles them to exactly one literal **branch** rule. Extra branch patterns,
duplicate rules and all tag rules are removed, including paginated results.
Reviewers, timers, custom protection rules, branch protection/rulesets, existing
visibility, unrelated variables and secrets are not rewritten. It never deletes
or recreates an environment. Existing custom-policy environments are configured
without an environment PUT.

For an existing protected-branch-only environment, or an unrestricted environment
with unrelated protections, the script stops after disabling. In GitHub select
**Selected branches and tags** while retaining all existing protections, review
the production branch protection separately, then rerun. This exception prevents
silently replacing a stronger policy. Conflicting environment variables with any
of the seven managed names also require manual removal before rerunning, because
GitHub environment values can override repository variables. Unknown/malformed
responses, inaccessible repositories, redirects, permission errors, readback
mismatches and API/network failures abort. No alternate insecure mode is used.

Only exact lowercase `true` enables deployment. The independent Python policy
still requires a push/manual event and the exact production ref; tags, PRs,
different branches and inexact opt-in strings never deploy.

At deployment time, `verify_host_key.py` discovers only ED25519 public keys with
bounded `ssh-keyscan`, validates the SSH wire encoding, requires exactly one
distinct key, and compares its SHA256 fingerprint with the pin before writing
`known_hosts`. Identical duplicate entries are harmless; distinct keys, incorrect
host/port tokens, missing keys, malformed blobs and wrong pins fail closed. SSH,
rsync and activation/rollback use strict checking, ED25519 only, and the verified
file with global known-host files disabled. No trust-on-first-use is performed.

## Offline tests

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\tests\onboarding.tests.ps1
pnpm test:infra
```

The PowerShell suite runs against an in-memory fake GitHub API with no additional
modules. Python tests use synthetic public host keys; no server or SSH private
key is used. Existing app, IndexedDB, build and browser checks remain required.
CI runs the PowerShell suite on Windows and requires it before the Ubuntu
`check` job; Linux infrastructure tests run the host-key and existing POSIX
protocol tests. The PowerShell-only tests are explicitly skipped on Linux.
