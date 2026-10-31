<p align="center">
  <img src="docs/logo.svg" alt="Woow k3s Pi Agent" width="120"/>
</p>

<h1 align="center">Woow k3s Pi Agent Package</h1>

<p align="center">
  <strong>Self-hosted AI coding agent for Kubernetes — web UI, browser terminal, and a video pipeline in one pod</strong><br/>
  pi-web + pi coding agent + ttyd, delivered as a Helm chart with a locally-managed Cloudflare Tunnel
</p>

<p align="center">
  <a href="#overview">Overview</a> &bull;
  <a href="#features">Features</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#components">Components</a> &bull;
  <a href="#surfaces">Surfaces</a> &bull;
  <a href="#installation">Installation</a> &bull;
  <a href="#configuration">Configuration</a> &bull;
  <a href="#security">Security</a> &bull;
  <a href="#testing">Testing</a> &bull;
  <a href="README_zh-TW.md">中文文件</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Kubernetes-k3s-blue?logo=kubernetes" alt="k3s"/>
  <img src="https://img.shields.io/badge/Helm-3.16+-0f1689?logo=helm" alt="Helm 3.16+"/>
  <img src="https://img.shields.io/badge/Node.js-22-green?logo=nodedotjs" alt="Node 22"/>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License"/>
  <img src="https://img.shields.io/badge/Registry-ghcr.io-black?logo=github" alt="GHCR"/>
</p>

---

## Source of truth

