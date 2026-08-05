# Woow k3s Pi Agent Package

pi-web + the pi coding agent + a ttyd browser terminal, packaged to run on k3s.

This is the Kubernetes sibling of
[`WOOWTECH/Woow_ha_pi_agent_add_on`](https://github.com/WOOWTECH/Woow_ha_pi_agent_add_on),
which packages the same stack as a Home Assistant add-on. The add-on repo stays
the upstream for behaviour; this repo owns the container image and the Helm
chart used on the cluster.

## What you get

| Component | What it is |
|---|---|
| **pi-web** | Next.js UI for the pi coding agent. Providers and API keys are configured in its own Models page and persisted to the volume — not injected as env vars. |
| **pi coding agent** | Imported by pi-web as a library (no separate daemon), plus the `pi` CLI/TUI on `PATH` for terminal use. |
| **ttyd** | Browser terminal running as a sidecar on the *same pod and same volume*, so `pi config` in the terminal configures the instance the web UI serves. |
| **nginx** | Small in-pod proxy. Not optional — see "Why nginx" below. |
| **cloudflared** | Locally-managed Cloudflare Tunnel. Hostname routing lives in this chart, not in the Cloudflare dashboard. |
| **video pipeline** | ffmpeg / Playwright-Chromium / edge-tts / rclone, bootstrapped onto the volume on first boot, in the background. |

## Quick start

```bash
helm upgrade --install pi-agent ./charts/pi-agent \
  --namespace pi-agent-woow --create-namespace \
  -f values-woow.yaml \
  --set ttyd.password="$(openssl rand -base64 18)" \
  --set-file cloudflare.credentialsJson=./tunnel-credentials.json

helm test pi-agent -n pi-agent-woow
```

`ttyd.password` has no default and the chart refuses to render without it. That
is deliberate: the terminal is a root shell.

## Design notes worth knowing before you change anything

**`pi` is not on `PATH` in upstream's image.** `@earendil-works/pi-coding-agent`
ships a `pi` bin, but it is only ever a transitive dependency of `@agegr/pi-web`,
and npm does not link bins of transitive deps. `rootfs/usr/local/bin/pi` resolves
the nested `dist/cli.js` at runtime. Without it the browser terminal cannot drive
the agent's TUI at all — which was the main thing wrong with the previous k3s
deploy.

**Why nginx.** pi-web's `isApiRequestAllowed()` rejects any request whose `Host`
is not a loopback name or raw IP, and any `Origin` that doesn't match. Traffic
arrives with the public hostname, so without the sidecar's `Host: localhost` +
`Origin: ""` rewrite, every auth-gated route (models, skills, sessions, plugins)
answers `403 Untrusted API request` and the UI loads but does nothing. The
add-on's *other* nginx job — the HA ingress-prefix `sub_filter` shim and the
`</head>` JS monkey-patch — is dropped here, because k3s serves the app at a
hostname root and there is no prefix to rewrite.

**ttyd is a sidecar, not its own deployment.** The earlier build ran ttyd in a
separate pod and used `kubectl exec` to hop into the agent. That needed a
ServiceAccount with `pods/exec` (a cluster shell as a service), broke whenever
the target pod restarted, and landed in a container where `pi` didn't exist.
Same pod + same PVC removes the RBAC, the hop, and the race.

**Skills path bridge.** pi-web reads skills from `$PI_CODING_AGENT_DIR/skills`;
the `skills` CLI writes to `$HOME/.pi/agent/skills`. On the add-on those
coincide, here they don't, so an install silently succeeds and never appears in
a session. `pi-web-start.sh` symlinks the two and migrates anything already on
the wrong side.

**The video bootstrap is backgrounded, not an initContainer.** Its first run
pulls ~720MB. As a blocking initContainer that is 10-20 minutes where the pod
serves nothing, and any download hiccup is a pod that never becomes ready. The
add-on ran it as a dependency-free s6 oneshot for exactly this reason; the same
semantics are preserved by backgrounding it from the entrypoint.

**Single replica, `Recreate`.** All state is files on one RWO volume — sessions,
worktrees, `models.json`, skills. A second replica would double-write every one
of them. This is a correctness constraint, not a tuning default.

## Repository layout

```
Dockerfile                  # k3s image: no s6, no bashio, ttyd baked in, pi on PATH
rootfs/                     # scripts baked into the image (not ConfigMap glue)
  usr/local/bin/pi                  # launcher for the transitively-installed CLI
  usr/local/bin/pi-agent-env.sh     # one env definition, shared by every process
  usr/local/bin/pi-web-start.sh     # pi-web container entrypoint
  usr/local/bin/video-tools-init.sh # background first-boot bootstrap
  usr/local/bin/ttyd-start.sh       # ttyd sidecar entrypoint
  usr/local/bin/pi-shell.sh         # the shell ttyd forks per browser session
charts/pi-agent/            # Helm chart
values-woow.yaml            # the WoowTech internal instance
```

Scripts live in the image rather than in ConfigMaps on purpose: a ConfigMap edit
with no `checksum/` annotation is inert until someone remembers to restart the
pod, which is a reliable way to spend an afternoon debugging a fix that was
never applied.

## Versions

| Thing | Pin | Why |
|---|---|---|
| `@agegr/pi-web` | `0.8.4` | The version the add-on validated end to end. The nginx guard and the `/api/*` surface are written against it. Bump the Dockerfile ARG only after re-running the acceptance suite. |
| `ttyd` | `1.7.7` | Current stable. Downloaded at build time and checksum-verified against the release's own `SHA256SUMS`. |
| `cloudflared` | pinned tag | Not `:latest` — see `values.yaml`. |

## Licence

MIT, matching the upstream add-on.
