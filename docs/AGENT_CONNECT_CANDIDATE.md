# Agent Connect release candidate — 2026-11-21

This is coordinated source preparation, not a published release or deployment.
The package archives below were produced locally with `npm pack`; the public
release URLs do not exist yet. Their SHA-256 values are the actual local bytes,
not placeholders. This image build consumes the reviewed archives committed
under `candidate-packages/`, verifying their digests before installation. Other
installers still need publication and anonymous download verification before
they can consume the candidate release URLs. Repacking changed source requires
updating every consumer pin together.

| Input | Candidate version | SHA-256 |
| --- | --- | --- |
| `@woowtech/pi-paseo` (Agent Connect) | 0.1.17 | `e1e3e420332ee9af34b4a5cb578c140c98b20a032e6bb8c4800e87df569cdcd3` |
| `@woowtech/pi-omnigent-plugin` | 0.3.33 | `8e3b55379e7850bc54896175a03c7611ee9d0080a21b8281441ac906b0a26fc9` |
| `@woowtech/pi-agent-shared-runtime` | 0.1.5 | `e70cbe7cdcee81ffff755cf1745608033a4615efe9fbbc14ec124a81a74f17d8` |
| Combined Pi Web 0.10 adapter | 0.3.33 | `dc6cf4eb7531445e1a9246a35c6383a60c6769f1e71ac1aa4e1aae9fae3128a7` |

Changes belong to the authoritative Gitea repository. The GitHub repository
and `paas/` remain mirrors; this candidate does not edit `paas/`. PaaS rollout
requires its own rebuilt derivative image and digest pin.

Agent Connect preserves package IDs and paths. Existing installations default
to Paseo; users may choose Woowtech Smart or Apporo Smart. A running daemon
continues until the user stops and starts it to apply a target change. Pairing
is blocked while that change is pending.

Shared runtime exposes host-local memory and shared skills/MCP to the three
providers. Ordinary startup preserves disabled selections. Explicit `enable`
migration backs up settings before replacing a legacy local source with the
bundled path; hosts keep independent state directories.

Before publication, run each platform's existing acceptance and upgrade gates
using the exact candidate image or installer. Local Linux tests and browser
fixtures do not substitute for macOS/Windows host acceptance, a multiarch
container build, HA Supervisor upgrade tests or actual branded relay pairing.
