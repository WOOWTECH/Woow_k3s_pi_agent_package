#!/usr/bin/env bash
#
# Tenant credential contract (0.1.2):
#   - authProxy.basicAuthUsername is tenant-changeable from the platform; it is
#     rendered into the chart Secret (admin_username) and the htpasswd init
#     container reads it via secretKeyRef
#   - REGRESSION GUARD: changing the username must NOT change the pod template.
#     The operator resets credentials with `helm upgrade --atomic --timeout 15s`
#     (i.e. --wait); a pod-template change makes helm wait for a new pod
#     (30-70 s), so every username change used to roll back after ~1 min of
#     downtime. With the username in the Secret only the Secret changes.
#   - auth.existingSecret keeps the literal value (an external Secret may not
#     carry admin_username)
#   - an unsafe username (':' / whitespace / empty / too long / non-ASCII)
#     FAILS the render instead of silently splitting the htpasswd line
#
# Usage:    bash charts/pi-agent/tests/test-credentials.sh
# Requires: helm + yq (mikefarah).
set -euo pipefail
CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELM="${HELM_BINARY:-helm}"
command -v yq >/dev/null 2>&1 || { echo "SKIP (credentials): yq (mikefarah) required"; exit 0; }
fail() { echo "FAIL (credentials): $1"; exit 1; }

render() { $HELM template t "$CHART_DIR" "$@" 2>/dev/null; }
user_env() {  # yq expression result for the BASIC_USER env entry
  yq 'select(.kind=="Deployment") | .spec.template.spec.initContainers[] | select(.name=="authproxy-init") | .env[] | select(.name=="BASIC_USER")'
}
secret_user() { yq 'select(.kind=="Secret") | .stringData.admin_username'; }
pod_template() { yq 'select(.kind=="Deployment") | .spec.template'; }

# Default: username lives in the Secret, env reads it from there.
OUT="$(render)"
[ "$(printf '%s' "$OUT" | secret_user)" = "admin" ] || fail "Secret admin_username must default to admin"
KEY="$(printf '%s' "$OUT" | user_env | yq '.valueFrom.secretKeyRef.key')"
[ "$KEY" = "admin_username" ] || fail "BASIC_USER must come from secretKeyRef admin_username (got '$KEY')"
[ "$(printf '%s' "$OUT" | user_env | yq 'has("value")')" = "false" ] || fail "BASIC_USER must not carry a literal value"

# Custom username reaches the Secret ...
CUSTOM="$(render --set authProxy.basicAuthUsername=design.team@woow)"
[ "$(printf '%s' "$CUSTOM" | secret_user)" = "design.team@woow" ] || fail "custom username did not reach the Secret"

# ... and the pod template is byte-identical (the whole point of this chart version).
[ "$(printf '%s' "$OUT" | pod_template)" = "$(printf '%s' "$CUSTOM" | pod_template)" ] \
  || fail "changing the username changed the pod template — the 15 s credential reset would roll back"

# existingSecret: literal value (external Secret may lack admin_username).
EXT="$(render --set auth.existingSecret=ext --set authProxy.basicAuthUsername=ops)"
[ "$(printf '%s' "$EXT" | user_env | yq '.value')" = "ops" ] || fail "existingSecret mode must keep the literal username"

LONG="$(printf 'a%.0s' $(seq 1 65))"
for bad in 'a:b' 'a b' '' "$LONG" 'tab	x' 'ünïcode'; do
  if $HELM template t "$CHART_DIR" --set-string "authProxy.basicAuthUsername=$bad" >/dev/null 2>&1; then
    fail "username '$bad' rendered — must be rejected"
  fi
done

echo "PASS (credentials): username in Secret via secretKeyRef, pod template unchanged by a username change, existingSecret literal, unsafe usernames rejected."
