# Agent Connect 0.1.24 / Omnigent 0.3.39 — local handoff

Task `a8b32f4365e7cfe0b`, branch `feat/agent-connect-official-paseo-20261125`.
Implementation commit: `2b4b67a4efab2df0c98097c119b545b83585d32c`.
The preceding `2cbfce7` and `90a49ce` commits are preserved. The incoming dirty
seed/test changes were completed. All commits are local, authored/committed as
`Claude Code <claude@anthropic.com>` with the requested Claude Sonnet 5.5 trailer.

## Completed review items

- Retained fixtures use actual agent/HOME paths, including Pi and provider
  credentials, daemon config/identity/conversations, pairing, preferences,
  state, retired web client and an old HOME runtime receipt. Fresh fixtures
  prove those files are not created. Both recursive directory readers use
  `entry.parentPath ?? entry.path`; the seed entry point is synchronous.
- Gitea runs the seed/migration tests before merge, with `rootfs/**`,
  `tests/*.test.mjs` and `tests/image-paseo.mjs` triggers. The workflow itself
  has a source regression test. Maintenance refusal requires the exact reason
  in both the guard response and installer result, including `unsafe-source-file`.
- Both READMEs and candidate notes cover PID permissions, collaboration off
  by default, guard recovery reasons, 0.17.4 config migration/defaults,
  Smart relay security, terminal workers/procps, disk use and rollback limits.
  Root release-tag wording follows `docs/IMAGE_PUBLICATION.md`.
- The 0.3.34 tarball had no reader in root/PaaS scripts, workflows or tests
  other than its allowlist. It and that allowlist were removed; Git history
  retains the bytes. The PaaS mirror's old version contract is independent
  of this tarball and was not changed.
- HA's launcher was read only for comparison. k3s inherits the image's
  `/opt/woow/pi-paseo-runtime` instead of preferring an old HOME runtime.
  The actual frozen plugin's `locations()` and `runtimeReady()` passed
  against an old-HOME fixture. `installRuntime()` only invokes runtime
  `npm ci` when that readiness check fails. This is selection/readiness
  evidence, not a daemon activation test; explicit runtime overrides are
  outside this guarantee.
- The prepared amd64 runtime measured 696,775,513 installed bytes and
  248,016,309 gzip-tar bytes (236.5 MiB). No image was built. GHCR's documented
  limits do not require splitting it; HA's separate 256 MiB budget and
  potential upload-proxy limits are documented in `IMAGE_PUBLICATION.md`.
  Ownership now uses `COPY --chown=1000:1000`, with modes prepared in the
  builder, to avoid a later ownership change duplicating the payload.

## Verification and evidence

The exact frozen archives match the supplied SHA-256 values. The combined
adapter is `5e2c36b43f56e9ca8c3c2873d94102a86c75b74973cc23b278c34a2556e678a5`.
All 37 maintenance package file hashes, sizes and modes were checked, together
with the gate-pins hash, publication-script hash, source-lock before/after
hashes, Dockerfile hash and manifest hash. The image's `expectedBrand` matches
both the frozen plugin and the prepared runtime's actual server/helper bytes
and receipt. Exact identities and log digests are in
[the verification record](agent-connect-0124-20261126.json).

| Local check | Result |
| --- | --- |
| Node 22.23.3 seed/migration tests | 54 passed |
| Python 3.12.14, PyYAML 6.0.2, all source tests | 93 passed |
| Gitea's separate `python -I -B` maintenance suite | 34 passed (included in the 93 above) |
| Profile, shared-runtime seed, Pi session environment shell suites | All 3 passed |
| Node/Bash syntax, Python compile and whitespace checks | Passed |
| Updated `image-paseo.mjs`, path-remapped to existing prepared amd64 artifacts | Passed |

Persistent logs and fixtures are under
`../../.local-checks/agent-connect-0124-20261126/` in this worktree, not only in
the original scratch directory. `run-source-checks.sh` reproduces the local
CI mirror using the prepared venv; `local-ci-mirror.log` records each result.
Other logs are `node-seeds.log`, `python-all.log`, `maintenance-isolated.log`,
`profile.log`, `shared-seed.log`, `session-env.log`, `syntax.log`,
`py-compile.log`, and `image-paseo-emulated.log`. The incoming dirty patch and
original review checklist are also saved there. The ignored prepared runtime
is an existing local install copied for inspection; it was not rebuilt.

