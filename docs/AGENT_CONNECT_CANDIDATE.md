# Agent Connect coordinated release candidate — 2026-11-27

This isolated root-image companion pins the exact peer-matched RC6 archives.
It remains unpublished: no OCI image was built or published, and no PaaS
BASE digest or mirror was changed.

| Input | Candidate | Source head | Archive SHA-256 |
| --- | --- | --- | --- |
| `@woowtech/pi-paseo` (Agent Connect) | 0.1.27-rc.6 | `867d9065f609aa5e32d88f2d55cf07c5d3fadc3e` (archive commit `ba9f1c408a61193efc47c2914c6edd67c6f681b7`) | `224c819fc14876c86f5febe0996a26e73ce618682faf611bac1b340b08b71335` |
| `@woowtech/pi-omnigent-plugin` | 0.3.42-rc.6 | `d4640bac3fd48b338c1f81230cb3d31fb75f79b2` | `91321ee0af4a8500317b726113e0c24332026f26142c4400b283cd55883f12e0` |
| Combined Pi Web 0.10 adapter | 0.3.42-rc.6 | bound to both heads above | `8d55d6824307023eed5ead7fa89080650d3981fae1746378db9a400fab8a9632` |

Agent Connect includes official Paseo `0.17.5`, runtime
`0.17.5-r4-8664f2c3f8f5`, and the complete peer-matched a7 payload. Its adapter
SHA-256 is `22d3a604d0c3ddc9305afe07f9f68524bec906fddb16636c08ac2783b4442a6c`.
The combined adapter metadata binds those exact versions and adapter digests.

The C6 image acceptance runs the bounded real HTTP sessions JSON check against
the owned loopback Pi Web process and also exercises the normal
`fetch().json()` client path. Its helper receipt records an actual Pi Web
0.12.0 / Next 16.3.8 run; canonical Agent Connect RC6 production HTTP logs
record a separate Next 16.4.6 check. The k3s source remains pinned to Pi Web
0.10.0 at `6fcd7d44981ab51a21d6cd6eb06d361d0e3d3068`, whose locked Next is
16.3.6; image startup verifies the installed version. No local image build is
claimed.

Fresh RC6 image acceptance on both architectures, publication gate, and any
separate PaaS derivative remain outstanding. The existing PaaS BASE is
unchanged.

The table is the current snapshot; `candidate-packages/manifest.json` is the
checked record (`tests/test_publication_packages.py`). Older sections below
preserve the history of earlier candidate generations.

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

Agent Connect 0.1.23 (source `152e1c3afe4b7081fa859f40aa316059cc3fa4fd`) and Omnigent plugin 0.3.38 (source `a447f30d4953c367916a68aaa3b621815cd93c81`) replaced 0.1.20 and 0.3.35. The combined adapter was regenerated and accepted only Agent Connect 0.1.23. The Paseo target now opens and pairs at `https://app.paseo.sh`: the bundled `/paseo-web` client, its Pi Web route and the image's offline web archive are removed, and Agent Connect deletes the copy older versions left in `<stateDir>/web-client` when it activates. The managed Paseo runtime lock, its patches and its layout are byte-identical to 0.1.20, so the runtime stays 0.11.2 with revision `0.11.2-r4-4cf9d40940bf`.

Browsers paired through the old `/paseo-web` pair once more; host identity and provider logins are unchanged, and tenants need the image restarted. This change adds no image or chart version: root `v*` candidates require `publish-accepted-image`, and PaaS consumes the accepted root `tag@sha256` for its separate derivative build ([publication contract](IMAGE_PUBLICATION.md)). Before promotion the exact-image acceptance, including the owned maintenance gate for the selected Omnigent archive, has to run on the new image. Agent Connect 0.1.24 then replaced this pair; the table above is the current snapshot.

## 2026-11-25 — Paseo 0.17.4 and the complete upgrade

Agent Connect 0.1.24 comes from `ee8f9b437dc8e7e4041dc0c9ef73755951cd5bbb`, paired only with Omnigent 0.3.39 from `b2c6d12c171013cb7575fb4161afe17d92d76d87`. Its runtime is `0.17.4-r1-a651f42711da`. The frozen plugin README, shipped in the archive, describes the lifecycle semantics. The full jump from 0.1.20 / 0.3.35 includes:

