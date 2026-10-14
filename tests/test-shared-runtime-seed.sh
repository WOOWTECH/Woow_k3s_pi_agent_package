#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED="${ROOT}/rootfs/usr/local/bin/pi-shared-runtime-seed.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

BUNDLE="${WORK}/bundle"
DATA="${WORK}/data"
mkdir -p "${BUNDLE}"
cat >"${BUNDLE}/package.json" <<'JSON'
{"name":"@woowtech/pi-agent-shared-runtime","version":"test"}
JSON

run_seed() {
  PI_AGENT_DATA_DIR="${DATA}" \
  PI_SHARED_RUNTIME_BUNDLE_DIR="${BUNDLE}" \
  PI_SHARED_RUNTIME_SEED_ONLY=1 \
  bash "${SEED}"
}

# A new data directory gets exactly one image-bundled package entry.
run_seed
node - "${DATA}/settings.json" "${BUNDLE}" "${DATA}/shared-runtime/image-seed.json" <<'NODE'
const fs = require('node:fs');
const [settings, bundle, marker] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(settings));
if (JSON.stringify(config.packages) !== JSON.stringify([bundle])) throw new Error('bundle was not registered once');
const seed = JSON.parse(fs.readFileSync(marker));
if (seed.mode !== 'seeded' || seed.source !== bundle) throw new Error('missing first-boot marker');
NODE

# A normal boot invokes the runtime watcher asynchronously after registration.
mkdir -p "${BUNDLE}/bin"
cat >"${BUNDLE}/bin/cli.mjs" <<'NODE'
import fs from 'node:fs';
const file = `${process.env.PI_AGENT_DATA_DIR}/shared-runtime/boot-args.json`;
fs.writeFileSync(file, JSON.stringify(process.argv.slice(2)));
NODE
PI_AGENT_DATA_DIR="${DATA}" PI_SHARED_RUNTIME_BUNDLE_DIR="${BUNDLE}" bash "${SEED}"
for _ in $(seq 1 30); do
  [ -f "${DATA}/shared-runtime/boot-args.json" ] && break
  sleep 0.1
done
node - "${DATA}/shared-runtime/boot-args.json" <<'NODE'
const fs = require('node:fs');
const args = JSON.parse(fs.readFileSync(process.argv[2]));
if (JSON.stringify(args) !== JSON.stringify(['boot', '--current'])) throw new Error(`unexpected bootstrap args: ${args}`);
NODE

# It is idempotent and preserves unrelated user settings and packages.
node - "${DATA}/settings.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const data = JSON.parse(fs.readFileSync(file));
data.userFlag = 'keep';
data.packages.unshift('npm:example/user-plugin');
fs.writeFileSync(file, JSON.stringify(data));
NODE
run_seed
node - "${DATA}/settings.json" "${BUNDLE}" <<'NODE'
const fs = require('node:fs');
const [settings, bundle] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(settings));
if (config.userFlag !== 'keep') throw new Error('unrelated settings were overwritten');
if (config.packages.filter(item => item === bundle).length !== 1) throw new Error('bundle entry was duplicated');
if (!config.packages.includes('npm:example/user-plugin')) throw new Error('user package was removed');
NODE

# Once seeded, a deliberate removal remains removed across a restart.
node - "${DATA}/settings.json" "${BUNDLE}" <<'NODE'
const fs = require('node:fs');
const [settings, bundle] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(settings));
config.packages = config.packages.filter(item => item !== bundle);
fs.writeFileSync(settings, JSON.stringify(config));
NODE
run_seed
node - "${DATA}/settings.json" "${BUNDLE}" <<'NODE'
const fs = require('node:fs');
const [settings, bundle] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(settings));
if (config.packages.includes(bundle)) throw new Error('a user removal was re-added');
NODE

# An older externally installed runtime stays authoritative on migration.
DATA="${WORK}/external"
mkdir -p "${DATA}"
cat >"${DATA}/settings.json" <<'JSON'
{"packages":["git:https://github.com/WOOWTECH/pi-agent-shared-runtime","npm:example/keep"]}
JSON
run_seed
node - "${DATA}/settings.json" "${BUNDLE}" "${DATA}/shared-runtime/image-seed.json" <<'NODE'
const fs = require('node:fs');
const [settings, bundle, marker] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(settings));
if (config.packages.includes(bundle)) throw new Error('external runtime was replaced');
if (!config.packages.includes('npm:example/keep')) throw new Error('unrelated external package was removed');
if (JSON.parse(fs.readFileSync(marker)).mode !== 'external') throw new Error('external runtime was not recorded');
NODE

echo "shared runtime first-boot seed: PASS"
