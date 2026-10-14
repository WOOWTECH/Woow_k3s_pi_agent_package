#!/bin/bash
# Register the image-bundled sharing runtime once for a fresh Pi data volume.
#
# The package itself stays immutable under /opt. Only Pi's package registration,
# sync state and the user's Claude/Codex configuration live on the data volume.
set -euo pipefail

DATA_DIR="${PI_AGENT_DATA_DIR:-/data/pi-agent}"
BUNDLE_DIR="${PI_SHARED_RUNTIME_BUNDLE_DIR:-/opt/woow/pi-agent-shared-runtime}"
STATE_DIR="${DATA_DIR}/shared-runtime"
SETTINGS_FILE="${DATA_DIR}/settings.json"
MARKER_FILE="${STATE_DIR}/image-seed.json"

log() { printf '[pi-shared-runtime] %s\n' "$*"; }

if [ ! -f "${BUNDLE_DIR}/package.json" ]; then
  log "bundle missing; startup continues without automatic sharing"
  exit 0
fi
if [ "${PI_SHARED_RUNTIME_SEED_ONLY:-0}" != "1" ] && [ ! -f "${BUNDLE_DIR}/bin/cli.mjs" ]; then
  log "bundle CLI missing; startup continues without automatic sharing"
  exit 0
fi

mkdir -p "${STATE_DIR}"
umask 077

# Exit 0 means the bundled runtime is registered and can boot. Exit 10 means
# an existing package or a deliberate user removal must be preserved.
if node - "${SETTINGS_FILE}" "${BUNDLE_DIR}" "${MARKER_FILE}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const [settingsFile, bundleDir, markerFile] = process.argv.slice(2);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sourceOf = entry => typeof entry === 'string' ? entry : entry?.source;
const isRuntime = source => typeof source === 'string' && (
  path.resolve(source) === path.resolve(bundleDir) || source.includes('pi-agent-shared-runtime')
);
const disabled = entry => typeof entry === 'object' && Array.isArray(entry.extensions) && entry.extensions.length === 0;
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
};

let settings = {};
try {
  if (fs.existsSync(settingsFile)) settings = read(settingsFile);
} catch (error) {
  console.error(`invalid Pi settings: ${error.message}`);
  process.exit(1);
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
  console.error('invalid Pi settings root');
  process.exit(1);
}
if (!Array.isArray(settings.packages)) settings.packages = [];

const existing = settings.packages.find(entry => isRuntime(sourceOf(entry)));
const marker = fs.existsSync(markerFile) ? read(markerFile) : null;
if (marker) {
  if (existing && path.resolve(sourceOf(existing)) === path.resolve(bundleDir) && !disabled(existing)) {
    console.log('managed runtime already registered');
    process.exit(0);
  }
  console.log('runtime seed already completed; preserving current user choice');
  process.exit(10);
}

if (existing) {
  write(markerFile, { schema: 1, mode: disabled(existing) ? 'disabled' : 'external', source: sourceOf(existing), seededAt: new Date().toISOString() });
  console.log('existing runtime package preserved');
  process.exit(10);
}

settings.packages.push(bundleDir);
write(settingsFile, settings);
write(markerFile, { schema: 1, mode: 'seeded', source: bundleDir, seededAt: new Date().toISOString() });
console.log('bundled runtime registered');
NODE
then
  if [ "${PI_SHARED_RUNTIME_SEED_ONLY:-0}" = "1" ]; then
    exit 0
  fi
  log "starting shared skills/MCP bootstrap in background"
  (
    exec node "${BUNDLE_DIR}/bin/cli.mjs" boot --current
  ) >> "${STATE_DIR}/image-bootstrap.log" 2>&1 &
else
  status=$?
  if [ "${status}" -eq 10 ]; then
    log "automatic seed skipped; existing runtime setting is preserved"
  else
    log "automatic seed could not read settings; startup continues without changes"
  fi
fi
