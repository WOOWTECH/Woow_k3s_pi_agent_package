#!/usr/bin/env bash
# pi-agent 0.1.4: the Omnigent host runs INSIDE the pi-web container (shared kit
# shared/omnigent-host, in-container mode; no sidecar):
#   * the vendored kit is byte-identical to the canonical copy (sha256);
#   * kit contract on pi-web: launcher between tini and pi-web-start.sh, kit + runtime
#     ConfigMaps mounted, telemetry off, OG_* env, no OG_SERVER_URL in the pod template;
#   * omnigentHost.serverUrl only reaches the runtime ConfigMap (no pod restart);
#   * the pod keeps exactly the containers it had in 0.1.2 and pi-web keeps the full
#     plan (2 vCPU / 4 GiB, V8 heap 3072) — no budget split, in every values shape the
#     platform produces (defaults, template helm_default_values, --reuse-values);
#   * migration of the by-hand host: identity + login in ~/.omnigent on the volume,
#     HOME = pi-web's home, identity never from env, pi's real login reaches sessions
#     (PI_CODING_AGENT_DIR on the container AND in the passthrough), stable name;
#   * enabled=false: pi-web-start.sh under tini, nothing of the kit left.
# shellcheck disable=SC2015 # ok/fail always return 0: "A && fail || ok" is intended
set -uo pipefail
CHART_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; HELM="${HELM_BINARY:-helm}"
command -v yq >/dev/null 2>&1 || { echo "SKIP (omnigent-host-kit): yq (mikefarah) required"; exit 0; }
# kit_assert_* call `helm` directly
[ "$HELM" = helm ] || helm() { "$HELM" "$@"; }
# shellcheck source=/dev/null  # shared/omnigent-host/chart/kit-test-lib.sh
. "$(cd "$CHART_DIR/../.." && pwd)/shared/omnigent-host/chart/kit-test-lib.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
rc=0
fail() { echo "  FAIL $1"; rc=1; }
ok() { echo "  ok   $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else fail "$1 (got '$2', want '$3')"; fi; }
render() { "$HELM" template "$@" 2>"$TMP/err"; }
dep() { yq 'select(.kind=="Deployment")' "$1"; }
cont() { yq "select(.kind==\"Deployment\") | .spec.template.spec.containers[] | select(.name==\"$2\")" "$1"; }
envv() { yq "select(.kind==\"Deployment\") | .spec.template.spec.containers[] | select(.name==\"pi-web\") | .env[] | select(.name==\"$2\") | .value" "$1"; }
# 0.1.5 (#1434): + ephemeral-storage (requests 512Mi / limits 6Gi)
FULL_PLAN='{"limits":{"cpu":"2","ephemeral-storage":"6Gi","memory":"4Gi"},"requests":{"cpu":"500m","ephemeral-storage":"512Mi","memory":"1Gi"}}'
LAUNCH='["/usr/bin/tini","--","/bin/sh","/etc/omnigent-host/omnigent-host-launch","--","/usr/local/bin/pi-web-start.sh"]'
PLAIN='["/usr/bin/tini","--","/usr/local/bin/pi-web-start.sh"]'

echo "== kit vendoring"
kit_assert_vendored "$CHART_DIR" || rc=1

echo "== defaults: kit contract on pi-web"
D="$TMP/default.yaml"
render svc-a "$CHART_DIR" -n ns --set image.tag=20261001.0000@sha256:abc >"$D" || { cat "$TMP/err"; exit 1; }
kit_assert_in_container "$D" pi-web chart || rc=1

echo "== serverUrl is runtime data"
kit_assert_runtime_server_url "$CHART_DIR" -n ns || rc=1

echo "== pod shape and resources: as in 0.1.2 (no sidecar, no split)"
check "containers (exactly pi-web + auth-proxy)" "$(dep "$D" | yq -o json -I0 '[.spec.template.spec.containers[].name]')" '["pi-web","auth-proxy"]'
check "init containers (exactly authproxy-init)" "$(dep "$D" | yq -o json -I0 '[.spec.template.spec.initContainers[].name]')" '["authproxy-init"]'
check "pi-web resources = full plan" "$(cont "$D" pi-web | yq -o json -I0 '.resources | sort_keys(..)')" "$FULL_PLAN"
check "pi-web V8 heap = full 3072" "$(envv "$D" NODE_OPTIONS)" "--max-old-space-size=3072"
check "auth-proxy resources unchanged" "$(cont "$D" auth-proxy | yq -o json -I0 '.resources.limits')" '{"cpu":"200m","ephemeral-storage":"256Mi","memory":"128Mi"}'
check "PID 1 tini → kit launcher → pi-web-start.sh" "$(cont "$D" pi-web | yq -o json -I0 '.command')" "$LAUNCH"
check "fsGroupChangePolicy OnRootMismatch (keeps 0600/0700 under ~/.omnigent)" "$(dep "$D" | yq '.spec.template.spec.securityContext.fsGroupChangePolicy')" OnRootMismatch
g=$(dep "$D" | yq '.spec.template.spec.terminationGracePeriodSeconds')
[ "$g" -ge 35 ] 2>/dev/null && ok "terminationGracePeriodSeconds $g >= 20 s launcher + pi-web stop" || fail "terminationGracePeriodSeconds '$g' too short for host (15 s) + launcher margin + pi-web"
dep "$D" | yq '.spec.template.metadata.annotations["checksum/omnigent-host"]' | grep -qE '^[0-9a-f]{64}$' \
  && ok "pod restarts when the kit changes (checksum)" || fail "checksum/omnigent-host annotation missing"

echo "== pi-agent parameters (migration of the by-hand host)"
check "OG_HOME = pi-web's HOME on the volume" "$(envv "$D" OG_HOME)" /data/pi-agent/home
for k in OG_CONFIG_HOME OMNIGENT_CONFIG_HOME OG_DATA_DIR OMNIGENT_DATA_DIR; do
  check "$k = ~/.omnigent on the volume (by-hand identity + login)" "$(envv "$D" "$k")" /data/pi-agent/home/.omnigent
done
check "workspace defaults to pi-web's HOME" "$(envv "$D" OG_WORKSPACE)" /data/pi-agent/home
check "provider seeded: pi-original only" "$(envv "$D" OG_PROVIDERS)" pi-original
check "OG_BIN = the image's pinned CLI (paas-odoo-ci pi-agent/ installs it at /usr/local/bin/omnigent)" "$(envv "$D" OG_BIN)" /usr/local/bin/omnigent
check "PI_CODING_AGENT_DIR on the container (supervisor starts before pi-agent-env.sh)" "$(envv "$D" PI_CODING_AGENT_DIR)" /data/pi-agent
envv "$D" OG_PASSTHROUGH | tr ',' '\n' | grep -qx PI_CODING_AGENT_DIR \
  && ok "PI_CODING_AGENT_DIR passed through to sessions" || fail "PI_CODING_AGENT_DIR must be in OG_PASSTHROUGH"
check "host name default" "$(envv "$D" OG_HOST_NAME)" "pi-agent · svc-a"
yq '.. | select(has("name")) | .name' "$D" 2>/dev/null | grep -qE '^OMNIGENT_HOST_(ID|NAME)$' \
  && fail "identity must never come from env (OMNIGENT_HOST_ID/NAME)" || ok "no OMNIGENT_HOST_ID/NAME env (identity stays in config.yaml)"
check "pi-web mounts the volume" "$(cont "$D" pi-web | yq '.volumeMounts[] | select(.name=="data") | .mountPath')" /data/pi-agent
yq 'select(.kind != "ConfigMap" or (.metadata.name|test("omnigent-host$")|not))' "$D" | grep -qiE 'refresh_token|access_token|BEGIN .*PRIVATE' \
  && fail "chart must not carry Omnigent tokens" || ok "no Omnigent credential in the chart"
check "entrance untouched (auth-proxy :8080)" "$(yq -N 'select(.kind=="Service") | .spec.ports[0].targetPort' "$D")" 8080

echo "== OOM wording stays as conservative as the kit README (\"OOM\": best effort)"
grep -rniE 'never (be )?the one|is never (killed|the one)|never goes' "$CHART_DIR/values.yaml" "$CHART_DIR/Chart.yaml" "$CHART_DIR/templates/NOTES.txt" \
  && fail "values/Chart/NOTES must not promise that pi-web is never the one that goes (kit README, OOM)" || ok "no 'pi-web is never killed' promise"
grep -qi 'best effort\|best-effort' "$CHART_DIR/values.yaml" && ok "values.yaml calls the memory guard best effort" || fail "values.yaml must call the memory guard best effort"

echo "== platform template values (cloud_app_pi_agent helm_default_values) and prod release"
cat >"$TMP/tpl.json" <<'JSON'
{"image":{"repository":"jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent","tag":"20260924.0235@sha256:723122778daaed23fb9bdec3fbac5faa0cb5fe63fe258e757a5c14259528d3b2"},"piWeb":{"resources":{"requests":{"cpu":"500m","memory":"1Gi"},"limits":{"cpu":"2","memory":"4Gi"}}},"persistence":{"size":"20Gi"},"service":{"port":8080,"targetPort":8080},"authProxy": {"port": 8080, "basicAuthUsername": "admin"},"resources":{"requests":{"cpu":"2","memory":"4Gi"},"limits":{"cpu":"2","memory":"4Gi"}}}
JSON
P="$TMP/tpl.yaml"
render svc-20c1c915 "$CHART_DIR" -n ns -f "$TMP/tpl.json" >"$P" || { cat "$TMP/err"; exit 1; }
check "template values: pi-web keeps the whole plan" "$(cont "$P" pi-web | yq -o json -I0 '.resources | sort_keys(..)')" "$FULL_PLAN"
check "prod release name → stable host name" "$(envv "$P" OG_HOST_NAME)" "pi-agent · svc-20c1c915"

echo "== --reuse-values from 0.1.2 (values without omnigentHost)"
cp -r "$CHART_DIR" "$TMP/c"
yq -i 'del(.omnigentHost) | del(.networkPolicy.omnigentPort)' "$TMP/c/values.yaml"
R="$TMP/reuse.yaml"
render svc-a "$TMP/c" -n ns -f "$TMP/tpl.json" >"$R" || { cat "$TMP/err"; exit 1; }
kit_assert_in_container "$R" pi-web chart >/dev/null && ok "reuse: renders the in-container defaults (enabled)" || fail "reuse: kit contract broken without an omnigentHost block"
check "reuse: pi-web keeps the whole plan" "$(cont "$R" pi-web | yq -o json -I0 '.resources | sort_keys(..)')" "$FULL_PLAN"
render svc-a "$TMP/c" -n ns --set networkPolicy.allowAllEgress=false | yq 'select(.kind=="NetworkPolicy") | .spec.egress[].ports[]?.port' | grep -qx 8000 \
  && ok "reuse: netpol defaults the omnigent port" || fail "netpol must default the omnigent port"

echo "== disabled"
O="$TMP/off.yaml"
render svc-a "$CHART_DIR" -n ns --set omnigentHost.enabled=false >"$O" || { cat "$TMP/err"; exit 1; }
kit_assert_disabled "$O" pi-web || rc=1
check "off: pi-web-start.sh directly under tini" "$(cont "$O" pi-web | yq -o json -I0 '.command')" "$PLAIN"
check "off: telemetry stays off" "$(envv "$O" OMNIGENT_ANALYTICS),$(envv "$O" DO_NOT_TRACK),$(envv "$O" DISABLE_TELEMETRY)" "0,1,1"
check "off: same pod shape and plan" "$(dep "$O" | yq -o json -I0 '[.spec.template.spec.containers[].name]') $(cont "$O" pi-web | yq -o json -I0 '.resources | sort_keys(..)')" "[\"pi-web\",\"auth-proxy\"] $FULL_PLAN"

echo "== overrides and guards"
V="$TMP/over.yaml"
render svc-a "$CHART_DIR" -n ns --set-string 'omnigentHost.hostName=ws1234 行政助理' --set omnigentHost.watchSeconds=60 \
  --set-string omnigentHost.workspace=/data/pi-agent/home/projects >"$V" || { cat "$TMP/err"; exit 1; }
check "hostName override (unicode)" "$(envv "$V" OG_HOST_NAME)" "ws1234 行政助理"
check "watchSeconds wired" "$(envv "$V" OG_WATCH_SECONDS)" 60
check "workspace override" "$(envv "$V" OG_WORKSPACE)" /data/pi-agent/home/projects
check "two releases, two names" "$(render svc-b "$CHART_DIR" -n ns | yq 'select(.kind=="Deployment") | .spec.template.spec.containers[] | select(.name=="pi-web") | .env[] | select(.name=="OG_HOST_NAME") | .value')" "pi-agent · svc-b"
for bad in 0 29 -5 abc; do
  render svc-a "$CHART_DIR" -n ns --set-string "omnigentHost.watchSeconds=$bad" >/dev/null && fail "watchSeconds=$bad must be rejected" || ok "watchSeconds=$bad rejected"
done
for bad in 'ftp://x' 'http://' 'svc:8000' 'http://u:p@h' 'http://h/?q=1'; do
  render svc-a "$CHART_DIR" -n ns --set-string "omnigentHost.serverUrl=$bad" >/dev/null && fail "serverUrl '$bad' must be rejected" || ok "serverUrl '$bad' rejected"
done
render svc-a "$CHART_DIR" -n ns --set-string 'omnigentHost.hostName=a"b' >/dev/null && fail "hostName with a quote must be rejected" || ok "hostName with a quote rejected"
render svc-a "$CHART_DIR" -n ns --set-string 'omnigentHost.workspace=relative/dir' >/dev/null && fail "relative workspace must be rejected" || ok "relative workspace rejected"

if [ "$rc" -eq 0 ]; then
  echo "PASS (omnigent-host-kit): kit vendored, host inside pi-web (tini → launcher → pi-web-start.sh), serverUrl runtime-only, pod shape + full plan as 0.1.2, ~/.omnigent migration, pi login passthrough, guards, off."
else
  echo "FAIL (omnigent-host-kit)"
fi
exit "$rc"
