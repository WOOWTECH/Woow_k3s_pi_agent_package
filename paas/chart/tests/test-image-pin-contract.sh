#!/usr/bin/env bash
# Deployment metadata must preserve a platform tag@digest through Omnigent setup
# opt-in/out and reuse of an existing PVC. Rendering never pulls the image.
set -euo pipefail
CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELM="${HELM_BINARY:-helm}"
command -v yq >/dev/null 2>&1 || { echo "FAIL (image-pin): mikefarah yq required"; exit 1; }
fail() { echo "FAIL (image-pin): $1"; exit 1; }
pi_image() { yq -r 'select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "pi-web") | .image'; }

# Historical 0.1.10 platform pin, NOT a proposed release or a registry check.
# Keep it independent of Chart.appVersion: older services must retain their pin.
REPOSITORY='jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent'
PIN='20261025.1200@sha256:7152969a4ffa3f05f46b28f49d8899448e426d85014d5f05875f7ede563c120d'
APP_VERSION="$(yq -r '.appVersion' "$CHART_DIR/Chart.yaml")"
DEFAULT_REPOSITORY="$(yq -r '.image.repository' "$CHART_DIR/values.yaml")"
OUT="$("$HELM" template pin-contract "$CHART_DIR" --set auth.existingSecret=tenant-auth)"
[ "$(printf '%s' "$OUT" | pi_image)" = "$DEFAULT_REPOSITORY:$APP_VERSION" ] || fail 'empty image.tag must use appVersion'

for host in true false; do
  for setup in true false; do
    OUT="$("$HELM" template pin-contract "$CHART_DIR" \
      --set-string "image.repository=$REPOSITORY" --set-string "image.tag=$PIN" \
      --set "omnigentHost.enabled=$host" --set "piWeb.omnigentSetup=$setup" \
      --set auth.existingSecret=tenant-auth --set persistence.existingClaim=tenant-data)"
    [ "$(printf '%s' "$OUT" | pi_image)" = "$REPOSITORY:$PIN" ] || fail "explicit digest lost (host=$host setup=$setup)"
    [ "$(printf '%s' "$OUT" | yq -r 'select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "pi-web") | .env[] | select(.name == "PI_OMNIGENT_AUTO_SETUP") | .value')" = "$setup" ] || fail 'setup choice lost during image upgrade'
    [ "$(printf '%s' "$OUT" | yq -r 'select(.kind == "Deployment") | .spec.template.spec.volumes[] | select(.name == "data") | .persistentVolumeClaim.claimName')" = tenant-data ] || fail 'existing tenant data claim changed'
    [ -z "$(printf '%s' "$OUT" | yq -r 'select(.kind == "PersistentVolumeClaim") | .metadata.name')" ] || fail 'existingClaim rendered a replacement PVC'
    [ -z "$(printf '%s' "$OUT" | yq -r 'select(.kind == "Secret") | .metadata.name')" ] || fail 'existingSecret rendered new credentials'
    [ "$(printf '%s' "$OUT" | yq 'select(.kind == "Deployment")' | yq -o json -I0 '[.spec.template.spec.containers[].name] | sort')" = '["auth-proxy","pi-web"]' ] || fail 'image upgrade added a competing host container'
  done
done
echo 'PASS (image-pin): appVersion fallback; exact historical tag@digest across four host/setup modes; existing PVC and credentials retained'
