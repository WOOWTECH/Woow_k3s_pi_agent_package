#!/usr/bin/env bash
# pi-agent NetworkPolicy contract (#1436, #1441 workspace = LAN): default-deny + one
# allow; egress = DNS + internet EXCLUDING the cluster / private / metadata / CGNAT /
# multicast ranges + every pod of this namespace on every port (default since 0.1.7) +
# the same-namespace Omnigent server pods on :8000 (kept explicit). Ingress = this
# namespace only (never a from-less #280 hole). Never a bare `- {}` (or a rule without
# `to`) — not even with the legacy allowAllEgress.
set -euo pipefail
CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; HELM="${HELM_BINARY:-helm}"
command -v yq >/dev/null 2>&1 || { echo "SKIP (networkpolicy): yq (mikefarah) required"; exit 0; }
fail() { echo "FAIL (networkpolicy): $1"; exit 1; }
allow() { $HELM template t "$CHART_DIR" "$@" | yq 'select(.kind=="NetworkPolicy" and (.metadata.name|test("-allow$")))'; }
OUT="$($HELM template t "$CHART_DIR")"
[ "$(yq -N 'select(.kind=="NetworkPolicy") | .metadata.name' <<<"$OUT" | grep -c .)" = "2" ] || fail "expected 2 NetworkPolicies"
A="$(allow)"
[ "$(yq -o=json -I=0 '.spec.ingress' <<<"$A")" = '[{"from":[{"podSelector":{}}]}]' ] || fail "ingress = the same namespace on every port, nothing else with empty ingressNamespaces"
E="$(yq '.spec.egress' <<<"$A")"
[ "$(yq 'length' <<<"$E")" = "4" ] || fail "default egress = DNS + internet + same namespace + omnigent server"
# no rule may lack `to` (a rule without `to` = every destination)
[ "$(yq '[.[] | select(has("to") | not)] | length' <<<"$E")" = "0" ] || fail "an egress rule without 'to' (allow-all) is rendered by default"
[ "$(yq '.[1].to[0].ipBlock.cidr' <<<"$E")" = "0.0.0.0/0" ] || fail "internet rule must be an ipBlock 0.0.0.0/0"
EXC="$(yq '.[1].to[0].ipBlock.except[]' <<<"$E")"
for c in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 224.0.0.0/4 240.0.0.0/4; do
  grep -qx "$c" <<<"$EXC" || fail "internet rule must exclude $c"
done
[ "$(yq '.[1] | has("ports")' <<<"$E")" = "false" ] || fail "internet rule must allow any port (git over ssh, registries)"
[ "$(yq -o=json -I=0 '.[2]' <<<"$E")" = '{"to":[{"podSelector":{}}]}' ] || fail "same-namespace egress must be every pod on every port (#1441)"
[ "$(yq '.[3].to[0].podSelector.matchLabels["app.kubernetes.io/name"]' <<<"$E")" = "omnigent" ] || fail "omnigent egress must target the omnigent pods"
[ "$(yq '.[3].to[0].podSelector.matchLabels["app.kubernetes.io/component"]' <<<"$E")" = "server" ] || fail "omnigent egress must target the SERVER pods only (not runners)"
[ "$(yq '.[3].to[0] | has("namespaceSelector")' <<<"$E")" = "false" ] || fail "omnigent egress must stay in-namespace"
[ "$(yq '.[3].ports[0].port' <<<"$E")" = "8000" ] || fail "omnigent egress port must be 8000"
# omnigent host off → DNS + internet + same namespace
[ "$(allow --set omnigentHost.enabled=false | yq '.spec.egress | length')" = "3" ] || fail "omnigentHost off must leave DNS + internet + same namespace"
# sameNamespaceEgress=false → the 0.1.6 shape (DNS + internet + omnigent hole only)
OFF="$(allow --set networkPolicy.sameNamespaceEgress=false --set networkPolicy.sameNamespaceIngress=false)"
[ "$(yq '.spec.egress | length' <<<"$OFF")" = "3" ] || fail "sameNamespaceEgress=false must drop only the namespace rule"
[ "$(yq '[.spec.egress[] | select(.to[0].podSelector != null and (.to[0].podSelector | length) == 0)] | length' <<<"$OFF")" = "0" ] || fail "sameNamespaceEgress=false must not open podSelector: {}"
[ "$(yq '.spec.ingress | length' <<<"$OFF")" = "0" ] || fail "sameNamespaceIngress=false must drop the ingress rule"
# allowAllEgress (legacy) → exactly the default rules, never {} (#1441)
[ "$(allow --set networkPolicy.allowAllEgress=true | yq -o=json -I=0 '.spec')" = "$(yq -o=json -I=0 '.spec' <<<"$A")" ] || fail "allowAllEgress=true must render exactly the default rules (no bare {})"
echo "PASS (networkpolicy)"
