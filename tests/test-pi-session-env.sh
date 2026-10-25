#!/bin/bash
# Exercise the actual launcher with fixture paths instead of changing the host.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/modules/@earendil-works/pi-coding-agent/dist"
printf '%s\n' 'console.log(process.env.PI_CODING_AGENT_DIR)' > "$WORK/modules/@earendil-works/pi-coding-agent/dist/cli.js"
printf '%s\n' 'export PI_CODING_AGENT_DIR=/canonical/agent' > "$WORK/env.sh"
sed -e "s|/usr/lib/node_modules|$WORK/modules|g" -e "s|/usr/local/lib/node_modules|$WORK/modules|g" -e "s|/usr/local/bin/pi-agent-env.sh|$WORK/env.sh|g" "$ROOT/rootfs/usr/local/bin/pi" > "$WORK/pi"
actual=$(PI_CODING_AGENT_DIR=/private/session bash "$WORK/pi")
[ "$actual" = /private/session ]
actual=$(env -u PI_CODING_AGENT_DIR bash "$WORK/pi")
[ "$actual" = /canonical/agent ]
echo 'Pi native session catalog survives image environment: PASS'
