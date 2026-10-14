#!/usr/bin/env python3
"""Mutation check for the shared omnigent-host kit: every mutant MUST make a test FAIL.

Proves that the checks in run-tests.sh / test-chart-snippet.sh are not vacuous:
each entry breaks one guarantee of the kit (in a scratch copy) and runs only the
scenarios that should catch it. A mutant that leaves the suite green "SURVIVED"
and the script exits 1.

  python3 shared/omnigent-host/tests/mutation-check.py            # all mutants
  python3 shared/omnigent-host/tests/mutation-check.py 3 17 c2    # a selection
  OG_MUT_JOBS=6 (parallel jobs), OG_MUT_KEEP=1 (keep the scratch copies)

Needs what the two suites need (python3 + PyYAML, flock, setsid; helm and yq for
the chart mutants "c*").
"""
import concurrent.futures as cf
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(KIT))

# Behaviour mutants: (name, file in the kit, old, new, OG_TEST_ONLY scenarios)
M = [
 ("launch: supervisor not started", "omnigent-host-launch",
  'OG_BIN=$REAL_OG $SETSID "${OG_SHELL:-/bin/sh}" "$KIT/supervisor.sh" </dev/null &', 'true &', "t_launch"),
 ("launch: product exec'd without kit PATH", "omnigent-host-launch",
  'PATH="$KIT/bin${PATH:+:$PATH}"; export PATH', ':', "t_launch"),
 ("launch: product signalled before supervisor stops", "omnigent-host-launch",
  '  stop_supervisor\n  [ -n "$PROD" ] && signal_group "$1" "$PROD"',
  '  [ -n "$PROD" ] && signal_group "$1" "$PROD"\n  stop_supervisor', "t_launch"),
 ("launch: product exit code dropped", "omnigent-host-launch", 'exit "$rc"', 'exit 0', "t_launch"),
 ("launch: SIGHUP not forwarded", "omnigent-host-launch", "trap 'forward HUP' HUP", "trap '' HUP", "t_launch"),
 ("launch: product not in own session", "omnigent-host-launch", '$SETSID "$@" <&3 3<&- &', '"$@" <&3 3<&- &', "t_launch"),
 ("launch: product stdin lost", "omnigent-host-launch", '$SETSID "$@" <&3 3<&- &', '$SETSID "$@" </dev/null 3<&- &', "t_launch"),
 ("launch: disabled still launches", "omnigent-host-launch", '  *) exec "$@" ;;\nesac', '  *) ;;\nesac', "t_launch"),
 ("entry stub: never runs the launcher", "image/omnigent-host-entry", '[ -r "$L" ] && exec', '[ -r "$L/x" ] && exec', "t_launch"),
 ("supervisor: serverUrl file ignored", "supervisor.sh",
  'if [ -z "$SURL" ] && [ -n "$OG_SERVER_URL_FILE" ]', 'if false', "t_server_url_file"),
 ("supervisor: serverUrl read once (cached)", "supervisor.sh",
  'read_server_url() {\n  SURL=$OG_SERVER_URL', 'read_server_url() {\n  [ -n "${SURL_DONE:-}" ] && return; SURL_DONE=1\n  SURL=$OG_SERVER_URL', "t_server_url_file"),
 ("status: runtime serverUrl file ignored", "omnigent-host-status",
  '[ -n "$surl" ] && login="omnigent login $surl"', ':', "t_status_printer"),
 ("status: host-error silent in --motd", "omnigent-host-status",
  '  host-error)\n    needs_action=1', '  host-error)\n    [ "$mode" = motd ] && exit 0', "t_status_printer"),
 ("supervisor: no refresh on reconnect", "supervisor.sh",
  'if [ -n "$UNREACH_AT" ] && host_reconnected_since "$UNREACH_AT"; then', 'if false; then', "t_reconnect"),
 ("supervisor: no short re-probe while unreachable", "supervisor.sh",
  '_next=$(($(now) + OG_UNREACHABLE_PROBE_SECONDS))', ':', "t_reconnect"),
 ("supervisor: no oom_score_adj", "supervisor.sh",
  '{ printf \'%s\\n\' "$OG_OOM_SCORE_ADJ" >/proc/self/oom_score_adj; }', ':', "t_memory"),
 ("supervisor: guard may kill the host", "supervisor.sh", '    [ "$_pid" = "$child" ] && continue\n', '', "t_memory"),
 ("supervisor: guard counts page cache", "supervisor.sh", '_ws=$((_use - _inact))', '_ws=$_use', "t_memory"),
 ("supervisor: guard ignores OG_HOST_TREE", "supervisor.sh",
  'grep -qx "OG_HOST_TREE=$SUP_PID" || continue', 'true', "t_memory"),
 ("supervisor: guard off", "supervisor.sh", '  [ "$MG_PCT" -ge "$OG_MEM_GUARD_PERCENT" ] || return 0', '  return 0', "t_memory"),
 ("supervisor: telemetry env not exported", "supervisor.sh",
  'export OMNIGENT_ANALYTICS=0 DO_NOT_TRACK=1 DISABLE_TELEMETRY=1', 'export DO_NOT_TRACK=1 DISABLE_TELEMETRY=1', "t_idle_login_start"),
 ("supervisor: reset-id hint without --yes", "supervisor.sh",
  '"omnigent host reset-id --yes"', '"omnigent host reset-id"', "t_409"),
 ("supervisor: status not stopped on TERM", "supervisor.sh",
  'set_status stopped "supervisor stopped (container terminating)"', ':', "t_launch"),
 ("supervisor: disabled still runs", "supervisor.sh",
  '  0 | false | no | off) log "omnigentHost disabled', '  0x) log "omnigentHost disabled', "t_image"),
 ("supervisor: image-too-old idles instead of exiting", "supervisor.sh",
  '  [ -n "${2:-}" ] && set_status "$2" "${3:-$1}" "${4:-}"\n  exit 0',
  '  [ -n "${2:-}" ] && set_status "$2" "${3:-$1}" "${4:-}"\n  while :; do sleep 3600; done', "t_image"),
 ("supervisor: shim used as the CLI", "supervisor.sh",
  'og_bin_path=$(og_real_bin "$OG_BIN" || true)', 'og_bin_path=$(command -v "$OG_BIN" || true)', "t_launch t_image"),
 ("shim: never managed", "omnigent-shim", '  [ $? -eq 1 ]\n}', '  false\n}', "t_shim t_launch"),
 ("shim: host status guarded too", "omnigent-shim", '    status | stop-session | reset-id | disable) ;;', '    stop-session | reset-id | disable) ;;', "t_shim"),
 ("shim: 'omnigent start' not guarded", "omnigent-shim", '    start) guard=start ;;', '    start) ;;', "t_shim"),
 ("shim: exits 0 when refusing", "omnigent-shim", '  command -v omnigent-host-status >/dev/null 2>&1 && omnigent-host-status >&2\n  exit 1', '  exit 0', "t_shim"),
 ("profile: no PATH", "omnigent-host-profile.sh", 'PATH="$OG_KIT_DIR/bin${PATH:+:$PATH}"; export PATH', ':', "t_shim"),
 ("profile: MOTD in every shell", "omnigent-host-profile.sh", '  *i*) command', '  *) command', "t_shim"),
 ("helper: name escaped (allow_unicode False)", "og_helper.py", 'allow_unicode=unicode_ok()', 'allow_unicode=False', "t_helper_seed"),
 ("helper: name always readable", "og_helper.py", 'allow_unicode=unicode_ok()', 'allow_unicode=True', "t_helper_seed"),
 ("helper: telemetry not enforced", "og_helper.py", None, None, "t_helper_seed t_idle_login_start"),
 ("supervisor: tokens not re-tightened (fsGroup)", "supervisor.sh", '[ -f "$TOKENS" ] && chmod go-rwx "$TOKENS" 2>/dev/null', ':', "t_idle_login_start"),
 ("shim: global options not looked past", "omnigent-shim",
  '      --debug | --log-to-stderr) shift ;;\n      --profiling) _prof=1; shift ;;', '      --profiling) _prof=1; shift ;;', "t_shim"),
 ("shim: host group options not looked past", "omnigent-shim",
  '      --server=* | --no-open | --background | --non-interactive | --debug | --log-to-stderr) shift ;;\n', '', "t_shim"),
 ("shim: bare omnigent on a terminal not guarded", "omnigent-shim", '[ -z "$_prof" ] && [ -t 0 ] && guard=start', ':', "t_shim"),
 ("shim: another --server not refused", "omnigent-shim", "  given=${_srv:-'\"\"'}\n  guard=server", "  given=${_srv:-'\"\"'}", "t_shim"),
 ("shim: harness command (claude) not checked", "omnigent-shim",
  'run | polly | debby | copilot | resume | claude |', 'run | polly | debby | copilot | resume |', "t_shim"),
 ("shim: server compared without normalising", "omnigent-shim",
  '[ "$(norm_url "$_srv")" = "$want" ] && return 0', '[ "$_srv" = "$want" ] && return 0', "t_shim"),
 ("shim: --server after -- counted", "omnigent-shim", '      --) break ;;\n      --server) _has=1', '      --server) _has=1', "t_shim"),
 ("shim: --help after -- honoured", "omnigent-shim", '      --) break ;;\n      --help | -h) guard="" ;;', '      --help | -h) guard="" ;;', "t_shim"),
 ("shim: runtime URL fallback ignored", "omnigent-shim", 'IFS= read -r _s <"$OG_SERVER_URL_FILE" || :', ':', "t_shim"),
 ("launch: absolute OG_BIN looked up on PATH", "omnigent-host-launch",
  'case $1 in */*) [ -x "$1" ] && printf \'%s\' "$1"; return ;; esac', 'case $1 in */*) set -- "${1##*/}" ;; esac', "t_pinned"),
 ("launch: tenant copy under HOME used", "omnigent-host-launch", '    under_home "$_c" && continue\n', '', "t_pinned"),
 ("supervisor: absolute OG_BIN looked up on PATH", "supervisor.sh",
  'case $1 in */*) [ -x "$1" ] && printf \'%s\' "$1"; return ;; esac', 'case $1 in */*) set -- "${1##*/}" ;; esac', "t_pinned"),
 ("supervisor: tenant copy under HOME used", "supervisor.sh", '    under_home "$_c" && continue\n', '', "t_pinned"),
 ("supervisor: product HOME not skipped (OG_HOME set)", "supervisor.sh", 'for _h in "$HOME0" "$HOME"', 'for _h in "$HOME"', "t_pinned"),
]

