#!/usr/bin/env bash
#
# Same-workspace LiteLLM wiring (平台契約：同工作區自動串接只帶網址): the platform
# injects llmGateway.baseUrl = http://<release>-litellm.<ns>.svc.cluster.local:4000/v1
# (URL only, never a key). Asserts:
#   - the URL reaches the main container ONLY as env LITELLM_BASE_URL, through a
#     runtime ConfigMap (t-pi-agent-llm-gateway) referenced by envFrom (optional);
#     OPENAI_BASE_URL / ANTHROPIC_BASE_URL are never set by it
#   - ★ the pod template (every workload object, byte for byte) is IDENTICAL whether
#     the URL is unset, set, or changed — the operator's password reset
#     (helm upgrade --atomic --timeout 15s + rollout restart) must never wait for a
#     new pod because of it; the URL never appears in a workload spec
#   - trailing "/" trimmed; a value that is not a plain http(s) URL is dropped (no
#     env, no egress hole) instead of failing the render; a missing llmGateway map
#     (--reuse-values from an older chart) renders
#   - NetworkPolicy: with allowAllEgress=false (the default since 0.1.5) a
#     same-namespace hole to the LiteLLM proxy pod
#     (name=litellm, component=app) on TCP 4000 exists only while the URL is set
#
# Usage:    bash charts/pi-agent/tests/test-llm-gateway.sh
# Requires: helm + yq (mikefarah).
set -euo pipefail
CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELM="${HELM_BINARY:-helm}"
command -v yq >/dev/null 2>&1 || { echo "SKIP (llm-gateway): yq (mikefarah) required"; exit 0; }
fail() { echo "FAIL (llm-gateway): $1"; exit 1; }

BASE=(--set-string config.sensitive.admin_password=pinned-test-password-1)
CM='t-pi-agent-llm-gateway'
MAIN='select(.kind=="Deployment") | .spec.template.spec.containers[] | select(.name=="pi-web")'
U='http://svc-1f000001-litellm.paas-ws-test.svc.cluster.local:4000/v1'
U2='http://svc-2e000002-litellm.paas-ws-test.svc.cluster.local:4000/v1'
render() { $HELM template t "$CHART_DIR" --namespace paas-ws-test "${BASE[@]}" "$@"; }
workloads() { render "$@" | yq 'select(.kind=="Deployment" or .kind=="StatefulSet")'; }
cmval() { render "$@" | yq "select(.kind==\"ConfigMap\" and .metadata.name==\"$CM\") | .data.LITELLM_BASE_URL // \"<unset>\""; }