The primary repository is the internal Gitea
[`woow-paas/Woow_k3s_pi_agent_package`](https://git-prod.woowtech.io/woow-paas/Woow_k3s_pi_agent_package).
This GitHub repository is a one-way mirror of its `main` branch and tags
(`.gitea/workflows/mirror-to-github.yml`). Open changes as Gitea pull requests;
commits made directly on GitHub block the mirror. GitHub builds unique candidate images for main and version tags. Accepted
images are published separately through the [publication gate](docs/IMAGE_PUBLICATION.md).

## PaaS edition

The pi-agent cloud service on the WOOW PaaS platform is built **on top of this
repository's release image** (pinned by digest) with its own per-tenant chart.
Its sources live on the internal Gitea; a read-only mirror is kept under
[`paas/`](paas/) — see [`paas/MIRROR.md`](paas/MIRROR.md) for the synced commits
and how the two editions differ. Do not edit `paas/` here.

One PaaS instance now runs on the local k3s from that chart:
[`deploy/local-k3s/pi5`](deploy/local-k3s/pi5/) has its values and the cutover record.

## Overview

This package runs the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) and its web UI, [pi-web](https://www.npmjs.com/package/@agegr/pi-web), on a k3s cluster. It is the Kubernetes sibling of [`Woow_ha_pi_agent_add_on`](https://github.com/WOOWTECH/Woow_ha_pi_agent_add_on), which packages the same stack as a Home Assistant Supervisor add-on.

Three surfaces share one pod and one volume: a chat UI, a browser terminal running the agent's own TUI, and a video-production toolchain the agent can drive through its bash tool. A change made in the terminal is a change to the instance the web UI serves — the same `models.json`, the same skills registry, the same session store.

### Why This Package?

| Challenge | Solution |
|---|---|
| The HA add-on is tied to a Supervisor that k3s does not have | Plain `debian:bookworm-slim` base; the kubelet is the supervisor, one process per container |
| `pi` is not on `PATH` in upstream's image — it ships only as a transitive dependency, so npm never links its bin | A launcher that resolves the nested CLI at runtime, plus a build assertion that fails the image if `pi --version` does not work |
| The browser terminal in earlier builds used `kubectl exec` into another pod, needing exec RBAC and breaking on every restart | ttyd runs as a sidecar on the same pod and the same PVC — no RBAC, no network hop, no race |
| Skills installed from the CLI never appeared in the web UI | A path bridge between `$PI_CODING_AGENT_DIR/skills` and `$HOME/.pi/agent/skills` |
| Tunnel routing lived in the Cloudflare dashboard, so a second team meant clicking through a UI | Locally-managed tunnel: hostname → service mapping is a chart template under version control |
| Any pod in the cluster could read the provider API key from an unauthenticated endpoint | A NetworkPolicy that admits only the tunnel pods and carves the cluster out of egress |
| CJK filenames containing U+3000 silently resolved to the wrong file | A build-time patch that demotes Unicode-space folding to a read-only fallback |

---

## Features

### Core Capabilities

- **Chat UI with real tool use** — the agent reads, writes, edits and runs shell commands against a persistent volume, streaming over SSE.
- **Skills** — drop a `SKILL.md` into the registry and it is injected into every session's system prompt. Discovery is live; no restart.
- **Browser terminal** — a full `pi` TUI over the web, on the same data directory as the UI. `pi config`, `pi auth`, `pi install` all operate on the instance the UI serves.
- **Provider-agnostic models** — configured in pi-web's own Models page and persisted to the volume. Any OpenAI-compatible or Anthropic-shaped endpoint; OpenRouter, LiteLLM, or a local vLLM service.
- **Video pipeline** — ffmpeg, Playwright-Chromium, edge-tts and rclone, bootstrapped onto the volume on first boot in the background so the chat UI is never blocked.
- **MCP over HTTP** — pi 0.83.0 has no native MCP client, but the agent performs the JSON-RPC/SSE handshake unaided through `bash` + `curl`. Verified against a live Odoo MCP server.

### Deployment Characteristics

- **One chart, one values file per team.** Namespace isolation; skills, sessions and credentials are per-instance.
- **Locally-managed Cloudflare Tunnel** with two hostnames — web UI and terminal — each gated by Cloudflare Access.
- **Everything baked into the image.** No runtime downloads of binaries; `ttyd` is checksum-verified at build time against the release's own `SHA256SUMS`.
- **Pinned dependencies.** `@agegr/pi-web` and `ttyd` are pinned build arguments, not floating tags.

---

## Architecture

### System Layout

```
                    Internet
                       │
                       ▼
        ┌─────────────────────────────┐
        │ Cloudflare Access           │  email allow-list, 24h session
        │ pi-agent-woow.woowtech.io   │
        │ pi-agent-woow-tty…          │
        └──────────────┬──────────────┘
                       │  QUIC (tunnel 88f7b0ed…)
                       ▼
   ┌─────────────────────────────────────────────────┐
   │ namespace: pi-agent-woow                        │
   │                                                 │
   │  ┌────────────────────┐                         │
   │  │ cloudflared × 2    │  locally-managed config │
   │  │ podAntiAffinity    │  routing in the chart   │
   │  └─────────┬──────────┘                         │
   │            │  NetworkPolicy: only these pods    │
   │            ▼                                    │
   │  ┌───────────────────────────────────────────┐  │
   │  │ pod: pi-agent  (replicas 1, Recreate)     │  │
   │  │                                           │  │
   │  │  ┌────────┐   ┌─────────┐   ┌─────────┐   │  │
   │  │  │ nginx  │──►│ pi-web  │   │  ttyd   │   │  │
   │  │  │ :30142 │   │ :30141  │   │  :7681  │   │  │
   │  │  └────────┘   └────┬────┘   └────┬────┘   │  │
   │  │   Host/Origin      │             │        │  │
   │  │   rewrite          ▼             ▼        │  │
   │  │              ┌──────────────────────┐     │  │
   │  │              │  /data/pi-agent      │     │  │
   │  │              │  (PVC 20Gi, RWO)     │     │  │
   │  │              │  sessions/ skills/   │     │  │
   │  │              │  models.json  venv/  │     │  │
   │  │              │  playwright-cache/   │     │  │
   │  │              └──────────────────────┘     │  │
   │  └───────────────────────────────────────────┘  │
   │            │  egress: internet allowed,         │
   │            ▼  cluster CIDRs blocked             │
   └─────────────────────────────────────────────────┘
              OpenRouter · GitHub · MCP endpoints
```

### Request Path — why nginx is not optional

pi-web's `isApiRequestAllowed()` rejects any request whose `Host` is not a loopback name or a raw IP, and any `Origin` that does not match. Traffic arrives carrying the public hostname, so without the sidecar's rewrite every auth-gated route answers `403 Untrusted API request` — the UI loads and then does nothing.

```mermaid
sequenceDiagram
    participant B as Browser
    participant CF as Cloudflare Access
    participant CD as cloudflared
    participant N as nginx :30142
    participant P as pi-web :30141
    participant V as PVC /data/pi-agent

    B->>CF: GET /api/models
    CF-->>B: redirect to IdP if no session
    B->>CF: authenticated request
    CF->>CD: over the tunnel
    CD->>N: httpHostHeader localhost
    Note over N: Host: localhost<br/>Origin: ""<br/>proxy_buffering off
    N->>P: proxy_pass 127.0.0.1:30141
    P->>V: read models.json
    V-->>P: provider catalogue
    P-->>N: 200 (SSE for chat)
    N-->>B: streamed, unbuffered
```

Two details in that diagram are load-bearing. `Origin: ""` is set only by nginx — the tunnel's `httpHostHeader` covers the `Host` half of the guard but not the `Origin` half. And `proxy_buffering off` is what lets a long chat response stream; with buffering on, generations truncate at the proxy and the UI simply stops mid-sentence.

### Storage and lifecycle

```mermaid
flowchart TD
    A[Pod starts] --> B[pi-web-start.sh]
    B --> C{credential files present?}
    C -->|yes| D[chmod 600 models.json, auth.json, rclone.conf]
    C -->|no| E[skip]
    D --> F[bridge skills path]
    E --> F
    F --> G{VIDEO_PIPELINE_ENABLED}
    G -->|true| H[video-tools-init.sh in BACKGROUND]
    G -->|false| I[skip]
    H --> J[exec pi-web]
    I --> J
    J --> K[startupProbe /api/home<br/>up to 300s]
    K --> L[readiness + liveness]

    H -.-> M[(venv + Chromium<br/>~720MB, first boot only)]
    M -.sentinel.-> N[.video-tools-installed]
    N -.-> O[subsequent boots skip in ms]
```

The video bootstrap is backgrounded rather than run as an initContainer. As a blocking init step, the first boot on a cold volume would leave the pod serving nothing for 10–20 minutes, and any hiccup in the download would produce a pod that never becomes ready. The HA add-on ran it as a dependency-free s6 oneshot for exactly this reason; the same semantics are preserved here.

### Why single replica

All state is files on one RWO volume — sessions, worktrees, `models.json`, the skills registry. Two replicas would double-write every one of them. `replicas: 1` with `strategy: Recreate` is a correctness constraint, not an untuned default.

---

## Components

### `Dockerfile` — the image

> Debian bookworm-slim, Node 22, no s6-overlay, no bashio.

- `pi` launcher on `PATH`, resolving the nested `@earendil-works/pi-coding-agent` CLI at runtime
- `ttyd` 1.7.7, downloaded and verified against the release `SHA256SUMS`
- Video toolchain: ffmpeg, `fonts-noto-cjk`, the Chromium runtime `.so` set, rclone
- Build assertions: `pi --version` must succeed, and the path patch must find at least two `path-utils.js` copies

**Image:** `ghcr.io/woowtech/woow-k3s-pi-agent` | **Arch:** amd64 (arm64 on tag pushes) | **Base:** `debian:bookworm-slim`

### `charts/pi-agent` — the Helm chart

> One chart, one values file per release. An agent release renders 5 objects by default; a tunnel-only release renders 3.

- `deployment.yaml` — pi-web + the nginx sidecar (and ttyd if re-enabled), `automountServiceAccountToken: false`, startup/readiness/liveness probes
- `configmap-nginx.yaml` — the Host/Origin rewrite and SSE settings
- `configmap-omnigent-patch.yaml` — the Omnigent model-picker patch, mounted for the postStart hook
- `configmap-cloudflared.yaml` + `cloudflared.yaml` — locally-managed tunnel, 2 replicas, pod anti-affinity
- `networkpolicy.yaml` — ingress from the tunnel (or whatever proxy fronts it) only; egress carves out the cluster
- `pvc.yaml` — RWO, `longhorn` by default, kept on uninstall
- `secret.yaml` — ttyd credential, or `existingSecret`
- `tests/smoke.yaml` — `helm test`: pi-web answers 200 through nginx (and ttyd answers 401 when enabled). Read-only, retried, and not rendered for a tunnel-only release
- `NOTES.txt` — what to run next, and whether this release keeps its data

Two switches decide what a release *is*:

| Value | Renders |
|---|---|
| `agent.enabled=true`, `cloudflare.enabled=false` (defaults) | the agent alone — public access comes from a separate tunnel release |
| `agent.enabled=false`, `cloudflare.enabled=true` | a tunnel-only release: cloudflared, its config and its credentials |
| both `true` | one release owning both, the original single-team topology |

`keepOnUninstall` (default `true`) puts `helm.sh/resource-policy: keep` on the data PVC and on every Secret the chart creates, so `helm uninstall` cannot be how a month of sessions — or the only copy of a locally-managed tunnel's credential — is lost. The chart never renders a Namespace: Helm keeps its release record there, so `--create-namespace` owns it.

### `patches/fix-unicode-space-paths.mjs` — the CJK path fix

> Upstream folds U+3000 and other Unicode spaces to ASCII on every read, write and edit.

Reading `台灣　報告.txt` missed the real file; writes landed at a different path while reporting success against the original name; and with two files differing only by space type, reading one returned the other's contents with `isError: false`. The patch demotes folding to a read-only fallback and asserts every hunk, so an upstream bump fails the build rather than silently dropping the fix.

**Applies to:** 2 distinct upstream implementations (`pi-agent-core` harness tools, `pi-coding-agent` core tools)

### `rootfs/` — the scripts baked into the image

> In the image, not in ConfigMaps. A ConfigMap edit with no checksum annotation is inert until someone restarts the pod.

| Script | Role |
|---|---|
| `usr/local/bin/pi` | Launcher for the transitively-installed CLI |
| `usr/local/bin/pi-agent-env.sh` | One env definition, shared by pi-web, ttyd and the `pi` wrapper |
| `usr/local/bin/pi-web-start.sh` | pi-web entrypoint: file modes, skills bridge, TZ, video bootstrap |
| `usr/local/bin/video-tools-init.sh` | Idempotent, non-fatal, sentinel-guarded first-boot install |
| `usr/local/bin/ttyd-start.sh` | ttyd sidecar; refuses to start without `TTYD_PASSWORD` |
| `usr/local/bin/pi-shell.sh` | The shell ttyd forks per browser session |

### `charts/pi-agent/values/woow-k3s/` — the live instance values

> One file per live release, so the cluster can be rebuilt from this repo instead of from `helm get values`.

| File | Release | What is special about it |
|---|---|---|
| `pi-agent.yaml` | `pi-agent` | 51Gi volume (grown by hand, never shrink it), `NODE_OPTIONS=--max-old-space-size=12288`, Omnigent on. No `fullnameOverride`: its release name already equals the chart name |
| `pi-agent-2.yaml`, `pi-agent-3.yaml` | `pi-agent-2/-3` | 20Gi, 12288MB heap, Omnigent off |
| `pi-agent-4.yaml`, `pi-agent-5.yaml` | `pi-agent-4/-5` | 20Gi, 6144MB heap, Omnigent on |
| `pi-tunnel.yaml` | `pi-tunnel` | the tunnel-only release: `agent.enabled=false` and the full seven-hostname routing table, including the two hostnames that belong to other things (opendesign, NPM's admin UI) |

**No credentials are in these files, by design.** `pi-tunnel` holds its tunnel credential inline in the live release, so an upgrade has to re-supply it:

```bash
umask 077
helm --kube-context woow-k3s get values pi-tunnel -n pi-agent-woow -o json \
  | jq -r .cloudflare.credentialsJson > /secure/tunnel-credentials.json
```

`scripts/check-drift.sh` renders every one of these against the live release and reports both the object diff and the pod-template diff — the second is the one that answers "would an upgrade restart anything":

```bash
CONTEXT=woow-k3s NAMESPACE=pi-agent-woow scripts/check-drift.sh
```

### `deploy/npm/` — Nginx Proxy Manager, deliberately not in the chart

NPM supplies the Basic Auth in front of four of the five agents and is applied with `kubectl apply -f deploy/npm/npm.yaml`. That is an owner decision, not an omission: folding it into a chart release would put the gate for every agent behind the same `helm upgrade` that touches one of them. The chart's `networkPolicy.extraCloudflaredApps: [npm]` is what admits its traffic.

---

## Surfaces

Screen captures are not committed to the repository, so this section describes each surface rather than showing it. The first four entries are panels of the web UI; the last two are the browser terminal.

### Web UI — chat with the working directory bound

The session opens in a `pi-cwd-YYYYMMDD` directory on the persistent volume. The model selector, skills, plugins and file explorer are all reachable from this one screen.

### Models — providers configured in the UI, persisted to the volume

Provider keys are entered in the Models page, not injected as environment variables. pi-web fetches the upstream catalogue and writes the selection to `models.json` on the PVC, so it survives a pod restart.

### Skills — the registry the agent sees

Every `SKILL.md` under `/data/pi-agent/skills` is parsed and injected into the system prompt. Malformed skills are excluded with a diagnostic while the rest keep loading.

### Plugins — packages installed from the terminal appear in the web UI

`pi install <github-url>` in the browser terminal registers a package in `settings.json`; the web UI reads the same file. This is the terminal/UI same-source-of-truth contract.

### Browser terminal — `pi` on `PATH`, same volume as the UI

The terminal opens on a banner naming the data directory and the pinned versions. This is the capability that earlier builds lacked entirely: `pi` was command-not-found inside the container.

### Browser terminal — the `pi config` TUI

The TUI enables and disables package resources from the browser, against the same instance the web UI serves.

---

## Installation

### Prerequisites

- **k3s or Kubernetes 1.28+** with a CNI that enforces NetworkPolicy
- **Helm 3.16+**
- **A ReadWriteOnce StorageClass** that is node-portable — the pod gets rescheduled, and a node-local volume strands its state
- **A Cloudflare account** with a zone, if using the bundled tunnel
- **An LLM provider API key** — entered in the UI after deployment, not at install time

### Step 1: Create the Cloudflare tunnel

```bash
# Creates a locally-managed tunnel and writes credentials.json
cloudflared tunnel create pi-agent-<team>

# Point the hostname at it
cloudflared tunnel route dns pi-agent-<team> pi-agent-<team>.example.com
```

Note the tunnel UUID — it goes into `cloudflare.tunnelId`. Keep `credentials.json`
outside the repo: it cannot be downloaded from Cloudflare again.

### Step 2: Create the namespace and the tunnel Secret

```bash
kubectl create namespace pi-agent-<team>

# Preferred over passing the credential as a Helm value: it then never lands in
# a release revision. See examples/secrets.example.yaml for every key.
kubectl -n pi-agent-<team> create secret generic pi-agent-cf-creds \
  --from-file=credentials.json=./tunnel-credentials.json
kubectl -n pi-agent-<team> annotate secret pi-agent-cf-creds helm.sh/resource-policy=keep
```

### Step 3: Install the agent

From a clone:

```bash
helm upgrade --install pi-agent ./charts/pi-agent \
  --namespace pi-agent-<team> \
  --set persistence.storageClassName=longhorn \
  --set persistence.size=20Gi
```

Or from the GitHub tarball, without a clone. The chart lives under `charts/`, so
the archive has to be unpacked first — Helm cannot install a chart from a
subdirectory of a tarball, and there is no OCI/`helm repo` publication of this
chart:

```bash
curl -sSL https://github.com/WOOWTECH/Woow_k3s_pi_agent_package/archive/refs/heads/main.tar.gz | tar xz
helm upgrade --install pi-agent \
  ./Woow_k3s_pi_agent_package-main/charts/pi-agent \
  --namespace pi-agent-<team> \
  --set persistence.storageClassName=longhorn
```

To reproduce one of the WoowTech releases instead, pass its instance values:

```bash
helm upgrade --install pi-agent-4 ./charts/pi-agent -n pi-agent-woow \
  -f charts/pi-agent/values/woow-k3s/pi-agent-4.yaml
```

The first boot downloads roughly 720 MB of Python venv and Chromium in the background. The chat UI is usable throughout; only the video pipeline waits.

### Step 4: Install the tunnel as its own release

The tunnel is deliberately **not** part of an agent release: one cloudflared fronts
every agent, and an agent upgrade must not be able to touch it.

```bash
helm upgrade --install pi-tunnel ./charts/pi-agent \
  --namespace pi-agent-<team> \
  --set agent.enabled=false \
  --set fullnameOverride=pi-tunnel \
  --set cloudflare.enabled=true \
  --set cloudflare.tunnelId=<tunnel-uuid> \
  --set cloudflare.existingCredentialsSecret=pi-agent-cf-creds \
  --set-json 'cloudflare.extraIngress=[{"hostname":"pi-agent-<team>.example.com","service":"http://pi-agent.pi-agent-<team>.svc.cluster.local:30142","originRequest":{"connectTimeout":"30s","httpHostHeader":"localhost"}}]'
```

Then tell the agent which tunnel is allowed to reach it — the per-release
selector matches nothing once the tunnel lives elsewhere:

```bash
helm upgrade pi-agent ./charts/pi-agent -n pi-agent-<team> --reuse-values \
  --set 'networkPolicy.extraCloudflaredApps[0]=pi-tunnel-cloudflared'
```

### Step 5: Verify

```bash
kubectl -n pi-agent-<team> rollout status deploy/pi-agent --timeout=10m
helm test pi-agent -n pi-agent-<team> --logs
```

The smoke test is read-only: it asks pi-web for `/api/home` through the nginx
sidecar and expects 200. It retries for up to 150s, because k3s's NetworkPolicy
implementation needs a few seconds to admit a freshly created Pod.

> `helm test` needs `networkPolicy.allowHelmTest=true` (the chart default) while
> `networkPolicy.enabled=true`. It is **off** in `values/woow-k3s/*.yaml` — see
> "Known gaps".

### Step 6: Gate every hostname with Cloudflare Access

1. Open **Cloudflare Zero Trust > Access > Applications**
2. Add a **Self-hosted** application for each hostname
3. Attach an **allow** policy with an email allow-list or your IdP group
4. Do **not** attach an IP-bypass policy — the agent is a root shell with no authentication of its own

### Uninstall — the data stays

```bash
helm uninstall pi-agent -n pi-agent-<team>
```

The Deployment, Service, ConfigMaps and NetworkPolicy go. The PVC and every
Secret the chart created stay, because `keepOnUninstall` is `true`; a later
`helm install` with the same names adopts them. Deleting the data is a separate,
deliberate act:

```bash
kubectl -n pi-agent-<team> delete pvc pi-agent-data   # irreversible
```

### Taking over a release, or moving one

All six woow-k3s releases are already Helm-managed, so a takeover is just
`helm upgrade` with the right values — and it should restart nothing. Prove that
before running it:

```bash
CONTEXT=woow-k3s NAMESPACE=pi-agent-woow scripts/check-drift.sh   # exit 0 = no drift
```

If a release were ever adopted from `kubectl`-managed objects, add
`--take-ownership` to the upgrade. Two things roll a pod even when nothing
functional changed, so check for them first:

- **the chart version.** `helm.sh/chart` is a pod-template label here, and the
  nginx/cloudflared ConfigMaps carry it too, so their `checksum/*` annotations
  move with it. A release on an older chart version *will* restart when it is
  brought up to the current one.
- **`persistence.size`.** It can only grow. A values file with a smaller number
  than the live PVC fails the upgrade.

---

## Configuration

### 1. Provider setup

Navigate to **Models** in the web UI. Add a provider, paste the API key, and pick the models to expose. pi-web writes the result to `/data/pi-agent/models.json` on the volume.

Prefer `modelOverrides{}` over a bare `models[]` entry: a `models[]` entry fully replaces the upstream catalogue entry, which silently zeroes the cost fields and truncates the context window to defaults.

### 2. Skills

```bash
# From the browser terminal, or any shell on the volume
mkdir -p /data/pi-agent/skills/my-skill
cat > /data/pi-agent/skills/my-skill/SKILL.md <<'EOF'
---
name: my-skill
description: Use when the user asks to do X. Write this imperatively — it is the exact string the model sees.
---

# Procedure
1. ...
EOF
```

Discovery is live. The `description` is what drives triggering; a description containing common vocabulary will over-trigger.

### 3. Chart values worth knowing

| Value | Default | Notes |
|---|---|---|
| `networkPolicy.enabled` | `true` | Blocks cluster-internal reach; leave on |
| `networkPolicy.blockedCIDRs` | pod, service, node, metadata | Adjust to your cluster's CIDRs |
| `videoPipeline.enabled` | `true` | ~720 MB first-boot download, backgrounded |
| `videoPipeline.reset` | `false` | One-shot: clears venv and Chromium, then set back |
| `persistence.storageClassName` | `longhorn` | Must be node-portable. `nfs-data` does not exist on woow-k3s and left the PVC Pending |
| `persistence.size` | `20Gi` | Can only grow — a smaller value than the live PVC fails the upgrade |
| `keepOnUninstall` | `true` | Keeps the PVC and chart-created Secrets when the release is uninstalled |
| `agent.enabled` | `true` | `false` renders a tunnel-only release |
| `cloudflare.enabled` | `false` | The tunnel belongs in its own release |
| `networkPolicy.allowHelmTest` | `true` | Lets the smoke Pod through the policy; off in the live instance values |
| `ttyd.existingSecret` | `""` | Preferred over `ttyd.password` — keeps the credential out of rendered manifests |
| `cloudflare.replicas` | `2` | A single tunnel pod is an SPOF for both hostnames |
| `podSecurityContext.runAsUser` | `0` | See Security — running non-root needs a chown pass over existing volumes |

---

## Security

### What this deployment does enforce

| Control | Status |
|---|---|
| Access gating in front of every hostname | **Not uniform on woow-k3s.** Only `pi-agent-woow-k3s-3` sits behind Cloudflare Access; the other four are gated by NPM Basic Auth only, and `pi-agent-npm` (NPM's own admin UI) answers 200 with nothing in front. Verified by request, 2026-09 |
| ttyd basic auth | The container refuses to start with an empty password — but ttyd is disabled since 0.2.0 and not deployed |
| NetworkPolicy ingress | Only the tunnel pods reach the app; direct pod-IP access is blocked |
| NetworkPolicy egress | Internet allowed; Kubernetes API, service CIDR, pod CIDR and node network blocked |
| ServiceAccount token | Not mounted (`automountServiceAccountToken: false`) |
| Credential file modes | `0600` on every boot |
| Worktree boundary | The REST file/git surface enforces a lexical **and** realpath check against the allowed roots |

### What it does not

These are upstream properties of the agent, not configuration mistakes, and they are the reason this package is **not yet suitable for untrusted or multi-tenant use**:

- **No sandbox and no approval gate.** `read`, `write`, `edit` and `bash` accept any absolute path in the container. There is no `permissionMode`, no `canUseTool` hook, and no approval event anywhere in `@earendil-works/pi-coding-agent`. A session can rewrite the shared skills registry, which is injected into every future session's system prompt.
- **The agent runs as root.** Changing this requires a chown pass over existing volumes; it is a tracked follow-up, not a values flip.
- **`GET /api/models-config` returns the provider API key unredacted and unauthenticated.** The NetworkPolicy closes the in-cluster path; any user who passes Cloudflare Access can still read it, and so can the agent's own `read` tool.
- **The chart ships no authentication of its own.** pi-web logs `listening on 0.0.0.0 without authentication` on every boot. Access-equivalent gating is a hard prerequisite, not an option.
- **Prompt-injection resistance is model behaviour, not an enforced control.** It held in testing; it must not be sold as a guarantee.

Treat this as a **single-tenant tool for a trusted team**, behind SSO, until those are addressed.

---

## Testing

A ten-dimension review drove real conversations through the web UI — not API assertions — and every reported failure above medium severity was independently re-verified by a separate reviewer whose default assumption was that the report was wrong.

| Dimension | Result |
|---|---|
| Skills | Positive triggering, five-prompt negative control, disambiguation with a decoy, helper-script execution, malformed-skill graceful degradation — all pass on both models |
| Sessions | Multi-turn continuity, resume-from-disk after eviction, valid JSONL, two concurrent sessions isolated, HTML export |
| Git & worktrees | Conversational git matched ground truth byte-for-byte; the allowed-root boundary held against `..`, symlink escape and a session-ID bypass |
| Robustness | `restartCount: 0` across ~20 conversations; RSS flat; 4-way concurrency at 1.46× latency; abort stops an LLM stream in 3 ms |
| Documents | Zero fabricated documents in 8 runs, including adversarial prompts |
| MCP over HTTP | Handshake discovered unaided; no hallucinated data on auth failure; answers matched ground truth exactly |
| Models | Both models complete tool-using turns; mid-session switch proven in raw SSE attribution |
| Files | 50 KB / 2000-line truncation never splits a line; 8.9 MB handled |
| Security | **3 blockers confirmed** — no path confinement, unrestricted cluster egress (now fixed), no approval gate |
| Document formats | CSV, JSON, Markdown, HTML native; XLSX/DOCX/PDF need packages baked in |

Full report: [`docs/READINESS.md`](docs/READINESS.md).

---

## Known Limitations

- **Single-tenant per pod.** One root home, one shared skills registry, one credential, one session store.
- **No native MCP client.** The agent acts as one over `bash` + `curl`; retry loops are unbounded.
- **Text-only unless a vision model is configured.** Scanned invoices and screenshots cannot be read by the default DeepSeek models.
- **Four tools only** — `read`, `write`, `edit`, `bash`. Every listing and search runs as a shell command.
- **300 s request ceiling.** Long conversions terminate without a final answer.
- **No plugin hot-reload in an open chat.** Extension source edits require a pod restart.
- **Session storage grows unbounded.** No retention job, no pagination on `/api/sessions`.
- **`helm.sh/chart` is a pod-template label.** Any chart version bump therefore rolls every release, so the version is held at 0.2.4 until the owner wants a rollout. Taking the label out of the pod template is the real fix, and is itself a one-time roll.
- **`helm test` cannot pass on the live releases yet.** `networkPolicy.allowHelmTest` is `false` in `values/woow-k3s/*.yaml`, because turning it on adds an ingress rule to a policy that is serving traffic. It restarts nothing; it just has to be a deliberate change.
- **`pi-tunnel` carries its credential as a Helm value**, so it sits in every release revision. `cloudflare.existingCredentialsSecret` is the end state, but switching stops the chart rendering `pi-tunnel-cf-creds` and is an owner decision.
- **Five agent releases still carry a `ttyd.password` in their live values** for a terminal that has been disabled since 0.2.0. It renders nothing; it should be dropped from the release values at the next upgrade. The committed instance values already omit it.
- **NPM is applied with `kubectl`, not Helm** — by decision. It is the auth gate for four of the five agents, and `deploy/npm/npm.yaml` still opens its admin UI (port 81) to `192.168.0.0/16` and publishes it at `pi-agent-npm.woowtech.io` with no Cloudflare Access in front.
- **The NetworkPolicy is wider than it needs to be.** `nodeCIDRs` is a whole `/16` when the nodes are `192.168.10.21-24`, and the ingress rule still opens ttyd's port 7681 when ttyd is disabled. Both are live-object changes and were left out of this pass.
- **The 20Gi PVC is advisory** on an NFS subdir provisioner, not enforced.

---

## Changelog

### chart 0.2.4 — Helm migration pass (2026-09)

- `charts/pi-agent/values/woow-k3s/`: the six live releases' values, secrets excluded, so the cluster is reproducible from this repo
- `keepOnUninstall` (default on): the data PVC **and** chart-created Secrets survive `helm uninstall`
- Default StorageClass `nfs-data` → `longhorn`; `nfs-data` does not exist on woow-k3s, so the old default could only ever leave the PVC Pending
- `cloudflare.enabled` now defaults to `false`, which makes a plain `helm template charts/pi-agent` render instead of failing on a missing `tunnelId`
- `helm test`: retried instead of one-shot, not rendered for a tunnel-only release, and admitted through the NetworkPolicy by the opt-in `networkPolicy.allowHelmTest`
- `scripts/check-drift.sh`, `templates/NOTES.txt`, `.helmignore`, `examples/secrets.example.yaml`, a chart `icon`
- CI: helm 3.19.5, lint and render of every values combination, `kubeconform -strict`, guards that the required-value and `keepOnUninstall` behaviour is real, a committed-secret scan, and no more bot pushes to `main`
- Removed `values-woow.yaml` and `deploy/rendered/`: both described a tunnel and a StorageClass that no live release has used since 0.2.0

### v0.1.0 (2026-08)

- Initial k3s package: image, Helm chart, locally-managed Cloudflare Tunnel, CI build and chart render
- `pi` launcher and build-time assertion — the browser terminal can drive the agent TUI for the first time
- ttyd as a same-pod sidecar, replacing the `kubectl exec` terminal and its exec RBAC
- Skills path bridge between the CLI's write location and pi-web's read location
- Video bootstrap backgrounded rather than blocking startup
- NetworkPolicy on by default; ingress restricted to the tunnel, cluster CIDRs carved out of egress
- Build-time patch for silent CJK path corruption
- Credential files forced to `0600` on every boot

---

## Support

- **Issues:** [GitHub Issues](https://github.com/WOOWTECH/Woow_k3s_pi_agent_package/issues)
- **Upstream add-on:** [Woow_ha_pi_agent_add_on](https://github.com/WOOWTECH/Woow_ha_pi_agent_add_on)
- **Email:** woowtech@designsmart.com.tw

---

## License

This project is licensed under the **MIT License**, matching the upstream add-on.

Bundled software keeps its own licence: `@agegr/pi-web`, `@earendil-works/pi-coding-agent`, `ttyd`, `cloudflared`, `ffmpeg` and `rclone` are each governed by their upstream terms.

---

<p align="center">
  <sub>Built by <a href="https://github.com/WOOWTECH">WOOWTECH</a> &bull; Powered by k3s</sub>
</p>

## Claude Code and Codex preinstalled (0.3.24)

The image now ships the official **Claude Code 2.1.296** and **Codex 0.162.1** CLIs for amd64 and arm64, so every Pi Agent built from it can run `claude` and `codex` in the Pi Web terminal.
- **Pinning:** exact npm versions and integrities come from `cli-runtime/{claude,codex}/package-lock.json`, byte-identical to the Home Assistant add-on's locks. They are installed under `/opt/pi-clis/{claude,codex}`, one image layer each, and linked as `/usr/local/bin/claude` and `/usr/local/bin/codex`. The unused musl Claude binary is dropped.
- **Sharing:** the bundled shared runtime finds both CLIs at startup and shares Pi skills (symbolic links in `~/.claude/skills`, `~/.codex/skills` and `~/.agents/skills`) and the Pi Web global MCP servers (one `pi_shared_runtime` entry in `~/.claude.json` and `~/.codex/config.toml`) with them.
- **Acceptance:** `tests/image-cli-sharing.mjs` proves this offline in the disposable acceptance containers. It checks the versions, a Pi skill visible to Claude and Codex, both CLIs listing the bridge, and a Pi Web global MCP tool answering through it.
- **Logins:** each CLI still needs its own official login (`claude auth login`, `codex login`). No provider token is copied and nothing is downloaded at tenant startup.
- **Size:** about 680 MB uncompressed per architecture (Claude 246 MB, Codex 432 MB).
- **PaaS:** the PaaS overlay no longer installs its own copy; it uses these CLIs.

## Omnigent 0.3.31 (0.3.23)

The image pins [Omnigent plugin 0.3.31](https://github.com/WOOWTECH/pi-omnigent-plugin/releases/tag/v0.3.31); Paseo 0.1.15 and the Pi Web patches are unchanged.

- **Settings → Omnigent opens faster** (measured about 4 s before on a production tenant): engine version probes are cached for 10 minutes instead of 15 s (a replaced or removed engine is still probed at once), and when you are signed in the status and the model catalog are read at the same time instead of one after the other.
- An empty Pi model list still triggers `pi update --models`, but the page waits at most 5 s for it; the refresh finishes in the background and the next read shows the models.

## Omnigent 0.3.30 and Paseo 0.1.15 (0.3.22)

The image pins [Omnigent plugin 0.3.30](https://github.com/WOOWTECH/pi-omnigent-plugin/releases/tag/v0.3.30) and [Paseo plugin 0.1.15](https://github.com/WOOWTECH/pi-paseo-plugin/releases/tag/v0.1.15), and moves official plugin git pins to the bundled plugins before Pi Web starts (next section).

- **Omnigent 0.3.30**: switching the plugin source (git pin, bundled copy, npm) keeps the approved sign-in; Settings → Omnigent shows the reason and the next step for each issue code (a host owned by another account asks you to sign in with that account first; `reset-id` is the last resort); a launcher whose recorded Pi Web is gone falls back to a working `pi-web`; `install-ui` steps aside on this image's native settings page without breaking Paseo's install; new `pi-omnigent doctor [--fix]` and `pi-omnigent connect --password-stdin`.
- **Paseo 0.1.15**: a plugin source switch no longer leaves Paseo switched off (0.1.14 already covered restarts).
- The Paseo runtime no longer ships the unused musl Claude SDK binaries.

## Official plugin git pins move to the bundled plugins at startup (0.3.22)

Before Pi Web starts, the image rewrites a Pi `settings.json` package entry that pins the official GitHub repository (`github.com/WOOWTECH/pi-omnigent-plugin` or `github.com/WOOWTECH/pi-paseo-plugin`, in one of the spellings listed below) to the plugin copy in the image (`/opt/woow/pi-omnigent-plugin`, `/opt/woow/pi-paseo-plugin`). No old plugin copy is running yet, so the switch is not seen as the plugin being removed: Omnigent keeps its sign-in and engine checks, and Paseo keeps its setting. Upgrading such a volume no longer asks for another sign-in in Settings → Omnigent.

- Recognised spellings: `git:github.com/WOOWTECH/<plugin>`, `git:git@github.com:WOOWTECH/<plugin>`, and an `https://`, `http://`, `ssh://` or `git://` URL of `github.com/WOOWTECH/<plugin>` (with or without `git:` in front and a `user@` part), each optionally followed by `.git`, `/` and an `@<ref>` or `#<ref>`. Host, owner and repository are compared without regard to case. Any other spelling, for example `git:WOOWTECH/<plugin>`, `www.github.com`, a `/tree/<ref>` URL or a URL with a port, is not recognised and stays as it is.
- Left as they are and listed in the receipt with the reason: a disabled entry (`"extensions": []`), a release tag newer than the image's plugin, a branch, commit or untagged pin whose cloned copy is not older than the image's plugin (or cannot be read), a plugin that the home project's `.pi/settings.json` also lists, and two entries for the same plugin.
- Never touched: forks and other repositories, local checkouts and npm sources.
- Before the first migration, `settings.json` is copied to `settings.json.pre-image-migration.bak`. The copy is complete before it appears (it is written to a temporary file first), and no later migration of either plugin replaces it, so it holds the settings from before the first migration, not from before the latest one. Every change (old and new source) and every entry left as it is (with the reason) is appended to `omnigent-plugin/image-migration.json` or `pi-paseo/image-migration.json`. Credentials in a git URL are masked there and in `image-seed.json`. A boot with nothing new to record writes nothing.
- If the boot that moved the Omnigent pin cannot put the image's Pi Web launcher in place (the plugin reports `conflict` or `host-unavailable`, or fails), Pi Web can still start through the old plugin's launcher, and that copy would find itself unregistered and reset the sign-in. The seed therefore writes the exact bytes `settings.json` had before that boot back before Pi Web starts, appends a `rolled-back` run with the reason code (`launcher-conflict`, `launcher-host-unavailable`, `launcher-error`) and the changes it undid, and exits with an error; the next boot tries again. A seed that fails after rewriting `settings.json` does the same with `seed-error` (Paseo too). If the bytes cannot be written back, the run says `rollback-failed`, and so does the log. A `host.json` repair (next item) is kept.
- When the image's Omnigent plugin is the active one and `omnigent-plugin/host.json` still starts a Pi Web copy that an older plugin built on the volume (`~/.local/share/pi-omnigent-web/…` or `~/.local/share/pi-paseo/…`), or a path that no longer exists, its `realWeb` is set to the image's `/usr/local/bin/pi-web` (`host.json` is copied once to `host.json.pre-image-migration.bak`). The old copy stays on disk. Other launchers, and the Shared Runtime's own `shared-runtime/host.json`, are not changed.
- `PI_OMNIGENT_AUTO_SETUP=false` and `PI_PASEO_AUTO_SETUP=false` also turn this rewrite off.

The bundled Paseo runtime no longer ships the musl build of the Claude SDK binary next to the glibc build. Its lockfile has no `libc` field, so `npm ci` installed both; the SDK starts the glibc build first, so the musl copy (about 230 MiB per architecture) never ran. The image build now fails if the glibc binary is missing or a musl copy remains.

## Paseo keeps your setting across restarts (0.3.21)

The image pins [Omnigent plugin 0.3.29](https://github.com/WOOWTECH/pi-omnigent-plugin/releases/tag/v0.3.29) and [Paseo plugin 0.1.14](https://github.com/WOOWTECH/pi-paseo-plugin/releases/tag/v0.1.14). Binding still happens only in Settings → Omnigent; no setup conversation is created or opened. Two fixes ride in the Paseo plugin: a plain stop of the Paseo supervisor (container restart, or a supervisor takeover after the plugin source changed) no longer persists "disabled", so a restart cannot switch Paseo off any more (only a real disable in Settings or Pi disabling the package does); and an empty or error-cached provider model catalog is refreshed once after login, so a fresh login lists its models without a restart.

## Fresh install with no conversation (0.3.20)

The image pins [Omnigent plugin 0.3.29](https://github.com/WOOWTECH/pi-omnigent-plugin/releases/tag/v0.3.29) and [Paseo plugin 0.1.13](https://github.com/WOOWTECH/pi-paseo-plugin/releases/tag/v0.1.13). Binding still happens only in Settings → Omnigent. On a brand-new volume (no conversation, no project picked) three things were wrong and are fixed: Settings → Paseo answered 404 and could not generate a pairing link (it now loads from the server's own fallback directory; a directory named by the client is still refused unless Pi Web serves it); the first screen never mentioned Omnigent (a plain-text third step now points to Settings → Omnigent; it is not a button or link and opens no conversation); and the Paseo settings section could not scroll on phones and short windows. Image acceptance now checks all three on a fresh volume, at desktop and phone widths, before and after a restart.

Upgrade note: when an Omnigent plugin pinned to a git source is switched to this image's bundled plugin path while Pi Web is running, the plugin asks for one more sign-in in Settings → Omnigent. Only Pi Web's Settings → Omnigent panel is affected: it shows "Complete server setup", and its per-engine model lists stay empty until that sign-in, because the panel reads the model catalog only after a confirmed sign-in. The host stays Online and the Omnigent web app is unaffected (observed on an existing tenant). Fresh installations are not affected because the plugin source is already the bundled path. From the next image release an official git pin is switched at startup, before Pi Web runs, and no sign-in is needed (see "Official plugin git pins move to the bundled plugins at startup").

## Settings-only Omnigent binding (0.3.19)

The image pins [Omnigent plugin 0.3.28](https://github.com/WOOWTECH/pi-omnigent-plugin/releases/tag/v0.3.28). A fresh installation binds only through Settings → Omnigent; neither startup nor restart creates or opens a setup conversation. Legacy conversation metadata is ignored without deleting user data. Root image 0.3.18 (plugin 0.3.27) is superseded because it created a setup conversation on first start. The image and Helm Chart default are 0.3.19. Existing tenant image pins require an explicit upgrade; provider credentials and pairing state stay on their tenant volume.

## Pi model catalog refresh (0.3.17)

Version 0.3.17 pinned [Omnigent plugin 0.3.26](https://github.com/WOOWTECH/pi-omnigent-plugin/releases/tag/v0.3.26). After an independent Pi provider login, the Omnigent model catalog refreshes an empty authenticated Pi cache on the next catalog or verification request.

## Settings-only Paseo pairing (0.3.16)

The image pins Paseo 0.1.12 and Omnigent 0.3.25. Installation and restart prepare their background services without creating or opening a setup conversation. Paseo pairing is a button in Settings → Paseo; Omnigent binding remains in Settings → Omnigent. The chat homepage has no Paseo shortcut. Existing sessions, provider credentials and pairing state are preserved. The root Helm chart defaults to image 0.3.16; tenants with an explicit image tag must opt into it.

## Paseo pairing update (0.3.15)

The 0.3.15 image and matching Helm chart pin [Paseo 0.1.11](https://github.com/WOOWTECH/pi-paseo-plugin/releases/tag/v0.1.11) and Omnigent 0.3.22. The paired Pi Web client opens the host confirmation at `/paseo-web/welcome`, which preserves the private offer fragment across navigation. The combined Omnigent adapter also redirects older managed Paseo pairing links to that route. An empty Pi `auth.json` is reported as missing credentials; each tenant still signs in to its own Claude Code, Codex, and Pi providers before model conversations can be verified. The PaaS image and Chart are versioned separately from this base image.

## Omnigent deployment package (0.3.13)

The 0.3.13 image build pins `@woowtech/pi-omnigent-plugin` **0.3.21** and the native
Omnigent settings tab beside MCP, also available at `/omnigent`. Both the
release archive and UI patch are SHA-256 verified during CI; Pi Web is built
there, never on a tenant's first boot. The chart selects `0.3.13`.
Image acceptance resolves each architecture from the verified image index to a distinct child digest before Docker pulls it; the 0.3.11 multiarch QA could not complete because Docker refused to replace the first architecture under the same local index reference.
The plugin archive is published in [v0.3.21](https://github.com/WOOWTECH/pi-omnigent-plugin/releases/tag/v0.3.21) and independently verified by anonymous download;
the root image follows this repository's image validation and release workflow.

For a verification conversation created by the plugin, version 0.3.16 retains
the v0.3.14 behavior: it reports `NATIVE_TERMINAL_REMOVED` promptly when the required Pi or Claude main terminal
disappears, instead of waiting for the 120-second verification timeout. This diagnostic does not
fix the underlying engine exit; the separate launcher guard below preserves the Omnigent session catalog. It does
not establish that any provider or all engines can answer successfully.

Version 0.3.21 rechecks transient native package reads before Pi Web reports the Omnigent tab disabled. Explicit disable remains immediate, and persistent removal remains disabled. The compiled UI adapter is byte-identical to 0.3.20. Version 0.3.20 explicitly verified Paseo 0.1.10 combined UI compatibility while retaining exact adapter checks for older supported versions.

Version 0.3.19 also recovers a proven stale PID after a container restart when another UID now occupies that PID. Complete kernel boot/start evidence is required, and recovery never signals the unrelated process.

Version 0.3.18 retains the 0.3.16 automatic restoration of a previously authorized host after restart only when the enabled plugin, successful connection receipt and server/host/workspace identity still match. It preserves provider settings and does not send model messages during recovery. Fresh installations and revoked/disabled/disconnected installations still require explicit login; uncertain live-process identity fails closed. The 0.3.18 runtime additionally handles a stale process receipt whose PID was reused after a full system restart, while retaining process ownership and server/workspace identity checks. This release note does not certify a particular HA VM restart; image and deployment acceptance remain separate. Known upstream limitation: explicitly switching a disconnected plugin-managed host to another server can report `HOST_PROCESS_MISMATCH` when an old process receipt remains. Same-identity restart is unaffected; see the plugin release notes.

A fresh data volume registers the plugin and creates **Omnigent 連線設定**.
On an untouched homepage Pi Web opens this conversation automatically. Enter the server URL, username and
password. No server URL, login, provider credential or host ID is included in
the image. Only engines already installed in the container are connected.
Existing external packages, native disable and deliberate removal are kept; an official GitHub git pin moves to the bundled plugin at startup (see "Official plugin git pins move to the bundled plugins at startup").
Plugin 0.3.17 adds automatic first-home selection of the saved pending setup conversation. It preserves explicit navigation, remembered work and user input; an untouched homepage waits at most 30 seconds for late setup metadata. This image prebuilds the matching UI. Existing installations that update only the plugin must run official `pi-omnigent install-ui` and restart Pi Web to load the new compiled UI.

Set `PI_OMNIGENT_AUTO_SETUP=false` to opt out before first boot. Existing engine
logins remain per-user; model listings alone do not count as verified replies.

The Pi launcher preserves `PI_CODING_AGENT_DIR` supplied by Omnigent so its
session-specific gateway catalog reaches the engine. The PaaS derivative
continues to supply its pinned Omnigent Python runtime; the standalone k3s
package downloads missing Omnigent dependencies through the plugin.

HA add-on has its own release and Pi Web 0.12 integration. Use that repository's
version and manifest, not the k3s image, for HA Supervisor/local builds.

0.3.2 also makes the bundled Shared Runtime discover existing Claude/Codex
executables without downloading missing ones when the setup conversation opens.
Skills/MCP sharing for installed engines remains enabled. Engine installation is
an explicit operator action (`PI_SHARED_INSTALL_MISSING_CLI=1` opts into the
sharing runtime installer). The 0.3.0 tag was superseded during deployment QA.

## Bundled Paseo integration

The 0.3.13 image bundles Paseo plugin **0.1.10**, Omnigent plugin **0.3.21**, and the locked Paseo **0.11.2** runtime with revision r3. Pi Web keeps its reviewed 0.10.0 base with settings sections ordered MCP → Omnigent → Paseo. Open `/paseo/setup` to pair with the bundled `/paseo-web/` client on the same authenticated Pi Web origin. The client fixes duplicated replies and partial replies after reconnect/refresh; it uses the existing encrypted relay. This does not change the separately deployed official `app.paseo.sh` client.

The image includes the fixed **0.13.0-woow.1** web archive (10,558,821 bytes; SHA256 `7e7495f70f721e96e121f76bd91573150cf91aa112143d9f4d51a3fcf9dc8bce`). Image build validates its checksum, source/repair commits and safe extraction through the exact bundled plugin installer. Before Pi Web starts, image-managed installations extract this local archive into `${PI_PASEO_STATE_DIR:-${PI_CODING_AGENT_DIR}/pi-paseo}/web-client/<sha256>` without network access. A valid existing cache is reused. Static files occupy approximately 28 MiB of the persistent volume; the image keeps the 10.6 MB compressed archive. `tar`, `gzip` and `flock` are explicitly installed for both supported architectures.

Fresh boot registers the plugin once; Pi Web creates or resumes its setup conversation and starts the local daemon. Upgrading an image-managed installation adds the fixed client while preserving provider credentials, daemon identity, settings and older client caches. No provider credential, daemon identity or pairing secret is included in the image. Independently installed plugins remain under the operator's control; upgrade them separately to use this client.

Paseo 0.1.10 records the verified daemon process birth and uses a shared Linux lock for the managed runtime and plugin recovery. It can recover a previously verified stale PID without signaling the unrelated process that now occupies that PID. The runtime revision is `0.11.2-r3-6d8dbe515479`; the underlying Paseo version stays 0.11.2. A healthy older r2 daemon remains visible and can be stopped normally even before r3 is installed. When updating only the plugin, a running r2 daemon requires an explicit normal Stop and Start. An old stale record without trustworthy birth evidence remains blocked for operator inspection.

Native package disable/removal and existing external plugin installations are preserved; an official GitHub git pin moves to the bundled plugin at startup (see "Official plugin git pins move to the bundled plugins at startup"). `PI_PASEO_AUTO_SETUP=false` opts out of new image registration and of that move; it does not remove an existing installation. Manual service Stop remains effective across restart. Use the Paseo settings page to resume. Existing services only change when explicitly upgraded.

Since 0.3.24 the image itself ships Claude Code and Codex (see "Claude Code and Codex preinstalled"); the PaaS overlay adds its Omnigent gateway; each tenant still needs valid provider login or gateway access. A bundled runtime does not prove a provider can answer. The HA package uses a separate ingress adapter for Pi Web 0.12.
