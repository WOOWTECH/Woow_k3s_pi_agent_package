# Coordinated Agent Connect candidate inputs

These are exact locally packed npm payloads, committed so a reviewed source
revision can build before the corresponding npm/GitHub releases exist. They are
not evidence of a public release. Package IDs remain unchanged.

`manifest.json` records package identity, version, SHA256 and publication state.
The Dockerfile copies each archive, verifies its SHA256 and package identity,
then performs the original install/build/acceptance gates. Lifecycle scripts do
not run while unpacking. Shared runtime includes `npm-shrinkwrap.json`; its
original `npm ci --omit=dev --legacy-peer-deps --ignore-scripts` and discovery
patch/verification remain in place.

| Source | Package | Candidate |
|---|---|---|
| `WOOWTECH/pi-paseo-plugin` | `@woowtech/pi-paseo` | 0.1.18 |
| `WOOWTECH/pi-omnigent-plugin` | `@woowtech/pi-omnigent-plugin` | 0.3.33 |
| `WOOWTECH/pi-agent-shared-runtime` | `@woowtech/pi-agent-shared-runtime` | 0.1.5 |

Review an archive without executing it using `tar tzf <file>` or
`tar xOf <file> package/package.json`. Verify all manifest digests before using
the archives outside the Dockerfile. The combined adapter pins the exact
Agent Connect contributor; mixing prior plugin versions is rejected.

Image promotion and PaaS deployment keep their existing gates. The shared
runtime's ordinary startup preserves disabled selections; an authorized
explicit `enable` migration backs up settings before moving an old local source
to the bundled canonical path. No identities, provider credentials, workspace
files or sessions are included in these archives.
