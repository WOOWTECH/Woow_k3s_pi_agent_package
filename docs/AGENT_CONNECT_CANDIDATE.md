# Agent Connect release candidate — 2026-11-21

This is coordinated source preparation, not a published release or deployment.
The earlier images failed live shared-skill authority or isolated extension-boundary checks and are superseded.
The package archives below were produced locally with `npm pack`; the public
release URLs do not exist yet. Their SHA-256 values are the actual local bytes,
not placeholders. This image build consumes the reviewed archives committed
under `candidate-packages/`, verifying their digests before installation. Other
installers still need publication and anonymous download verification before
they can consume the candidate release URLs. Repacking changed source requires
updating every consumer pin together.

| Input | Candidate version | SHA-256 |
| --- | --- | --- |
| `@woowtech/pi-paseo` (Agent Connect) | 0.1.20 | `1574c1bd1d0023c7b536c9feb773e1cdded929104d79cfb05b1deda5846203f8` |
| `@woowtech/pi-omnigent-plugin` | 0.3.34 | `e9e80783881f8a036cbf922d2f50fad860dac3bd23e170dda768ab3c56107945` |
| `@woowtech/pi-agent-shared-runtime` | 0.1.5 | `f59b204a681f147b843199ffec9845723176916dee979ee78c4cf82b7dd1f3ea` |
| Combined Pi Web 0.10 adapter | 0.3.34 | `f5c909b3fe6f544e11a4eed46c7e217a490f89c5e4ec356c9906e3908d9f6c30` |

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

Shared runtime source `8009ba9c77148b8d329d3660cca31c4da91e435c` retains the skill-authority fix and prevents resource synchronization from importing user extensions. The original sentinel failed all 10 source cases; the replacement passes those 10 cases, the full 61-test source suite, 21 focused SDK 1.4 checks and 12 exact-archive SDK 1.4 checks including the actual shared-memory MCP bridge. The dependency lock is unchanged and its audit reports zero findings. These results do not replace final image or live provider acceptance.

The image installs `tests/image-shared-sync-boundary.mjs`. Canonical `scripts/accept-image.sh` runs its six sync/initialize/boot/watch/provider-refresh checks on every built architecture with no network or provider login. Provider child positive controls use owned fake CLI binaries and the actual Pi SDK. Each architecture must record `shared-sync-extension-boundary:<platform>` in the image acceptance receipt; `scripts/image-publication.py` rejects promotion when this check is absent. The same regression must pass on the final PaaS derivative before any controlled host upgrade.

Connector source `aea2da4a83dbd220d8e9aa532ff91f9ac4e2c206` adds the selected-target `server_info.brand` identity to the frozen official server. Runtime `0.11.2-r4-4cf9d40940bf` preserves the runtime lock and PID transition patch. Root and PaaS image gates require the exact patched server, helper and brand receipt; the root gate checks all three selected identities. Earlier macOS lifecycle receipts remain historical evidence for the prior archive. The new archive requires fresh exact-image and branded public-Web acceptance.

Connector 0.1.20 also raises the outer supervisor stop budget to 30 seconds, above the nested 20-second graceful deactivate budget. The previous 0.1.18 image is held after the real macOS first-stop failure; its build receipts remain diagnostic. The final derivative must rerun its actual daemon recovery/normal-stop gate.

Joint fixture correction: Paseo 0.1.20 and Omnigent 0.3.34 bind the exact new standalone and combined adapter patches. Runtime production modules remain byte-identical to 0.1.19. The VM fixtures now supply lifecycle timeout constants and the r4 runtime generation; the earlier 0.1.19/0.3.33 combination was rejected before a derivative was built.
