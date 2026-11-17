# Node-only tooling migration

Date: 2026-11-16. Scope: the ordinary Workout Companion checkout on `main`,
initially clean at `b7f0595`. No Studio worktree, application feature, workout
record, browser storage schema, Nginx reference configuration, live host,
repository setting, or Git index was changed. Changes remain uncommitted.

## Inventory and replacements

The inventory covered tracked source, hidden CI configuration, package scripts,
infrastructure, onboarding tools, documentation and the dependency lockfile.
There were twelve Python source files. No requirements file, virtual environment
configuration, pytest configuration, or Python/node-gyp dependency was found in
the project's lockfile. Existing ignored bytecode caches were also removed.

| Removed Python source | Node replacement | Responsibility |
| --- | --- | --- |
| `infra/deploy_static.py` | `infra/deploy_static.mjs` | Artifact validation, activation, rollback, conditional rollback, status, retention and cleanup |
| `infra/storage_guard.py` | `infra/storage_guard.mjs` | Root-owned policy, same-filesystem checks, free bytes and inode admission |
| `infra/ssh_gateway.py` | `infra/ssh_gateway.mjs` | Restricted SSH parser, serialized uploads, inherited receiver lock and timeouts |
| `scripts/validate_artifact.py` | `scripts/validate_artifact.mjs` | Validate the real `dist/` with the same validator used by the release manager |
| `scripts/activate_checked.py` | `scripts/activate_checked.mjs` | Read current production HEAD immediately before SSH activation; fail closed |
| `scripts/deployment_policy.py` | `scripts/deployment_policy.mjs` | Exact lowercase deployment opt-in, allowed event and production ref |
| `scripts/verify_host_key.py` | `scripts/verify_host_key.mjs` | Authenticate ED25519 discovery against the pinned SHA256 fingerprint |
| `infra/tests/test_deploy.py` | `infra/tests/deploy.test.mjs` | Validator, release lifecycle, SSH allowlist and real rsync tests |
| `infra/tests/test_corrections.py` | `infra/tests/corrections.test.mjs` | Ordering, retention, rollback, locking and cleanup regressions |
| `infra/tests/test_readiness.py` | `infra/tests/readiness.test.mjs` | Opt-in, workflow wiring, disk reserve and activation admission |
| `infra/tests/test_onboarding.py` | `infra/tests/onboarding.test.mjs` | Host-key verification, workflow security and PowerShell offline suite |
| `infra/tests/nginx_integration.py` | `infra/tests/nginx_integration.mjs` | Actual Nginx configuration/routing against an activated build |

Additional Python invocations were found in `.github/workflows/ci-deploy.yml`:
deployment policy, Nginx integration, host-key verification, activation, inline
JSON extraction and public release identity checking. They now invoke Node/pnpm.
The two inline checks are tested exports in the new `scripts/release_health.mjs`.
The deployment job explicitly sets up the same pinned Node version as CI.

`scripts/GitHubDeployment.psm1` reviewed remote Python helper filenames before
allowing deployment enablement. Its reviewed-file list and the offline fake API
now use the Node helpers, including the new health helper and its infrastructure
imports. This preserves source-review coverage rather than merely renaming the
three old entries.

## File and command changes

All twelve replacements in the table are added, and all twelve original Python
files are removed. Also added: `infra/tests/fixtures.mjs`,
`scripts/release_health.mjs`, and this document.

Changed files:

- `package.json`: migrated commands and added `validate:artifact`.
- `.github/workflows/ci-deploy.yml`: Node invocations, health helper and pinned
  Node setup in the deploy job; no change to deployment enablement or targets.
- `eslint.config.js`: lint the new Node modules with the recommended JS rules
  and Node globals.
- `scripts/GitHubDeployment.psm1` and `scripts/tests/onboarding.tests.ps1`:
  reviewed helper inventory and matching fake API.
- `.gitignore`: removed obsolete Python bytecode rules.
- `README.md`, `docs/deployment.md`, `docs/github-onboarding.md`: current setup,
  test commands and deployment-runtime boundaries.

No dependency was added or upgraded; `pnpm-lock.yaml` is unchanged. Temporary
tool downloads and verification harnesses are confined to ignored `.dev/`.

