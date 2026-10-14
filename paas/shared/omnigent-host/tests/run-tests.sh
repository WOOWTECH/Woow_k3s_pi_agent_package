#!/usr/bin/env bash
# Self-contained behaviour tests for the shared omnigent-host kit.
#
# Runs the REAL supervisor.sh / og_helper.py / omnigent-host-status against a fake
# `omnigent` CLI (tests/fake_omnigent) and a fake Omnigent server
# (tests/fake_server.py). Needs: bash, python3 with PyYAML, flock, setsid.
#
#   bash shared/omnigent-host/tests/run-tests.sh
#
# Shells the supervisor runs under: $OG_TEST_SHELLS (space separated, default
# "sh"). Set OG_TEST_BUSYBOX=/path/to/busybox to also run every scenario under
# busybox ash with busybox applets first on PATH (the Alpine/open-design case).
# OG_TEST_ONLY="t_launch t_shim" runs a subset; OG_TEST_KEEP=1 keeps the scratch dir.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
KIT=$(dirname "$HERE")
SUP=$KIT/supervisor.sh
HELPER=$KIT/og_helper.py
STATUS=$KIT/omnigent-host-status

pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$*"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$*"; }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
wait_for() { # <seconds> <cmd...>
  local end=$((SECONDS + $1)); shift
  while [ "$SECONDS" -lt "$end" ]; do "$@" && return 0; sleep 0.2; done
  "$@"
}

for dep in python3 flock setsid; do
  command -v "$dep" >/dev/null 2>&1 || { echo "FAIL: $dep is required"; exit 1; }
done
python3 -c 'import yaml' 2>/dev/null || { echo "FAIL: python3 needs PyYAML (pip install pyyaml)"; exit 1; }
# The scenarios run with a scratch HOME; keep PyYAML importable if it lives in a user site.
YAML_PATH=$(python3 -c 'import os, yaml; print(os.path.dirname(os.path.dirname(yaml.__file__)))')

WORK=$(mktemp -d "${TMPDIR:-/tmp}/og-kit-test.XXXXXX")
PIDS=()
kill_quiet() { kill -KILL "$1" 2>/dev/null; wait "$1" 2>/dev/null; }
# reap <pid>: collect the exit status of a process that should be gone; if it is
# still alive (a broken kit), kill it instead of hanging in `wait` (status 137).
reap() { if dead "$1"; then wait "$1" 2>/dev/null; else kill_quiet "$1"; return 137; fi; }
cleanup() {
  for p in "${PIDS[@]}"; do kill_quiet "$p"; done
  pkill -KILL -f "$WORK/" 2>/dev/null
  [ -n "${OG_TEST_KEEP:-}" ] || rm -rf "$WORK"
}
trap cleanup EXIT

# ── per-scenario environment ─────────────────────────────────────────────────
# new_env <name>: E=<dir>, starts a fake server, URL=http://127.0.0.1:<port>
new_env() {
  E=$WORK/$RUN_TAG-$1
  mkdir -p "$E/home" "$E/data" "$E/ws" "$E/bin" "$E/og" "$E/srv"
  ln -s "$HERE/fake_omnigent" "$E/bin/omnigent"
  printf '#!/bin/sh\necho "tmux %s"\n' "${2:-3.5a}" >"$E/bin/tmux"
  chmod +x "$E/bin/tmux" "$HERE/fake_omnigent"
  echo '{"mode": "run"}' >"$E/og/ctl.json"
  echo '{"me": 200, "token": 200}' >"$E/srv/ctl.json"
  : >"$E/srv/requests.log"
  python3 "$HERE/fake_server.py" "$E/srv/ctl.json" "$E/srv/port" "$E/srv/requests.log" &
  SRV_PID=$!
  PIDS+=("$SRV_PID")
  wait_for 5 test -s "$E/srv/port" || { bad "$1: fake server did not start"; return 1; }
  URL=http://127.0.0.1:$(cat "$E/srv/port")
  STATUS_FILE=$E/data/omnigent-host/status.json
}
srv_ctl() { echo "$1" >"$E/srv/ctl.json.tmp" && mv "$E/srv/ctl.json.tmp" "$E/srv/ctl.json"; }
og_ctl() { echo "$1" >"$E/og/ctl.json"; }

