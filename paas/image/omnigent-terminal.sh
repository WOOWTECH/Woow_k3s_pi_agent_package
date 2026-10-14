# shellcheck shell=bash
# WOOW PaaS pi-agent — Omnigent bits for interactive shells (the pi-web terminal and
# `kubectl exec -it … bash`). Sourced from /etc/bash.bashrc: pi-web's terminal is
# `bash -l`, and Debian's /etc/profile sources /etc/bash.bashrc for interactive bash.
#
# The Omnigent host runs INSIDE this container (chart pi-agent >= 0.1.4: the shared
# kit's launcher starts the supervisor next to pi-web). The launcher put the kit's bin
# directory (the `omnigent` guard + omnigent-host-status) first on pi-web's PATH, but
# /etc/profile resets PATH in a login shell and ~/.profile may put a by-hand install
# (~/.local/bin, on the volume) in front again, so this hook restores it:
#
# 1. The kit's profile hook (chart-mounted at $OG_KIT_DIR, absent when omnigentHost is
#    disabled or on an older chart): kit bin first on PATH, plus ONE status block per
#    terminal while the tenant has to act (not logged in, login expired, reset-id, …),
#    with the exact `omnigent login <url>` command. Not repeated in nested shells.
_og_kit=${OG_KIT_DIR:-/etc/omnigent-host}
if [ -r "$_og_kit/omnigent-host-profile.sh" ]; then
  if [ -z "${OG_MOTD_SHOWN:-}" ]; then
    export OG_MOTD_SHOWN=1
    # shellcheck source=/dev/null
    . "$_og_kit/omnigent-host-profile.sh"
  else
    case ":${PATH}:" in
      *":$_og_kit/bin:"*) ;;
      *) PATH="$_og_kit/bin:${PATH}"; export PATH ;;
    esac
  fi
elif [ -z "${OG_MOTD_SHOWN:-}" ] && command -v omnigent-host-status >/dev/null 2>&1; then
  export OG_MOTD_SHOWN=1
  omnigent-host-status --motd
fi
# 2. `omnigent` (and its alias `omni`) always mean the image's CLI — the one the
#    supervisor runs — never a copy a by-hand install left on the volume, and always go
#    through the kit guard when the chart mounted it: while the supervisor keeps the host
#    connected, a second `omnigent host` / `omnigent host stop` fails clearly ("already
#    running, managed automatically — see omnigent-host-status") instead of fighting it;
#    `omnigent login`, `host status`, `host reset-id`, sessions etc. pass through.
if [ -x /usr/local/bin/omnigent ]; then
  if [ -x "$_og_kit/bin/omnigent" ]; then
    # The guard execs the first real `omnigent` on PATH: put the image's CLI first.
    omnigent() { PATH="/usr/local/bin:${PATH}" "${OG_KIT_DIR:-/etc/omnigent-host}/bin/omnigent" "$@"; }
  else
    omnigent() { /usr/local/bin/omnigent "$@"; }
  fi
  omni() { omnigent "$@"; }
fi
unset _og_kit
