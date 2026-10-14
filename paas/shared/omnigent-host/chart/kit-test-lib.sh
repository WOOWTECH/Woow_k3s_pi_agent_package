# shellcheck shell=bash
# Chart-test helpers for charts that vendor the shared omnigent-host kit
# (in-container mode: the host runs inside the main container).
#
# Source from charts/<chart>/tests/test-omnigent-host-kit.sh (see README.md):
#
#   . "$(cd "$(dirname "$0")/../../.." && pwd)/shared/omnigent-host/chart/kit-test-lib.sh"
#   kit_assert_vendored "$CHART_DIR"                         # byte-identity (sha256)
#   kit_assert_in_container "$RENDERED" <main> [image]       # env/mount/launch contract
#   kit_assert_runtime_server_url "$CHART_DIR" [helm args]   # serverUrl never restarts the pod
#   kit_assert_disabled "$RENDERED_DISABLED" <main>          # enabled=false leaves no trace
#
# The rendered-manifest helpers look at ONE workload: the Deployment/StatefulSet
# whose containers include <main>, else the first one. (A chart may render
# several, e.g. open-design's console Deployment sorts before its daemon.)
#
# Each helper prints "ok"/"FAIL" lines and returns non-zero on failure. Needs
# bash, sha256sum, helm and yq (mikefarah v4).

KIT_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KIT_DIR=$(dirname "$KIT_LIB_DIR")
KIT_RUNTIME_FILES=(supervisor.sh og_helper.py omnigent-host-status omnigent-host-launch omnigent-host-profile.sh omnigent-shim)

_kit_ok() { printf '  ok   %s\n' "$*"; }
_kit_fail() { printf '  FAIL %s\n' "$*"; }
_kit_sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
# First non-empty result of a yq expression over a (single-workload) file.
_kit_yq() { yq "$1" "$2" 2>/dev/null | grep -v -e '^---$' -e '^$' | head -n 1; }

# _kit_workload <rendered.yaml> [main container] -> path of a temp file holding
# exactly one workload document (see above), so that expressions like
# `[...] | length` are evaluated once and never answered by an unrelated
# document. Empty file = none.
_kit_workload() {
  local file=$1 main=${2:-} out wl='(.kind == "Deployment" or .kind == "StatefulSet")'
  out=$(mktemp)
  if [ -n "$main" ]; then
    yq "select($wl and ([.spec.template.spec.containers[].name] | contains([\"$main\"])))" "$file" 2>/dev/null |
      yq 'select(document_index == 0)' - >"$out" 2>/dev/null
  fi
  grep -q '[^-[:space:]]' "$out" || yq "select($wl)" "$file" 2>/dev/null | yq 'select(document_index == 0)' - >"$out" 2>/dev/null
  printf '%s' "$out"
}

# kit_assert_vendored <chart_dir>
# The chart's vendored kit must be byte-identical (sha256) to the canonical
# shared/omnigent-host copy, and KIT.sha256 must list the canonical hashes.
kit_assert_vendored() {
  local chart=$1 rc=0 f want got
  local pairs=("chart/_omnigent-host.tpl:templates/_omnigent-host.tpl")
  for f in "${KIT_RUNTIME_FILES[@]}"; do pairs+=("$f:files/omnigent-host/$f"); done
  for f in "${pairs[@]}"; do
    want=$(_kit_sha "$KIT_DIR/${f%%:*}")
    got=$(_kit_sha "$chart/${f#*:}")
    if [ -n "$want" ] && [ "$want" = "$got" ]; then
      _kit_ok "vendored ${f#*:} == shared/omnigent-host/${f%%:*} (sha256 ${want:0:12})"
    else
      _kit_fail "vendored ${f#*:} differs from shared/omnigent-host/${f%%:*}; run scripts/sync-omnigent-host-kit.sh $(basename "$chart")"
      rc=1
    fi
  done
  if diff -q <(cd "$KIT_DIR" && sha256sum "${KIT_RUNTIME_FILES[@]}" chart/_omnigent-host.tpl) \
    "$chart/files/omnigent-host/KIT.sha256" >/dev/null 2>&1; then
    _kit_ok "files/omnigent-host/KIT.sha256 matches the canonical kit"
  else
    _kit_fail "files/omnigent-host/KIT.sha256 is stale; run scripts/sync-omnigent-host-kit.sh $(basename "$chart")"
    rc=1
  fi
  return $rc
}

