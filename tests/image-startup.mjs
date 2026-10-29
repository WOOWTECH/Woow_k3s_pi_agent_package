// Run inside the built image before publication. No host/server login or model
// request is made: only real SDK registration and launcher routing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const bundle = '/opt/woow/pi-omnigent-plugin', nativeWeb = '/usr/local/bin/pi-web';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnigent-image-'));
try {
  const env = { ...process.env, HOME: temporary, PI_AGENT_DATA_DIR: temporary, PI_CODING_AGENT_DIR: temporary };
  const run = () => {
    const result = spawnSync(process.execPath, ['/usr/local/bin/pi-omnigent-seed.mjs'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, 'real SDK must register the plugin and prepare a managed launcher');
  };
  run(); run();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary, 'settings.json'))).packages, [bundle]);
  assert.equal(fs.existsSync(path.join(temporary, 'omnigent-plugin/onboarding.json')), false, 'startup must not create onboarding state');
  const sessionsDir = path.join(temporary, 'sessions');
  const sessions = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir, { recursive: true }).filter(file => file.endsWith('.jsonl')) : [];
  assert.equal(sessions.length, 0, 'startup must not create a conversation');
  assert.ok(!fs.existsSync(path.join(temporary, '.omnigent/config.yaml')), 'no host identity or login is distributed');
  for (const file of ['settings.json.pre-image-migration.bak', 'omnigent-plugin/image-migration.json']) {
    assert.equal(fs.existsSync(path.join(temporary, file)), false, `a fresh volume has nothing to migrate: ${file}`);
  }
  const root = spawnSync(process.execPath, ['/usr/local/bin/pi-omnigent-seed.mjs', '--resolve-root'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(root.status, 0); assert.equal(root.stdout, bundle);
  console.log('[build] real SDK settings-only registration and repeat boot OK');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }

// An existing volume whose plugin is pinned to the official git repository and
// whose launcher still starts a Pi Web copy built by an older plugin. The image
// moves both to its own copies before Pi Web starts, and the bundled plugin's
// first lifecycle check keeps the recorded consent: no second sign-in.
const upgrade = fs.mkdtempSync(path.join(os.tmpdir(), 'omnigent-upgrade-'));
try {
  const env = { ...process.env, HOME: upgrade, PI_AGENT_DATA_DIR: upgrade, PI_CODING_AGENT_DIR: upgrade };
  const pin = 'git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.21';
  const state = path.join(upgrade, 'omnigent-plugin'), clone = path.join(upgrade, 'git/github.com/WOOWTECH/pi-omnigent-plugin');
  const shim = path.join(upgrade, '.local/bin/pi-web'), copy = path.join(upgrade, '.local/share/pi-omnigent-web/pi-web/bin/pi-web.js');
  for (const dir of [path.join(clone, 'bin'), state, path.dirname(shim)]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: '@woowtech/pi-omnigent-plugin', version: '0.3.21' }));
  fs.writeFileSync(path.join(clone, 'bin/cli.mjs'), '');
  fs.writeFileSync(path.join(upgrade, 'settings.json'), JSON.stringify({ packages: [pin] }));
  const consent = { phase: 'needs-verification', enabled: true, nativeActive: true, loginConfirmed: true, server: 'https://omnigent.invalid' };
  fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify(consent), { mode: 0o600 });
  fs.writeFileSync(path.join(state, 'verification.json'), JSON.stringify({ claude: { ok: true } }), { mode: 0o600 });
  fs.writeFileSync(path.join(state, 'host.json'), JSON.stringify({ version: 1, realWeb: copy, shim, mode: 'path-wrapper' }), { mode: 0o600 });
  fs.writeFileSync(shim, `#!/usr/bin/env node\n// pi-omnigent-plugin web launcher\nconst cli=${JSON.stringify(path.join(clone, 'bin/cli.mjs'))};\n`, { mode: 0o755 });
  for (let boot = 0; boot < 2; boot++) {
    const result = spawnSync(process.execPath, ['/usr/local/bin/pi-omnigent-seed.mjs'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, 'the seed must move the pin and prepare the bundled launcher');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(upgrade, 'settings.json'))).packages, [bundle]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(upgrade, 'settings.json.pre-image-migration.bak'))).packages, [pin]);
  const receipt = JSON.parse(fs.readFileSync(path.join(state, 'image-migration.json')));
  assert.equal(receipt.runs.length, 1, 'the second boot changes nothing');
  assert.equal(receipt.runs[0].changed[0].from, pin);
  assert.deepEqual([receipt.runs[0].launcher.from, receipt.runs[0].launcher.to], [copy, nativeWeb]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'host.json'))).realWeb, nativeWeb);
  const launcher = fs.readFileSync(shim, 'utf8');
  assert.ok(launcher.includes(path.join(bundle, 'bin/cli.mjs')) && !launcher.includes(clone), 'Pi Web must start through the bundled plugin');
  const root = spawnSync(process.execPath, ['/usr/local/bin/pi-omnigent-seed.mjs', '--resolve-root'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(root.stdout, bundle);
  // The first thing launch-web does: the bundled plugin observes its own registration.
  const web = await import(path.join(bundle, 'src/web.mjs'));
  const runtime = await import(path.join(bundle, 'src/runtime.mjs'));
  const lifecycle = await web.packageLifecycle({ env });
  assert.equal(lifecycle.active, true); assert.equal(lifecycle.registered, true);
  assert.equal((await runtime.observeLifecycle(lifecycle, { env })).reset, false, 'moving the pin must not reset consent');
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'state.json'))).loginConfirmed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'verification.json'))), { claude: { ok: true } });
  console.log('[build] official git pin and old Pi Web copy moved to the image; consent kept');
} finally { fs.rmSync(upgrade, { recursive: true, force: true }); }
