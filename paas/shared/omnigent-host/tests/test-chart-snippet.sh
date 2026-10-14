#!/usr/bin/env bash
# Chart-side tests for the shared omnigent-host kit (in-container mode):
# renders tests/fixture-chart (which wires the kit exactly like a real chart)
# after vendoring the kit into a scratch copy with
# scripts/sync-omnigent-host-kit.sh, then checks the env/mount/launch contract,
# that serverUrl is runtime data (no pod-template change), the values
# contract/validation, the byte-identity check, and that every kit-test-lib
# assertion FAILS on a manifest that violates it.
#
#   bash shared/omnigent-host/tests/test-chart-snippet.sh      (needs helm, yq, python3+PyYAML)
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
KIT=$(dirname "$HERE")
ROOT=$(cd "$KIT/../.." && pwd)
for dep in helm yq python3 sha256sum; do
  command -v "$dep" >/dev/null 2>&1 || { echo "FAIL: $dep is required"; exit 1; }
done
# shellcheck disable=SC1091 # path resolved at run time
. "$KIT/chart/kit-test-lib.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$*"; }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
quiet() { "$@" >/dev/null 2>&1; }
not() { ! "$@"; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/og-kit-chart.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
CH=$WORK/kit-fixture
cp -r "$HERE/fixture-chart" "$CH"

echo "- sync script"
check "sync --dest vendors the kit" quiet bash "$ROOT/scripts/sync-omnigent-host-kit.sh" --dest "$CH"
check "sync --check passes right after a sync" quiet bash "$ROOT/scripts/sync-omnigent-host-kit.sh" --check --dest "$CH"
check "kit_assert_vendored passes" quiet kit_assert_vendored "$CH"
for f in omnigent-host-launch omnigent-host-profile.sh omnigent-shim; do
  check "sync vendors $f" cmp -s "$KIT/$f" "$CH/files/omnigent-host/$f"
done

render() { helm template rel "$CH" "$@" 2>&1; }
R=$WORK/default.yaml
render >"$R" || { cat "$R"; bad "default render failed"; }
main='select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "app")'
envv() { yq "$1 | .env[] | select(.name == \"$2\") | .value" "${3:-$R}" | head -n 1; }

echo "- default render: in-container contract"
check "kit_assert_in_container passes" quiet kit_assert_in_container "$R" app
check "kit_assert_runtime_server_url passes" quiet kit_assert_runtime_server_url "$CH"
check "exactly one container (no sidecar)" test "$(yq 'select(.kind == "Deployment") | .spec.template.spec.containers | length' "$R")" = 1
check "plan limits stay on the main container (no budget split)" test "$(yq "$main | .resources.limits.memory" "$R")/$(yq "$main | .resources.limits.cpu" "$R")" = 4Gi/2
check "command = init + launcher + product" test "$(yq "$main | .command | join(\" \")" "$R")" = "dumb-init /bin/sh /etc/omnigent-host/omnigent-host-launch -- /usr/bin/app --port 8080"
check "default host name '<chart> · <release>'" test "$(envv "$main" OG_HOST_NAME)" = "kit-fixture · rel"
check "default workspace from the chart" test "$(envv "$main" OG_WORKSPACE)" = /workspace
check "default watchSeconds 120" test "$(envv "$main" OG_WATCH_SECONDS)" = 120
check "OG_PROVIDERS from the chart" test "$(envv "$main" OG_PROVIDERS)" = claude-subscription,pi-original
check "OG_PASSTHROUGH from the chart" test "$(envv "$main" OG_PASSTHROUGH)" = PI_CODING_AGENT_DIR
check "OG_UNSET_ENV lists the product's password" test "$(envv "$main" OG_UNSET_ENV)" = PASSWORD,ANTHROPIC_API_KEY
check "OG_HOME from the chart" test "$(envv "$main" OG_HOME)" = /data/app/home
check "OG_DATA_DIR defaults to configHome" test "$(envv "$main" OG_DATA_DIR)" = /data/app/omnigent
check "status file on the data volume" test "$(envv "$main" OG_STATUS_FILE)" = /data/app/omnigent/omnigent-host/status.json
check "OG_SERVER_URL_FILE in the runtime dir" test "$(envv "$main" OG_SERVER_URL_FILE)" = /etc/omnigent-host-runtime/server-url
check "OG_BIN = the image's pinned CLI (default /usr/local/bin/omnigent)" test "$(envv "$main" OG_BIN)" = /usr/local/bin/omnigent
check "bin/omni is the guard too, executable" test "$(yq 'select(.kind == "Deployment") | .spec.template.spec.volumes[] | select(.name == "omnigent-host-kit") | .configMap.items[] | select(.path == "bin/omni") | [.key, .mode] | join(",")' "$R" | grep -v -e '^---$' -e '^$')" = omnigent-shim,365
check "status printer also at /usr/local/bin" test "$(yq "$main | .volumeMounts[] | select(.subPath == \"omnigent-host-status\") | .mountPath" "$R")" = /usr/local/bin/omnigent-host-status
check "pod checksum annotation for the kit" test -n "$(yq 'select(.kind == "Deployment") | .spec.template.metadata.annotations["checksum/omnigent-host"]' "$R")"
check "scripts projected executable (0555), data files 0444" test "$(yq 'select(.kind == "Deployment") | .spec.template.spec.volumes[] | select(.name == "omnigent-host-kit") | [.configMap.defaultMode, (.configMap.items[] | select(.path == "bin/omnigent") | .mode)] | join(",")' "$R" | grep -v -e '^---$' -e '^$')" = 292,365
check "runtime ConfigMap server-url empty by default" test "$(yq 'select(.kind == "ConfigMap" and .metadata.name == "rel-omnigent-host-runtime") | .data["server-url"]' "$R")" = ""
check "kit ConfigMap carries the kit byte-for-byte" python3 - "$R" "$KIT" <<'PY'
import sys, yaml
docs = [d for d in yaml.safe_load_all(open(sys.argv[1])) if d and d.get("metadata", {}).get("name") == "rel-omnigent-host"]
data = docs[0]["data"]
for f in ("supervisor.sh", "og_helper.py", "omnigent-host-status", "omnigent-host-launch", "omnigent-host-profile.sh", "omnigent-shim"):
    if data[f] != open(f"{sys.argv[2]}/{f}").read():
        sys.exit(f"{f} differs")
PY
check "kit checksum changes when the kit changes" bash -c "
  a=\$(yq 'select(.kind == \"Deployment\") | .spec.template.metadata.annotations[\"checksum/omnigent-host\"]' '$R')
  cp -r '$CH' '$WORK/edited'; printf '\n# edit\n' >>'$WORK/edited/files/omnigent-host/supervisor.sh'
  b=\$(helm template rel '$WORK/edited' | yq 'select(.kind == \"Deployment\") | .spec.template.metadata.annotations[\"checksum/omnigent-host\"]')
  [ -n \"\$a\" ] && [ \"\$a\" != \"\$b\" ]"

echo "- kit-test-lib assertions fail on broken manifests"
# Another workload rendered BEFORE the one with the main container (open-design:
# its console Deployment sorts first) must not be the one inspected.
{ printf 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: aaa-console\nspec:\n  template:\n    spec:\n      containers:\n        - name: console\n          image: x\n          env: [{name: OG_SERVER_URL, value: "http://x"}]\n---\n'; cat "$R"; } >"$WORK/two.yaml"
check "two workloads: kit_assert_in_container inspects the main container's workload" quiet kit_assert_in_container "$WORK/two.yaml" app
yq '(select(.kind == "Deployment") | .spec.template.spec.containers) += [{"name": "omnigent-host", "image": "x"}]' "$R" >"$WORK/sidecar.yaml"
check "FAILS with an omnigent-host sidecar" not quiet kit_assert_in_container "$WORK/sidecar.yaml" app
yq '(select(.kind == "Deployment") | .spec.template.spec.containers[0].env) += [{"name": "OG_SERVER_URL", "value": "http://x"}]' "$R" >"$WORK/urlenv.yaml"
check "FAILS with OG_SERVER_URL in the pod template" not quiet kit_assert_in_container "$WORK/urlenv.yaml" app
yq '(select(.kind == "Deployment") | .spec.template.spec.containers[0].env[] | select(.name == "DO_NOT_TRACK") | .value) = "0"' "$R" >"$WORK/tele.yaml"
check "FAILS with telemetry on" not quiet kit_assert_in_container "$WORK/tele.yaml" app
yq '(select(.kind == "Deployment") | .spec.template.spec.containers[0].env[] | select(.name == "OMNIGENT_CONFIG_HOME") | .value) = "/elsewhere"' "$R" >"$WORK/cfgh.yaml"
check "FAILS when OMNIGENT_CONFIG_HOME != OG_CONFIG_HOME" not quiet kit_assert_in_container "$WORK/cfgh.yaml" app
yq '(select(.kind == "Deployment") | .spec.template.spec.containers[0].volumeMounts[] | select(.mountPath == "/etc/omnigent-host-runtime") | .subPath) = "server-url"' "$R" >"$WORK/subpath.yaml"
check "FAILS when the runtime ConfigMap is a subPath mount" not quiet kit_assert_in_container "$WORK/subpath.yaml" app
yq '(select(.kind == "Deployment") | .spec.template.spec.containers[0].command) = ["dumb-init", "/usr/bin/app"]' "$R" >"$WORK/nolaunch.yaml"
check "FAILS without the launcher (chart mode)" not quiet kit_assert_in_container "$WORK/nolaunch.yaml" app
check "image mode accepts a chart without a command override" quiet kit_assert_in_container "$WORK/nolaunch.yaml" app image
yq '(select(.kind == "Deployment") | .spec.template.spec.volumes[] | select(.name == "omnigent-host-kit") | .configMap.items) |= map(select(.path != "bin/omnigent"))' "$R" >"$WORK/noshim.yaml"
check "FAILS without the bin/omnigent guard" not quiet kit_assert_in_container "$WORK/noshim.yaml" app
yq '(select(.kind == "Deployment") | .spec.template.spec.volumes[] | select(.name == "omnigent-host-kit") | .configMap.items) |= map(select(.path != "bin/omni"))' "$R" >"$WORK/noomni.yaml"
check "FAILS without the bin/omni guard (the CLI's second entry point)" not quiet kit_assert_in_container "$WORK/noomni.yaml" app
yq '(select(.kind == "Deployment") | .spec.template.spec.containers[0].env) |= map(select(.name != "OG_BIN"))' "$R" >"$WORK/nobin.yaml"
check "FAILS without OG_BIN (the launcher would look omnigent up on PATH)" not quiet kit_assert_in_container "$WORK/nobin.yaml" app
yq '(select(.kind == "Deployment") | .spec.template.spec.containers[0].env[] | select(.name == "OG_BIN") | .value) = "omnigent"' "$R" >"$WORK/relbin.yaml"
check "FAILS with a bare-name OG_BIN" not quiet kit_assert_in_container "$WORK/relbin.yaml" app
# serverUrl leaking into the pod template must be caught by the runtime check.
cp -r "$CH" "$WORK/leak"
sed -i 's|^      annotations:$|      annotations:\n        x-url: {{ .Values.omnigentHost.serverUrl \| quote }}|' "$WORK/leak/templates/deployment.yaml"
check "(leak fixture really puts the URL into the pod template)" grep -q 'x-url:' "$WORK/leak/templates/deployment.yaml"
check "kit_assert_runtime_server_url FAILS when serverUrl reaches the pod template" not quiet kit_assert_runtime_server_url "$WORK/leak"
cp -r "$CH" "$WORK/cksum"
sed -i 's|include "woow.omnigentHost.checksum" (dict "root" . "name" $kitCM)|include "woow.omnigentHost.configMaps" (dict "root" . "name" $kitCM) \| sha256sum|' "$WORK/cksum/templates/deployment.yaml"
check "kit_assert_runtime_server_url FAILS when the checksum covers the runtime ConfigMap" not quiet kit_assert_runtime_server_url "$WORK/cksum"

echo "- values contract"
R2=$WORK/disabled.yaml
render --set omnigentHost.enabled=false >"$R2"
check "kit_assert_disabled passes for enabled=false" quiet kit_assert_disabled "$R2" app
check "kit_assert_disabled FAILS for the enabled render" not quiet kit_assert_disabled "$R" app
check "enabled=false: product command unchanged (no launcher)" test "$(yq "$main | .command | join(\" \")" "$R2")" = "dumb-init /usr/bin/app --port 8080"
check "enabled=false: telemetry still off" test "$(envv "$main" DO_NOT_TRACK "$R2")" = 1
check "enabled=false: no checksum annotation" test "$(yq 'select(.kind == "Deployment") | .spec.template.metadata.annotations // {} | length' "$R2")" = 0
cp -r "$CH" "$WORK/noblock"
yq -i 'del(.omnigentHost)' "$WORK/noblock/values.yaml"
R3=$WORK/noblock.yaml
helm template rel "$WORK/noblock" >"$R3" 2>&1
check "no omnigentHost block (--reuse-values from an old chart): renders, host on" quiet kit_assert_in_container "$R3" app
check "no block: watchSeconds default 120" test "$(envv "$main" OG_WATCH_SECONDS "$R3")" = 120
R4=$WORK/custom.yaml
render --set omnigentHost.serverUrl=http://svc-1-omnigent.ns.svc.cluster.local:8000/ \
  --set-string omnigentHost.hostName="ws1234 code-server" --set omnigentHost.workspace=/data/w \
  --set omnigentHost.watchSeconds=30 >"$R4"
check "serverUrl only in the runtime ConfigMap (trailing slash trimmed)" test "$(yq 'select(.kind == "ConfigMap" and .metadata.name == "rel-omnigent-host-runtime") | .data["server-url"]' "$R4")" = http://svc-1-omnigent.ns.svc.cluster.local:8000
check "serverUrl nowhere in the Deployment" bash -c "! yq 'select(.kind == \"Deployment\")' '$R4' | grep -q svc-1-omnigent"
check "custom host name" test "$(envv "$main" OG_HOST_NAME "$R4")" = "ws1234 code-server"
check "custom workspace" test "$(envv "$main" OG_WORKSPACE "$R4")" = /data/w
check "watchSeconds 30 accepted" test "$(envv "$main" OG_WATCH_SECONDS "$R4")" = 30
check "watchSeconds 29 rejected" not quiet render --set omnigentHost.watchSeconds=29
check "watchSeconds 0 rejected" not quiet render --set omnigentHost.watchSeconds=0
check "watchSeconds non-integer rejected" not quiet render --set-string omnigentHost.watchSeconds=abc
check "serverUrl ftp:// rejected" not quiet render --set omnigentHost.serverUrl=ftp://x
check "serverUrl with userinfo rejected" not quiet render --set omnigentHost.serverUrl=http://u:p@x
check "serverUrl with query rejected" not quiet render --set "omnigentHost.serverUrl=http://x/?a=b"
check "serverUrl with a quote rejected" not quiet render --set-string "omnigentHost.serverUrl=http://x/a'b"
check "hostName with a quote rejected" not quiet render --set-string 'omnigentHost.hostName=a"b'
check "hostName over 120 chars rejected" not quiet render --set-string "omnigentHost.hostName=$(printf 'x%.0s' $(seq 121))"
check "relative workspace rejected" not quiet render --set omnigentHost.workspace=work
check "workspace with .. rejected" not quiet render --set omnigentHost.workspace=/a/../b
check "custom ogBin rendered as OG_BIN" test "$(envv "$main" OG_BIN "$(render --set ogBin=/opt/omnigent/bin/omnigent >"$WORK/ogbin.yaml"; echo "$WORK/ogbin.yaml")")" = /opt/omnigent/bin/omnigent
check "relative ogBin rejected" not quiet render --set ogBin=omnigent
check "ogBin with .. rejected" not quiet render --set ogBin=/opt/../home/coder/.local/bin/omnigent
check "ogBin with a space rejected" not quiet render --set-string "ogBin=/opt/x y/omnigent"

echo "- drift detection"
printf '\n# local edit\n' >>"$CH/files/omnigent-host/omnigent-host-launch"
check "kit_assert_vendored FAILS on an edited vendored launcher" not quiet kit_assert_vendored "$CH"
check "sync --check FAILS on drift" not quiet bash "$ROOT/scripts/sync-omnigent-host-kit.sh" --check --dest "$CH"
bash "$ROOT/scripts/sync-omnigent-host-kit.sh" --dest "$CH" >/dev/null
check "sync repairs the drift" quiet kit_assert_vendored "$CH"
echo "stale" >"$CH/files/omnigent-host/KIT.sha256"
check "kit_assert_vendored FAILS on a stale KIT.sha256" not quiet kit_assert_vendored "$CH"

echo
echo "omnigent-host chart snippet: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
