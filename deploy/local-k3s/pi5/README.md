# pi5 on the local k3s

pi5 ran as a WOOW PaaS pi-agent service until 2026-10-14 and now runs on the local k3s
cluster (kube context `default`, namespace `pi5`, release `pi5`) from
[`values.yaml`](values.yaml) and the PaaS edition chart in [`paas/chart`](../../../paas/chart).
It keeps its Omnigent identity, so it still appears in Omnigent as "Pi Web ChatGPT (pi5)"
with its existing sessions. It has no web entry.

## Cutover record (2026-10-14)

Downtime 07:30–08:02 UTC (about 32 minutes).

1. A copy of the PaaS volume had already been restored, verified and acceptance-tested in
   an isolated namespace with all egress denied: login and auth boundary, sessions,
   terminal and SSE reconnect, restart persistence, and scale-to-zero plus reinstall.
2. The PaaS deployment was scaled to 0. A helper pod attached the PaaS volume, and only the
   files that differed from the local copy were transferred, each checked by SHA-256 on
   both sides. The local copy was then fully verified against the source: 450,779 entries
   and 67 SQLite databases (integrity check). Had any step failed, the PaaS deployment
   would have been scaled back to 1 automatically.
3. The retained local-path volume was bound to PVC `pi5/pi5-data`, the release was
   installed, and the Omnigent host reconnected under the same host id.

The migration tooling (acknowledged transfers over `kubectl exec`, delta sync, backup and
restore verifiers) is kept in the internal repository `woow-paas/pi-agent-local-k3s`.

## Rollback

Until the PaaS service is cancelled (not before 2026-10-21) its release and volume are kept,
scaled to 0. To go back: scale `deploy/pi5` in namespace `pi5` to 0, then scale the PaaS
pi5 deployment to 1. Anything written locally after the cutover is not in the PaaS copy.

## Operating notes

- Storage is a single local-path volume on the AI coder laptop with no replica. Keep an
  off-node backup.
- Egress: the public internet only; cluster, private and tailnet ranges are blocked by the
  chart's NetworkPolicy.
- Logins live on the volume: Omnigent in `home/.omnigent`, Claude Code in `home/.claude`
  (`env HOME=/data/pi-agent/home claude auth login` from the pi-web terminal).
