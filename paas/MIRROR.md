# paas/ — the WOOW PaaS pi-agent edition (read-only mirror)

Everything **outside** `paas/` is this repository's own k3s package: the
upstream image `ghcr.io/woowtech/woow-k3s-pi-agent` (`Dockerfile`, `rootfs/`)
and the single-instance chart that runs the internal `pi-agent-woow` machines
(`charts/pi-agent`, `values/woow-k3s/*`).

`paas/` is **different**: it mirrors the pi-agent cloud service sold on the
WOOW PaaS platform. Its source of truth is the internal Gitea
(`git-prod.woowtech.io`); changes land there first, go through that repo's
review and prod approval gates, and are synced here with
[`scripts/sync-paas-from-gitea.sh`](../scripts/sync-paas-from-gitea.sh).

**Do not edit `paas/image/`, `paas/chart/` or `paas/shared/` here** — the next sync overwrites
them. Open the change against the Gitea repository instead.

## Current sync

<!-- BEGIN GENERATED: scripts/sync-paas-from-gitea.sh -->
| Mirror path | Source repository | Source path | Commit |
|---|---|---|---|
| `paas/image/` | `woow-paas/paas-odoo-ci` | `pi-agent/` | `71f5b3c2c50a5ffab209789b5798721d47cc41c5` |
| `paas/chart/` | `woow-paas/woow-paas-charts` | `charts/pi-agent/` | `2f634a79a7d9df52369314220d5e429b90b530e8` |
| `paas/shared/omnigent-host/` | `woow-paas/woow-paas-charts` | `shared/omnigent-host/` | `2f634a79a7d9df52369314220d5e429b90b530e8` |

PaaS image base (this repository's release): `ghcr.io/woowtech/woow-k3s-pi-agent:0.2.4@sha256:32f83c2932003c7e5b24f40133011028d06bcfd919c420cb88e23f2822be6df6`  
PaaS image repository: `jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent` (the platform pins the tag by `tag@sha256`)

Chart `0.1.7` / pi-agent image `0.2.1` — synced 2026-10-14 08:30 UTC.
<!-- END GENERATED -->

## How the two editions relate

| | k3s package (repo root) | PaaS edition (`paas/`) |
|---|---|---|
| Image | `ghcr.io/woowtech/woow-k3s-pi-agent` — built here | `jcr-prod…/pi-agent` — a thin layer **on top of this repository's release image**, pinned by digest: uid 1000, `models-config` API-key redaction, video pipeline off |
| Chart | `charts/pi-agent` 0.2.x: cloudflared, NodePort/NPM, per-machine values | `paas/chart` 0.1.x: in-pod nginx basic-auth proxy (the only exposed port), pi-web on loopback, non-root, default-deny NetworkPolicy, ClusterIP behind the platform tunnel |
| Login | pi-web behind Nginx Proxy Manager | tenant username and password, set and rotated from the PaaS service page ("Admin Credentials") |
| Runs as | the internal `pi-agent-woow` machines | one release per tenant in a `paas-ws-*` namespace |

A new upstream release here (a `v*` tag) reaches PaaS tenants only after the
PaaS image is rebuilt on the new digest in `woow-paas/paas-odoo-ci` and the
platform re-pins it.

## Connecting a PaaS pi-agent to an Omnigent

A PaaS pi-agent can join an Omnigent service in the same workspace as a machine
(omnigent's own `omnigent login` + `omnigent host`, over the in-cluster
address). See
[WOOWTECH/Woow_k3s_omnigent_package](https://github.com/WOOWTECH/Woow_k3s_omnigent_package#readme).

## Resyncing

```bash
scripts/sync-paas-from-gitea.sh              # both Gitea repos at main
scripts/sync-paas-from-gitea.sh <ci-ref> <charts-ref>
```

Needs read access to both Gitea repositories.