# ── runtime ConfigMap + envFrom ─────────────────────────────────────────────
[ "$(render | yq "select(.kind==\"ConfigMap\" and .metadata.name==\"$CM\") | .metadata.name")" = "$CM" ] \
  || fail "runtime ConfigMap $CM must always be rendered (data {} when unset)"
[ "$(cmval)" = "<unset>" ] || fail "LITELLM_BASE_URL must be absent by default"
[ "$(cmval --set llmGateway.baseUrl="$U/")" = "$U" ] || fail "LITELLM_BASE_URL must carry the URL (trailing / trimmed)"
REF="$(render | yq "$MAIN | .envFrom[] | select(.configMapRef.name==\"$CM\")")"
[ -n "$REF" ] || fail "main container lacks envFrom configMapRef $CM"
[ "$(printf '%s' "$REF" | yq '.configMapRef.optional')" = "true" ] || fail "envFrom $CM must be optional"
for v in OPENAI_BASE_URL ANTHROPIC_BASE_URL; do
  [ -z "$(render --set llmGateway.baseUrl="$U" | yq "$MAIN | .env[] | select(.name==\"$v\") | .name")" ] \
    || fail "$v must not be set by the LiteLLM wiring (would hijack the tenant's provider)"
done
[ -z "$(render --set llmGateway.baseUrl="$U" | yq "select(.kind==\"ConfigMap\" and .metadata.name==\"$CM\") | .data | keys | .[] | select(. != \"LITELLM_BASE_URL\")")" ] \
  || fail "$CM must carry nothing but LITELLM_BASE_URL"
PT="$(render | yq "$MAIN | .env[] | select(.name==\"OG_PASSTHROUGH\") | .value")"
case ",$PT," in *,LITELLM_BASE_URL,*) ;; *) fail "OG_PASSTHROUGH must pass LITELLM_BASE_URL to Omnigent sessions ($PT)" ;; esac
# ── ★ pod template byte-identical across URL values ────────────────────────
W0="$(workloads)"
[ -n "$W0" ] || fail "no workload rendered"
[ "$(workloads --set llmGateway.baseUrl="$U")" = "$W0" ] || fail "setting llmGateway.baseUrl changed a workload (pod template must be identical)"
[ "$(workloads --set llmGateway.baseUrl="$U2")" = "$W0" ] || fail "changing llmGateway.baseUrl changed a workload"
[ "$(workloads --set llmGateway=null)" = "$W0" ] || fail "a missing llmGateway map changed a workload"
workloads --set llmGateway.baseUrl="$U" | grep -q 'svc-1f000001-litellm' && fail "the URL leaked into a workload spec"

# ── bad values: dropped, never a render failure ──────────────────────────────
for bad in 'not a url' 'javascript:alert(1)' 'ftp://x/v1' 'http://a b/v1' 'http://x/"$(id)"'; do
  render --set-string llmGateway.baseUrl="$bad" >/dev/null 2>&1 || fail "render failed for llmGateway.baseUrl=[$bad] (must drop, not fail)"
  [ "$(cmval --set-string llmGateway.baseUrl="$bad")" = "<unset>" ] || fail "invalid llmGateway.baseUrl=[$bad] must be dropped"
done
render --set llmGateway=null >/dev/null 2>&1 || fail "render failed without an llmGateway map (--reuse-values)"
# ── NetworkPolicy: same-namespace LiteLLM proxy hole, only while the URL is set ─
# (allowAllEgress=false is the default since 0.1.5 — assert the default render)
NP() { render "$@" | yq 'select(.kind=="NetworkPolicy" and .metadata.name=="t-pi-agent-allow") | .spec.egress[] | select(.to[0].podSelector.matchLabels."app.kubernetes.io/name"=="litellm")'; }
[ -z "$(NP)" ] || fail "LiteLLM egress hole must be absent while llmGateway.baseUrl is empty"
P="$(NP --set llmGateway.baseUrl="$U")"
[ -n "$P" ] || fail "LiteLLM egress hole missing while llmGateway.baseUrl is set"
[ "$(printf '%s' "$P" | yq '.to[0].podSelector.matchLabels."app.kubernetes.io/component"')" = "app" ] || fail "hole must target the LiteLLM proxy pod (component=app), not its database"
[ "$(printf '%s' "$P" | yq '.to | length')" = "1" ] || fail "hole must have exactly one peer"
[ "$(printf '%s' "$P" | yq '.to[0] | has("namespaceSelector") or has("ipBlock")')" = "false" ] || fail "hole must stay inside this namespace (podSelector only)"
[ "$(printf '%s' "$P" | yq -o=json -I=0 '.ports')" = '[{"protocol":"TCP","port":4000}]' ] || fail "hole must be TCP 4000 only"
[ -z "$(NP --set llmGateway.baseUrl="$U" --set networkPolicy.litellmEgress.enabled=false)" ] || fail "litellmEgress.enabled=false must drop the hole"
[ -z "$(NP --set-string llmGateway.baseUrl='not a url')" ] || fail "an invalid URL must not open the hole"
[ -n "$(NP --set llmGateway.baseUrl="$U" --set networkPolicy.litellmEgress=null)" ] || fail "a missing litellmEgress map (--reuse-values) must fall back to the defaults"
[ -n "$(NP --set llmGateway.baseUrl="$U" --set networkPolicy.sameNamespaceEgress=false)" ] || fail "the hole must not depend on sameNamespaceEgress"
# 0.1.7 (#1441): allowAllEgress no longer renders a bare {} — the hole stays explicit.
ALLOW="$(render --set llmGateway.baseUrl="$U" --set networkPolicy.allowAllEgress=true | yq 'select(.kind=="NetworkPolicy" and .metadata.name=="t-pi-agent-allow")')"
[ "$(yq '[.spec.egress[] | select(tag == "!!map" and length == 0)] | length' <<<"$ALLOW")" = "0" ] || fail "allowAllEgress=true must not render a bare {} (#1441)"
[ -n "$(NP --set llmGateway.baseUrl="$U" --set networkPolicy.allowAllEgress=true)" ] || fail "the LiteLLM hole must not depend on allowAllEgress"
echo "PASS (llm-gateway): LITELLM_BASE_URL via runtime ConfigMap + optional envFrom only (no OPENAI_/ANTHROPIC_BASE_URL); pod template byte-identical across unset/set/changed URL; bad values dropped, never fatal; TCP 4000 hole to the same-ns LiteLLM proxy only while the URL is set."