# kit_assert_in_container <rendered.yaml> <main container> [chart|image]
# The in-container contract on the workload carrying <main>:
#   * no omnigent-host (side)container, no init container of the kit;
#   * main env: telemetry off, OG_HOST_ENABLED=1, OG_KIT_DIR, OG_SERVER_URL_FILE,
#     OG_CONFIG_HOME = OMNIGENT_CONFIG_HOME, OG_DATA_DIR = OMNIGENT_DATA_DIR,
#     OG_STATUS_FILE, OG_HOST_NAME, OG_WORKSPACE, OG_WATCH_SECONDS >= 30,
#     OG_BIN an absolute path (the image's pinned CLI, never a PATH lookup);
#   * NO OG_SERVER_URL env in any container (the URL is runtime data);
#   * kit ConfigMap mounted read-only at OG_KIT_DIR with bin/omnigent and
#     bin/omni (both the guard), bin/omnigent-host-status, supervisor.sh and
#     omnigent-host-launch;
#     runtime ConfigMap mounted read-only (not subPath) at OG_SERVER_URL_FILE's dir;
#   * launch: "chart" (default) = the main command runs
#     <OG_KIT_DIR>/omnigent-host-launch; "image" = the image's ENTRYPOINT
#     (image/omnigent-host-entry) does it, so no command override is required.
kit_assert_in_container() {
  local file main=$2 mode=${3:-chart} rc=0 m v kitdir urlf rtdir kitvol rtvol cmd
  file=$(_kit_workload "$1" "$main")
  m=".spec.template.spec.containers[] | select(.name == \"$main\")"
  _t() { if [ "$2" = "$3" ]; then _kit_ok "$1"; else _kit_fail "$1 (got '$2', want '$3')"; rc=1; fi; }
  _e() { _kit_yq "$m | .env[] | select(.name == \"$1\") | .value" "$file"; }
  _t "main container $main present" "$(_kit_yq "$m | .name" "$file")" "$main"
  _t "no omnigent-host sidecar or init container" \
    "$(_kit_yq '[(.spec.template.spec.containers // [])[], (.spec.template.spec.initContainers // [])[]] | map(select(.name | test("omnigent"))) | length' "$file")" 0
  _t "OG_HOST_ENABLED=1" "$(_e OG_HOST_ENABLED)" 1
  for v in OMNIGENT_ANALYTICS=0 DO_NOT_TRACK=1 DISABLE_TELEMETRY=1; do
    _t "telemetry off: ${v%%=*}" "$(_e "${v%%=*}")" "${v#*=}"
  done
  for v in OG_CONFIG_HOME OG_DATA_DIR OG_STATUS_FILE OG_HOST_NAME OG_WORKSPACE OG_KIT_DIR OG_SERVER_URL_FILE; do
    if [ -n "$(_e "$v")" ]; then _kit_ok "env $v set"; else _kit_fail "env $v missing"; rc=1; fi
  done
  _t "OMNIGENT_CONFIG_HOME = OG_CONFIG_HOME (the tenant's omnigent login writes there)" "$(_e OMNIGENT_CONFIG_HOME)" "$(_e OG_CONFIG_HOME)"
  _t "OMNIGENT_DATA_DIR = OG_DATA_DIR" "$(_e OMNIGENT_DATA_DIR)" "$(_e OG_DATA_DIR)"
  case $(_e OG_BIN) in
    /*) _kit_ok "OG_BIN is an absolute path ($(_e OG_BIN)): the image's pinned CLI" ;;
    *) _kit_fail "OG_BIN '$(_e OG_BIN)' is not an absolute path (the launcher would look omnigent up on PATH)"; rc=1 ;;
  esac
  v=$(_e OG_WATCH_SECONDS)
  if [ -n "$v" ] && [ "$v" -ge 30 ] 2>/dev/null; then _kit_ok "OG_WATCH_SECONDS $v >= 30"; else _kit_fail "OG_WATCH_SECONDS '$v' < 30"; rc=1; fi
  _t "no OG_SERVER_URL env in the pod template (serverUrl is runtime data)" \
    "$(_kit_yq '[.spec.template.spec.containers[].env[]? | select(.name == "OG_SERVER_URL")] | length' "$file")" 0
  kitdir=$(_e OG_KIT_DIR)
  urlf=$(_e OG_SERVER_URL_FILE)
  rtdir=${urlf%/*}
  kitvol=$(_kit_yq "$m | .volumeMounts[] | select(.mountPath == \"$kitdir\") | .name" "$file")
  _t "kit mounted read-only at $kitdir" "$(_kit_yq "$m | .volumeMounts[] | select(.mountPath == \"$kitdir\") | .readOnly" "$file")" true
  for v in supervisor.sh omnigent-host-launch bin/omnigent bin/omni bin/omnigent-host-status; do
    _t "kit volume projects $v" "$(_kit_yq ".spec.template.spec.volumes[] | select(.name == \"$kitvol\") | .configMap.items[] | select(.path == \"$v\") | .path" "$file")" "$v"
  done
  for v in bin/omnigent bin/omni; do
    _t "kit $v is the guard (omnigent-shim)" "$(_kit_yq ".spec.template.spec.volumes[] | select(.name == \"$kitvol\") | .configMap.items[] | select(.path == \"$v\") | .key" "$file")" omnigent-shim
  done
  rtvol=$(_kit_yq "$m | .volumeMounts[] | select(.mountPath == \"$rtdir\") | .name" "$file")
  _t "runtime ConfigMap mounted read-only at $rtdir" "$(_kit_yq "$m | .volumeMounts[] | select(.mountPath == \"$rtdir\") | .readOnly" "$file")" true
  _t "runtime mount is not a subPath (ConfigMap updates must reach the file)" "$(_kit_yq "$m | .volumeMounts[] | select(.mountPath == \"$rtdir\") | (.subPath // \"\")" "$file")" ""
  if [ -n "$rtvol" ] && [ -n "$(_kit_yq ".spec.template.spec.volumes[] | select(.name == \"$rtvol\") | .configMap.name" "$file")" ]; then
    _kit_ok "runtime volume is a ConfigMap"
  else
    _kit_fail "runtime volume '$rtvol' is not a ConfigMap"; rc=1
  fi
  if [ "$mode" = chart ]; then
    cmd=$(_kit_yq "$m | (.command // []) + (.args // []) | join(\" \")" "$file")
    case " $cmd " in
      *" $kitdir/omnigent-host-launch "*) _kit_ok "product started through $kitdir/omnigent-host-launch" ;;
      *) _kit_fail "main command does not run $kitdir/omnigent-host-launch (got '$cmd')"; rc=1 ;;
    esac
  else
    _kit_ok "launch via the image ENTRYPOINT (omnigent-host-entry) — asserted by the image test"
  fi
  rm -f "$file"
  return $rc
}

# kit_assert_disabled <rendered.yaml> <main container>
# omnigentHost.enabled=false: no OG_* env, no kit volumes/mounts/ConfigMaps, no
# launcher in the command (telemetry env may stay).
kit_assert_disabled() {
  local file main=$2 rc=0 m
  file=$(_kit_workload "$1" "$main")
  m=".spec.template.spec.containers[] | select(.name == \"$main\")"
  _t() { if [ "$2" = "$3" ]; then _kit_ok "$1"; else _kit_fail "$1 (got '$2', want '$3')"; rc=1; fi; }
  _t "disabled: no OG_* env" "$(_kit_yq "[$m | .env[]? | select(.name | test(\"^OG_\"))] | length" "$file")" 0
  _t "disabled: no omnigent-host volumes" "$(_kit_yq '[.spec.template.spec.volumes[]? | select(.name | test("omnigent-host"))] | length' "$file")" 0
  _t "disabled: no launcher in the command" "$(_kit_yq "[$m | (.command // []) + (.args // []) | .[] | select(test(\"omnigent-host-launch\"))] | length" "$file")" 0
  _t "disabled: no omnigent-host ConfigMap" "$(yq 'select(.kind == "ConfigMap" and (.metadata.name | test("omnigent-host"))) | .metadata.name' "$1" 2>/dev/null | grep -cv -e '^---$' -e '^$')" 0
  rm -f "$file"
  return $rc
}

# kit_assert_runtime_server_url <chart_dir> [extra helm args...]
# Renders the chart with two different omnigentHost.serverUrl values: every
# Deployment/StatefulSet must be byte-identical (no restart when the platform
# injects or changes the URL), and the runtime ConfigMap must carry each URL
# under server-url.
kit_assert_runtime_server_url() {
  local chart=$1 rc=0 a b
  shift
  a=$(mktemp); b=$(mktemp)
  helm template t "$chart" "$@" --set omnigentHost.serverUrl=http://svc-a-omnigent.ns-a.svc.cluster.local:8000 >"$a" 2>&1
  helm template t "$chart" "$@" --set omnigentHost.serverUrl=https://omnigent-b.example.com/ >"$b" 2>&1
  local wl='select(.kind == "Deployment" or .kind == "StatefulSet")'
  if [ -n "$(yq "$wl" "$a" 2>/dev/null | grep -v -e '^---$' -e '^$')" ] && cmp -s <(yq "$wl" "$a") <(yq "$wl" "$b"); then
    _kit_ok "workloads identical for two serverUrls (setting serverUrl never restarts the pod)"
  else
    _kit_fail "a workload changes with serverUrl (pod restart on URL injection):"
    diff <(yq "$wl" "$a") <(yq "$wl" "$b") | head -n 20 | sed 's/^/        /'
    rc=1
  fi
  local sel='select(.kind == "ConfigMap" and .data["server-url"] != null) | .data["server-url"]'
  if [ "$(_kit_yq "$sel" "$a")" = http://svc-a-omnigent.ns-a.svc.cluster.local:8000 ] &&
    [ "$(_kit_yq "$sel" "$b")" = https://omnigent-b.example.com ]; then
    _kit_ok "runtime ConfigMap server-url carries the URL (trailing slash trimmed)"
  else
    _kit_fail "runtime ConfigMap server-url missing or wrong ('$(_kit_yq "$sel" "$a")' / '$(_kit_yq "$sel" "$b")')"
    rc=1
  fi
  rm -f "$a" "$b"
  return $rc
}
