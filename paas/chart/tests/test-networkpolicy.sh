#!/usr/bin/env bash
set -euo pipefail
CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; HELM="${HELM_BINARY:-helm}"
command -v yq >/dev/null 2>&1 || { echo "SKIP (networkpolicy): yq (mikefarah) required"; exit 0; }
fail() { echo "FAIL (networkpolicy): $1"; exit 1; }
OUT="$($HELM template t "$CHART_DIR")"
[ "$(printf '%s' "$OUT" | yq -N 'select(.kind=="NetworkPolicy") | .metadata.name' | grep -c .)" = "2" ] || fail "expected 2 NetworkPolicies"
A="$(printf '%s' "$OUT" | yq 'select(.kind=="NetworkPolicy" and (.metadata.name|test("-allow$")))')"
[ "$(printf '%s' "$A" | yq '.spec.ingress | length')" = "0" ] || fail "no chart ingress allow with empty ingressNamespaces (operator baseline governs)"
[ "$(printf '%s' "$A" | yq '.spec.egress | length')" = "2" ] || fail "egress = DNS + all (BYOK model APIs) by default"
[ "$($HELM template t "$CHART_DIR" --set networkPolicy.allowAllEgress=false | yq 'select(.kind=="NetworkPolicy" and (.metadata.name|test("-allow$"))) | .spec.egress | length')" = "1" ] || fail "allowAllEgress=false must leave DNS only"
echo "PASS (networkpolicy)"