| Command | Implementation |
| --- | --- |
| `pnpm build` | `tsc -b && vite build && node scripts/release.ts && pnpm validate:artifact` |
| `pnpm validate:artifact` | `node scripts/validate_artifact.mjs` |
| `pnpm test:infra` | `node --test infra/tests/*.test.mjs` |
| `pnpm test:nginx` | `node infra/tests/nginx_integration.mjs` |
| `pnpm verify` / `pnpm run verify` | Unchanged orchestration: typecheck, lint, Vitest, infrastructure tests, build/validation, Playwright |

`pnpm test`, `pnpm test:e2e`, `pnpm dev`, `pnpm preview`, `pnpm typecheck`,
`pnpm lint` and `pnpm app:config` retain their previous implementations.
Nginx remains a separate Linux integration check, as before; hosted CI requires it.

## Safeguards and coverage comparison

The original files define 33 unittest cases. Their assertions were compared
with the replacements; the new Node suite has 39 cases. The added six cases
exercise previously untested branches rather than replacing original checks.

| Original suite | Original → new cases | Preserved assertions |
| --- | --- | --- |
| `test_deploy.py` | 8 → 11 | Invalid slug/release inputs; valid artifact and tampering; wrong app/release identity; hidden/unlisted files; bad HTML base and PWA scope even with correct hashes; activation/rollback and failed activation/missing rollback preserving current; symlink artifacts and escaping uploads; accepted and rejected forced commands; actual `rsync -rt --delete` protocol through the parser |
| `test_corrections.py` | 9 → 9 | Newer deployment wins and obsolete reruns fail; HEAD/API errors prevent activation; conditional rollback respects newer activation and owner rollback; five-release retention protects active/actual previous; stale cleanup preserves fresh uploads and ignores links; upload lock excludes cleanup and receiver receives lock/timeout; disk refusal precedes mkdir/receiver; actual rsync retains lock after parent context closes; cleanup failure reports committed activation |
| `test_readiness.py` | 8 → 11 | Inexact/missing opt-in rejected; branch/event restrictions; deployment gating without gating CI; two-copy upload budget; staging-copy activation budget and inode refusal; configured reserve and invalid/legacy policy; space drop preserves current without staging; healthy activation |
| `test_onboarding.py` | 8 → 8 | Duplicate public keys/comments accepted; wrong/ambiguous pins rejected; missing/malformed/injected/truncated/wrong-algorithm keys rejected; strict host/port/canonical pin validation; bounded discovery preserves existing trust on errors and writes mode 0600; workflow variable/secret/SSH protections; existing PowerShell fake API suite; entry points reject endpoints before authentication |

Added coverage includes malformed inventory/manifest types, required PWA files,
exact inventory, malformed hashes, file-count/manifest-size/release-size limits;
FIFO and manifest-link rejection; unmanaged/escaping current links; path and
retention argument validation; untrusted storage-policy owner/mode/type;
filesystem mismatch; and the extracted public-health/previous-release checks.
Existing cases also gained newline/type validation, duplicate release refusal,
status/permissions assertions, command quoting, and use of available rather than
root-reserved filesystem blocks.

The Nginx runner retains **all** original HTTP assertions: existing site,
application HTML, no-cache and content type, two SPA deep links, JavaScript MIME
type, service worker, all ten invalid/missing routes, and all four security
headers on each of six successful/error routes. It activates the actual build
before serving it and runs `nginx -t` explicitly in both local and Docker modes.

Implementation differences:

- Tests use `node:test`/`node:assert`, filesystem fixtures and injected system
  operations instead of unittest patches. Linux lock exclusion is checked with
  a separate nonblocking `flock` contender, and a separate cleanup process waits
  while an actual rsync receiver owns the inherited descriptor.
- Node has no built-in `flock`. The reference invokes Linux util-linux
  `/usr/bin/flock` on an inherited descriptor. Its lock belongs to the shared
  open-file description and remains held by the parent and rsync. No lockfile
  polling, external package or daemon replaces the kernel lock.
- Node `statfsSync` uses `bavail * bsize` and Linux `ffree`; Python used
  `statvfs`'s `f_bavail * f_frsize` and `f_favail`. BigInt arithmetic avoids byte
  counter rounding. Linux is the supported deployment platform; no equivalence
  is claimed for other Unix filesystems or macOS release operations.