# Chart mutants: (name, file in the kit, old, new) -> test-chart-snippet.sh must fail
C = [
 ("tpl: runtime ConfigMap mounted read-write", "chart/_omnigent-host.tpl",
  "- name: omnigent-host-runtime\n  mountPath: {{ include \"woow.omnigentHost.runtimeDir\" .root }}\n  readOnly: true",
  "- name: omnigent-host-runtime\n  mountPath: {{ include \"woow.omnigentHost.runtimeDir\" .root }}"),
 ("tpl: runtime ConfigMap as a subPath mount", "chart/_omnigent-host.tpl",
  "  mountPath: {{ include \"woow.omnigentHost.runtimeDir\" .root }}\n",
  "  mountPath: {{ include \"woow.omnigentHost.runtimeDir\" .root }}\n  subPath: server-url\n"),
 ("tpl: serverUrl rendered into the pod env", "chart/_omnigent-host.tpl",
  "- name: OMNIGENT_HOST_NO_OPEN\n",
  "- name: OG_SERVER_URL\n  value: {{ include \"woow.omnigentHost.serverUrl\" $root | quote }}\n- name: OMNIGENT_HOST_NO_OPEN\n"),
 ("tpl: checksum covers the runtime ConfigMap", "chart/_omnigent-host.tpl",
  "{{- include \"woow.omnigentHost.kitConfigMap\" . | sha256sum -}}",
  "{{- include \"woow.omnigentHost.configMaps\" . | sha256sum -}}"),
 ("tpl: launcher missing from the command", "chart/_omnigent-host.tpl",
  "{{- $cmd = concat (list \"/bin/sh\" (printf \"%s/omnigent-host-launch\" (include \"woow.omnigentHost.kitDir\" .root)) \"--\") $cmd -}}", ""),
 ("tpl: telemetry env only when enabled", "chart/_omnigent-host.tpl",
  "# Telemetry off for every omnigent process (also enforced in config.yaml).\n- name: OMNIGENT_ANALYTICS\n  value: \"0\"\n- name: DO_NOT_TRACK\n  value: \"1\"\n- name: DISABLE_TELEMETRY\n  value: \"1\"\n{{- if include \"woow.omnigentHost.enabled\" $root }}\n", "{{- if include \"woow.omnigentHost.enabled\" $root }}\n# Telemetry off for every omnigent process (also enforced in config.yaml).\n- name: OMNIGENT_ANALYTICS\n  value: \"0\"\n- name: DO_NOT_TRACK\n  value: \"1\"\n- name: DISABLE_TELEMETRY\n  value: \"1\"\n"),
 ("tpl: no bin/omnigent guard projected", "chart/_omnigent-host.tpl",
  "      - {key: omnigent-shim, path: bin/omnigent, mode: 365}\n", ""),
 ("tpl: OMNIGENT_CONFIG_HOME not the login dir", "chart/_omnigent-host.tpl",
  "- name: OMNIGENT_CONFIG_HOME\n  value: {{ .configHome | quote }}", "- name: OMNIGENT_CONFIG_HOME\n  value: \"/tmp/elsewhere\""),
 ("tpl: watchSeconds floor dropped", "chart/_omnigent-host.tpl", "{{- if lt (int $w) 30 -}}", "{{- if lt (int $w) 0 -}}"),
 ("tpl: serverUrl userinfo accepted", "chart/_omnigent-host.tpl", "(not $u.host) $u.userinfo $u.query", "(not $u.host) $u.query"),
 ("tpl: default host name changed", "chart/_omnigent-host.tpl", "(printf \"%s · %s\" .Chart.Name .Release.Name)", "(printf \"%s\" .Release.Name)"),
 ("tpl: kit volumes rendered when disabled", "chart/_omnigent-host.tpl",
  "{{- define \"woow.omnigentHost.volumes\" -}}\n{{- if include \"woow.omnigentHost.enabled\" .root }}",
  "{{- define \"woow.omnigentHost.volumes\" -}}\n{{- if true }}"),
 ("lib: workload picked without the main container", "chart/kit-test-lib.sh", "  if [ -n \"$main\" ]; then", "  if false; then"),
 ("lib: vendored check ignores the launcher", "chart/kit-test-lib.sh",
  "KIT_RUNTIME_FILES=(supervisor.sh og_helper.py omnigent-host-status omnigent-host-launch omnigent-host-profile.sh omnigent-shim)",
  "KIT_RUNTIME_FILES=(supervisor.sh og_helper.py omnigent-host-status omnigent-host-profile.sh omnigent-shim)"),
 ("tpl: no bin/omni guard projected", "chart/_omnigent-host.tpl",
  "      - {key: omnigent-shim, path: bin/omni, mode: 365}\n", ""),
 ("tpl: OG_BIN not rendered", "chart/_omnigent-host.tpl",
  "- name: OG_BIN\n  value: {{ include \"woow.omnigentHost.ogBin\" . | quote }}\n", ""),
 ("tpl: relative ogBin accepted", "chart/_omnigent-host.tpl",
  "{{- if or (not (hasPrefix \"/\" $b)) (contains", "{{- if or (contains"),
 ("lib: OG_BIN not checked", "chart/kit-test-lib.sh",
  "    /*) _kit_ok \"OG_BIN is an absolute path", "    *) _kit_ok \"OG_BIN is an absolute path"),
]


