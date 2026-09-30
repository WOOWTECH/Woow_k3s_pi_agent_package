#!/usr/bin/env bash
# Sync paas/ — the WOOW PaaS pi-agent edition — from the Gitea source of truth.
#
# The rest of this repository is the k3s package itself (the upstream
# ghcr.io/woowtech/woow-k3s-pi-agent image and the single-instance chart that
# runs the internal pi-agent-woow machines). paas/ is different: it is a
# READ-ONLY MIRROR of the PaaS cloud service, whose sources live on the
# internal Gitea (git-prod.woowtech.io). Edits made under paas/ are overwritten
# by the next sync.
#
#   paas/image/  <- woow-paas/paas-odoo-ci      pi-agent/
#   paas/chart/  <- woow-paas/woow-paas-charts  charts/pi-agent/
#
# Usage:  scripts/sync-paas-from-gitea.sh [paas-odoo-ci-ref] [woow-paas-charts-ref]
#         (both refs default to "main")
#
# Needs git read access to the Gitea repos (e.g. a credential helper for
# https://git-prod.woowtech.io). Writes the resolved commits into
# paas/MIRROR.md so every mirrored file traces back to its source revision.
set -Eeuo pipefail

GITEA="${GITEA_URL:-https://git-prod.woowtech.io}"
CI_REF="${1:-main}"
CHARTS_REF="${2:-main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch() {  # fetch <repo> <ref> <dir>
  git init -q "$3"
  git -C "$3" fetch -q --depth 1 "$GITEA/$1.git" "$2"
  git -C "$3" checkout -q FETCH_HEAD
  git -C "$3" rev-parse HEAD
}

CI_SHA="$(fetch woow-paas/paas-odoo-ci "$CI_REF" "$WORK/ci")"
CHARTS_SHA="$(fetch woow-paas/woow-paas-charts "$CHARTS_REF" "$WORK/charts")"

replace() {  # replace <src-dir> <dst-dir>
  [ -d "$1" ] || { echo "missing source directory: $1" >&2; exit 1; }
  rm -rf "$2"
  mkdir -p "$2"
  cp -a "$1/." "$2/"
}

replace "$WORK/ci/pi-agent"              "$ROOT/paas/image"
replace "$WORK/charts/charts/pi-agent"   "$ROOT/paas/chart"

CHART_VERSION="$(sed -n 's/^version: *//p' "$ROOT/paas/chart/Chart.yaml")"
APP_VERSION="$(sed -n 's/^appVersion: *"\{0,1\}\([^"]*\)"\{0,1\}/\1/p' "$ROOT/paas/chart/Chart.yaml")"

# Rewrite only the generated block of paas/MIRROR.md; the prose around it is kept.
python3 - "$ROOT/paas/MIRROR.md" "$ROOT/paas/chart/values.yaml" "$ROOT/paas/image/Dockerfile" \
  "$CI_SHA" "$CHARTS_SHA" "$CHART_VERSION" "$APP_VERSION" <<'PY'
import sys, re, datetime
path, values_path, dockerfile, ci, charts, chart_ver, app_ver = sys.argv[1:8]
values = open(values_path, encoding="utf-8").read()
repo = re.search(r'^  repository: (\S+)', values, re.M).group(1)
base = re.search(r'^ARG BASE=(\S+)', open(dockerfile, encoding="utf-8").read(), re.M).group(1)
block = (
    "<!-- BEGIN GENERATED: scripts/sync-paas-from-gitea.sh -->\n"
    "| Mirror path | Source repository | Source path | Commit |\n"
    "|---|---|---|---|\n"
    f"| `paas/image/` | `woow-paas/paas-odoo-ci` | `pi-agent/` | `{ci}` |\n"
    f"| `paas/chart/` | `woow-paas/woow-paas-charts` | `charts/pi-agent/` | `{charts}` |\n"
    "\n"
    f"PaaS image base (this repository's release): `{base}`  \n"
    f"PaaS image repository: `{repo}` (the platform pins the tag by `tag@sha256`)\n"
    "\n"
    f"Chart `{chart_ver}` / pi-agent image `{app_ver}` — synced "
    f"{datetime.datetime.now(datetime.timezone.utc):%Y-%m-%d %H:%M} UTC.\n"
    "<!-- END GENERATED -->"
)
text = open(path, encoding="utf-8").read()
new, n = re.subn(r"<!-- BEGIN GENERATED.*?<!-- END GENERATED -->", block, text, flags=re.S)
if n != 1:
    sys.exit("paas/MIRROR.md is missing its generated block markers")
open(path, "w", encoding="utf-8").write(new)
PY

echo "synced: paas-odoo-ci@${CI_SHA:0:8}  woow-paas-charts@${CHARTS_SHA:0:8}  paas chart ${CHART_VERSION} / image ${APP_VERSION}"