The first Python pass detected the expected stale whole-Dockerfile hash after
the ownership-layer edit. The reviewed hash was refreshed and the suite passed.
The known baseline missing-install test used to fall through to this host's
`/opt/omnigent/venv`; it now redirects default search roots to owned fixtures
before invoking the real parser/patcher. A new test proves that default-root
fallback still works. No check was skipped and the host installation was not
patched by these tests.

## Exact future PR source checks

From a clean checkout of this branch, use Node 22 and Python 3.12. These are
source tests only; the full Python discovery is a superset of Gitea's
`test_publication_*.py` selection and matches the build workflow's source step.

```bash
set -euo pipefail
mkdir -p .local-checks/pr/tmp
export TMPDIR="$PWD/.local-checks/pr/tmp"
export PIP_CACHE_DIR="$PWD/.local-checks/pr/pip-cache"
export PYTHONDONTWRITEBYTECODE=1
export NODE_DISABLE_COMPILE_CACHE=1
python3.12 -m venv .local-checks/pr/venv
export PATH="$PWD/.local-checks/pr/venv/bin:$PATH"
python -m pip install 'PyYAML==6.0.2'
python -m unittest discover -s tests -p 'test_*.py' -v
python -I -B tests/test_image_maintenance_gate.py
node --test tests/*seed*.test.mjs tests/plugin-pin-migration.test.mjs
bash tests/test-profile-posix.sh
bash tests/test-shared-runtime-seed.sh
bash tests/test-pi-session-env.sh
node --check tests/image-paseo.mjs
node --check tests/image-managed-maintenance.mjs
node --check rootfs/usr/local/bin/pi-paseo-seed.mjs
bash -n scripts/accept-image.sh
PYTHONPYCACHEPREFIX="$PWD/.local-checks/pr/pycache" python -m py_compile \
  scripts/image-candidate.py scripts/image-publication.py tests/image-browser.py \
  scripts/image-maintenance-gate.py tests/image-managed-maintenance-check.py \
  tests/test_image_maintenance_gate.py
git diff --check
```

After a separately authorized candidate build, the exact final-image command
on its disposable release runner is:

```bash
python3 -m pip install 'playwright==1.56.0'
python3 -m playwright install --with-deps chromium
bash scripts/accept-image.sh image-candidate.json
```

Use the genuine candidate record for that exact source/digest and both
architectures. The acceptance script runs the baked Paseo checks, the owned
maintenance gate and the browser/other image checks. It is not a host test.

## Files changed

```text
.gitea/workflows/publication-contracts.yml
.gitignore
Dockerfile
README.md
README_zh-TW.md
candidate-packages/README.md
candidate-packages/woowtech-pi-omnigent-plugin-0.3.34.tgz (removed)
docs/AGENT_CONNECT_CANDIDATE.md
docs/IMAGE_PUBLICATION.md
docs/evidence/agent-connect-0124-20261126.json
docs/evidence/agent-connect-0124-handoff-20261126.md
rootfs/usr/local/bin/pi-paseo-seed.mjs
tests/image-managed-maintenance.mjs
tests/image-paseo.mjs
tests/paseo-seed.test.mjs
tests/test_image_maintenance_gate.py
tests/test_omnigent_model_options.py
tests/test_publication_packages.py
tests/test_publication_workflow.py
```

## Remaining release limits

No push, PR, merge, remote mutation, image build, deployment or mutation-test
campaign was performed. Hermes and HA were not changed. The reused amd64
artifact check does not certify a newly built image, changed COPY ownership,
ARM64, container reboot, a real managed SDK repair, provider replies or live
Smart/Paseo relay pairing. These still require their authorized release gates.
The PaaS mirror retains its old root digest and `/paseo-web` contracts; its
upstream imports/routes/contracts must be updated and tested before a base bump.