# login [expires_in_seconds] [user]: what `omnigent login` leaves behind
login() {
  python3 - "$E/data" "$URL" "${1:-3600}" "${2:-tester}" <<'PY'
import json, os, sys, time, yaml
d, url, exp, user = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
p = os.path.join(d, "auth_tokens.json")
data = {url: {"token": "SECRET-LOGIN-" + user, "user_id": user,
              "expires_at": time.time() + exp, "refresh_token": "SECRET-REFRESH-" + user}}
fd = os.open(p + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(data, f)
os.replace(p + ".tmp", p)
c = os.path.join(d, "config.yaml")
cfg = (yaml.safe_load(open(c)) or {}) if os.path.exists(c) else {}
cfg["server"] = url
open(c, "w").write(yaml.safe_dump(cfg))
PY
}
expire_token() {
  python3 - "$E/data/auth_tokens.json" <<'PY'
import json, sys, time
p = sys.argv[1]; d = json.load(open(p))
for e in d.values(): e["expires_at"] = time.time() - 10
json.dump(d, open(p, "w"))
PY
}

st() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$STATUS_FILE" "$1" 2>/dev/null; }
st_is() { [ "$(st state)" = "$1" ]; }
starts() { if [ -f "$E/og/starts.log" ]; then wc -l <"$E/og/starts.log" | tr -d ' '; else echo 0; fi; }
starts_is() { [ "$(starts)" = "$1" ]; }
starts_ge() { [ "$(starts)" -ge "$1" ]; }
st_field_is() { [ "$(st "$1")" = "$2" ]; }
detail_has() { case $(st detail) in *"$1"*) return 0 ;; esac; return 1; }
in_backoff() { [ -n "$(st retry_at)" ]; }
host_pid() { tail -n 1 "$E/og/starts.log" 2>/dev/null | sed -n 's/.*pid=//p'; }
alive() { kill -0 "$1" 2>/dev/null; }
dead() { ! kill -0 "$1" 2>/dev/null; }
cfg_get() { python3 -c 'import sys,yaml; c=yaml.safe_load(open(sys.argv[1])) or {}
v=c
for k in sys.argv[2].split("."):
    v = v.get(k) if isinstance(v, dict) else None
print("" if v is None else v)' "$E/data/config.yaml" "$1"; }

# start_sup [extra env assignments...]: SUP_PID, output in $E/stdout.log
start_sup() {
  local out=${SUP_OUT:-$E/stdout.log}
  # shellcheck disable=SC2086 # $SUP_SHELL may be two words ("busybox sh")
  env -i PATH="$E/bin:$TEST_PATH" HOME="$E/home" LANG=C.UTF-8 PYTHONPATH="$YAML_PATH" \
    OG_CONFIG_HOME="$E/data" OG_DATA_DIR="$E/data" \
    OG_SERVER_URL="$URL/" OG_HOST_NAME="test-chart · rel" OG_WORKSPACE="$E/ws" \
    OG_PROVIDERS="claude-subscription,pi-original" \
    OG_PASSTHROUGH="PI_CODING_AGENT_DIR, PI_AGENT_DATA_DIR,bad-name" \
    OG_UNSET_ENV="FAKE_SECRET_KEY" FAKE_SECRET_KEY=shh \
    OMNIGENT_HOST_ID=0123456789abcdef0123456789abcdef OMNIGENT_HOST_NAME=env-name \
    OG_IDLE_SECONDS=1 OG_TICK_SECONDS=1 OG_WATCH_SECONDS=2 OG_CONFIRM_SECONDS=1 \
    OG_REPROBE_SECONDS=2 OG_STOP_GRACE_SECONDS=2 OG_BACKOFF_78_MIN=1 OG_BACKOFF_78_MAX=4 \
    OG_HTTP_TIMEOUT=2 OG_LOCK_RETRY_SECONDS=1 OG_PRUNE_SECONDS=1 \
    FAKE_OG_DIR="$E/og" "$@" \
    $SUP_SHELL "$SUP" >>"$out" 2>&1 &
  SUP_PID=$!
  PIDS+=("$SUP_PID")
}
stop_sup() { kill -TERM "$1" 2>/dev/null; wait_for 8 dead "$1"; reap "$1"; }

# ── scenarios ────────────────────────────────────────────────────────────────
t_idle_login_start() {
  echo "- not logged in -> quiet idle; login -> host starts (identity, env, config)"
  new_env idle || return
  mkdir -p "$E/seed"; printf 'seeded brief\n' >"$E/seed/BRIEF.md"
  start_sup OG_WORKSPACE_SEED_DIR="$E/seed"
  check "status waiting-login while not logged in" wait_for 6 st_is waiting-login
  check "login command uses OG_SERVER_URL" test "$(st login_command)" = "omnigent login $URL"
  check "action carries the login command" test "$(st action)" = "omnigent login $URL"
  sleep 3
  check "no host started while not logged in" test "$(starts)" = 0
  check "no server traffic while idle (file test only)" test ! -s "$E/srv/requests.log"
  check "idle is quiet: one 'not logged in' log line" test "$(grep -c 'not logged in' "$E/stdout.log")" = 1
  check "status file has no secrets and is valid JSON" python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$STATUS_FILE"
  login
  chmod 660 "$E/data/auth_tokens.json"   # what a pod fsGroup does on every mount
  check "host starts after login" wait_for 10 starts_is 1
  check "status running once the host printed Connected" wait_for 6 st_is running
  check "status shows the host name" test "$(st host_name)" = "test-chart · rel"
  local envf=$E/og/env-1.txt
  check "argv: host --server <url> --non-interactive --no-open" grep -qx "argv=host --server $URL --non-interactive --no-open" "$envf"
  check "host cwd is OG_WORKSPACE" grep -qx "cwd=$E/ws" "$envf"
  check "OMNIGENT_HOST_ID env removed" grep -qx 'OMNIGENT_HOST_ID=<unset>' "$envf"
  check "OMNIGENT_HOST_NAME env removed" grep -qx 'OMNIGENT_HOST_NAME=<unset>' "$envf"
  check "OG_UNSET_ENV variable removed" grep -qx 'FAKE_SECRET_KEY=<unset>' "$envf"
  check "telemetry env off (OMNIGENT_ANALYTICS=0)" grep -qx 'OMNIGENT_ANALYTICS=0' "$envf"
  check "telemetry env off (DO_NOT_TRACK=1)" grep -qx 'DO_NOT_TRACK=1' "$envf"
  check "telemetry env off (DISABLE_TELEMETRY=1)" grep -qx 'DISABLE_TELEMETRY=1' "$envf"
  check "passthrough = telemetry vars + OG_PASSTHROUGH (invalid names dropped)" \
    grep -qx 'OMNIGENT_RUNNER_ENV_PASSTHROUGH=OMNIGENT_ANALYTICS,DO_NOT_TRACK,DISABLE_TELEMETRY,OG_HOST_TREE,PI_CODING_AGENT_DIR,PI_AGENT_DATA_DIR' "$envf"
  check "OMNIGENT_CONFIG_HOME/DATA_DIR exported" grep -qx "OMNIGENT_DATA_DIR=$E/data" "$envf"
  check "host runs in its own process group (setsid)" grep -qx 'pgid_is_pid=True' "$envf"
  check "host oom_score_adj raised to 1000 (default)" test "$(sed -n 's/^oom_score_adj=//p' "$envf")" = 1000
  check "host tree marked OG_HOST_TREE=<supervisor pid> (memory guard)" grep -qx "OG_HOST_TREE=$SUP_PID" "$envf"
  check "OG_HOST_TREE passed through to runners" grep -q '^OMNIGENT_RUNNER_ENV_PASSTHROUGH=.*OG_HOST_TREE' "$envf"
  check "auth_tokens.json re-tightened to 0600 (fsGroup chmod)" test "$(stat -c %a "$E/data/auth_tokens.json")" = 600
  check "config.yaml host.name pinned" test "$(cfg_get host.name)" = "test-chart · rel"
  check "host_id generated by omnigent, not by the kit" grep -q 'new identity; host_id will be generated by omnigent' "$E/stdout.log"
  check "host_id present after first start" grep -Eq '^[0-9a-f]{32}$' <<<"$(cfg_get host.host_id)"
  check "telemetry: false in config.yaml" test "$(cfg_get telemetry)" = False
  check "providers.claude-subscription seeded" test "$(cfg_get providers.claude-subscription.cli)" = claude
  check "providers.pi-original seeded" test "$(cfg_get providers.pi-original.default)" = pi
  check "HOME/workspace links to OG_WORKSPACE" test "$(readlink "$E/home/workspace")" = "$E/ws"
  check "workspace seeded at host start (OG_WORKSPACE_SEED_DIR)" grep -qx 'seeded brief' "$E/ws/BRIEF.md"
  check "seed decision logged" grep -q 'seed: BRIEF.md: seeded' "$E/stdout.log"
  local hp; hp=$(host_pid)
  stop_sup "$SUP_PID"
  check "SIGTERM: supervisor exits" dead "$SUP_PID"
  check "SIGTERM: host stopped too" dead "$hp"
  check "SIGTERM: status stopped" st_is stopped
  # Restart: same identity, no re-seeding of providers.
  local id; id=$(cfg_get host.host_id)
  rm -f "$E/ws/BRIEF.md"
  start_sup OG_WORKSPACE_SEED_DIR="$E/seed"
  check "restart: host back without a new login" wait_for 10 st_is running
  check "restart: same host_id kept" test "$(cfg_get host.host_id)" = "$id"
  check "restart: seed file the tenant deleted is not re-created" test ! -e "$E/ws/BRIEF.md"
  stop_sup "$SUP_PID"
}

t_outage() {
  echo "- 5xx / connection errors never stop the host"
  new_env outage || return
  login
  start_sup
  wait_for 10 st_is running || { bad "outage: host did not come up"; return; }
  local hp; hp=$(host_pid)
  srv_ctl '{"me": 500, "token": 502}'
  sleep 6
  check "5xx on /v1/me: same host keeps running" alive "$hp"
  check "5xx: status still running, detail says unreachable" bash -c "[ \"\$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d[\"state\"], d[\"detail\"])' '$STATUS_FILE')\" != '' ] && python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));sys.exit(0 if d[\"state\"]==\"running\" and \"unreachable\" in d[\"detail\"] else 1)' '$STATUS_FILE'"
  expire_token
  sleep 6
  check "expired token + refresh 502: host keeps running" alive "$hp"
  kill_quiet "$SRV_PID"
  sleep 6
  check "server gone (connection refused): host keeps running" alive "$hp"
  check "no restarts during the outage" test "$(starts)" = 1
  check "never reported login-expired during the outage" bash -c "! grep -q 'login no longer usable\|expired or was revoked' '$E/stdout.log'"
  stop_sup "$SUP_PID"
}

t_single_401() {
  echo "- one rejection that is not confirmed does not stop the host"
  new_env blip || return
  login
  start_sup
  wait_for 10 st_is running || { bad "blip: host did not come up"; return; }
  local hp; hp=$(host_pid)
  # probe 1: /v1/me 401 + refresh 401 -> rejected; confirmation probe: /v1/me 200
  srv_ctl '{"me": 200, "me_fail_first": 1, "token": 401}'
  sleep 5
  check "unconfirmed 401: host keeps running" alive "$hp"
  check "unconfirmed 401: still one start" test "$(starts)" = 1
  check "the rejection did happen (server saw a refused refresh)" grep -q 'POST /oauth/token 401' "$E/srv/requests.log"
  stop_sup "$SUP_PID"
}

t_revoked() {
  echo "- server-side revocation (401 with an unexpired token), confirmed twice -> stop"
  new_env revoked || return
  login
  start_sup
  wait_for 10 st_is running || { bad "revoked: host did not come up"; return; }
  local hp id
  hp=$(host_pid)
  id=$(cfg_get host.host_id)
  srv_ctl '{"me": 401, "token": 400, "token_error": "invalid_grant"}'
  check "revoked: host stopped" wait_for 12 dead "$hp"
  check "revoked: status login-expired" wait_for 4 st_is login-expired
  check "revoked: detail names a revocation" grep -q 'revoked' <<<"$(st detail)"
  check "revoked: confirmed by two probes (>= 2 refused refreshes)" test "$(grep -c 'POST /oauth/token 400' "$E/srv/requests.log")" -ge 2
  sleep 3
  check "revoked: host not restarted while the login is dead" test "$(starts)" = 1
  check "revoked: status printer asks for login" grep -q "omnigent login $URL" <<<"$(OG_STATUS_FILE=$STATUS_FILE sh "$STATUS" --motd)"
  srv_ctl '{"me": 200, "token": 200}'
  login 3600
  check "re-login: host back" wait_for 10 st_is running
  check "re-login: same host_id" test "$(cfg_get host.host_id)" = "$id"
  check "re-login: second start" test "$(starts)" = 2
  stop_sup "$SUP_PID"
}

t_expired() {
  echo "- expired login whose refresh grant is refused (expired_token)"
  new_env expired || return
  srv_ctl '{"me": 200, "token": 400, "token_error": "expired_token"}'
  login -100
  start_sup
  check "expired at startup: status login-expired" wait_for 8 st_is login-expired
  check "expired at startup: detail says expired" grep -q 'expired' <<<"$(st detail)"
  check "expired at startup: host never started" test "$(starts)" = 0
  stop_sup "$SUP_PID"
  # Running host whose refresh grant expires later.
  srv_ctl '{"me": 200, "token": 200}'
  login 3600
  start_sup
  wait_for 10 st_is running || { bad "expired: host did not come up"; return; }
  local hp; hp=$(host_pid)
  srv_ctl '{"me": 200, "token": 400, "token_error": "expired_token"}'
  expire_token
  check "grant expired while running: host stopped" wait_for 12 dead "$hp"
  check "grant expired while running: status login-expired" wait_for 4 st_is login-expired
  stop_sup "$SUP_PID"
}

t_409() {
  echo "- exit 78 with HTTP 409 -> exponential backoff + reset-id hint"
  new_env conflict || return
  # shellcheck disable=SC2016 # literal backticks, as omnigent prints them
  og_ctl '{"mode": "exit", "exit_code": 78, "lines": ["x Could not connect to the server.", "Connection refused (HTTP 409): this machine is already registered to a different account on this server. Run `omnigent host reset-id` to mint a fresh host id."]}'
  login
  start_sup OG_BACKOFF_78_MIN=2 OG_BACKOFF_78_MAX=8
  check "409: status needs-reset-id" wait_for 10 st_is needs-reset-id
  check "409: action is omnigent host reset-id --yes" test "$(st action)" = "omnigent host reset-id --yes"
  check "409: status printer shows reset-id --yes" grep -q 'omnigent host reset-id --yes' <<<"$(OG_STATUS_FILE=$STATUS_FILE sh "$STATUS" --motd)"
  wait_for 10 in_backoff
  check "409: status printer shows the next retry time" grep -q '下次重試' <<<"$(OG_STATUS_FILE=$STATUS_FILE sh "$STATUS" --motd)"
  wait_for 40 starts_ge 5
  check "409: retried (>= 5 starts)" starts_ge 5
  local deltas
  deltas=$(awk '{t[NR]=$1} END {for (i = 2; i <= NR; i++) printf "%.1f ", t[i] - t[i-1]}' "$E/og/starts.log")
  # Nominal gaps 2, 4, 8, 8 s, plus start/probe overhead and 1 s clock granularity.
  check "409: backoff grows exponentially (gaps: $deltas)" awk -v d="$deltas" 'BEGIN {n = split(d, g, " "); exit !(n >= 3 && g[2] >= g[1] && g[3] >= g[2] && g[3] > g[1] + 3)}'
  check "409: backoff capped at OG_BACKOFF_78_MAX" awk -v d="$deltas" 'BEGIN {n = split(d, g, " "); for (i = 1; i <= n; i++) if (g[i] > 8 + 3.5) exit 1}'
  # Tenant runs `omnigent host reset-id` (a new host_id in config.yaml) while the
  # supervisor sits in an 8 s backoff: it retries at once.
  wait_for 10 in_backoff
  sleep 0.5
  og_ctl '{"mode": "run"}'
  python3 - "$E/data/config.yaml" <<'PY'
import sys, uuid, yaml
p = sys.argv[1]; c = yaml.safe_load(open(p)); c["host"]["host_id"] = uuid.uuid4().hex
open(p, "w").write(yaml.safe_dump(c))
PY
  check "reset-id: host reconnects without waiting out the backoff" wait_for 3 st_is running
  check "reset-id: early retry logged" grep -q 'files changed; retrying now' "$E/stdout.log"
  stop_sup "$SUP_PID"
}

t_sigkill() {
  echo "- SIGTERM -> SIGKILL escalation"
  new_env sigkill || return
  og_ctl '{"mode": "ignore-term"}'
  login
  start_sup
  wait_for 10 st_is running || { bad "sigkill: host did not come up"; return; }
  local hp; hp=$(host_pid)
  kill -TERM "$SUP_PID"
  check "supervisor exits within grace + margin" wait_for 7 dead "$SUP_PID"
  check "host that ignores SIGTERM is SIGKILLed" wait_for 2 dead "$hp"
  check "escalation logged" grep -q 'ignored SIGTERM' "$E/stdout.log"
  check "status stopped" st_is stopped
}

t_logs() {
  echo "- size-capped host log + omnigent log pruning while running"
  new_env logs || return
  mkdir -p "$E/data/logs/runner" "$E/data/logs/host"
  echo old >"$E/data/logs/runner/runner-old.log"
  touch -d '20 days ago' "$E/data/logs/runner/runner-old.log"
  og_ctl '{"mode": "spam"}'
  login
  start_sup OG_LOG_MAX_BYTES=65536
  wait_for 10 st_is running || { bad "logs: host did not come up"; return; }
  head -c 1048576 /dev/zero | tr '\0' 'y' >"$E/data/logs/runner/runner-big.log"
  sleep 8
  local sz; sz=$(wc -c <"$E/data/omnigent-host/host.log")
  check "host.log stays near the cap ($sz <= 65536 + 1 tick of output)" test "$sz" -le $((65536 + 60000))
  check "host.log rotated to host.log.1" test -s "$E/data/omnigent-host/host.log.1"
  check "rotated copy is capped too" test "$(wc -c <"$E/data/omnigent-host/host.log.1")" -le $((65536 + 60000))
  check "runner logs older than retention pruned" test ! -e "$E/data/logs/runner/runner-old.log"
  check "oversized runner log trimmed while running" test "$(wc -c <"$E/data/logs/runner/runner-big.log")" -le 65536
  check "host kept running through rotation" test "$(starts)" = 1
  stop_sup "$SUP_PID"
}

t_lock() {
  echo "- lock: one supervisor / one host per volume"
  new_env lock || return
  login
  start_sup
  local a=$SUP_PID
  wait_for 10 st_is running || { bad "lock: host did not come up"; return; }
  SUP_OUT=$E/stdout-b.log start_sup
  local b=$SUP_PID
  sleep 4
  check "second supervisor waits for the lock" grep -q 'another supervisor holds' "$E/stdout-b.log"
  check "second supervisor stays alive (no crash loop)" alive "$b"
  check "still exactly one host" test "$(starts)" = 1
  check "status still owned by the first supervisor" test "$(st supervisor_pid)" = "$a"
  stop_sup "$a"
  check "second supervisor takes over after the first exits" wait_for 10 starts_is 2
  check "takeover: status owned by the second supervisor" wait_for 5 st_field_is supervisor_pid "$b"
  stop_sup "$b"
}

t_relogin() {
  echo "- re-login as another account restarts the host"
  new_env relogin || return
  login
  start_sup
  wait_for 10 st_is running || { bad "relogin: host did not come up"; return; }
  login 3600 other-user
  check "account change: host restarted" wait_for 10 starts_is 2
  check "account change logged" grep -q 'logged in again' "$E/stdout.log"
  stop_sup "$SUP_PID"
}

t_image() {
  echo "- image checks: old tmux / missing omnigent -> image-too-old, idle"
  new_env oldtmux 3.2 || return
  login
  start_sup
  check "tmux 3.2: status image-too-old" wait_for 6 st_is image-too-old
  sleep 2
  check "tmux 3.2: host never started" test "$(starts)" = 0
  check "tmux 3.2: supervisor exits quietly (no idle process left)" wait_for 4 dead "$SUP_PID"
  reap "$SUP_PID"
  check "tmux 3.2: ... with exit code 0" test "$?" = 0
  check "tmux 3.2: status stays image-too-old" st_is image-too-old
  check "tmux 3.2: status printer tells the tenant" grep -q '映像版本太舊' <<<"$(OG_STATUS_FILE=$STATUS_FILE sh "$STATUS" --motd)"
  new_env noomni || return
  rm -f "$E/bin/omnigent"
  start_sup
  check "no omnigent CLI: status image-too-old" wait_for 6 st_is image-too-old
  check "no omnigent CLI: supervisor exits" wait_for 4 dead "$SUP_PID"
  new_env shimonly || return
  rm -f "$E/bin/omnigent"
  mkdir -p "$E/kitbin"; ln -s "$KIT/omnigent-shim" "$E/kitbin/omnigent"
  start_sup PATH="$E/kitbin:$E/bin:$TEST_PATH"
  check "only the kit's omnigent guard on PATH: not mistaken for the CLI (image-too-old)" wait_for 6 st_is image-too-old
  stop_sup "$SUP_PID"
  # the guard FIRST on PATH, the real CLI after it, OG_BIN unset (the supervisor
  # started without the launcher): the host must be the real CLI, not the guard
  # (which would refuse 'omnigent host' while this supervisor holds the lock)
  new_env shimfirst || return
  mkdir -p "$E/kitbin"; ln -s "$KIT/omnigent-shim" "$E/kitbin/omnigent"
  login
  start_sup PATH="$E/kitbin:$E/bin:$TEST_PATH"
  check "guard first on PATH, real CLI after it: the host runs the real CLI" wait_for 10 st_is running
  check "... started once, through the real CLI" bash -c "[ \"\$(wc -l <'$E/og/starts.log')\" -eq 1 ] && grep -q '^argv=host --server ' '$E/og/env-1.txt'"
  check "... the guard never refused the supervisor's own host" bash -c "! grep -q 'already running, managed automatically' '$E/data/omnigent-host/host.log' '$E/stdout.log' 2>/dev/null"
  stop_sup "$SUP_PID"
  new_env disabled || return
  login
  start_sup OG_HOST_ENABLED=0
  check "OG_HOST_ENABLED=0: supervisor exits" wait_for 4 dead "$SUP_PID"
  check "OG_HOST_ENABLED=0: no host, no status file" test "$(starts)" = 0 -a ! -e "$STATUS_FILE"
  new_env notmuxok || return
  rm -f "$E/bin/tmux"
  login
  start_sup OG_TMUX_MIN=
  check "OG_TMUX_MIN= disables the tmux requirement" wait_for 10 st_is running
  stop_sup "$SUP_PID"
}

# decoy <path>: an `omnigent` a tenant installed; it only records that it ran
decoy() {
  mkdir -p "$(dirname "$1")"
  # shellcheck disable=SC2016 # $0/$* belong to the decoy script
  printf '#!/bin/sh\necho "$0 $*" >>"%s/decoy.log"\nexit 3\n' "$E" >"$1"
  chmod +x "$1"
}
no_decoy() { [ ! -e "$E/decoy.log" ]; }
t_pinned() {
  echo "- pinned CLI: the launcher/supervisor run OG_BIN, never a tenant copy on PATH"
  new_env pinned || return
  kit_dir "$E/kit"; make_product
  mkdir -p "$E/pin"
  mv "$E/bin/omnigent" "$E/pin/omnigent"
  decoy "$E/home/.local/bin/omnigent"   # persistent ~/.local/bin, first on PATH
  decoy "$E/decoy/omnigent"             # any other copy earlier on PATH
  login
  start_launch PATH="$E/home/.local/bin:$E/decoy:$E/bin:$TEST_PATH" OG_BIN="$E/pin/omnigent" -- "$E/kit/omnigent-host-launch" -- "$E/product.sh"
  check "launcher, OG_BIN path, two other omnigents first on PATH: the host runs OG_BIN" wait_for 10 st_is running
  check "... the copies on PATH never ran" no_decoy
  kill -TERM -- "-$L_PID"; wait_for 15 dead "$L_PID"; reap "$L_PID"
  rm -rf "$E/prod"
  # shellcheck disable=SC2086
  env -i PATH="$E/home/.local/bin:$E/decoy:$E/pin:$E/bin:$TEST_PATH" HOME="$E/home" PROD_OUT="$E/prod" OG_HOST_ENABLED=1 OG_KIT_DIR="$E/kit" \
    OG_BIN="$E/pin/missing" $SUP_SHELL "$E/kit/omnigent-host-launch" "$E/product.sh" &
  local lp=$!
  wait_for 5 test -s "$E/prod/pid"
  check "OG_BIN path missing: no fallback to PATH, the product is exec'd (same pid)" test "$(cat "$E/prod/pid")" = "$lp"
  check "... the copies on PATH never ran" no_decoy
  kill -TERM "$lp"; wait_for 5 dead "$lp"; reap "$lp"
  rm -rf "$E/prod"
  start_launch PATH="$E/home/.local/bin:$E/pin:$E/bin:$TEST_PATH" -- "$E/kit/omnigent-host-launch" -- "$E/product.sh"
  check "launcher, OG_BIN unset: skips the copy under HOME, runs the image's CLI" wait_for 10 st_is running
  check "... ~/.local/bin/omnigent never ran" no_decoy
  kill -TERM -- "-$L_PID"; wait_for 15 dead "$L_PID"; reap "$L_PID"
  start_sup PATH="$E/decoy:$E/bin:$TEST_PATH" OG_BIN="$E/pin/omnigent"
  check "supervisor alone, OG_BIN path, another omnigent first on PATH: runs OG_BIN" wait_for 10 st_is running
  check "... the copy on PATH never ran" no_decoy
  stop_sup "$SUP_PID"
  decoy "$E/oghome/.local/bin/omnigent"
  start_sup PATH="$E/oghome/.local/bin:$E/home/.local/bin:$E/pin:$E/bin:$TEST_PATH" OG_HOME="$E/oghome"
  check "supervisor alone, OG_BIN unset: skips copies under OG_HOME and the product's HOME" wait_for 10 st_is running
  check "... neither ever ran" no_decoy
  stop_sup "$SUP_PID"
}

t_status_printer() {
  echo "- omnigent-host-status"
  local f=$WORK/$RUN_TAG-status.json
  check "missing status file: --motd silent, exit 0" bash -c "out=\$(OG_STATUS_FILE='$f' sh '$STATUS' --motd); [ \$? -eq 0 ] && [ -z \"\$out\" ]"
  check "missing status file: full mode exit 2" bash -c "OG_STATUS_FILE='$f' sh '$STATUS' >/dev/null; [ \$? -eq 2 ]"
  printf '{\n  "schema": 1,\n  "state": "running",\n  "detail": "connected",\n  "action": "",\n  "login_command": "omnigent login http://x",\n  "server": "http://x",\n  "host_name": "a \\"quoted\\" name",\n  "workspace": "/w",\n  "supervisor_pid": "1"\n}\n' >"$f"
  check "running: --motd silent" test -z "$(OG_STATUS_FILE=$f sh "$STATUS" --motd)"
  check "running: full mode names the host (escapes decoded)" grep -q 'a "quoted" name' <<<"$(OG_STATUS_FILE=$f sh "$STATUS")"
  check "--json prints the file" cmp -s "$f" <(OG_STATUS_FILE=$f sh "$STATUS" --json)
  printf '{\n  "schema": 1,\n  "state": "running",\n  "detail": "server unreachable right now (me-503); the host keeps retrying",\n  "server": "http://x",\n  "host_name": "n"\n}\n' >"$f"
  check "running + unreachable: full mode shows the detail" grep -q 'unreachable' <<<"$(OG_STATUS_FILE=$f sh "$STATUS")"
  printf '{\n  "schema": 1,\n  "state": "host-error",\n  "detail": "the host stopped with a permanent error (exit 78)",\n  "retry_at": "2026-10-01T10:00:00Z",\n  "host_log": "/d/omnigent-host/host.log"\n}\n' >"$f"
  check "host-error: --motd tells the tenant the host is down" grep -q '目前離線' <<<"$(OG_STATUS_FILE=$f sh "$STATUS" --motd)"
  check "host-error: --motd points at the host log" grep -q '/d/omnigent-host/host.log' <<<"$(OG_STATUS_FILE=$f sh "$STATUS" --motd)"
  check "host-error: --motd shows the next retry" grep -q '2026-10-01T10:00:00Z' <<<"$(OG_STATUS_FILE=$f sh "$STATUS" --motd)"
  check "host-error: full mode exit 1 (needs attention)" bash -c "OG_STATUS_FILE='$f' sh '$STATUS' >/dev/null; [ \$? -eq 1 ]"
  printf '{\n  "schema": 1,\n  "state": "backoff",\n  "detail": "the host exited (rc=1)"\n}\n' >"$f"
  check "backoff (transient): --motd silent" test -z "$(OG_STATUS_FILE=$f sh "$STATUS" --motd)"
  printf '{\n  "schema": 1,\n  "state": "waiting-login",\n  "login_command": "omnigent login http://x"\n}\n' >"$f"
  check "waiting-login: --motd mentions the admin default of the Username prompt" grep -q 'admin' <<<"$(OG_STATUS_FILE=$f sh "$STATUS" --motd)"
  # serverUrl injected AFTER the supervisor wrote the status: the printer reads the runtime file itself
  printf '{\n  "schema": 1,\n  "state": "waiting-login",\n  "login_command": "omnigent login <Omnigent URL>"\n}\n' >"$f"
  printf 'http://svc-x-omnigent.ns.svc.cluster.local:8000/\n' >"$f.url"
  check "runtime serverUrl file: the printed login command uses it (status file stale)" grep -q 'omnigent login http://svc-x-omnigent.ns.svc.cluster.local:8000$' <<<"$(OG_STATUS_FILE=$f OG_SERVER_URL_FILE=$f.url sh "$STATUS" --motd)"
  printf 'ftp://bad host\n' >"$f.url"
  check "runtime serverUrl file with an invalid URL: ignored" grep -q 'omnigent login <Omnigent URL>' <<<"$(OG_STATUS_FILE=$f OG_SERVER_URL_FILE=$f.url sh "$STATUS" --motd)"
  check "no runtime file: the status file's login command" grep -q 'omnigent login <Omnigent URL>' <<<"$(OG_STATUS_FILE=$f OG_SERVER_URL_FILE=$f.none sh "$STATUS" --motd)"
}

t_helper_seed() {
  echo "- og_helper.py seed: identity rule, telemetry, non-destructive providers"
  local d=$WORK/$RUN_TAG-seed
  mkdir -p "$d/cfg" "$d/state"
  seed() { LC_ALL=C.UTF-8 OMNIGENT_CONFIG_HOME=$d/cfg OMNIGENT_DATA_DIR=$d/cfg OG_STATE_DIR=$d/state OG_HOST_NAME="pi-agent · svc-20c1c915" "$@" python3 "$HELPER" seed; }
  printf 'host:\n  host_id: cb1b5336100f4bc5bea04c5e4f2d5217\n  name: svc-20c1c915-pi-agent-6d44486c76-tdn6t\nserver: http://s:8000\ntelemetry: true\nproviders:\n  mine:\n    kind: subscription\n    cli: claude\n    default: true\n' >"$d/cfg/config.yaml"
  chmod 600 "$d/cfg/config.yaml"
  seed env OG_PROVIDERS=claude-subscription,pi-original,bogus >"$d/out1" 2>&1
  local c=$d/cfg/config.yaml
  y() { python3 -c 'import sys,yaml; c=yaml.safe_load(open(sys.argv[1]))
v=c
for k in sys.argv[2].split("."):
    v = v.get(k) if isinstance(v, dict) else None
print("" if v is None else v)' "$c" "$1"; }
  check "existing host_id kept" test "$(y host.host_id)" = cb1b5336100f4bc5bea04c5e4f2d5217
  check "existing host renamed to OG_HOST_NAME" test "$(y host.name)" = "pi-agent · svc-20c1c915"
  check "server: untouched" test "$(y server)" = "http://s:8000"
  check "host name written readably (UTF-8, no \\x/\\u escapes)" grep -q 'name: pi-agent · svc-20c1c915' "$d/cfg/config.yaml"
  check "telemetry forced false" test "$(y telemetry)" = False
  check "claude-subscription NOT added (tenant entry claims the default)" test -z "$(y providers.claude-subscription)"
  check "tenant provider kept" test "$(y providers.mine.cli)" = claude
  check "pi-original added" test "$(y providers.pi-original.cli)" = pi
  check "unknown provider name reported" grep -q "unknown provider entry 'bogus'" "$d/out1"
  check "config.yaml mode 0600 preserved" test "$(stat -c %a "$c")" = 600
  python3 - "$c" <<'PY'
import sys, yaml
p = sys.argv[1]; c = yaml.safe_load(open(p)); del c["providers"]["pi-original"]
open(p, "w").write(yaml.safe_dump(c))
PY
  seed env OG_PROVIDERS=claude-subscription,pi-original >/dev/null 2>&1
  check "provider the tenant removed is not re-added (seeded once per volume)" test -z "$(y providers.pi-original)"
  rm -f "$c"
  seed env OG_PROVIDERS= >/dev/null 2>&1
  check "no host block: only host.name written (no invented host_id)" bash -c "[ \"\$(python3 -c 'import sys,yaml; print(sorted(yaml.safe_load(open(sys.argv[1]))[\"host\"]))' '$c')\" = \"['name']\" ]"
  printf 'host: [broken\n' >"$c"
  cp "$c" "$d/broken.orig"
  seed env OG_PROVIDERS= >"$d/out3" 2>&1
  local rc=$?
  check "invalid YAML: exit 1" test "$rc" = 1
  check "invalid YAML: file left untouched" cmp -s "$c" "$d/broken.orig"
  # omnigent itself rewrites config.yaml with escapes (e.g. when minting the id)
  printf 'host:\n  host_id: cb1b5336100f4bc5bea04c5e4f2d5217\n  name: "pi-agent \\xB7 svc-20c1c915"\ntelemetry: false\n' >"$c"
  seed env OG_PROVIDERS= >"$d/out4" 2>&1
  check "escaped name (same value) rewritten readably" grep -q 'name: pi-agent · svc-20c1c915' "$c"
  check "... host_id still kept" test "$(y host.host_id)" = cb1b5336100f4bc5bea04c5e4f2d5217
  rm -f "$c"
  PYTHONCOERCECLOCALE=0 PYTHONUTF8=0 LC_ALL=C OMNIGENT_CONFIG_HOME=$d/cfg OMNIGENT_DATA_DIR=$d/cfg OG_STATE_DIR=$d/state OG_HOST_NAME="pi-agent · svc-20c1c915" OG_PROVIDERS='' python3 "$HELPER" seed >/dev/null 2>&1
  check "ASCII-only locale: name written with escapes (omnigent could not decode UTF-8)" bash -c "grep -q 'svc-20c1c915' '$c' && ! grep -q '·' '$c'"
  # compared inside python (UTF-8 mode): a surrogate-escaped name would print the
  # same bytes under a C locale and pass a shell comparison
  check "ASCII-only locale: the value still round-trips (decoded as UTF-8, no surrogates)" env PYTHONUTF8=1 python3 -c 'import sys, yaml; sys.exit(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))["host"]["name"] != "pi-agent \u00b7 svc-20c1c915")' "$c"
  check "ASCII-only locale: the file is pure ASCII (readable by omnigent there)" env LC_ALL=C python3 -c 'import sys; open(sys.argv[1], "rb").read().decode("ascii")' "$c"
  printf 'server: http://s\n' >"$c"
  OMNIGENT_CONFIG_HOME=$d/cfg OMNIGENT_DATA_DIR=$d/cfg OG_STATE_DIR=$d/state OG_HOST_NAME='' OG_PROVIDERS='' python3 "$HELPER" seed >/dev/null
  check "empty OG_HOST_NAME leaves identity alone" test -z "$(y host)"
}

t_helper_workspace() {
  echo "- og_helper.py workspace: manifest-tracked seed, tenant opt-out and edits win"
  local d=$WORK/$RUN_TAG-wsseed
  mkdir -p "$d/seed1" "$d/seed2" "$d/ws" "$d/state"
  printf 'brief v1\n' >"$d/seed1/CLAUDE.md"
  printf '{"mcpServers": {}}\n' >"$d/seed1/.mcp.json"
  printf '{"permissions": {}}\n' >"$d/seed1/.claude__settings.json"
  printf 'mine\n' >"$d/seed1/NOTES.md"
  printf 'x\n' >"$d/seed1/a__..__escape"
  printf 'brief v2\n' >"$d/seed2/CLAUDE.md"
  printf '{"mcpServers": {"x": {}}}\n' >"$d/seed2/.mcp.json"
  printf '{"permissions": {"deny": []}}\n' >"$d/seed2/.claude__settings.json"
  printf 'theirs\n' >"$d/ws/NOTES.md"
  wsh() { OG_STATE_DIR=$d/state OG_WORKSPACE=$d/ws OG_WORKSPACE_SEED_DIR=$d/$1 OG_WORKSPACE_SEED_UPDATE="CLAUDE.md" python3 "$HELPER" workspace >"$d/out.$1" 2>&1; }
  m() { python3 -c 'import json,sys; f=json.load(open(sys.argv[1]))["files"].get(sys.argv[2]) or {}; print(f.get(sys.argv[3], ""))' "$d/state/workspace-seed.json" "$1" "$2"; }
  wsh seed1
  check "seeded CLAUDE.md" grep -qx 'brief v1' "$d/ws/CLAUDE.md"
  check "seeded .mcp.json" test -f "$d/ws/.mcp.json"
  check "flat key a__b seeded as a/b (.claude/settings.json)" test -f "$d/ws/.claude/settings.json"
  check "seeded files are 0644" test "$(stat -c %a "$d/ws/CLAUDE.md")" = 644
  check "pre-existing tenant file untouched" grep -qx theirs "$d/ws/NOTES.md"
  check "manifest: NOTES.md recorded as the tenant's" test "$(m NOTES.md state)" = tenant
  check "manifest: CLAUDE.md seeded with its sha256" test "$(m CLAUDE.md sha256)" = "$(sha256sum "$d/seed1/CLAUDE.md" | cut -d' ' -f1)"
  check "unsafe key (..) skipped" bash -c "! test -e '$d/escape' && ! test -e '$d/ws/a' && grep -q 'unsafe seed name' '$d/out.seed1'"
  cp "$d/state/workspace-seed.json" "$d/m1"
  wsh seed1
  check "second run with the same seed: no change" cmp -s "$d/state/workspace-seed.json" "$d/m1"
  rm -f "$d/ws/.mcp.json"
  wsh seed1
  check "deleted .mcp.json is NOT re-created" test ! -e "$d/ws/.mcp.json"
  check "manifest records the deletion" test "$(m .mcp.json state)" = deleted
  printf '{"permissions": {"allow": ["mine"]}}\n' >"$d/ws/.claude/settings.json"
  wsh seed2
  check "new seed version: unedited CLAUDE.md (in OG_WORKSPACE_SEED_UPDATE) updated" grep -qx 'brief v2' "$d/ws/CLAUDE.md"
  check "deleted .mcp.json stays deleted after a new seed version" test ! -e "$d/ws/.mcp.json"
  check "edited settings.json kept" grep -q mine "$d/ws/.claude/settings.json"
  check "newer settings.json offered under .omnigent-seed-updates/" grep -q deny "$d/ws/.omnigent-seed-updates/.claude/settings.json"
  check "offer reported" grep -q 'edited by the tenant; a newer version' "$d/out.seed2"
  wsh seed2
  check "offer reported only once" test "$(grep -c 'newer version' "$d/out.seed2")" = 0
  printf 'brief v2, plus my rules\n' >"$d/ws/CLAUDE.md"
  printf 'brief v3\n' >"$d/seed2/CLAUDE.md"
  wsh seed2
  check "edited CLAUDE.md is NOT updated" grep -qx 'brief v2, plus my rules' "$d/ws/CLAUDE.md"
  check "newer CLAUDE.md offered instead" grep -qx 'brief v3' "$d/ws/.omnigent-seed-updates/CLAUDE.md"
  printf 'brief v3\n' >"$d/ws/CLAUDE.md"
  wsh seed2
  check "offer removed once the file matches the seed" test ! -e "$d/ws/.omnigent-seed-updates/CLAUDE.md"
  rm -rf "$d/ws2" "$d/outside"; mkdir -p "$d/ws2" "$d/outside"; ln -s "$d/outside" "$d/ws2/.claude"
  OG_STATE_DIR=$d/state2 OG_WORKSPACE=$d/ws2 OG_WORKSPACE_SEED_DIR=$d/seed1 python3 "$HELPER" workspace >/dev/null 2>&1
  check "symlinked directory leaving the workspace is not written through" test ! -e "$d/outside/settings.json"
}

t_helper_state() {
  echo "- og_helper.py state: verdicts"
  new_env state || return
  hs() { OMNIGENT_CONFIG_HOME=$E/data OMNIGENT_DATA_DIR=$E/data OG_SERVER_URL=$URL OG_HTTP_TIMEOUT=2 python3 "$HELPER" state >"$E/state.out" 2>&1; echo $?; }
  check "no token file -> 3 absent" test "$(hs)" = 3
  login
  check "fresh token + /v1/me 200 -> 0" test "$(hs)" = 0
  check "output carries no token" bash -c "! grep -q SECRET '$E/state.out'"
  srv_ctl '{"me": 503, "token": 200}'
  check "fresh token + /v1/me 503 -> 5 unreachable" test "$(hs)" = 5
  srv_ctl '{"me": 403, "token": 200}'
  check "fresh token + /v1/me 403 -> 5 (only 401 is definitive)" test "$(hs)" = 5
  srv_ctl '{"me": 200, "me_fail_first": 1, "token": 200}'
  check "401 then refresh ok + /v1/me 200 -> 0" test "$(hs)" = 0
  srv_ctl '{"me": 401, "token": 502}'
  check "401 + refresh 502 -> 5" test "$(hs)" = 5
  srv_ctl '{"me": 401, "token": 400, "token_error": "invalid_grant"}'
  check "401 + refresh invalid_grant -> 4 revoked" test "$(hs)" = 4
  check "reason says revoked" grep -q '^reason=revoked' "$E/state.out"
  srv_ctl '{"me": 200, "token": 200}'
  login 3600
  expire_token
  check "expired + refresh 200 -> 0" test "$(hs)" = 0
  check "refreshed token persisted (0600, not expired)" python3 -c 'import json,os,stat,sys,time
p=sys.argv[1]; d=json.load(open(p)); e=list(d.values())[0]
sys.exit(0 if e["token"].startswith("SECRET-ACCESS-") and e["expires_at"]>time.time()+3000 and e["refresh_token"]=="SECRET-REFRESH-tester" and stat.S_IMODE(os.stat(p).st_mode)==0o600 else 1)' "$E/data/auth_tokens.json"
  expire_token
  srv_ctl '{"me": 200, "token": 400, "token_error": "unsupported_grant_type"}'
  check "expired + refresh 400 (other error) -> 5" test "$(hs)" = 5
  srv_ctl '{"me": 200, "token": 401}'
  check "expired + refresh 401 -> 4" test "$(hs)" = 4
  kill_quiet "$SRV_PID"; sleep 0.3
  check "expired + server down -> 5" test "$(hs)" = 5
}

t_reconnect() {
  echo "- after an outage the status follows the host's own reconnect at once"
  new_env reconnect || return
  login
  # watch and unreachable re-probe far away: only the host log can flip the detail
  start_sup OG_WATCH_SECONDS=300 OG_UNREACHABLE_PROBE_SECONDS=300
  wait_for 10 st_is running || { bad "reconnect: host did not come up"; return; }
  srv_ctl '{"me": 503, "token": 200}'
  printf '# touched\n' >>"$E/data/config.yaml"   # file change -> immediate probe
  check "outage: detail says unreachable" wait_for 8 detail_has unreachable
  sleep 2
  check "outage: still unreachable while the host has not reconnected" detail_has unreachable
  srv_ctl '{"me": 200, "token": 200}'
  touch "$E/og/reconnect"
  check "host printed 'Connected as' again -> detail connected within a tick" wait_for 4 st_field_is detail connected
  check "reconnect logged" grep -q 'host reconnected to the server' "$E/stdout.log"
  check "no restart for the outage" test "$(starts)" = 1
  stop_sup "$SUP_PID"
  echo "- unreachable: re-probe after OG_UNREACHABLE_PROBE_SECONDS instead of OG_WATCH_SECONDS"
  new_env reprobe || return
  login
  start_sup OG_WATCH_SECONDS=300 OG_UNREACHABLE_PROBE_SECONDS=3
  wait_for 10 st_is running || { bad "reprobe: host did not come up"; return; }
  srv_ctl '{"me": 503, "token": 200}'
  printf '# touched\n' >>"$E/data/config.yaml"
  wait_for 8 detail_has unreachable || bad "reprobe: never unreachable"
  srv_ctl '{"me": 200, "token": 200}'
  check "server back, no reconnect line: detail connected after the short re-probe" wait_for 8 st_field_is detail connected
  stop_sup "$SUP_PID"
}

t_server_url_file() {
  echo "- serverUrl read at runtime from OG_SERVER_URL_FILE (ConfigMap file, no restart)"
  new_env urlfile || return
  mkdir -p "$E/rt"
  # kubelet's ConfigMap layout: the file is a symlink swapped atomically on update
  set_url_file() { mkdir -p "$E/rt/..$1"; printf '%s' "$2" >"$E/rt/..$1/server-url"; ln -sfn "..$1/server-url" "$E/rt/server-url.new"; mv -fT "$E/rt/server-url.new" "$E/rt/server-url"; }
  set_url_file a "$URL/"
  start_sup OG_SERVER_URL= OG_SERVER_URL_FILE="$E/rt/server-url"
  check "login hint uses the URL from the file (slash trimmed)" wait_for 6 st_field_is login_command "omnigent login $URL"
  set_url_file b "https://omnigent-b.example.com"
  check "file updated -> hint follows without a restart" wait_for 6 st_field_is login_command "omnigent login https://omnigent-b.example.com"
  check "same supervisor process (no restart)" test "$(st supervisor_pid)" = "$SUP_PID"
  set_url_file c "ftp://bad host"
  check "invalid URL in the file is ignored (placeholder)" wait_for 6 st_field_is login_command "omnigent login <Omnigent URL>"
  set_url_file d "$URL"
  # tokens for the file's URL, config.yaml without server: -> the helper's fallback uses the file
  login
  python3 - "$E/data/config.yaml" <<'PY'
import sys, yaml
p = sys.argv[1]; c = yaml.safe_load(open(p)); c.pop("server", None); open(p, "w").write(yaml.safe_dump(c))
PY
  check "host starts against the file's URL (config.yaml has no server:)" wait_for 10 st_is running
  check "host --server is the file's URL" grep -qx "argv=host --server $URL --non-interactive --no-open" "$E/og/env-1.txt"
  # the login dies: the hint must keep following the file (re-read on every use,
  # never cached by the supervisor even after it probed the login)
  srv_ctl '{"me": 401, "token": 400, "token_error": "invalid_grant"}'
  wait_for 12 st_is login-expired || bad "urlfile: login-expired not reached"
  check "login-expired hint uses the file's URL" st_field_is login_command "omnigent login $URL"
  set_url_file e "http://127.0.0.1:9"
  check "file updated after probes ran -> login-expired hint follows (not cached)" wait_for 6 st_field_is login_command "omnigent login http://127.0.0.1:9"
  stop_sup "$SUP_PID"
  rm -f "$STATUS_FILE" "$E/data/auth_tokens.json"
  SUP_OUT=$E/stdout2.log start_sup OG_SERVER_URL=https://env.example.com OG_SERVER_URL_FILE="$E/rt/server-url"
  check "... login hint from the env" wait_for 6 st_field_is login_command "omnigent login https://env.example.com"
  stop_sup "$SUP_PID"
}

t_memory() {
  echo "- OOM: host tree oom_score_adj 1000; memory guard kills the largest session, never the product/host"
  new_env memory || return
  mkdir -p "$E/cg"
  printf '%s\n' 1073741824 >"$E/cg/memory.max"
  printf '%s\n' 104857600 >"$E/cg/memory.current"
  printf 'anon 1\ninactive_file 52428800\nactive_file 1\n' >"$E/cg/memory.stat"
  og_ctl '{"mode": "children", "child_mb": 30}'
  # the "product": a bigger process outside the host tree (no OG_HOST_TREE)
  python3 -c 'import time; b = bytearray(80 * 1048576); b[::4096] = b"x" * len(b[::4096]); time.sleep(3600)' &
  local prod=$!
  PIDS+=("$prod")
  login
  start_sup OG_CGROUP_DIR="$E/cg" OG_MEM_GUARD_SECONDS=1
  wait_for 10 st_is running || { bad "memory: host did not come up"; return; }
  wait_for 5 test -s "$E/og/child.pid"
  local hp cp
  hp=$(host_pid)
  cp=$(cat "$E/og/child.pid")
  check "session child inherited oom_score_adj 1000" test "$(cat "/proc/$cp/oom_score_adj")" = 1000
  check "product keeps its lower oom_score_adj" test "$(cat "/proc/$prod/oom_score_adj")" -lt 1000
  check "session oom_score > product oom_score (kernel prefers the session)" test "$(cat "/proc/$cp/oom_score")" -gt "$(cat "/proc/$prod/oom_score")"
  check "session child carries OG_HOST_TREE=<supervisor pid>" bash -c "tr '\\0' '\\n' </proc/$cp/environ | grep -qx OG_HOST_TREE=$SUP_PID"
  sleep 3
  check "below the threshold: nothing killed" bash -c "kill -0 $cp && kill -0 $prod && kill -0 $hp"
  # working set = current - inactive_file: 1000 MiB - 50 MiB = 92.8 % of 1 GiB
  printf '%s\n' 1048576000 >"$E/cg/memory.current"
  check "over OG_MEM_GUARD_PERCENT: the session child is killed" wait_for 6 dead "$cp"
  check "... the product survives" alive "$prod"
  check "... the host survives" alive "$hp"
  check "guard logged the kill (with the victim's RSS)" grep -Eq 'memory guard: container at 92% .*killed Omnigent session process [0-9]+ \(python3, (29|3[0-9]) MiB\)' "$E/stdout.log"
  check "status keeps the last memory-guard kill" grep -q 'killed session process python3' <<<"$(st memory_guard)"
  check "status printer shows it" grep -q '記憶體保護' <<<"$(OG_STATUS_FILE=$STATUS_FILE sh "$STATUS")"
  # still over the threshold after the throttle window (3 x OG_MEM_GUARD_SECONDS):
  # the only process left in the tree is the host itself -> never a victim
  sleep 4
  check "still over the limit, only the host left in the tree: the host is never killed" alive "$hp"
  check "... exactly one guard kill logged" test "$(grep -c 'memory guard: container at' "$E/stdout.log")" = 1
  check "no host restart" test "$(starts)" = 1
  stop_sup "$SUP_PID"
  echo "- memory guard: page cache does not count; no limit / disabled = no kills"
  new_env memory2 || return
  mkdir -p "$E/cg"
  printf '%s\n' 1073741824 >"$E/cg/memory.max"
  printf '%s\n' 1048576000 >"$E/cg/memory.current"
  printf 'inactive_file 524288000\n' >"$E/cg/memory.stat"   # half of it is reclaimable cache
  og_ctl '{"mode": "children", "child_mb": 10}'
  login
  start_sup OG_CGROUP_DIR="$E/cg" OG_MEM_GUARD_SECONDS=1
  wait_for 10 st_is running || { bad "memory2: host did not come up"; return; }
  wait_for 5 test -s "$E/og/child.pid"
  cp=$(cat "$E/og/child.pid")
  sleep 4
  check "high usage that is mostly inactive_file cache: no kill" alive "$cp"
  printf 'max\n' >"$E/cg/memory.max"; printf 'inactive_file 0\n' >"$E/cg/memory.stat"
  sleep 3
  check "memory.max = max (no limit): no kill" alive "$cp"
  stop_sup "$SUP_PID"
  new_env memory3 || return
  mkdir -p "$E/cg/memory"
  printf '%s\n' 1073741824 >"$E/cg/memory/memory.limit_in_bytes"
  printf '%s\n' 1060000000 >"$E/cg/memory/memory.usage_in_bytes"
  printf 'total_inactive_file 0\n' >"$E/cg/memory/memory.stat"
  og_ctl '{"mode": "children", "child_mb": 10}'
  login
  start_sup OG_CGROUP_DIR="$E/cg" OG_MEM_GUARD_SECONDS=1 OG_MEM_GUARD_PERCENT=0
  wait_for 10 st_is running || { bad "memory3: host did not come up"; return; }
  wait_for 5 test -s "$E/og/child.pid"
  cp=$(cat "$E/og/child.pid")
  sleep 3
  check "OG_MEM_GUARD_PERCENT=0 disables the guard" alive "$cp"
  stop_sup "$SUP_PID"
  SUP_OUT=$E/stdout2.log start_sup OG_CGROUP_DIR="$E/cg" OG_MEM_GUARD_SECONDS=1
  wait_for 10 st_is running
  wait_for 5 test -s "$E/og/child.pid"
  cp=$(cat "$E/og/child.pid")
  check "cgroup v1 files: the guard works there too" wait_for 6 dead "$cp"
  stop_sup "$SUP_PID"
}

# kit_dir <dir>: the kit ConfigMap layout (as the chart's volume items project it)
kit_dir() {
  mkdir -p "$1/bin"
  for f in supervisor.sh og_helper.py omnigent-host-launch omnigent-host-profile.sh omnigent-host-status; do ln -sf "$KIT/$f" "$1/$f"; done
  ln -sf "$KIT/omnigent-shim" "$1/bin/omnigent"
  ln -sf "$KIT/omnigent-shim" "$1/bin/omni"
  ln -sf "$KIT/omnigent-host-status" "$1/bin/omnigent-host-status"
}
# product script for the launcher tests: records argv/pid/PATH/stdin and, on
# SIGTERM, whether the supervisor and the host were already gone.
make_product() {
  cat >"$E/product.sh" <<'SH'
#!/bin/sh
o=$PROD_OUT
mkdir -p "$o"
echo "$$" >"$o/pid"
printf '%s\n' "$@" >"$o/argv"
printf '%s\n' "$PATH" >"$o/path"
printf '%s\n' "${PASSWORD:-}" >"$o/password"
if [ -n "${PROD_READ:-}" ]; then IFS= read -r line; printf '%s\n' "$line" >"$o/stdin"; fi
if [ -n "${PROD_RUN:-}" ]; then sh -c "$PROD_RUN" >"$o/run.out" 2>&1; echo "rc=$?" >>"$o/run.out"; fi
on_term() {
  st=$(sed -n 's/^  "state": "\(.*\)",$/\1/p' "$STATUS_FILE" 2>/dev/null)
  hp=$(tail -n 1 "$FAKE_OG_DIR/starts.log" 2>/dev/null | sed -n 's/.*pid=//p')
  h=none; [ -n "$hp" ] && { if kill -0 "$hp" 2>/dev/null; then h=alive; else h=dead; fi; }
  echo "TERM status=$st host=$h" >"$o/term"
  exit 0
}
trap on_term TERM
trap 'echo HUP >>"$o/hup"' HUP
[ -n "${PROD_EXIT:-}" ] && { sleep 1; exit "$PROD_EXIT"; }
while :; do sleep 1 & wait $!; done
SH
  chmod +x "$E/product.sh"
}
# start_launch [env assignments...] -- <launcher args>: L_PID (own process group)
start_launch() {
  local envs=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
  shift
  # shellcheck disable=SC2086
  env -i PATH="$E/bin:$TEST_PATH" HOME="$E/home" LANG=C.UTF-8 PYTHONPATH="$YAML_PATH" \
    OG_HOST_ENABLED=1 OG_KIT_DIR="$E/kit" OG_SHELL="$SUP_SHELL_BIN" \
    OG_CONFIG_HOME="$E/data" OG_DATA_DIR="$E/data" OMNIGENT_CONFIG_HOME="$E/data" OMNIGENT_DATA_DIR="$E/data" \
    OG_STATUS_FILE="$STATUS_FILE" STATUS_FILE="$STATUS_FILE" OG_SERVER_URL="$URL" OG_HOST_NAME="launch · rel" OG_WORKSPACE="$E/ws" \
    OG_IDLE_SECONDS=1 OG_TICK_SECONDS=1 OG_WATCH_SECONDS=2 OG_CONFIRM_SECONDS=1 OG_REPROBE_SECONDS=2 \
    OG_STOP_GRACE_SECONDS=2 OG_HTTP_TIMEOUT=2 OG_UNSET_ENV=PASSWORD PASSWORD=product-secret \
    FAKE_OG_DIR="$E/og" PROD_OUT="$E/prod" "${envs[@]}" \
    setsid $SUP_SHELL "$@" >>"$E/launch.log" 2>&1 &
  L_PID=$!
  PIDS+=("$L_PID")
}

t_launch() {
  echo "- omnigent-host-launch: background supervisor + product, ordered SIGTERM"
  new_env launch || return
  kit_dir "$E/kit"; make_product
  login
  start_launch -- "$E/kit/omnigent-host-launch" -- "$E/product.sh" "arg one" 'two  "quoted"' ''
  check "supervisor started in the background (host running)" wait_for 10 st_is running
  check "product started" wait_for 5 test -s "$E/prod/pid"
  check "product argv passed unchanged (spaces, quotes, empty arg)" bash -c "[ \"\$(cat '$E/prod/argv')\" = \"\$(printf '%s\n' 'arg one' 'two  \"quoted\"' '')\" ]"
  check "product PATH starts with the kit's bin" bash -c "case \$(cat '$E/prod/path') in '$E/kit/bin:'*) exit 0;; esac; exit 1"
  check "product keeps its own env (PASSWORD), the host does not (OG_UNSET_ENV)" bash -c "grep -qx product-secret '$E/prod/password' && grep -qx 'PASSWORD=<unset>' '$E/og/env-1.txt'"
  check "supervisor runs the real CLI, not the guard" grep -qx "argv=host --server $URL --non-interactive --no-open" "$E/og/env-1.txt"
  local prod hp
  prod=$(cat "$E/prod/pid")
  hp=$(host_pid)
  check "product is not the launcher (launcher stays to order the stop)" test "$prod" != "$L_PID"
  check "product in its own session (group-wide init signals reach only the launcher)" test "$(python3 -c 'import os, sys; print(os.getsid(int(sys.argv[1])))' "$prod")" = "$prod"
  # dumb-init style: SIGTERM to the launcher's whole process group
  kill -TERM -- "-$L_PID"
  check "launcher exits after SIGTERM" wait_for 15 dead "$L_PID"
  reap "$L_PID"
  check "product got SIGTERM" test -s "$E/prod/term"
  check "ordering: supervisor had already stopped (status stopped) when the product got SIGTERM" grep -q 'status=stopped' "$E/prod/term"
  check "ordering: the host was already gone when the product got SIGTERM" grep -q 'host=dead' "$E/prod/term"
  check "host stopped" dead "$hp"
  echo "- launcher: product exit code, HUP forwarding, product crash stops the supervisor"
  rm -rf "$E/prod"
  start_launch -- "$E/kit/omnigent-host-launch" "$E/product.sh"
  wait_for 10 st_is running || bad "launch2: host did not come up"
  wait_for 5 test -s "$E/prod/pid"
  hp=$(host_pid)
  kill -HUP "$L_PID"
  check "SIGHUP forwarded to the product" wait_for 4 test -s "$E/prod/hup"
  check "SIGHUP does not stop the host" alive "$hp"
  kill -TERM "$(cat "$E/prod/pid")"     # the product ends by itself (rc 0 from its trap)
  check "product exit -> launcher exits" wait_for 15 dead "$L_PID"
  reap "$L_PID"
  check "launcher exit code = product's (0)" test "$?" = 0
  check "product exit -> supervisor stopped too" st_is stopped
  check "product exit -> host stopped" dead "$hp"
  rm -rf "$E/prod"
  start_launch PROD_EXIT=3 -- "$E/kit/omnigent-host-launch" -- "$E/product.sh"
  check "crashing product: launcher exits" wait_for 15 dead "$L_PID"
  reap "$L_PID"
  check "crashing product: exit code 3 propagated" test "$?" = 3
  echo "- launcher: stdin, a second manual omnigent host inside the product, disabled/no-CLI exec"
  rm -rf "$E/prod"
  : >"$E/og/calls.log"
  printf 'hello stdin\n' | {
    # shellcheck disable=SC2086
    env -i PATH="$E/bin:$TEST_PATH" HOME="$E/home" PYTHONPATH="$YAML_PATH" OG_HOST_ENABLED=1 OG_KIT_DIR="$E/kit" OG_SHELL="$SUP_SHELL_BIN" \
      OG_CONFIG_HOME="$E/data" OG_DATA_DIR="$E/data" OMNIGENT_DATA_DIR="$E/data" OG_STATUS_FILE="$STATUS_FILE" STATUS_FILE="$STATUS_FILE" \
      OG_SERVER_URL="$URL" OG_IDLE_SECONDS=1 OG_TICK_SECONDS=1 OG_STOP_GRACE_SECONDS=2 FAKE_OG_DIR="$E/og" PROD_OUT="$E/prod" PROD_READ=1 \
      PROD_RUN='sleep 4; timeout 5 omnigent host; echo "host-rc=$?"; timeout 5 omni host; echo "omni-rc=$?"; timeout 5 omnigent host status; omnigent-host-status --motd >/dev/null && echo motd-ok' PROD_EXIT=0 \
      $SUP_SHELL "$E/kit/omnigent-host-launch" -- "$E/product.sh" >>"$E/launch.log" 2>&1
  }
  check "product received the container's stdin" grep -qx 'hello stdin' "$E/prod/stdin"
  check "manual 'omnigent host' in the product's terminal fails clearly" grep -q 'already running, managed automatically — see omnigent-host-status' "$E/prod/run.out"
  check "... with exit 1" grep -qx 'host-rc=1' "$E/prod/run.out"
  check "manual 'omni host' (the CLI's second entry point) fails the same way" grep -qx 'omni-rc=1' "$E/prod/run.out"
  check "... and never reached the real CLI as a second host" bash -c "! grep -qx 'host' '$E/og/calls.log'"
  check "'omnigent host status' passes through to the real CLI" grep -qx 'host status' "$E/og/calls.log"
  check "omnigent-host-status on the product's PATH" grep -q 'motd-ok' "$E/prod/run.out"
  rm -rf "$E/prod"
  env -i PATH="$E/bin:$TEST_PATH" PROD_OUT="$E/prod" OG_KIT_DIR="$E/kit" $SUP_SHELL "$E/kit/omnigent-host-launch" -- "$E/product.sh" &
  local lp=$!
  wait_for 5 test -s "$E/prod/pid"
  check "OG_HOST_ENABLED unset: launcher execs the product (same pid)" test "$(cat "$E/prod/pid")" = "$lp"
  check "OG_HOST_ENABLED unset: PATH untouched" bash -c "! grep -q '$E/kit/bin' '$E/prod/path'"
  kill -TERM "$lp"; wait_for 5 dead "$lp"; reap "$lp"
  rm -rf "$E/prod"
  rm -f "$E/bin/omnigent"
  env -i PATH="$E/bin:$TEST_PATH" PROD_OUT="$E/prod" OG_HOST_ENABLED=1 OG_KIT_DIR="$E/kit" $SUP_SHELL "$E/kit/omnigent-host-launch" "$E/product.sh" &
  lp=$!
  wait_for 5 test -s "$E/prod/pid"
  check "no omnigent CLI in the image: launcher execs the product (same pid)" test "$(cat "$E/prod/pid")" = "$lp"
  kill -TERM "$lp"; wait_for 5 dead "$lp"; reap "$lp"
  ln -s "$HERE/fake_omnigent" "$E/bin/omnigent"
  check "no product command: usage error 64" bash -c "env -i PATH='$TEST_PATH' $SUP_SHELL '$E/kit/omnigent-host-launch' >/dev/null 2>&1; [ \$? -eq 64 ]"
  echo "- image stub omnigent-host-entry"
  rm -rf "$E/prod"
  env -i PATH="$E/bin:$TEST_PATH" PROD_OUT="$E/prod" OG_KIT_DIR="$E/nokit" $SUP_SHELL "$KIT/image/omnigent-host-entry" "$E/product.sh" x &
  lp=$!
  wait_for 5 test -s "$E/prod/pid"
  check "entry stub without a mounted kit: execs the product (same pid)" test "$(cat "$E/prod/pid")" = "$lp"
  kill -TERM "$lp"; wait_for 5 dead "$lp"; reap "$lp"
  rm -rf "$E/prod" "$STATUS_FILE"
  start_launch -- "$KIT/image/omnigent-host-entry" "$E/product.sh"
  check "entry stub with the kit mounted: runs the launcher (supervisor up)" wait_for 10 st_is running
  check "... and the product" wait_for 5 test -s "$E/prod/pid"
  kill -TERM -- "-$L_PID"; wait_for 15 dead "$L_PID"
  check "... ordered stop through the stub" grep -q 'status=stopped' "$E/prod/term"
}

t_shim() {
  echo "- bin/omnigent guard: a second manual host fails clearly, everything else passes through"
  new_env shim || return
  kit_dir "$E/kit"
  mkdir -p "$E/data/omnigent-host"
  : >"$E/og/calls.log"
  sh_og() { env -i PATH="$E/kit/bin:$E/kit/bin:$E/bin:$TEST_PATH" HOME="$E/home" PYTHONPATH="$YAML_PATH" OG_DATA_DIR="$E/data" FAKE_OG_DIR="$E/og" OG_STATUS_FILE="$E/none.json" "$@" >"$E/shim.out" 2>&1; }
  sh_og timeout 3 $SUP_SHELL "$E/kit/bin/omnigent" host --server http://x
  check "not managed (no supervisor holds the lock): 'omnigent host' passes through" grep -qx 'host --server http://x' "$E/og/calls.log"
  printf '{\n  "schema": 1,\n  "server": "%s"\n}\n' "$URL" >"$E/st-old.json"
  : >"$E/og/calls.log"
  # shellcheck disable=SC2086
  sh_og OG_STATUS_FILE="$E/st-old.json" timeout 3 $SUP_SHELL "$E/kit/bin/omnigent" claude --server http://other.example:1
  check "not managed: 'omnigent claude --server <other>' passes through" grep -qx 'claude --server http://other.example:1' "$E/og/calls.log"
  # a supervisor holding the lock
  flock "$E/data/omnigent-host/supervisor.lock" sleep 60 &
  local lk=$!
  PIDS+=("$lk")
  sleep 0.5
  local c
  for c in "host" "host --server http://x" "host http://x" "host --background" "host enable" "host stop" "start" "stop"; do
    : >"$E/og/calls.log"
    # shellcheck disable=SC2086
    sh_og timeout 5 $SUP_SHELL "$E/kit/bin/omnigent" $c   # a broken guard would start a (never-ending) host
    local rc=$?
    check "managed: 'omnigent $c' -> exit 1 with a clear message, real CLI not run" bash -c "[ $rc -eq 1 ] && grep -q 'already running, managed automatically — see omnigent-host-status' '$E/shim.out' && [ ! -s '$E/og/calls.log' ]"
  done
  for c in "--debug host" "--log-to-stderr --profiling host --server http://x" "host --debug" "--debug start" "--profiling stop"; do
    : >"$E/og/calls.log"
    # shellcheck disable=SC2086
    sh_og timeout 5 $SUP_SHELL "$E/kit/bin/omnigent" $c
    local rc=$?
    check "managed, global options first: 'omnigent $c' -> exit 1, real CLI not run" bash -c "[ $rc -eq 1 ] && grep -q 'already running, managed automatically' '$E/shim.out' && [ ! -s '$E/og/calls.log' ]"
  done
  for c in "host" "host --server http://x" "--debug host stop" "start"; do
    : >"$E/og/calls.log"
    # shellcheck disable=SC2086
    sh_og timeout 5 $SUP_SHELL "$E/kit/bin/omni" $c
    local rc=$?
    check "managed: 'omni $c' (bin/omni) -> exit 1, real CLI not run" bash -c "[ $rc -eq 1 ] && grep -q 'already running, managed automatically' '$E/shim.out' && [ ! -s '$E/og/calls.log' ]"
  done
  for c in "host --server http://x status" "--log-to-stderr host status" "host --background --no-open reset-id --yes" "--version"; do
    : >"$E/og/calls.log"
    # shellcheck disable=SC2086
    sh_og timeout 3 $SUP_SHELL "$E/kit/bin/omnigent" $c
    check "managed: 'omnigent $c' passes through to the real CLI" grep -qx -- "$c" "$E/og/calls.log"
  done
  : >"$E/og/calls.log"
  # shellcheck disable=SC2086
  sh_og timeout 3 $SUP_SHELL "$E/kit/bin/omni" host status
  check "managed: 'omni host status' passes through to the real CLI" grep -qx -- "host status" "$E/og/calls.log"
  : >"$E/og/calls.log"
  # shellcheck disable=SC2086
  sh_og timeout 3 $SUP_SHELL "$E/kit/bin/omnigent" </dev/null
  check "managed: bare 'omnigent' without a terminal (= --help) passes through" bash -c "[ \"\$(cat '$E/og/calls.log')\" = '' ] && [ \"\$(wc -l <'$E/og/calls.log')\" -eq 1 ]"
  if command -v script >/dev/null 2>&1; then
    : >"$E/og/calls.log"
    SHELL=/bin/sh script -qec "env -i PATH='$E/kit/bin:$E/bin:$TEST_PATH' HOME='$E/home' PYTHONPATH='$YAML_PATH' OG_DATA_DIR='$E/data' FAKE_OG_DIR='$E/og' OG_STATUS_FILE='$E/none.json' $SUP_SHELL '$E/kit/bin/omnigent'; echo rc=\$?" /dev/null >"$E/tty.out" 2>&1
    check "managed: bare 'omnigent' on a terminal (= omnigent start) -> exit 1, real CLI not run" bash -c "grep -q 'rc=1' '$E/tty.out' && grep -q 'already running, managed automatically' '$E/tty.out' && [ ! -s '$E/og/calls.log' ]"
  else
    ok "bare 'omnigent' on a terminal: skipped (no script(1) to make a pty)"
  fi
  echo "- bin/omnigent guard: commands that spawn their own host daemon with another --server"
  printf '{\n  "schema": 1,\n  "state": "running",\n  "server": "%s",\n  "host_name": "x"\n}\n' "$URL" >"$E/st-run.json"
  local ucase
  ucase=$(printf '%s' "$URL" | sed 's|^http://|HTTP://|')
  for c in "claude --server http://other.example:1" "run --server=http://other.example:1 agent.yaml" "--debug codex --server http://other.example:1" \
    "./agent.yaml --server http://other.example:1" "--harness claude-native --server http://other.example:1" "resume conv1 --server http://other.example:1" \
    "kimi --server local" "polly --server $URL/x" "claude --server http://other.example:1 -- --help"; do
    : >"$E/og/calls.log"
    # shellcheck disable=SC2086
    sh_og OG_STATUS_FILE="$E/st-run.json" timeout 5 $SUP_SHELL "$E/kit/bin/omnigent" $c
    local rc=$?
    check "managed: 'omnigent $c' -> exit 1 (another server), real CLI not run" bash -c "[ $rc -eq 1 ] && grep -q 'is not the server of this environment' '$E/shim.out' && grep -q '同一個 host_id' '$E/shim.out' && [ ! -s '$E/og/calls.log' ]"
  done
  : >"$E/og/calls.log"
  # shellcheck disable=SC2086
  sh_og OG_STATUS_FILE="$E/st-run.json" timeout 5 $SUP_SHELL "$E/kit/bin/omni" pi --server http://other.example:1
  check "managed: 'omni pi --server <other>' -> refused too" bash -c "[ ! -s '$E/og/calls.log' ] && grep -q 'is not the server of this environment' '$E/shim.out'"
  for c in "claude --server $URL" "claude --server $URL/" "claude --server=$ucase" "claude" "claude -- --server http://other.example:1" \
    "codex -s workspace-write" "session list --server http://other.example:1" "claude --server http://other.example:1 --help"; do
    : >"$E/og/calls.log"
    # shellcheck disable=SC2086
    sh_og OG_STATUS_FILE="$E/st-run.json" timeout 3 $SUP_SHELL "$E/kit/bin/omnigent" $c
    check "managed: 'omnigent $c' passes through (same server, no --server, or not a host-spawning command)" grep -qx -- "$c" "$E/og/calls.log"
  done
  printf '{\n  "schema": 1,\n  "state": "waiting-login",\n  "server": "",\n  "host_name": "x"\n}\n' >"$E/st-wait.json"
  printf '%s\n' "$URL" >"$E/server-url"
  : >"$E/og/calls.log"
  # shellcheck disable=SC2086
  sh_og OG_STATUS_FILE="$E/st-wait.json" OG_SERVER_URL_FILE="$E/server-url" timeout 5 $SUP_SHELL "$E/kit/bin/omnigent" claude --server http://other.example:1
  check "no host started yet: compared with the runtime Omnigent URL (refused)" bash -c "[ ! -s '$E/og/calls.log' ] && grep -q 'is not the server of this environment' '$E/shim.out'"
  : >"$E/og/calls.log"
  # shellcheck disable=SC2086
  sh_og OG_STATUS_FILE="$E/st-wait.json" OG_SERVER_URL_FILE="$E/server-url" timeout 5 $SUP_SHELL "$E/kit/bin/omnigent" claude --server "$URL"
  check "... the runtime URL itself passes through" grep -qx -- "claude --server $URL" "$E/og/calls.log"
  : >"$E/og/calls.log"
  # shellcheck disable=SC2086
  sh_og OG_STATUS_FILE="$E/st-wait.json" timeout 5 $SUP_SHELL "$E/kit/bin/omnigent" claude --server http://other.example:1
  check "server unknown (no status server, no runtime URL): passes through" grep -qx -- "claude --server http://other.example:1" "$E/og/calls.log"
  for c in "host status" "host reset-id --yes" "host stop-session abc" "login http://x" "host --help" "session list"; do
    : >"$E/og/calls.log"
    # shellcheck disable=SC2086
    sh_og timeout 3 $SUP_SHELL "$E/kit/bin/omnigent" $c
    check "managed: 'omnigent $c' passes through to the real CLI" grep -qx -- "$c" "$E/og/calls.log"
  done
  : >"$E/og/calls.log"
  sh_og OG_SHIM_BYPASS=1 timeout 3 $SUP_SHELL "$E/kit/bin/omnigent" host --server http://y
  check "OG_SHIM_BYPASS=1 disables the guard" grep -qx 'host --server http://y' "$E/og/calls.log"
  kill_quiet "$lk"
  rm -f "$E/bin/omnigent"
  sh_og $SUP_SHELL "$E/kit/bin/omnigent" login x
  check "no real CLI: exit 127, no self-recursion" bash -c "[ $? -eq 127 ] && grep -q 'not installed' '$E/shim.out'"
  ln -s "$HERE/fake_omnigent" "$E/bin/omnigent"
  echo "- omnigent-host-profile.sh (shells entered with kubectl exec)"
  local out
  out=$(env -i PATH=/usr/bin:/bin OG_KIT_DIR="$E/kit" $SUP_SHELL -c ". '$E/kit/omnigent-host-profile.sh'; . '$E/kit/omnigent-host-profile.sh'; printf '%s' \"\$PATH\"")
  check "profile puts the kit's bin first on PATH, once" test "$out" = "$E/kit/bin:/usr/bin:/bin"
  printf '{\n  "schema": 1,\n  "state": "waiting-login",\n  "login_command": "omnigent login http://x"\n}\n' >"$E/st.json"
  out=$(env -i PATH=/usr/bin:/bin OG_KIT_DIR="$E/kit" OG_STATUS_FILE="$E/st.json" $SUP_SHELL -c ". '$E/kit/omnigent-host-profile.sh'")
  check "non-interactive shell: no MOTD" test -z "$out"
  out=$(env -i PATH=/usr/bin:/bin OG_KIT_DIR="$E/kit" OG_STATUS_FILE="$E/st.json" ENV= $SUP_SHELL -i -c ". '$E/kit/omnigent-host-profile.sh'" 2>/dev/null)
  check "interactive shell: MOTD with the login command" grep -q 'omnigent login http://x' <<<"$out"
  out=$(env -i PATH=/usr/bin:/bin $SUP_SHELL -c ". '$E/kit/omnigent-host-profile.sh'; echo rc=\$?; printf '%s' \"\$PATH\"")
  check "no OG_KIT_DIR: harmless (rc 0, PATH unchanged)" test "$out" = "rc=0
/usr/bin:/bin"
}

leak_check() {
  echo "- no token ever appears outside auth_tokens.json"
  local hits
  hits=$(grep -rl 'SECRET-' "$WORK" 2>/dev/null | grep -v '/auth_tokens\.json$' || true)
  check "no SECRET-* token in logs, status, config or stdout${hits:+ (found in: $hits)}" test -z "$hits"
}

run_suite() {
  RUN_TAG=$1 SUP_SHELL=$2 TEST_PATH=$3
  SUP_SHELL_BIN=$(command -v "$2")
  echo "=== supervisor under: $SUP_SHELL ==="
  local t
  for t in ${OG_TEST_ONLY:-t_helper_seed t_helper_workspace t_helper_state t_status_printer t_idle_login_start t_outage t_single_401 t_revoked t_expired t_409 t_sigkill t_logs t_lock t_relogin t_image t_reconnect t_server_url_file t_memory t_launch t_shim t_pinned}; do
    "$t"
  done
}

BASE_PATH=$(dirname "$(command -v python3)"):/usr/local/bin:/usr/bin:/bin
for s in ${OG_TEST_SHELLS:-sh}; do
  run_suite "$(basename "$s")" "$s" "$BASE_PATH"
done
if [ -n "${OG_TEST_BUSYBOX:-}" ]; then
  bb=$WORK/busybox-bin
  mkdir -p "$bb"
  for a in sh flock setsid stat find du tail wc date tr sed awk grep ls cp mv rm mkdir cat sleep head readlink dirname basename chmod ln kill env; do
    ln -sf "$OG_TEST_BUSYBOX" "$bb/$a"
  done
  run_suite busybox "$bb/sh" "$bb:$BASE_PATH"
fi
leak_check
echo
echo "omnigent-host kit: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
