# Deployment onboarding verification

Verified locally on 2026-11-15 in both the personal-app-template and
workout-companion repositories. No GitHub configuration or live Droplet was
accessed. No SSH private key was accessed. Changes remain unstaged/uncommitted.

| Check                                                     | Template                                          | Workout Companion                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck, lint, frontend unit tests and production build | `pnpm check` passed; 10 frontend tests            | `pnpm verify` passed; 20 frontend tests; artifact validation passed                                                              |
| Chromium production tests                                 | 3 passed                                          | 4 passed, including unchanged native IndexedDB history/metadata, draft recovery, offline save/reload and waiting-worker behavior |
| Built-in Windows PowerShell mock API suite                | 14 groups passed                                  | 14 groups passed                                                                                                                 |
| Windows infrastructure tests                              | 33 discovered: 21 passed, 12 POSIX skips          | 33 discovered: 21 passed, 12 POSIX skips                                                                                         |
| Local Ubuntu infrastructure tests                         | 33 discovered: 31 passed, 2 PowerShell-only skips | 33 discovered: 31 passed, 2 PowerShell-only skips                                                                                |
| Git whitespace/staging/source-scope review                | Passed; no staged changes                         | Passed; no staged or frontend/config/lockfile changes                                                                            |

Focused onboarding coverage includes exact configuration validation, mandatory
confirmed host/port, Workout wrapper constants, disabled setup, separate enable
invocation, repository identity/admin checks, public/private repository creation,
repeat runs without duplicate mutations, branch/tag policy reconciliation with
pagination, protection preservation, environment-variable shadowing, remote
source review, API failures, sanitized authentication errors, failed readback,
and restoration of the disabled flag after an uncertain enable write.

Host-key tests use synthetic public keys and mocked discovery. They cover
standard/custom ports, canonical ED25519 SSH wire encoding and SHA256 pins,
missing/wrong/malformed/ambiguous keys, wrong endpoint tokens, identical
duplicates, timeout/process failures, atomic known_hosts replacement, and SSH
option wiring for upload, activation and rollback. No real keyscan was performed.

The Linux suites exercise actual local rsync protocol, file locks, activation,
stale-run rejection, conditional rollback, storage reserve and retention. Those
tests use temporary directories, not a production server.

Hosted GitHub Actions, real GitHub REST writes, real SSH deployment and live
health/rollback are deliberately untested here. Nginx/Docker are unavailable in
the local Ubuntu installation, so actual Nginx integration remains a required
hosted CI check. The added Windows onboarding job gates the existing Ubuntu
check job; the deployment protocol and its existing gates remain in place.

See [the onboarding guide](github-onboarding.md) for exact owner commands and the
manual environment-secret step. Existing protected-branch-only environments
require owner review before switching policy modes; private environments also
require a supporting GitHub plan. Neither limitation triggers an insecure fallback.