def mutate(path, old, new):
    s = open(path).read()
    if old is None:  # helper telemetry: drop the line that enforces it
        m = re.search(r'.*\["telemetry"\]\s*=\s*False.*\n', s)
        if not m:
            return False
        s = s.replace(m.group(0), "")
    else:
        if old not in s:
            return False
        s = s.replace(old, new)
    open(path, "w").write(s)
    return True


def run_suite(cmd, env, timeout, logfile):
    """Run a suite in its own session with output to a file (a stray background
    process can then neither keep a pipe open nor survive a timeout). A suite
    that hangs is reported as TIMEOUT, which counts as a failure of this check:
    a broken guarantee must make a test FAIL, not hang."""
    with open(logfile, "w") as out:
        p = subprocess.Popen(cmd, env=env, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            rc = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            rc = None
        finally:
            try:
                os.killpg(p.pid, 9)
            except OSError:
                pass
            p.wait()
    return rc, open(logfile, errors="replace").read()


def verdict(rc, stdout):
    fails = [l for l in stdout.splitlines() if l.startswith("  FAIL")]
    if rc is None:
        return "TIMEOUT", "\n".join(fails[:3])
    return ("KILLED" if rc != 0 and fails else "SURVIVED"), "\n".join(fails[:3])


def run_behaviour(base, i):
    name, f, old, new, only = M[i]
    d = os.path.join(base, f"m{i:02d}")
    shutil.copytree(KIT, f"{d}/kit", symlinks=True, ignore=shutil.ignore_patterns("__pycache__"))
    if not mutate(f"{d}/kit/{f}", old, new):
        return f"{i:02d}", name, "MUTATION-NOT-APPLIED", ""
    os.makedirs(f"{d}/tmp")
    env = dict(os.environ, TMPDIR=f"{d}/tmp", OG_TEST_ONLY=only, OG_TEST_SHELLS="sh")
    env.pop("OG_TEST_BUSYBOX", None)
    rc, out = run_suite(["bash", f"{d}/kit/tests/run-tests.sh"], env, 900, f"{d}/suite.log")
    return (f"{i:02d}", name) + verdict(rc, out)


def run_chart(base, i):
    name, f, old, new = C[i]
    d = os.path.join(base, f"c{i:02d}")
    for sub in ("shared", "scripts"):
        shutil.copytree(f"{ROOT}/{sub}", f"{d}/{sub}", symlinks=True, ignore=shutil.ignore_patterns("__pycache__"))
    if not mutate(f"{d}/shared/omnigent-host/{f}", old, new):
        return f"c{i}", name, "MUTATION-NOT-APPLIED", ""
    os.makedirs(f"{d}/tmp")
    env = dict(os.environ, TMPDIR=f"{d}/tmp")
    rc, out = run_suite(["bash", f"{d}/shared/omnigent-host/tests/test-chart-snippet.sh"], env, 600, f"{d}/suite.log")
    return (f"c{i}", name) + verdict(rc, out)


def main():
    sel = sys.argv[1:]
    jobs = [("m", i) for i in range(len(M))] + [("c", i) for i in range(len(C))]
    if sel:
        jobs = [j for j in jobs if (f"{j[1]}" if j[0] == "m" else f"c{j[1]}") in sel]
    base = tempfile.mkdtemp(prefix="og-kit-mut.", dir=os.environ.get("TMPDIR"))
    res = []
    try:
        with cf.ThreadPoolExecutor(int(os.environ.get("OG_MUT_JOBS", "6"))) as ex:
            futs = [ex.submit(run_behaviour if k == "m" else run_chart, base, i) for k, i in jobs]
            for fu in cf.as_completed(futs):
                res.append(fu.result())
    finally:
        if not os.environ.get("OG_MUT_KEEP"):
            shutil.rmtree(base, ignore_errors=True)
    bad = 0
    for key, name, verdict, fails in sorted(res):
        print(f"{key:>3} {verdict:22s} {name}")
        if fails:
            print("     " + fails.replace("\n", "\n     "))
        bad += verdict != "KILLED"
    print(f"\n{len(res) - bad}/{len(res)} mutants killed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
