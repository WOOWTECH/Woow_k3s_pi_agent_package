# RC6 companion candidate — 2026-11-27

This k3s worktree selects the complete paired candidate:

| Package | Source commit | Archive SHA-256 |
| --- | --- | --- |
| Agent Connect 0.1.27-rc.6 | `867d9065f609aa5e32d88f2d55cf07c5d3fadc3e` (archive commit `ba9f1c408a61193efc47c2914c6edd67c6f681b7`) | `224c819fc14876c86f5febe0996a26e73ce618682faf611bac1b340b08b71335` |
| Omnigent 0.3.42-rc.6 | `d4640bac3fd48b338c1f81230cb3d31fb75f79b2` | `91321ee0af4a8500317b726113e0c24332026f26142c4400b283cd55883f12e0` |

The Agent Connect adapter SHA-256 is
`22d3a604d0c3ddc9305afe07f9f68524bec906fddb16636c08ac2783b4442a6c`.
Omnigent's combined adapter SHA-256 is
`8d55d6824307023eed5ead7fa89080650d3981fae1746378db9a400fab8a9632`;
the archive metadata pairs both RC6 packages and declares zero effective
dependency changes after removing the stale JSON3 entry.

The C6 sessions acceptance checks bounded raw gzip bytes and normal
`fetch().json()` parsing on the owned image loopback server. The local helper
receipt at
[`logs/sessions-http-json-live-piweb-receipt.json`](../logs/sessions-http-json-live-piweb-receipt.json)
records Pi Web 0.12.0 / Next 16.3.8 and the exact installed package/lock hashes.
Canonical Agent Connect RC6 production HTTP evidence separately records Next
16.4.6 and valid single-layer gzip JSON. The k3s image source still pins Pi Web
0.10.0 / Next 16.3.6 and checks the installed Next package version at startup.

The source acceptance suites pass, but no k3s image was built locally. Fresh
RC6 multi-architecture image acceptance and the publication gate remain
required; the PaaS BASE and mirror are unchanged.
