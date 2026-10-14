# omnigent-host kit (shared)

This kit keeps `omnigent host` connected from a PaaS environment such as code-server, pi-agent or open-design. An Omnigent server can then run sessions there with the tenant's own LLM logins. The host stays connected unattended and across pod restarts, and the platform never logs in, holds or sees an Omnigent token.

**In-container mode.** The host runs **inside the service's main container**, like a daemon on an ordinary machine. The container's entrypoint wrapper (`omnigent-host-launch`) starts the kit supervisor in the background and then runs the product. The host dials **out** over the network to the workspace's Omnigent service, container to container, exactly as it would reach any external server. There is no sidecar, no extra container and no resource split: the host and its sessions share the main container's plan limits and cgroup.

There is **one canonical copy**, in this directory. Charts vendor byte-identical copies with `scripts/sync-omnigent-host-kit.sh`, and a test in each chart compares their sha256 with the canonical files. Services differ only through environment variables and values. Images provide the omnigent CLI and its tools, and optionally the small `image/omnigent-host-entry` stub (see [Image requirements](#image-requirements)); the supervisor, launcher and guard always come from the chart's ConfigMap, so a kit fix never needs a new image.

| File | Role |
|---|---|
| `omnigent-host-launch` | Entrypoint wrapper (POSIX sh). Starts `supervisor.sh` in the background, runs the product, orders the shutdown. Mounted at `/etc/omnigent-host/omnigent-host-launch`. |
| `supervisor.sh` | Background supervisor (POSIX sh: dash, bash, busybox ash). Waits for the tenant's login, runs `omnigent host`, watchdog, backoff, log caps, lock, status file, OOM priority and memory guard. |
| `og_helper.py` | Run with omnigent's own python, which has PyYAML. `state` classifies the stored login without printing a token. `seed` merges the config.yaml defaults without destroying tenant settings. `workspace` seeds workspace files. |
| `omnigent-shim` | Mounted as `/etc/omnigent-host/bin/omnigent` **and** `bin/omni` (the CLI's two entry points), first on the product's PATH. Refuses a second manual host, and a host daemon for another `--server`, while the supervisor runs; everything else goes to the real CLI. |
| `omnigent-host-status` | The status printer the tenant sees (zh-TW), in the IDE terminal, the pi-web terminal or the OD `/console/`. `--motd` prints only when the tenant has to act. Mounted at `bin/omnigent-host-status` and `/usr/local/bin/omnigent-host-status`. |
| `omnigent-host-profile.sh` | Interactive-shell hook for shells that do not descend from the product (`kubectl exec`): kit `bin` on PATH plus the MOTD. |
| `image/omnigent-host-entry` | Optional image-side stub: runs the launcher when the chart mounted the kit, else `exec`s the product. Not vendored into charts. |
| `chart/_omnigent-host.tpl` | Helm helpers: values, validation, env block, command, volumes, mounts, ConfigMaps, checksum. Vendored into `templates/`. |
| `chart/values-snippet.yaml` | The standard `omnigentHost:` values block. |
| `chart/kit-test-lib.sh` | Chart-test helpers: `kit_assert_vendored`, `kit_assert_in_container`, `kit_assert_runtime_server_url`, `kit_assert_disabled`. |
| `tests/run-tests.sh` | Behaviour suite: the real scripts against a fake `omnigent`, a fake server and a fake cgroup. |
| `tests/test-chart-snippet.sh` | Render suite: `tests/fixture-chart` wired exactly like a real chart. |

Edit only the canonical files, then run `scripts/sync-omnigent-host-kit.sh` to update every chart that carries the kit. CI runs `--check`, and each chart's kit test fails on drift.

## Launch contract

```
PID 1: dumb-init / tini (reaps zombies; unchanged)
 └─ sh omnigent-host-launch -- <product command...>        (stays resident, ~1 MB)
     ├─ setsid sh supervisor.sh   (background; own session)
     │    └─ setsid omnigent host --server <login URL> --non-interactive --no-open
     │         └─ runners / tmux / Claude Code / pi ...    (oom_score_adj 1000, OG_HOST_TREE)
     └─ setsid <product command...>                        (own session; argv, env, cwd, stdin unchanged)
```

- **Two ways to put the launcher in front of the product.**
  - *Chart-provided* (no image change): the main container's `command` comes from `woow.omnigentHost.command`, which renders `init + ["/bin/sh", "/etc/omnigent-host/omnigent-host-launch", "--"] + <product command>` when enabled and `init + <product command>` when disabled.
  - *Image-provided*: the image puts `image/omnigent-host-entry` between its init and the product, e.g. `ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/omnigent-host-entry", "/usr/bin/entrypoint.sh"]`. The stub `exec`s the launcher from `/etc/omnigent-host` when the kit is mounted, and the product itself otherwise. The chart then needs no command override (`kit_assert_in_container <file> <main> image`).
- **Disabled or impossible → plain `exec`.** If `OG_HOST_ENABLED` is not `1`/`true`, `supervisor.sh` is not mounted, or the image has no real `omnigent` CLI at `OG_BIN`, the launcher `exec`s the product: same pid, same everything, zero overhead.
- **Pinned CLI.** The launcher and the supervisor run exactly `OG_BIN`, the absolute path of the image's hash-locked CLI that the chart sets (`ogBin`, default `/usr/local/bin/omnigent`). They never look an absolute `OG_BIN` up on PATH and never fall back to PATH when it is missing. That matters because a tenant can install another `omnigent` in a directory that comes first on PATH and survives restarts and image upgrades (code-server: `~/.local/bin`; `uv tool install omnigent`, `pip install --user omnigent`). The tenant's own terminal commands still use whatever PATH finds after the guard: that is the tenant's choice. A bare-name `OG_BIN` (a chart that sets none; tests) is looked up on PATH, skipping the guard and every copy under `HOME` or `OG_HOME` (the product's HOME too, in the supervisor).
- **Never blocks or crashes the product.** The supervisor runs in the background with stdin closed. Anything it cannot fix (disabled, image too old, unwritable state dir) is written to the status file and the supervisor **exits 0 quietly**. The launcher never restarts it; a container restart starts a fresh one.
- **PATH.** The launcher prepends `$OG_KIT_DIR/bin` to the product's PATH, so the product's terminals and agents get the `omnigent` guard and `omnigent-host-status`. Shells entered with `kubectl exec` get it from `omnigent-host-profile.sh`.
- **Sessions.** The supervisor and the product each run in their own session (`setsid`). An init that signals the whole process group (dumb-init's default) therefore reaches only the launcher, which orders the shutdown. Under tini, or with the launcher as PID 1, only the launcher gets the signal anyway.
- **SIGTERM / SIGINT / SIGQUIT.** The launcher stops the supervisor first; the supervisor stops the host gracefully, with SIGKILL to the host's group after `OG_STOP_GRACE_SECONDS`. The launcher waits up to `OG_LAUNCH_STOP_SECONDS` (default `OG_STOP_GRACE_SECONDS + 5` = 20 s), then passes the same signal to the product's process group and waits for it. Set `terminationGracePeriodSeconds` to at least 20 s plus what the product needs to stop (the fixture uses 45).
- **SIGHUP / SIGUSR1 / SIGUSR2** go to the product only.
- **The product exits by itself.** The launcher stops the supervisor and exits with the product's status, so the container restarts exactly as before.
- **PID 1** must stay an init that reaps zombies (dumb-init, tini). If the launcher is PID 1 anyway, each of its `wait`s also reaps adopted orphans.
- `OG_SHELL` (default `/bin/sh`) is the shell that runs `supervisor.sh`.
- **Verified on woow-k3s** (sandbox `dev-sandbox-kit-omni3`, the fixture chart as a real Deployment, `dumb-init` as PID 1): process tree `dumb-init → launcher → {supervisor → host, product}` with the supervisor and the product in their own sessions; `kubectl delete pod` took 4 s and the product logged `PRODUCT got SIGTERM: supervisor status=stopped host=dead`. Without a real `omnigent` on PATH the launcher `exec`ed the product (it ran directly under dumb-init). Idle (not logged in) cost: launcher 1.9 MB + supervisor 2.0 MB + its `sleep` 1.9 MB RSS (dash; about 2 MB in total under busybox). Updating only the runtime ConfigMap changed `/etc/omnigent-host-runtime/server-url` in the running pod within about 40 s (same pod, restartCount 0), and the `waiting-login` hint then showed the new URL.

## Behaviour

```
            ┌────────────── tenant: omnigent login <url> ─────────────┐
 start ─► waiting-login ──(token usable, or server unreachable)──► starting ─► running
   │           ▲  ▲                                                 │  ▲         │
   │           │  └── login-expired ◄── 2× definitive rejection ────┘  │         │
   │           │                                                       │   exit ─┤
   │           └── re-login (other URL/account) restarts the host ─────┘         │
   └─► image-too-old / error / disabled: status written, supervisor exits 0      ▼
                         needs-reset-id (exit 78 + HTTP 409) / host-error / backoff / duplicate-host
```

- **Waiting quietly.** While no `auth_tokens.json` exists, the supervisor only tests for the file every `OG_IDLE_SECONDS`: no python and no network, just a sleeping shell (measured RSS about 1–2 MB; see the chart tasks' sandbox numbers). Once the file exists, python runs only when the token or config files change, or every `OG_REPROBE_SECONDS`.
- **Definitive rejection.** `og_helper.py state` returns `rejected` (exit 4) in exactly three cases:
  - `GET /v1/me` answers **401** with a token that has not expired, and a refresh is refused too. This is server-side revocation, such as a deleted user.
  - The token has expired, and `POST /oauth/token` answers **401**, or **400** with `invalid_grant` or `expired_token`.
  - The token has expired and no refresh token is stored.

  Everything else counts as "unreachable" (exit 5): connection errors, timeouts, 5xx, 403, redirects and unexpected bodies. The host rides out the outage and is never stopped for it. The supervisor stops a host only after **two consecutive** rejections, `OG_CONFIRM_SECONDS` apart. It then reports `login-expired` with the exact login command.
- **Outage and recovery.** During an outage the status says `running` with detail "server unreachable right now". The supervisor then follows host.log: as soon as the host prints a new `Connected as` it switches the detail back to `connected`. It also re-probes after `OG_UNREACHABLE_PROBE_SECONDS` (15) instead of waiting for `OG_WATCH_SECONDS`.
- **Refreshing.** A refresh done by the probe is stored exactly as omnigent stores it: same JSON, `flock` on `auth_tokens.lock`, a 0600 temp file renamed into place, and the directory set to 0700.
- **Re-login.** The watchdog also runs whenever the token or config files change. If the tenant logs in to another URL or account, the host restarts against it.
- **Exit 78.**
  - With `HTTP 409`, the host id is owned by another account. The supervisor backs off exponentially, from `OG_BACKOFF_78_MIN` up to `OG_BACKOFF_78_MAX`, and sets status `needs-reset-id` with action `omnigent host reset-id --yes` (omnigent ≥ 0.16 supports `--yes`; without it the command asks `[y/N]`). reset-id refuses while a host daemon runs, which is never the case in this state. When `config.yaml` changes (reset-id) or the tokens change (a new login), it retries at once.
  - Other 78s are re-probed: a login problem returns the supervisor to `login-expired`, anything else becomes `host-error` with backoff, and `--motd` tells the tenant the host is offline.
- **Other exits** back off exponentially from 5 s up to `OG_BACKOFF_MAX`. The backoff resets after `OG_HEALTHY_SECONDS` of healthy running. A log tail of "already running" gives status `duplicate-host`: someone bypassed the guard and started a host by hand.
- **Stopping.** The supervisor sends SIGTERM to the host. After `OG_STOP_GRACE_SECONDS` it sends SIGKILL to the host's whole process group; `setsid` gives the host its own group. On SIGTERM the supervisor stops the host this way, writes `stopped` and exits 0.
- **Logs.**
  - `host.log` (the host's stdout and stderr) and `supervisor.log` are copy-truncated at `OG_LOG_MAX_BYTES`, keeping one `.1` file. The supervisor's state changes also go to the container log, next to the product's.
  - omnigent's own `logs/**` files are trimmed to half the cap when they exceed it, pruned after `OG_LOG_RETENTION_DAYS`, and kept under `OG_LOGS_MAX_BYTES` in total, oldest first. This runs every `OG_PRUNE_SECONDS` while the host is running.
- **One host per volume.** The supervisor takes `flock` on `$OG_STATE_DIR/supervisor.lock`. A second supervisor waits, retrying every `OG_LOCK_RETRY_SECONDS`, and never touches the status file. Neither the host nor the `sleep`s inherit the lock fd.
- **A second manual `omnigent host`.** The tenant's terminal now runs in the same container as the real daemon, so `omnigent host status` sees it. The guard is mounted as `bin/omnigent` and `bin/omni` (omnigent's second console script). While the supervisor holds its lock it makes these fail with exit 1 and *"already running, managed automatically — see omnigent-host-status"*, instead of fighting it:
  - `omnigent host [URL|--server …|--background|enable]`, `omnigent host stop`, `omnigent start`, `omnigent stop`;
  - a bare `omnigent` on a terminal (omnigent runs `start` then; without a terminal it prints `--help` and passes);
  - the same with global options first: `--debug`, `--log-to-stderr` and `--profiling` are looked past (`omnigent --debug host …`), and so are the host group's own options (`host --server X status` is a status call and passes).
- **A host daemon for another server.** `run` (and its shorthands `omnigent agent.yaml …`, `omnigent --harness …`, `polly`, `debby`, `copilot`), `resume` and the harness commands (`claude`, `codex`, `opencode`, `pi`, `cursor`, `devin`, `kiro`, `goose`, `hermes`, `antigravity`/`agy`, `qwen`, `kimi`) make omnigent 0.16 start or reuse its own background host daemon for their target (`_ensure_host_daemon`). For the supervisor's server that daemon is reused, which is fine. For a different one it would register the **same host_id** against another server and fight the supervisor. So while the supervisor runs, the guard refuses (exit 1, zh-TW message) an explicit `--server X` / `--server=X` (options end at `--`) when X is not the supervisor's server: `server` in the status file, or, before the host first started, the environment's Omnigent URL (`OG_SERVER_URL` / `OG_SERVER_URL_FILE`). `--server local` and `--server ""` (a local server plus a local host) count as different. Trailing `/` and the case of scheme and host are ignored. No `--server`, the same server, or an unknown supervisor server pass through unchanged. omnigent 0.16 has no `-s` alias for `--server` (`-s` is a legacy `--session`, and codex's own sandbox flag), so `-s` is not inspected.
- `host status`, `host reset-id`, `host stop-session`, `login`, sessions and `--help` (before `--`) pass through unchanged. `OG_SHIM_BYPASS=1` disables the guard. The supervisor and launcher never run the guard (marker `OMNIGENT_HOST_KIT_SHIM`; see **Pinned CLI**).
- **Telemetry off.** The chart sets `OMNIGENT_ANALYTICS=0`, `DO_NOT_TRACK=1` and `DISABLE_TELEMETRY=1` on the main container, even with the host disabled, so a CLI run by hand is covered too. The supervisor also exports `OMNIGENT_DISABLE_TELEMETRY=1`, adds the three to `OMNIGENT_RUNNER_ENV_PASSTHROUGH` so sessions inherit them, and `og_helper.py seed` enforces `telemetry: false` in config.yaml.
- **No secrets.** There is no `set -x` and no env dump. The helper prints verdicts, URLs and a 12-hex hash of the user id. The status file and the logs carry no token, and the test suite greps every file it produced to prove it. The product's own secrets (e.g. code-server's `PASSWORD`) are in the container env: list them in `unsetEnv` so the host does not inherit them (runners get only omnigent's allowlist anyway).
- **Permissions.** A pod `fsGroup` makes kubelet chmod the volume recursively on every mount (`auth_tokens.json` 0600 → 0660, `~/.omnigent` → 2770). The supervisor re-tightens `auth_tokens.json` to 0600 before each host start; charts should also set `fsGroupChangePolicy: OnRootMismatch` (faster starts, and the 0600/0700 that omnigent sets survive).

### OOM: priority and memory guard

The host and its sessions share the product's container. Kubernetes on cgroup v2 sets **`memory.oom.group=1`** on every container (verified on woow-k3s, k3s 1.34): when the container hits its memory limit, the kernel kills **every process in it**, product included, whatever their `oom_score_adj`. A sandbox pod whose "session" process had `oom_score_adj` 1000 still took PID 1 down with it (`OOMKilled`, restartCount 1). So the kit uses two layers:

1. **`oom_score_adj`** (`OG_OOM_SCORE_ADJ`, default 1000, raise only) for the host and everything it starts; it is inherited through runners and tmux. kubelet already gives a Burstable pod's processes an `oom_score_adj` of about 1000 − 1000 × request / node memory (999 in the sandbox), so a smaller value such as 800 would be a no-op (raise only) and would even leave the sessions *below* the product. With 1000 the kernel prefers a session over the product in a node-level OOM **only while** the product's RSS does not exceed the session's by more than (1000 − product adj) ‰ of node memory. That margin is small: in the sandbox the host showed adj 1000 and the product 999 (`oom_score` 1333 vs 1333 at 18 MiB vs 168 MiB RSS); on a 125 GiB node one point is about 128 MiB, so with a product adj of 999 to 993 (larger memory requests give lower values) a product only 128 MiB to about 0.9 GiB larger than the biggest session is picked first. This layer is only a **tie-breaker**; inside the container's own limit it does nothing (see above).
2. **Memory guard** in the supervisor. Every `OG_MEM_GUARD_SECONDS` (2) while the host runs, it reads the container's cgroup (`memory.max`, `memory.current`, `memory.stat`; v1 files as fallback). When the working set (usage minus `inactive_file`, as kubelet counts it, so page cache never triggers it) reaches `OG_MEM_GUARD_PERCENT` (90) of the limit, it SIGKILLs the largest-RSS process carrying `OG_HOST_TREE=<supervisor pid>`. That environment marker is set on the host and passed through to runners. The host itself, the supervisor and anything else (the product, the tenant's terminal) are never touched. It kills at most one process per 3 × `OG_MEM_GUARD_SECONDS`, logs the kill, and keeps it in the status (`memory_guard`) so `omnigent-host-status` can show it. No limit (`max`) or `OG_MEM_GUARD_PERCENT=0` disables it.

   Verified on woow-k3s (sandbox, the fixture chart rendered as a real Deployment, limit 512Mi, product holding 168 MiB, a session growing 20 MiB/s): the guard killed the session at 94 % and 92 % of the limit (`killed Omnigent session process … (python3, 299 MiB)`), the product and the host kept running, restartCount stayed 0. The guard is **best-effort**: it samples every `OG_MEM_GUARD_SECONDS` (2 s), so a session that allocates the remaining 10 % faster than that still triggers the container OOM, and then the product goes too (`memory.oom.group=1`; everything restarts, the host comes back by itself).

**What this does and does not promise.** Together the two layers make it *likely* that a runaway session is killed before the product, but they do not guarantee it. Do not describe the product as "never the one that goes" (in values comments, Chart.yaml notes or rollout texts). Accurate wording: *the memory guard tries, at a 2 s sampling interval, to kill the largest session before the container reaches its limit; in a node-level OOM the kernel prefers sessions unless the product's RSS is much larger.* The product's own child processes (e.g. OpenDesign's own agent runs) are not covered by the guard.

### Identity rule (`og_helper.py seed`)

- If config.yaml has a `host:` mapping, its `host_id` is **kept** and only `name` is set to `OG_HOST_NAME`. The same host_id with a new name is renamed in place on the server, and conversations stay attached.
- If there is no `host:` block, the helper writes `host: {name: OG_HOST_NAME}`, and **omnigent** generates the host_id on first start. The kit never invents ids.
- The name is written readably (`name: pi-agent · svc-20c1c915`) whenever omnigent will read config.yaml as UTF-8 (UTF-8 mode or a UTF-8 locale, which includes the C locale since Python 3.7), and as `\x`/`\u` escapes otherwise. If omnigent itself rewrote the file with escapes, the next seed writes the name readably again.
- An empty `OG_HOST_NAME` leaves identity alone.
- The supervisor **unsets** `OMNIGENT_HOST_ID` and `OMNIGENT_HOST_NAME`, which would bypass config.yaml, and logs that it did.
- Invalid YAML, or a config.yaml that is not a mapping, is left untouched: the helper exits 1 and the host still starts.

### Workspace seed

`og_helper.py workspace` copies the files of `OG_WORKSPACE_SEED_DIR` into `OG_WORKSPACE` and records each decision in `$OG_STATE_DIR/workspace-seed.json` (path, state, sha256 of what was seeded; no secrets). The tenant always wins:

- A file is written only where nothing exists. An existing file the kit did not write is recorded as `tenant` and never touched.
- A seeded file the tenant **deleted** is recorded as `deleted` and is **never re-created**, across restarts and chart upgrades. That is the opt-out.
- A seeded file the tenant has **not edited** (its sha256 still equals the recorded one) is updated to a newer seed version only if its path is in `OG_WORKSPACE_SEED_UPDATE`.
- Otherwise a newer version is only **offered**: it is written to `<workspace>/.omnigent-seed-updates/<path>` and logged once. The offer is removed again when the file matches the seed.
- Paths that would leave the workspace through a symlink are left alone.

### Providers (`OG_PROVIDERS`)

`claude-subscription` (`{kind: subscription, cli: claude, default: true}`) and `pi-original` (`{kind: subscription, cli: pi, default: pi}`) are each added **at most once per volume**, recorded by a marker in `OG_STATE_DIR`. An entry is added only if both of these hold:

- the tenant has no entry of that name;
- no other entry already claims the same default: `true`/`anthropic` for Claude, `pi` for pi.

If the tenant later removes an entry, it is never re-added.

## Environment contract

### Set by the chart on the main container (`woow.omnigentHost.env`)

| Variable | Value | Meaning |
|---|---|---|
| `OMNIGENT_ANALYTICS`, `DO_NOT_TRACK`, `DISABLE_TELEMETRY` | `0`, `1`, `1` | Telemetry off. Rendered **even when disabled**. |
| `OG_HOST_ENABLED` | `1` | The launcher starts the supervisor only when this is `1`/`true`. Absent when disabled. |
| `OG_KIT_DIR` | `/etc/omnigent-host` | Kit mount. The launcher and the profile hook put `$OG_KIT_DIR/bin` first on PATH. |
| `OG_SERVER_URL_FILE` | `/etc/omnigent-host-runtime/server-url` | Runtime Omnigent URL (see below). |
| `OG_CONFIG_HOME` = `OMNIGENT_CONFIG_HOME` | chart `configHome` | omnigent config dir: `config.yaml` with `server:`, `host:`, `providers:`, `telemetry:`. The tenant's `omnigent login` in this container writes here too. |
| `OG_DATA_DIR` = `OMNIGENT_DATA_DIR` | chart `dataDir` (default `configHome`) | omnigent data dir: `auth_tokens.json`, `logs/`, and the kit's `omnigent-host/` state (lock, logs, status). |
| `OG_STATUS_FILE` | `<dataDir>/omnigent-host/status.json` | Status JSON, no secrets. |
| `OG_HOST_NAME` | `omnigentHost.hostName` or `<chart> · <release>` | Name pinned in `config.yaml` `host.name`. Must be unique per Omnigent account. |
| `OG_WORKSPACE` | `omnigentHost.workspace` or the chart default | Absolute path sessions should use. It is the host's cwd, shown in the status, and linked as `~/workspace` when it lies outside HOME. |
| `OG_WATCH_SECONDS` | `omnigentHost.watchSeconds` (≥ 30) | Login re-check period of a running host. |
| `OG_PROVIDERS`, `OG_PASSTHROUGH`, `OG_UNSET_ENV` | chart parameters | Provider entries to seed; extra env names for `OMNIGENT_RUNNER_ENV_PASSTHROUGH`; env names the host must not inherit (**the product's own secrets**). |
| `OMNIGENT_HOST_NO_OPEN` | `1` | Never try to open a browser. |
| `OG_HOME` | chart `home` (optional) | HOME of the host and its sessions, when it must differ from the product's HOME **as the launcher sees it** (the image's user HOME, before any start script changes it). |
| `OG_BIN` | chart `ogBin` (default `/usr/local/bin/omnigent`; absolute, the render fails otherwise) | The image's pinned omnigent CLI. The launcher and the supervisor run exactly this file (see **Pinned CLI**). |
| `OG_WORKSPACE_SEED_DIR`, `OG_WORKSPACE_SEED_UPDATE` | chart `seedDir`, `seedUpdate` (optional) | Workspace seed (open-design). |

**Never set `OG_SERVER_URL` (or any URL) in the pod template.** The URL is runtime data: the chart renders `omnigentHost.serverUrl` only into the runtime ConfigMap `<name>-runtime` (key `server-url`). That ConfigMap is mounted as a directory (not a subPath), so kubelet updates the file in place, and it is deliberately **not** part of the pod's checksum annotation. The platform can inject or change the URL with a `helm upgrade` and the pod does not restart; the supervisor re-reads the file every time it needs it (login hint, helper fallback), and `omnigent-host-status` reads it itself each time it prints, so a URL injected after the status was written still shows up in the login command.

### Supervisor knobs (defaults are fine; override for tests or special charts)

| Variable | Default | Meaning |
|---|---|---|
| `OG_SERVER_URL` | `""` | Explicit URL; overrides `OG_SERVER_URL_FILE`. Only http(s) URLs without whitespace, quotes or backslashes are used; trailing `/` stripped. The URL is a login hint and the fallback server when config.yaml has no `server:`. The host always uses the URL the tenant logged in to, if it has a token. |
| `OG_STATE_DIR` | `$OG_DATA_DIR/omnigent-host` | Supervisor state: lock, logs, status, seed markers. Created with mode 0700. |
| `OG_LOG_MAX_BYTES` | `5242880` | Cap for `host.log` and `supervisor.log` (one rotated `.1` each), and per-file cap for omnigent's `logs/**`. Floor: 64 KiB. |
| `OG_LOG_RETENTION_DAYS` / `OG_LOGS_MAX_BYTES` | `14` / `268435456` | Age limit / total cap for omnigent's `logs/` (oldest `runner/` and `host/` files first). |
| `OG_TMUX_MIN` | `3.3` | Minimum tmux version (native Claude and pi harnesses). Empty disables the check. |
| `OG_STOP_GRACE_SECONDS` | `15` | SIGTERM → SIGKILL grace for the host. |
| `OG_LAUNCH_STOP_SECONDS` | `OG_STOP_GRACE_SECONDS + 5` | How long the launcher waits for the supervisor before it signals the product. |
| `OG_CONFIRM_SECONDS` | `20` | Delay before the confirming probe of a rejection. |
| `OG_IDLE_SECONDS` | `15` | File-test period while waiting for a login. |
| `OG_REPROBE_SECONDS` | `300` | Re-probe period while tokens exist but are not usable. |
| `OG_UNREACHABLE_PROBE_SECONDS` | `15` | Re-probe period while the server is unreachable. |
| `OG_TICK_SECONDS` | `5` | Liveness, log-rotation and file-change tick while the host runs. |
| `OG_BACKOFF_MAX` | `300` | Cap of the exponential restart backoff, which starts at 5 s. |
| `OG_BACKOFF_78_MIN` / `OG_BACKOFF_78_MAX` | `60` / `1800` | Exponential backoff after exit 78. |
| `OG_HEALTHY_SECONDS` | `600` | A run this long resets the backoffs. |
| `OG_PRUNE_SECONDS` | `60` | Period of the omnigent `logs/` cap and prune while running. |
| `OG_LOCK_RETRY_SECONDS` | `60` | How often a second supervisor retries the lock. |
| `OG_OOM_SCORE_ADJ` | `1000` | `oom_score_adj` of the host tree (raise only). Empty disables it. |
| `OG_MEM_GUARD_PERCENT` / `OG_MEM_GUARD_SECONDS` | `90` / `2` | Memory guard threshold (working set as % of the container limit; `0` disables) and check period. |
| `OG_CGROUP_DIR` | `/sys/fs/cgroup` | Where the guard reads the container's memory files. |
| `OG_BIN` | `omnigent` (charts: an absolute path) | omnigent CLI. An absolute path is used as is (never a PATH lookup, no fallback). A bare name is resolved on PATH, skipping the kit guard and any copy under `HOME`/`OG_HOME`. |
| `OG_PYTHON` | (from the CLI's shebang) | Python with PyYAML for `og_helper.py`. |
| `OG_HELPER` | `<script dir>/og_helper.py` | Helper path. |
| `OG_HTTP_TIMEOUT` | `10` | HTTP timeout of the probe, in seconds. |
| `OG_SHELL` | `/bin/sh` | Shell the launcher uses for `supervisor.sh`. |
| `OG_SHIM_BYPASS` | `""` | `1` disables the `omnigent host` guard for one command. |

The status printer reads `OG_STATUS_FILE`, falling back to `$OG_STATE_DIR/status.json` and then `${OG_DATA_DIR:-$OMNIGENT_DATA_DIR:-~/.omnigent}/omnigent-host/status.json`.

### Status file (`schema: 1`)

The file has one `"key": "value"` per line, and every value is a string:

| Key | Content |
|---|---|
| `state` | `waiting-login`, `starting`, `running`, `login-expired`, `needs-reset-id`, `backoff`, `host-error`, `duplicate-host`, `image-too-old`, `error` or `stopped` |
| `detail` | Explanation of the state, e.g. `connected` or `server unreachable right now (...)` |
| `action` | What the tenant has to run, if anything |
| `login_command` | `omnigent login <OG_SERVER_URL / runtime URL / last login URL>` |
| `server` | Server URL in use |
| `host_name`, `workspace` | Host name and session workspace |
| `since`, `updated` | Timestamps |
| `retry_at` | When the next retry happens |
| `restarts`, `last_exit_code` | Host restart count and last exit code |
| `host_log` | Path of the host log |
| `memory_guard` | Last memory-guard kill (time, process, MiB, %), if any |
| `supervisor_pid` | Process id of the supervisor |

The tenant must act, or at least be told, in these states: `waiting-login`, `login-expired`, `needs-reset-id`, `image-too-old`, `duplicate-host`, `host-error` and `error`. In those states `omnigent-host-status --motd` prints a zh-TW message with the exact command; in all other states it stays silent.

## Image requirements

Images ship only the tools; the supervisor, launcher, guard and helper come from the chart's ConfigMap.

- The `omnigent` CLI (≥ 0.16 for `host reset-id --yes`), pinned with hashes: `uv pip compile --generate-hashes` into a lock committed next to the Dockerfile, installed with `--require-hashes`, and compiled at build with `UV_COMPILE_BYTECODE=1`. Its python must import `yaml`, which omnigent depends on.
- `tmux` ≥ 3.3, `flock` and `setsid`. Debian has these in util-linux; Alpine has them in busybox or util-linux. `getconf` is optional.
- An init that reaps zombies as PID 1 (`tini` or `dumb-init`).
- Optionally `image/omnigent-host-entry` in the ENTRYPOINT (see [Launch contract](#launch-contract)).

The supervisor reports anything missing as `image-too-old` and exits; the product is unaffected.

## Chart integration

1. Copy `chart/values-snippet.yaml` into `values.yaml`. **Do not** split the plan: the main container keeps its full plan limits, as before the kit.
2. Run `scripts/sync-omnigent-host-kit.sh <chart>`. It writes `files/omnigent-host/{supervisor.sh,og_helper.py,omnigent-host-status,omnigent-host-launch,omnigent-host-profile.sh,omnigent-shim,KIT.sha256}` and `templates/_omnigent-host.tpl`.
3. Add the ConfigMaps (kit plus runtime), using `tests/fixture-chart/templates/omnigent-host-configmap.yaml` as the template:
   ```yaml
   {{- include "woow.omnigentHost.configMaps" (dict "root" . "name" (printf "%s-omnigent-host" (include "<chart>.fullname" .)) "labels" (include "<chart>.labels" . | fromYaml)) }}
   ```
4. Wire the main container. `tests/fixture-chart/templates/deployment.yaml` is a complete worked example:
   ```yaml
   {{- $kitCM := printf "%s-omnigent-host" (include "<chart>.fullname" .) }}
   # pod template metadata
   annotations:
     {{- if include "woow.omnigentHost.enabled" . }}
     checksum/omnigent-host: {{ include "woow.omnigentHost.checksum" (dict "root" . "name" $kitCM) }}
     {{- end }}
   # main container
   command: {{ include "woow.omnigentHost.command" (dict "root" . "init" (list "dumb-init") "command" (list "/usr/bin/entrypoint.sh" "--bind-addr" "0.0.0.0:8080" ".")) }}
   env:
     {{- include "woow.omnigentHost.env" (dict
           "root" .
           "configHome" "/data/pi-agent/omnigent"    # where `omnigent login` writes
           "home" ""                                 # optional OG_HOME
           "workspace" "/workspace"                  # default when omnigentHost.workspace is ""
           "providers" "claude-subscription,pi-original"
           "passthrough" "PI_CODING_AGENT_DIR,PI_AGENT_DATA_DIR"
           "unsetEnv" "PASSWORD,HASHED_PASSWORD"
           "ogBin" "/usr/local/bin/omnigent") | nindent 12 }}  # the image's pinned CLI (default)
   volumeMounts:
     {{- include "woow.omnigentHost.volumeMounts" (dict "root" .) | nindent 12 }}
   # pod volumes
   volumes:
     {{- include "woow.omnigentHost.volumes" (dict "root" . "name" $kitCM) | nindent 8 }}
   ```
   - Image-provided launch instead: keep the image's ENTRYPOINT (with `omnigent-host-entry`) and drop the `command` line.
   - If the chart already sets `OMNIGENT_CONFIG_HOME`/`OMNIGENT_DATA_DIR`, remove those entries; the env block sets them, and duplicates are ambiguous.
   - Pod: `fsGroupChangePolicy: OnRootMismatch` next to `fsGroup`, and `terminationGracePeriodSeconds` ≥ 20 s plus the product's own stop time.
5. Hook the profile into the environment's interactive shells. Each hook is the one-liner `[ -r /etc/omnigent-host/omnigent-host-profile.sh ] && . /etc/omnigent-host/omnigent-host-profile.sh`:
   - **code-server:** mount or bake it as `/etc/woow/bashrc.d/omnigent-host.sh` (the image's `/etc/bash.bashrc` sources it).
   - **pi-agent:** an image hook in `/etc/bash.bashrc`, because `~/.bashrc` lives on the PVC.
   - **open-design:** `/etc/bash/omnigent-host.sh` in the daemon container. Alpine's `/etc/bash/bashrc` sources `/etc/bash/*.sh` in every interactive bash, which is what the `/console/` ttyd `kubectl exec -- /bin/bash` starts. That shell does not descend from the launcher, so this hook is what gives it the guard.
6. Add the chart test `tests/test-omnigent-host-kit.sh`:
   ```bash
   #!/usr/bin/env bash
   set -u
   CHART_DIR=$(cd "$(dirname "$0")/.." && pwd)
   . "$(cd "$CHART_DIR/../.." && pwd)/shared/omnigent-host/chart/kit-test-lib.sh"
   rc=0
   kit_assert_vendored "$CHART_DIR" || rc=1
   out=$(mktemp); helm template t "$CHART_DIR" >"$out"
   kit_assert_in_container "$out" <main-container> [chart|image] || rc=1
   kit_assert_runtime_server_url "$CHART_DIR" || rc=1          # serverUrl never restarts the pod
   helm template t "$CHART_DIR" --set omnigentHost.enabled=false >"$out"
   kit_assert_disabled "$out" <main-container> || rc=1
   rm -f "$out"; exit $rc
   ```
   The rendered-manifest helpers inspect ONE workload: the one whose containers include `<main-container>`, never whichever Deployment happens to render first. Every helper is proven to FAIL on a manifest that violates it (`tests/test-chart-snippet.sh`).

**`--reuse-values`.** All helpers read `omnigentHost` through `woow.omnigentHost.values`, so an upgrade from a chart without the block renders the defaults (enabled). Charts that had a round-2 `planBudget`/sidecar split must restore their pre-kit main-container resources defaults.

### Per-service parameters (decided per chart task)

| | code-server | pi-agent | open-design |
|---|---|---|---|
| `configHome` = `dataDir` | `/data/pi-agent/omnigent` (prod is already logged in here, as admin) | `/data/pi-agent/home/.omnigent` (prod identity `host_id cb1b…` and its login live here) | `/home/opendesign/.omnigent` |
| `home` (OG_HOME) | — (container HOME `/home/coder`) | **`/data/pi-agent/home`** (required: the image user's HOME is `/home/pi` until `pi-web-start.sh` sources `pi-agent-env.sh` and changes it; the launcher starts the supervisor before that) | — (`/home/opendesign`) |
| `ogBin` (OG_BIN) | `/usr/local/bin/omnigent` (default; `~/.local/bin` is persistent and first on PATH) | `/usr/local/bin/omnigent` (→ `/opt/omnigent/venv`) | `/usr/local/bin/omnigent` (→ `/opt/omnigent/venv`) |
| `workspace` | `/workspace` | `/data/pi-agent/home` | `/home/opendesign/studio` (+ `seedDir`, `seedUpdate: CLAUDE.md`) |
| `providers` | `claude-subscription,pi-original` | `pi-original` | `claude-subscription` |
| `passthrough` | `PI_CODING_AGENT_DIR,PI_AGENT_DATA_DIR,PI_TELEMETRY,PI_SKIP_VERSION_CHECK,DISABLE_AUTOUPDATER,OPENROUTER_API_KEY` | `PI_CODING_AGENT_DIR,PI_AGENT_DATA_DIR,PI_TELEMETRY,PI_SKIP_VERSION_CHECK` | `OD_DAEMON_URL,NODE_PATH,NODE_OPTIONS,PUPPETEER_*,PLAYWRIGHT_*,USE_BUILTIN_RIPGREP` |
| `unsetEnv` | `PASSWORD,HASHED_PASSWORD,SUDO_PASSWORD` | the pi-web login secret(s), if any | `ANTHROPIC_API_KEY,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL,CLAUDE_CODE_OAUTH_TOKEN,OPENAI_API_KEY,OPENAI_BASE_URL,OPENROUTER_API_KEY,GEMINI_API_KEY,CODEX_ACCESS_TOKEN,OD_API_TOKEN` |
| init (PID 1) | `dumb-init` | `tini` (add one if the image has none) | `/sbin/tini --` |

**pi-agent migration.** The existing `config.yaml` has a `host:` block, so `seed` keeps `host_id cb1b5336100f4bc5bea04c5e4f2d5217` and renames the host to `pi-agent · svc-20c1c915`. `auth_tokens.json` in the same directory keeps the login. pi's own login (`/data/pi-agent/auth.json`) reaches sessions through `PI_CODING_AGENT_DIR` in `passthrough`. Never set `OMNIGENT_HOST_ID` or `OMNIGENT_HOST_NAME`; the supervisor unsets them anyway. The manual host the tenant started by hand disappears with the pod restart; the guard keeps a new one from being started.

## Accounts

The host belongs to the Omnigent account that ran `omnigent login` in the environment. Only that account sees and uses the machine in Omnigent.

- **WOOW default: the Omnigent `admin` account.** The user decided that all three hosts (code-server, pi-agent, open-design) connect with the admin account, which owns them. code-server production is already logged in as admin and has no host identity yet; after the rollout its host appears as **"code-server · svc-49085988"** under admin. That is intended.
- **General advice (other tenants).** A dedicated or everyday account limits what an agent session can do with the stored refresh grant. Sessions run as the environment's user and can read `auth_tokens.json`, which holds a refresh grant valid up to `OMNIGENT_GRANT_MAX_LIFETIME_DAYS`. The kit does not block any account. The login hint mentions that the `Username` prompt defaults to `admin`.
- **Deleting the token file is only a local logout.** `rm auth_tokens.json` logs out this machine only: the refresh grant stays valid on the server. To truly revoke, delete or disable the user in Omnigent. The watchdog then sees the 401 and stops the host within `OG_WATCH_SECONDS` plus `OG_CONFIRM_SECONDS`.
- **Switching accounts.** After logging in with a different account, the old host id belongs to the previous account. The status shows `needs-reset-id`; run `omnigent host reset-id --yes` and the host reconnects by itself. The previous account keeps an offline entry that an Omnigent administrator has to clean up (there is no delete API).

## Tests

```bash
bash shared/omnigent-host/tests/run-tests.sh          # behaviour (python3 + PyYAML, flock, setsid)
OG_TEST_SHELLS="sh bash" OG_TEST_BUSYBOX=/path/busybox bash shared/omnigent-host/tests/run-tests.sh
OG_TEST_ONLY="t_launch t_shim" bash shared/omnigent-host/tests/run-tests.sh   # a subset
bash shared/omnigent-host/tests/test-chart-snippet.sh # render (helm, yq)
bash scripts/sync-omnigent-host-kit.sh --check        # vendored copies in sync
```

`run-tests.sh` covers these cases:

- **Not logged in:** quiet idle, with no python and no network.
- **Login:** the host starts, and the test checks argv, cwd, env (telemetry, passthrough incl. `OG_HOST_TREE`, unset vars, identity env removed), the process group, `oom_score_adj` 1000, the 0600 re-tightening, the identity rule, `telemetry: false` and the providers.
- **Outages:** 5xx, an expired token with a refresh 502, and connection-refused all keep the host running.
- **Reconnect:** after an outage the detail returns to `connected` as soon as the host logs `Connected as` (watch and re-probe set far away), and via the short re-probe without such a line.
- **Unconfirmed 401:** a single 401 is ignored.
- **Revocation:** server-side revocation, confirmed twice, stops the host and reports `login-expired`; a re-login brings it back with the same host_id.
- **Expired grant:** an expired refresh grant is caught both at startup and while the host runs.
- **Exit 78 with 409:** exponential backoff, the `reset-id --yes` hint, and an immediate retry after `reset-id`.
- **Runtime serverUrl:** the status printer's login command follows the runtime file even when the status file is older; the supervisor's login hint follows `OG_SERVER_URL_FILE` when kubelet swaps the file (same supervisor process); invalid content is ignored; the helper's fallback server comes from the file; after the login dies the `login-expired` hint still follows a file change (never cached once probes ran); `OG_SERVER_URL` overrides it.
- **Memory:** sessions inherit `oom_score_adj` 1000 and get a higher `oom_score` than the product; the guard kills the session child at 92% (never the product or the host, not even when the host is the only process left in the tree and memory stays high), ignores page cache, no-limit and `OG_MEM_GUARD_PERCENT=0`, and works with cgroup v1 files.
- **Launcher:** background supervisor plus product, argv/env/stdin/PATH, product in its own session, dumb-init-style group SIGTERM with the order supervisor → host → product, SIGHUP forwarding, the product's exit code (0 and 3), product exit stops the supervisor, plain `exec` when disabled or without a CLI, usage error, and the image stub.
- **Guard:** the blocked forms fail with exit 1 and the message while the lock is held and never reach the CLI, also with global options first (`--debug`, `--log-to-stderr`, `--profiling`), through `bin/omni`, and for a bare `omnigent` on a pty (`script`); the pass-through forms reach it (`host --server X status`, bare `omnigent` without a terminal, `--version`); no lock → pass-through; `OG_SHIM_BYPASS`; no CLI → 127; a manual `omnigent host` and `omni host` inside the launched product fail while `omnigent host status` passes.
- **Guard, other server:** `claude`/`run`/`codex`/`resume`/`kimi`/`polly`, the `agent.yaml` and `--harness` shorthands and `omni pi` with another `--server` (incl. `--server=`, `local`, another path, after global options, with `--help` only after `--`) are refused; the same server (trailing `/`, upper-case scheme), no `--server`, `--server` after `--`, `codex -s …`, `session …` and `--help` pass; before the host started the runtime URL is the reference; unknown server or no supervisor → pass-through.
- **Pinned CLI:** with decoy `omnigent`s first on PATH (one in `~/.local/bin`) the launcher and the supervisor run `OG_BIN`; a missing `OG_BIN` path makes the launcher `exec` the product, never fall back to PATH; with a bare `OG_BIN` both skip copies under `HOME`, `OG_HOME` and (supervisor) the product's HOME.
- **Profile hook:** PATH once, MOTD only in interactive shells, harmless without the kit.
- **Stopping:** SIGTERM escalates to SIGKILL.
- **Logs:** log rotation cap, plus pruning and trimming of omnigent logs while running.
- **Lock:** a second supervisor waits and takes over cleanly.
- **Re-login as another account:** the host restarts.
- **Images:** old tmux, a missing CLI, or only the guard on PATH give `image-too-old` and the supervisor exits 0; with the guard first on PATH and the real CLI after it (supervisor started without the launcher) the host runs the real CLI; `OG_HOST_ENABLED=0` exits without a status file.
- **Status printer:** its output for each mode is checked, including `host-error` in `--motd`.
- **Identity under an ASCII locale:** `OG_HOST_NAME` is decoded as UTF-8 (not surrogate escapes); config.yaml stays pure ASCII (`\xB7`) and round-trips to `pi-agent · svc-20c1c915`.
- **Leak check:** no token appears outside `auth_tokens.json`.

The suite runs under dash and bash, and under busybox ash with busybox applets.
