#!/bin/bash
# Entrypoint for the ttyd sidecar — a browser terminal that runs INSIDE the
# agent pod, on the same PVC as pi-web.
#
# Why a sidecar and not a separate deployment: the previous k3s build ran ttyd
# in its own pod and used `kubectl exec` to hop into pi-agent. That needed a
# ServiceAccount with exec rights (effectively cluster-shell-as-a-service), it
# broke whenever the target pod was mid-restart, and — because it exec'd into a
# container where `pi` was not on PATH — it could not actually drive the TUI.
# Sharing the pod removes the RBAC, the network hop, and the race.
set -euo pipefail
exec 2>&1

log() { printf '[ttyd] %s\n' "$*"; }

if [ -z "${TTYD_PASSWORD:-}" ]; then
  log "FATAL: TTYD_PASSWORD is empty — refusing to expose a root shell without auth"
  exit 1
fi

PORT="${TTYD_PORT:-7681}"
USER_NAME="${TTYD_USERNAME:-admin}"
MAX_CLIENTS="${TTYD_MAX_CLIENTS:-8}"

log "ttyd $(ttyd --version 2>&1 | head -1) listening on :${PORT} (basic auth user: ${USER_NAME})"
log "note: this is defence in depth only — Cloudflare Access is the primary gate"

# -W  writable (a read-only terminal cannot run `pi config`)
# -m  cap concurrent sessions; each one forks a shell holding the PVC open
# No -O: origin checking is left off because the request arrives from the
# Cloudflare edge, whose Origin header will never match the pod's own host.
exec ttyd \
  -p "${PORT}" \
  -i 0.0.0.0 \
  -c "${USER_NAME}:${TTYD_PASSWORD}" \
  -m "${MAX_CLIENTS}" \
  -W \
  -t fontSize=14 \
  -t 'theme={"background":"#101216"}' \
  -T xterm-256color \
  /usr/local/bin/pi-shell.sh