- Node's permissive Base64 decoder is followed by canonical re-encoding and
  exact SSH wire-format checks. Fingerprints use `timingSafeEqual`. Identifier
  regexes reject final newlines explicitly. Unsafe integer reserve values,
  nonregular manifests and malformed public-health output fail closed.
- Missing rsync/flock now fails Linux testing instead of silently skipping the
  real rsync check. Windows still skips release operations; the Linux run
  covers them. PowerShell is an optional Windows onboarding tool, not a new
  dependency; its existing offline tests run on Windows and skip if unavailable
  on Linux.

## Verification results

Toolchain: Node 24.18.0 and pnpm 11.9.0. Windows checks use the existing pinned
dependencies. Linux checks use WSL Ubuntu 24.04 and a checksum-verified Node
24.18.0 archive in `.dev/`. Nginx 1.24.0 was extracted from the current Ubuntu
package into `.dev/`; it was not installed as a service.

| Check | Result |
| --- | --- |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS, including all new `.mjs` modules |
| `pnpm test` | PASS: 5 files, 20 tests |
| `pnpm test:infra` on Windows | PASS: 26 passed, 13 explicit Linux skips |
| Linux `node --test infra/tests/*.test.mjs` | PASS: 37 passed, 2 PowerShell/Windows skips; all 39 cases exercised across the two OS runs |
| `pnpm build` | PASS: Vite assets, generated PWA worker/precache, release packaging and shared validator |
| `pnpm validate:artifact` | PASS: `workout / local`, `/apps/workout/` identity and file integrity |
| `pnpm test:nginx --nginx <extracted-binary>` in WSL | PASS: actual `nginx -t` and all isolated HTTP assertions |
| `pnpm test:e2e` | PASS: all 4 Chromium scenarios |
| Full `pnpm run verify` with Python absent from PATH | PASS, exit 0: typecheck, lint, 20 Vitest tests, 26 Windows infrastructure cases (13 explicit Linux skips), build/artifact validation, all 4 Playwright scenarios |
| Linux infrastructure and Nginx with Python absent from PATH | PASS: 37 infrastructure cases (2 Windows/PowerShell skips), real configuration test and all HTTP assertions against the final build |
| `pnpm install --frozen-lockfile` | PASS: restored 494 exact locked packages from cache, no downloads or dependency upgrades; lockfile unchanged |
| `git diff --check` | PASS |

The WSL pnpm invocation uses `--config.verify-deps-before-run=false` **only for
the dependency-free Nginx script**, to avoid replacing the Windows checkout's
dependencies with Linux packages. No project setting was changed. An initial
WSL attempt stopped at pnpm's no-TTY dependency-recreation guard before running
Nginx; the isolated rerun passed. A subsequent Windows dependency refresh stalled
before verification; that invocation was stopped, its incomplete dependency
directory preserved under `.dev/`, and a fresh frozen-lockfile install restored
the exact packages. The final full run above passed. An outdated Ubuntu package
URL returned 404; the current package index supplied the working package and checksum.

The unchanged browser suite exercises native IndexedDB compatibility and
recovery, save/reopen/completion, offline deep links and saving, and a real
waiting service worker that respects unsaved edits. These use test profiles and
fixtures, not the owner's saved workout records.

### Python-free execution proof

The verification process is launched with a deliberately restricted PATH:
the installed Node directory, pnpm shim directory, Windows System32 and the
built-in PowerShell directory. Python installation directories, WindowsApps
aliases and `C:\Windows` (which contains `py.exe` on this machine) are excluded.
Python/virtual-environment override variables are cleared. Before invoking the
unchanged `pnpm run verify` command, `Get-Command` must find none of `python`,
`python3`, `py`, `pip` or `pip3`; otherwise the proof aborts.

Reproduce from a fresh PowerShell process at the repository root:

