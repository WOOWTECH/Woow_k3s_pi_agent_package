# Agent Connect 0.1.27 / Omnigent 0.3.42 pair — 2026-11-27

This k3s companion selects the complete paired stable release (both archives are GitHub Release assets;
`candidate-packages/manifest.json` records their `releaseURL`):

| Package | Source commit | Archive SHA-256 |
| --- | --- | --- |
| Agent Connect 0.1.27 | `053a39a7b72e83787a419b97206adc34f45e35bb` (source/archive commit) | `aecf3bdff1505d3745ddc694f1e50fead50a0fc19b3fa2c82205174917143b6f` |
| Omnigent 0.3.42 | `7b56ad586711e6a707c6c3f36ff5dc5fef2790a4` | `7ffa8983e3bb2d9790f3122fd53db3e7adca4e24aed33f37aa4cc86bbeea5bb5` |

The Agent Connect adapter SHA-256 is
`22d3a604d0c3ddc9305afe07f9f68524bec906fddb16636c08ac2783b4442a6c`.
Omnigent's combined adapter SHA-256 is
`8d55d6824307023eed5ead7fa89080650d3981fae1746378db9a400fab8a9632`;
the archive metadata pairs both packages and declares zero effective
dependency changes after removing the stale JSON3 entry.

The sessions acceptance checks bounded raw gzip bytes and normal
`fetch().json()` parsing on the owned image loopback server. The local helper
receipt at
[`logs/sessions-http-json-live-piweb-receipt.json`](../logs/sessions-http-json-live-piweb-receipt.json)
records Pi Web 0.12.0 / Next 16.3.8 and the exact installed package/lock hashes;
this is isolated helper evidence, not the k3s image version.
Canonical Agent Connect 0.1.27 production HTTP evidence separately records Next
16.4.6 and valid single-layer gzip JSON. The k3s image source still pins Pi Web
0.10.0. The combined adapter changes its package and lock to Next 16.4.6,
which startup checks against the installed `next/package.json`.

The source acceptance suites pass, but no k3s image was built locally. Fresh
multi-architecture image acceptance and the publication gate remain
required; the PaaS BASE and mirror are unchanged.
