# Namespace topology after 2026-09-09

    cloudflared (release `pi-tunnel`)
        └── npm  :80   ── HTTP Basic per host ──┐
            npm  :81   admin UI                 │
                                                ├── pi-agent    nginx:30142 → pi-web:30141
                                                ├── pi-agent-2  …
                                                ├── pi-agent-3  …
                                                ├── pi-agent-4  …
                                                └── pi-agent-5  …

Three things changed at once, and each undoes a specific problem.

## 1. ttyd is gone

pi-web 0.9.0 serves its own terminal in the UI, reaching the same pod, volume
and `$HOME`. Keeping ttyd meant two shells, two auth stories and two things to
patch for one capability. Removed from all five: sidecar container, `-tty`
Service, ttyd Secret, and the five `-tty` routes. The chart now defaults
`ttyd.enabled=false`.

The five `pi-agent-woow-k3s*-tty.woowtech.io` DNS records and any Cloudflare
Access applications on them are now orphaned — remove them in the dashboard.

## 2. cloudflared has its own release

It used to be owned by release `pi-agent`, which meant every upgrade of that
one agent rewrote the routing table for all five. Worse, the live ConfigMap
carried ten hostnames while Helm's copy carried two — the extra eight had been
appended by hand, and a plain `helm upgrade` would have dropped them.

It now lives in release **`pi-tunnel`** rendered from this same chart with
`agent.enabled=false` — cloudflared, its ConfigMap and its credentials Secret,
nothing else. Agents no longer carry `cloudflare.*` at all.

Extraction was zero-downtime by construction: the new release uses distinct
resource names (`pi-tunnel-*`), so both tunnels ran against the same tunnel ID
until the old one was removed.

Two traps found doing it, both now fixed in the chart:
- A tunnel-only release has no Service of its own, so the primary route's
  origin — derived from the release name — pointed at nothing and 502'd. The
  primary route is now only rendered when `agent.enabled=true`; a tunnel-only
  release declares every route in `cloudflare.extraIngress`.
- The credentials Secret is named after the release. Moving the tunnel means
  giving the new release its own `credentialsJson` BEFORE removing the old
  release's cloudflared, or the Secret is deleted out from under the running
  tunnel.

## 3. NPM authenticates

Deployed from `npm.yaml` — deliberately not part of the pi-agent chart. It is
shared namespace infrastructure, and folding it into the agent chart would
recreate exactly the coupling that extracting cloudflared just removed.

One Access List per release, so access to one instance can be revoked without
touching the other four. NPM does NOT replace the per-agent nginx sidecar: that
sidecar still performs the Host/Origin rewrite pi-web's trust guard requires.
NPM sits in front of it.

`advanced_config` on each proxy host disables buffering and sets a 3600s
timeout — pi-web streams chat and terminal output over SSE and buffering
truncates it mid-response.

NetworkPolicy now reflects the real graph: agents admit **only** `npm`, and NPM
admits only the tunnel pods plus the node network for kubelet probes.

## Operating notes

- Rollout order for agent upgrades is unchanged: one at a time, each owns a RWO
  volume with a Recreate strategy.
- Check the live PVC capacity before upgrading. `pi-agent`'s was expanded out of
  band to 51Gi; the chart's 20Gi would shrink it, which Kubernetes forbids and
  which fails the upgrade half-applied.
- `pi-agent-woow-k3s-3` also sits behind Cloudflare Access, so it answers 302
  before NPM is ever reached. Deliberate — two layers on that one host.
- NPM's own state lives on two RWO PVCs (`npm-data`, `npm-letsencrypt`). Losing
  them loses every proxy host and Access List.