```powershell
$ErrorActionPreference = 'Stop'
$nodeDir = Split-Path (Get-Command node.exe).Source
$pnpmDir = Split-Path (Get-Command pnpm.cmd).Source
$env:PATH = @($nodeDir, $pnpmDir, "$env:SystemRoot\System32",
  "$env:SystemRoot\System32\WindowsPowerShell\v1.0") -join ';'
foreach ($name in @('PYTHON','PYTHONHOME','PYTHONPATH','VIRTUAL_ENV',
    'CONDA_PREFIX','npm_config_python')) {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
foreach ($name in @('python','python3','py','pip','pip3')) {
  if (Get-Command $name -ErrorAction SilentlyContinue) { throw "$name is available" }
  Write-Output "$name unavailable in verification PATH"
}
pnpm.cmd run verify
if ($LASTEXITCODE -ne 0) { throw 'Verification failed' }
```

This proves executable lookup absence in the verification environment; it does
not uninstall Python from the owner's computer. The repository source/CI audit
also finds no absolute or indirect Python invocation in required commands.

The Linux proof additionally used a PATH containing only temporary symlinks to
Node, rsync, mkfifo and true. All five Python command lookups failed before
running the infrastructure suite and Nginx integration. Linux flock remains at
its explicit `/usr/bin/flock` path; Nginx uses the extracted binary's absolute
path. Both runs passed. Neither proof substitutes a Python stub or silently
turns Python commands into successes.

## Remaining dependencies and limitations

There are no remaining repository Python executables or required Python
commands. Historical Python references in `docs/deployment-integration.md` are
retained because they describe the earlier integration's files and executed
checks. The onboarding guide's statement that Python is not needed remains
accurate. Migration notes and a negative workflow regression assertion also
mention Python intentionally.

Linux deployment/integration tooling still requires rsync, util-linux flock,
OpenSSH and Nginx or Docker as appropriate. These are existing protocol/OS
requirements; Node replaces the Python helpers, not Nginx static hosting.
There is no runtime Node application server, new backend, or paid API.

Local Nginx verification used Ubuntu Nginx 1.24.0. The CI Docker image remains
`nginx:1.28.0-alpine`; that exact container variant and hosted GitHub Actions
were not run locally. No real GitHub API/SSH activation, public production
health failure, live rollback or Droplet filesystem was exercised. Synthetic
keys, fake API tests and isolated release fixtures cover their local logic.

The live host was neither inspected nor modified. If its installed shared
helpers are the old Python implementations, they still require Python there.
The workflow retains their wire protocol and remains compatible, but claiming
the **existing host** is Python-free would require a separate owner-approved
migration. The Node reference can replace those helpers under the same
root-owned installation policy, with Node 24.18.0 and util-linux flock available
and the forced-command entry point updated to `ssh_gateway.mjs`. Review all
shared-host consumers first. This task does not install it or change SSH/Nginx.

## Studio follow-up before a new pathway

No Studio repository, Settings, authorization, hold, pathway or worktree was
modified. There is no Studio validation configuration file in this checkout.
The existing Vite validation profile still needs the exact command:

```text
pnpm run verify
```

Required owner follow-up:

1. Review and integrate this migration in the ordinary checkout using the
   owner's Git workflow. The updated baseline must contain the new modules and
   scripts; do not copy changes into `wc_001` or `wc_002`.
2. Before starting a **new** pathway, have Studio capture a fresh verification
   identity from that updated baseline and approve that identity through its
   normal authorization flow. The `verify` string is unchanged, but its
   transitive commands and `package.json` bytes changed: `build`, `test:infra`,
   `test:nginx`, and new `validate:artifact`. Old frozen identities must not be
   reused or manually patched to conceal this change.
3. Keep Node **24.18.0**, pnpm **11.9.0**, the ordinary project root and the Vite
   profile. Any future project-specific prerequisite/enrollment list should
   require the existing Node/pnpm executables, with no Python executable, PATH,
   venv or Python test command. The normal Windows verify command does not
   require WSL, Nginx or Docker; Linux integration remains a separate CI check.
4. Leave existing pathways, worktrees, holds and authorization records intact.
   If Studio reports a frozen-identity mismatch, recapture/reapprove for the
   new baseline rather than weakening verification or changing the command.

Exact Studio internal field names or UI steps cannot be certified without
inspecting Studio's current implementation/state; this task intentionally did
neither. No Studio backend rewrite or validation-profile command change is
needed in Workout Companion.
