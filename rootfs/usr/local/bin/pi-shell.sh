#!/bin/bash
# The shell ttyd forks for each browser session.
#
# Lands the user in the agent's own data directory with `pi` on PATH and the
# same env pi-web runs with, so anything configured here is the same instance
# the web UI serves.
# shellcheck source=/dev/null
source /usr/local/bin/pi-agent-env.sh

DATA_DIR="${PI_AGENT_DATA_DIR:-/data/pi-agent}"
mkdir -p "${HOME}"
cd "${HOME}" || cd /

cat <<BANNER

  Woow Pi Agent — browser terminal
  ────────────────────────────────────────────────────────────
  data dir : ${PI_CODING_AGENT_DIR}
  image    : ${PI_AGENT_IMAGE_VERSION:-dev}  (pi-web ${PI_WEB_VERSION:-?} · ttyd ${TTYD_VERSION:-?})

  pi                 start an interactive agent session (TUI)
  pi config          TUI to enable/disable skills, extensions, prompts
  pi auth            inspect stored provider credentials
  pi install <src>   install a skill or extension
  pi --list-models   list models the current config can reach

  This shell and the web UI share ${DATA_DIR}. Prefer the web UI's
  Models page for provider/API-key changes; if you edit models.json
  from here while the UI has it open, last writer wins.
  ────────────────────────────────────────────────────────────

BANNER

exec bash -l
