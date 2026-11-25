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
| `@woowtech/pi-paseo` (Agent Connect) | 0.1.23 | `0e4f3c99dc26b670b59c5b328285655dd47b0d81f892707f7ce387ca551e0265` |
| `@woowtech/pi-omnigent-plugin` | 0.3.38 | `2ed6aef9d64a3e53166805db76a98437aee44a4401b6cc698bd92c6a79425cde` |
| `@woowtech/pi-agent-shared-runtime` | 0.1.6 | `0914069fb0cf83f258cf81034bb16573f6e4242e8779cea47b4a5e841f98a937` |
| Combined Pi Web 0.10 adapter | 0.3.38 | `a5f5e6ebe6efd9ba350fe8e494677ef224ad7681d7e44beb4840d281dfbc4449` |

The table is the current snapshot; `candidate-packages/manifest.json` is the checked record (see `tests/test_publication_packages.py`). The sections below keep the history of how the candidate was prepared, so they name the versions of their day.

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

## 2026-11-25 — official Paseo app, bundled web client removed

Agent Connect 0.1.23 (source `152e1c3afe4b7081fa859f40aa316059cc3fa4fd`) and Omnigent plugin 0.3.38 (source `a447f30d4953c367916a68aaa3b621815cd93c81`) replace 0.1.20 and 0.3.35 in the table above. The combined adapter is regenerated and accepts only Agent Connect 0.1.23. The Paseo target now opens and pairs at `https://app.paseo.sh`: the bundled `/paseo-web` client, its Pi Web route and the image's offline web archive are removed, and Agent Connect deletes the copy older versions left in `<stateDir>/web-client` when it activates. The managed Paseo runtime lock, its patches and its layout are byte-identical to 0.1.20, so the runtime stays 0.11.2 with revision `0.11.2-r4-4cf9d40940bf`.

Browsers paired through the old `/paseo-web` pair once more; host identity and provider logins are unchanged, and tenants need the image restarted. This change adds no image or chart version: the PaaS build produces the image tag. Before promotion the exact-image acceptance, including the owned maintenance gate for the 0.3.38 archive, has to run on the new image. A later Agent Connect 0.1.24 moves the runtime to Paseo 0.17.4 and replaces this pair.
