# Coordinated Agent Connect candidate inputs

These are exact locally packed npm payloads, committed so a reviewed source
revision can build before the corresponding npm/GitHub releases exist. They are
not evidence of a public release. Package IDs remain unchanged.

`manifest.json` records package identity, version, SHA256, source commit, the
Paseo runtime revision and publication state; it is the single record of the
version of each package the image installs.
`tests/test_publication_packages.py` fails when the archives, the Dockerfile
pins, `tests/maintenance-gate-pins.json` and the combined Pi Web adapter
disagree with it.
The Dockerfile copies each archive, verifies its SHA256 and package identity,
then performs the original install/build/acceptance gates. Lifecycle scripts do
not run while unpacking. Shared runtime includes `npm-shrinkwrap.json`; its
original `npm ci --omit=dev --legacy-peer-deps --ignore-scripts` and discovery
patch/verification remain in place.

| Source | Package |
|---|---|
| `WOOWTECH/pi-paseo-plugin` | `@woowtech/pi-paseo` |
| `WOOWTECH/pi-omnigent-plugin` | `@woowtech/pi-omnigent-plugin` |
| `WOOWTECH/pi-agent-shared-runtime` | `@woowtech/pi-agent-shared-runtime` |

Review an archive without executing it using `tar tzf <file>` or
`tar xOf <file> package/package.json`. Verify all manifest digests before using
the archives outside the Dockerfile. The combined adapter pins the exact
Agent Connect contributor; mixing prior plugin versions is rejected, so
`@woowtech/pi-paseo` and `@woowtech/pi-omnigent-plugin` are always replaced
together. `woowtech-pi-omnigent-plugin-0.3.34.tgz` is the previous frozen
Omnigent archive; it is kept for reference and is not installed or listed.

Image promotion and PaaS deployment keep their existing gates. The shared
runtime's ordinary startup preserves disabled selections; an authorized
explicit `enable` migration backs up settings before moving an old local source
to the bundled canonical path. No identities, provider credentials, workspace
files or sessions are included in these archives.
