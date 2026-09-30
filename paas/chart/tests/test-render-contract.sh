#!/usr/bin/env bash
# pi-agent render contract: loopback-only app behind an nginx basic-auth proxy that is
# the single exposed port; admin_password → Secret → htpasswd initContainer; platform
# pin / existingSecret honoured; no NodePort/cloudflared/ttyd; video pipeline off;
# non-root; RWO PVC + Recreate; no hard-coded namespace.
set -euo pipefail
CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; HELM="${HELM_BINARY:-helm}"
command -v yq >/dev/null 2>&1 || { echo "SKIP (render-contract): yq (mikefarah) required"; exit 0; }
fail() { echo "FAIL (render-contract): $1"; exit 1; }
OUT="$($HELM template t "$CHART_DIR" -n SENTINEL)"
DEP="$(printf '%s' "$OUT" | yq 'select(.kind=="Deployment")')"
# single ClusterIP :8080 → auth-proxy; nothing else exposed
[ "$(printf '%s' "$OUT" | yq -N 'select(.kind=="Service")' | yq -N 'documentIndex' | wc -l)" = "1" ] || fail "expected exactly one Service"
[ "$(printf '%s' "$OUT" | yq -N 'select(.kind=="Service") | .spec.type')" = "ClusterIP" ] || fail "Service is not ClusterIP"
[ "$(printf '%s' "$OUT" | yq -N 'select(.kind=="Service") | .spec.ports[0].targetPort')" = "8080" ] || fail "Service targetPort != 8080 (auth-proxy)"
printf '%s' "$DEP" | yq '.spec.template.spec.containers[] | select(.name=="pi-web") | .ports' | grep -q containerPort && fail "pi-web must not declare a container port (loopback-only)"
[ "$(printf '%s' "$DEP" | yq '.spec.template.spec.containers[] | select(.name=="pi-web") | .env[] | select(.name=="PI_WEB_HOSTNAME") | .value')" = "127.0.0.1" ] || fail "pi-web must bind 127.0.0.1"
[ "$(printf '%s' "$DEP" | yq '.spec.template.spec.containers[] | select(.name=="pi-web") | .env[] | select(.name=="VIDEO_PIPELINE_ENABLED") | .value')" = "false" ] || fail "video pipeline must be off"
printf '%s' "$OUT" | grep -qiE 'cloudflared|ttyd' && fail "cloudflared/ttyd must not be rendered"
# auth: basic auth on /, health exempt, Host localhost shim, htpasswd from admin_password
CONF="$(printf '%s' "$OUT" | yq -N 'select(.kind=="ConfigMap") | .data["default.conf"]')"
printf '%s' "$CONF" | grep -q 'auth_basic_user_file /auth/.htpasswd' || fail "auth_basic not configured"
printf '%s' "$CONF" | grep -A1 'location = /healthz {' | grep -q 'auth_basic off' || fail "/healthz must be auth-exempt"
printf '%s' "$CONF" | grep -q 'proxy_set_header Host localhost' || fail "Host localhost shim missing (pi-web trust guard)"
INIT="$(printf '%s' "$DEP" | yq '.spec.template.spec.initContainers[] | select(.name=="authproxy-init")')"
[ "$(printf '%s' "$INIT" | yq '.env[] | select(.name=="ADMIN_PASSWORD") | .valueFrom.secretKeyRef.key')" = "admin_password" ] || fail "htpasswd init must read admin_password from the Secret"
SEC="$(printf '%s' "$OUT" | yq -N 'select(.kind=="Secret") | .stringData.admin_password')"
[ ${#SEC} -ge 20 ] || fail "self-generated admin_password too short ('$SEC')"
PIN="$($HELM template t "$CHART_DIR" --set-string config.sensitive.admin_password=pinned-by-platform | yq -N 'select(.kind=="Secret") | .stringData.admin_password')"
[ "$PIN" = "pinned-by-platform" ] || fail "platform-pinned admin_password not honoured"
$HELM template t "$CHART_DIR" --set auth.existingSecret=ext | yq -N 'select(.kind=="Secret") | .metadata.name' | grep -q . && fail "chart Secret rendered despite auth.existingSecret"
[ "$($HELM template t "$CHART_DIR" --set auth.existingSecret=ext | yq 'select(.kind=="Deployment") | .spec.template.spec.initContainers[0].env[] | select(.name=="ADMIN_PASSWORD") | .valueFrom.secretKeyRef.name')" = "ext" ] || fail "existingSecret not wired into htpasswd init"
# hardening / storage
[ "$(printf '%s' "$DEP" | yq '.spec.template.spec.securityContext.runAsNonRoot')" = "true" ] || fail "runAsNonRoot missing"
[ "$(printf '%s' "$DEP" | yq '.spec.strategy.type')" = "Recreate" ] || fail "strategy must be Recreate (RWO PVC)"
[ "$(printf '%s' "$DEP" | yq '.spec.template.spec.automountServiceAccountToken')" = "false" ] || fail "SA token must not be mounted"
[ "$(printf '%s' "$OUT" | yq -N 'select(.kind=="PersistentVolumeClaim") | .spec.accessModes[0]')" = "ReadWriteOnce" ] || fail "PVC must be RWO"
$HELM template t "$CHART_DIR" --set persistence.existingClaim=keep | yq -N 'select(.kind=="PersistentVolumeClaim") | .metadata.name' | grep -q . && fail "PVC rendered despite existingClaim"
for c in $(printf '%s' "$DEP" | yq '.spec.template.spec | (.initContainers + .containers)[] | .name'); do
  printf '%s' "$DEP" | yq ".spec.template.spec | (.initContainers + .containers)[] | select(.name==\"$c\") | .resources.limits.cpu" | grep -q . || fail "container $c lacks limits (ResourceQuota)"; done
NS="$(printf '%s' "$OUT" | { grep -E '^  namespace:' || true; } | awk '{print $2}' | sort -u | tr '\n' ' ')"; [ -z "$NS" ] || [ "$NS" = "SENTINEL " ] || fail "hard-coded namespace: $NS"
echo "PASS (render-contract): loopback app + basic-auth proxy :8080, admin_password→Secret→htpasswd (pin/existing/lookup), no tunnel/ttyd, video off, non-root, RWO+Recreate, limits everywhere."