- **0.1.21 PID permissions:** the owned, single-link PID file may be group-writable within a private `0700` daemon home, matching upstream's umask `002` behavior. World-write, ownership, symlink and private-proof checks remain.
- **0.1.22 collaboration:** “Allow agents to collaborate” controls `daemon.mcp.injectIntoAgents`, off by default. Turning it on gives agents tools to create/control agents, terminals and schedules, change permission modes and approve permissions. Terminal commands need no confirmation. Only new conversations pick up a change; disabling the switch leaves existing tools and schedules active. Stop/start Agent Connect and review schedules to reset them. Local CLI execution remains possible for agents allowed to run commands, so this is not a sandbox.
- **Omnigent 0.3.36–0.3.37:** maintenance refusal includes a bounded `reason`, including `unsafe-source-file` for hard-linked source. The recovery hint is `repair --update`: reinstall the managed SDK in copy mode, then verify preservation. The gate asserts the expected reason from both guard and installer.
- **0.1.23:** the official Paseo site replaces the bundled client, as described above.
- **0.1.24 first start:** use 0.17.4's own config loader/migrations before writing managed fields. OpenAI credentials/URLs move into the selected voice providers, missing voice providers become `local`, and unsupported local-voice fields are removed. An invalid file reports `CONFIG_CORRUPT`; incompatible settings report `CONFIG_INCOMPATIBLE`. Correct these before stopping a live old daemon. Otherwise that daemon continues serving with `RESTART_REQUIRED` until stop/start. The plugin uses the old daemon's verified release for its control calls; an unavailable release reports `DAEMON_RELEASE_UNAVAILABLE`. Replacing the container ends its old processes before the new runtime starts on the retained daemon home.
- **Smart targets:** every start sets `daemon.relay.requireProtectedSecurity=false` for Woowtech Smart/Apporo Smart's older relay protocol. If it is re-enabled while running, the plugin refuses pairing with `PAIRING_SECURITY_UNSUPPORTED`. Paseo clients retain their choice. Live branded app pairing is still required before rollout.
- **0.17.4 defaults:** `agents.idleRuntimeCleanup` closes idle runtimes after 60 minutes while retaining conversations for reopening. `daemon.usage.enabled` allows client-requested usage queries using the host's provider credentials; disabling it stops those queries. Both can be changed with daemon config/reload. These are daemon settings, separate from the collaboration switch.
- **Terminal workers:** the image already supplies procps `ps`. Detached terminal workers survive daemon crashes/restarts; explicit stop cleans them up. `PS_UNAVAILABLE` / `PS_INCOMPATIBLE` can mean cleanup leaves background jobs behind, and repeated unresolved cleanup can cause `STOP_NOT_CONFIRMED`. Status/diagnose expose these warnings; the Pi Web settings page does not show all of them.

The k3s Dockerfile sets `PI_PASEO_RUNTIME_DIR=/opt/woow/pi-paseo-runtime`; neither `pi-agent-env.sh` nor `pi-web-start.sh` replaces it with HOME's older runtime. With the image's ready prebuilt release, the plugin skips runtime `npm ci`. Seed migration only changes package registration, preserving Pi/provider credentials, daemon identity, pairing, preferences, state, conversations and any old runtime under HOME. `tests/image-paseo.mjs` verifies the actual plugin's location/readiness against such a fixture. An explicit runtime override or a different plugin can require installation; it is not covered by this default-path guarantee. HA uses a different runtime-selection launcher and was inspected only for comparison.

One release directory is about 0.6–0.7 GB; 0.11.2 plus 0.17.4 is about 1.3 GB. The plugin prunes only recognized unused releases after a healthy new start, keeping the current release, one prior release for rollback, newer releases and releases still in use. It does not clean a separate old runtime under HOME when using `/opt/woow/pi-paseo-runtime`. Budget persistent HOME, image layers and container writable space separately. See [layer limits](IMAGE_PUBLICATION.md#runtime-layer-size).

Rollback also needs stop/start. 0.17.4 can write voice config and agent `providerOptions`/`controls` that 0.11.2 cannot fully interpret; restore compatible config (including OpenAI voice credentials) and reselect affected agent options. Preserving files does not guarantee automatic downgrade compatibility.

The mirrored `paas/` still pins its older root digest and managed-web contracts. Its upstream seed imports, route expectations and runtime contracts must be updated and accepted before bumping that base. This candidate does not change the PaaS mirror or certify a final image, ARM64 runtime, HA upgrade or live provider/relay session.
