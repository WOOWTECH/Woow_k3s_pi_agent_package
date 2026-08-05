#!/bin/bash
# Entrypoint for the pi-web container.
#
# Replaces the add-on's s6 `pi-web/run`. Everything bashio used to read from
# the Supervisor's options.json now arrives as plain env from the Helm chart.
set -euo pipefail

# Both streams to stdout so crash traces land in `kubectl logs` next to the
# ordinary output instead of being split across two channels.
exec 2>&1

# shellcheck source=/dev/null
source /usr/local/bin/pi-agent-env.sh

DATA_DIR="${PI_AGENT_DATA_DIR:-/data/pi-agent}"
log() { printf '[pi-web] %s\n' "$*"; }

mkdir -p "${DATA_DIR}/sessions" "${DATA_DIR}/home" "${DATA_DIR}/skills" "${DATA_DIR}/rclone"

# --- Skills path bridge -------------------------------------------------------
# pi-web reads skills from ${PI_CODING_AGENT_DIR}/skills, but the `skills` CLI
# (and `pi install`) writes to the agent's own home at $HOME/.pi/agent/skills.
# On the HA add-on those happen to coincide; here they do not, so an install
# succeeds and then the skill never shows up in a session. Bridge the two with
# a symlink, migrating anything already written to the wrong side.
AGENT_SKILLS_DIR="${HOME}/.pi/agent/skills"
mkdir -p "$(dirname "${AGENT_SKILLS_DIR}")"
if [ -d "${AGENT_SKILLS_DIR}" ] && [ ! -L "${AGENT_SKILLS_DIR}" ]; then
  log "migrating existing skills from ${AGENT_SKILLS_DIR} into ${DATA_DIR}/skills"
  cp -an "${AGENT_SKILLS_DIR}/." "${DATA_DIR}/skills/" 2>/dev/null || true
  rm -rf "${AGENT_SKILLS_DIR}"
fi
if [ ! -e "${AGENT_SKILLS_DIR}" ]; then
  ln -sfn "${DATA_DIR}/skills" "${AGENT_SKILLS_DIR}"
  log "skills bridged: ${AGENT_SKILLS_DIR} -> ${DATA_DIR}/skills"
fi

# --- Video tools reset (maintenance escape hatch) -----------------------------
# Ported from the add-on's reset_video_tools option. Without it, recovering a
# half-written venv means exec'ing in and deleting the sentinel by hand — and a
# venv on NFS is exactly the thing that ends up half-written.
if [ "${RESET_VIDEO_TOOLS:-false}" = "true" ]; then
  log "RESET_VIDEO_TOOLS=true — clearing venv, playwright cache and sentinel"
  rm -rf "${DATA_DIR}/.video-tools-installed" "${DATA_DIR}/venv" "${DATA_DIR}/playwright-cache"
  log "  set it back to false once the reinstall completes, or every restart re-downloads ~720MB"
fi

# --- Timezone -----------------------------------------------------------------
# Debian defaults to UTC, which makes session timestamps and any SRT cue the
# video pipeline generates awkward for a Taipei team. Node reads TZ from the
# environment, not /etc/timezone, so both are set.
if [ -n "${TZ:-}" ]; then
  if [ -f "/usr/share/zoneinfo/${TZ}" ]; then
    ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime
    echo "${TZ}" > /etc/timezone
    log "timezone set to ${TZ}"
  else
    log "WARNING: timezone '${TZ}' not found in /usr/share/zoneinfo — staying on UTC"
  fi
fi

# --- Video pipeline bootstrap -------------------------------------------------
# Deliberately backgrounded rather than run as an initContainer.
#
# The first-run install pulls ~720MB (Python venv + Playwright's Chromium). As
# a blocking initContainer that delays the pi-web container by 10-20 minutes on
# a cold volume, and any hiccup in the download becomes a pod that never serves
# traffic. The add-on ran it as an s6 oneshot with no dependency edge — chat
# stays usable while the video tools install behind it. Same semantics here:
# non-blocking, non-fatal, sentinel-guarded.
if [ "${VIDEO_PIPELINE_ENABLED:-true}" = "true" ]; then
  log "video pipeline enabled — bootstrapping in background"
  /usr/local/bin/video-tools-init.sh &
else
  log "video pipeline disabled (VIDEO_PIPELINE_ENABLED=${VIDEO_PIPELINE_ENABLED:-})"
fi

# --- pi-web runtime -----------------------------------------------------------
export PI_WEB_HOSTNAME="${PI_WEB_HOSTNAME:-127.0.0.1}"
export PI_WEB_NO_OPEN=1
export PORT="${PI_WEB_PORT:-30141}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

cd "${HOME}"

log "starting pi-web on ${PI_WEB_HOSTNAME}:${PORT}"
log "  data dir : ${PI_CODING_AGENT_DIR}"
log "  home     : ${HOME}"
log "  image    : ${PI_AGENT_IMAGE_VERSION:-dev} (pi-web ${PI_WEB_VERSION:-?}, ttyd ${TTYD_VERSION:-?})"

exec pi-web
