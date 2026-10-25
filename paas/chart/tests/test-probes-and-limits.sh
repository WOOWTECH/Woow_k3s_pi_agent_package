#!/usr/bin/env bash
#
# AI-FIX-PI-3 (chart 0.1.9):
#  A. AI-PI-005-1  The pi-web container's exec probes are time-bounded. BEHAVIOURAL: the rendered probe command is
#     run against a TCP server that accepts and never answers (what `kill -STOP pi-web` looks like from outside).
#     The OLD command (plain `curl -sf URL`) is the negative control and must hang; the new one must exit non-zero
#     within probe.curlMaxSeconds + 3 s, and still exit 0 against a healthy server.
#  B. AI-PI-005-4  A too-big request body answers a JSON 413 naming the limit (not nginx's HTML page); the limit in
#     the message follows authProxy.clientMaxBodySize.
#  C. probe.curlMaxSeconds is validated (1-8).
#
# Usage:    bash charts/pi-agent/tests/test-probes-and-limits.sh
# Requires: helm, yq (mikefarah), python3, curl, timeout.
set -euo pipefail
CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELM="${HELM_BINARY:-helm}"
for c in yq python3 curl timeout; do command -v "$c" >/dev/null 2>&1 || { echo "SKIP (probes-and-limits): $c required"; exit 0; }; done
fail() { echo "FAIL (probes-and-limits): $1"; exit 1; }
render() { $HELM template t "$CHART_DIR" "$@" 2>/dev/null; }

OUT="$(render)"
probe_cmd() {  # $1 = startupProbe|readinessProbe|livenessProbe ; stdin = rendered manifests
  yq "select(.kind==\"Deployment\") | .spec.template.spec.containers[] | select(.name==\"pi-web\") | .$1.exec.command[2]"
}
for p in startupProbe readinessProbe livenessProbe; do
  C="$(printf '%s' "$OUT" | probe_cmd "$p")"
  case "$C" in
    "timeout -s KILL 8 curl -sf -m 5 --connect-timeout 2 http://127.0.0.1:30141/api/home >/dev/null") ;;
    *) fail "$p command is not the time-bounded curl (got: $C)" ;;
  esac
done
CUSTOM="$(render --set probe.curlMaxSeconds=3)"
[ "$(printf '%s' "$CUSTOM" | probe_cmd livenessProbe)" = "timeout -s KILL 6 curl -sf -m 3 --connect-timeout 2 http://127.0.0.1:30141/api/home >/dev/null" ] \
  || fail "probe.curlMaxSeconds=3 did not reach the command"
for bad in 0 9 -1; do
  if $HELM template t "$CHART_DIR" --set "probe.curlMaxSeconds=$bad" >/dev/null 2>&1; then fail "probe.curlMaxSeconds=$bad rendered — must be rejected"; fi
done
LT="$(printf '%s' "$OUT" | yq 'select(.kind=="Deployment") | .spec.template.spec.containers[] | select(.name=="pi-web") | .livenessProbe.timeoutSeconds')"
[ "$LT" -ge 9 ] || fail "liveness timeoutSeconds ($LT) must exceed the command bound (8 s)"

# ---- behaviour against a hung server --------------------------------------------------------------------------
TMP="$(mktemp -d)"; PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT
python3 - "$TMP" <<'PY' &
import socket, sys, threading, http.server, socketserver
tmp = sys.argv[1]
hung = socket.socket(); hung.bind(("127.0.0.1", 0)); hung.listen(16)   # accepts (kernel backlog) and never answers
open(f"{tmp}/hung.port", "w").write(str(hung.getsockname()[1]))
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
ok = socketserver.TCPServer(("127.0.0.1", 0), H); open(f"{tmp}/ok.port", "w").write(str(ok.server_address[1]))
threading.Thread(target=ok.serve_forever, daemon=True).start()
threading.Event().wait()
PY
PIDS+=("$!")
for _ in $(seq 1 50); do [ -s "$TMP/hung.port" ] && [ -s "$TMP/ok.port" ] && break; sleep 0.1; done
[ -s "$TMP/ok.port" ] || fail "test servers did not start"
HUNG="$(cat "$TMP/hung.port")"; GOOD="$(cat "$TMP/ok.port")"
NEWCMD="$(printf '%s' "$OUT" | probe_cmd livenessProbe)"
newcmd_for() { printf '%s' "$NEWCMD" | sed "s/30141/$1/"; }

# negative control: the pre-0.1.9 command never returns (we cut it at 12 s)
set +e
SECONDS=0; timeout 12 sh -c "curl -sf http://127.0.0.1:$HUNG/api/home >/dev/null"; RC_OLD=$?; OLD_S=$SECONDS
set -e
[ "$RC_OLD" = 124 ] || fail "negative control: the old probe command should hang against a non-answering server (rc=$RC_OLD after ${OLD_S}s)"

set +e
SECONDS=0; sh -c "$(newcmd_for "$HUNG")"; RC_NEW=$?; NEW_S=$SECONDS
set -e
[ "$RC_NEW" != 0 ] || fail "the new probe command reported success against a hung server"
[ "$NEW_S" -le 9 ] || fail "the new probe command took ${NEW_S}s against a hung server (must be <= 8)"
sh -c "$(newcmd_for "$GOOD")" || fail "the new probe command failed against a healthy server"

# ---- B. JSON 413 ------------------------------------------------------------------------------------------------
CONF="$(printf '%s' "$OUT" | yq 'select(.kind=="ConfigMap" and (.data | has("default.conf"))) | .data["default.conf"]')"
printf '%s' "$CONF" | grep -q 'error_page 413 @too_large;' || fail "default.conf has no 413 error_page"
printf '%s' "$CONF" | grep -q 'default_type application/json;' || fail "413 answer must be application/json"
printf '%s' "$CONF" | grep -q '單一請求上限 100 MiB' || fail "413 message must name the 100 MiB limit"
CONF2="$(render --set authProxy.clientMaxBodySize=40m | yq 'select(.kind=="ConfigMap" and (.data | has("default.conf"))) | .data["default.conf"]')"
printf '%s' "$CONF2" | grep -q '單一請求上限 40 MiB' || fail "413 message must follow authProxy.clientMaxBodySize"
printf '%s' "$CONF2" | grep -q 'client_max_body_size 40m;' || fail "client_max_body_size not rendered"

echo "PASS (probes-and-limits): exec probes time-bounded (old command hangs ${OLD_S}s+, new exits rc=$RC_NEW in ${NEW_S}s, healthy ok), curlMaxSeconds validated, JSON 413 follows clientMaxBodySize."
