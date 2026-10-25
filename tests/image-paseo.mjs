// Validate the image artifact without login, pairing, model calls or downloads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runtimeReady, runtimeDirectory } from '/opt/woow/pi-paseo-plugin/src/runtime-layout.mjs';
const loc = { runtimeDir: '/opt/woow/pi-paseo-runtime' };
assert.equal(runtimeReady(loc), true, 'locked Paseo runtime must be ready in the image');
const runtime = runtimeDirectory(loc);
const cli = spawnSync(process.execPath, [path.join(runtime, 'node_modules/@getpaseo/cli/bin/paseo'), '--version'], { encoding: 'utf8', timeout: 30000 });
assert.equal(cli.status, 0); assert.equal(cli.stdout.trim(), '0.11.2');
const bundle = '/opt/woow/pi-paseo-plugin';
assert.equal(JSON.parse(fs.readFileSync(path.join(bundle, 'package.json'))).version, '0.1.7');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-image-'));
try {
  const env = { ...process.env, HOME: temp, PI_AGENT_DATA_DIR: temp, PI_CODING_AGENT_DIR: temp, PI_PASEO_PLUGIN_ROOT: bundle };
  for (let boot = 0; boot < 2; boot++) {
    const result = spawnSync(process.execPath, ['/usr/local/bin/pi-paseo-seed.mjs'], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, 'bundled registration requires no package manager');
  }
  const settings = JSON.parse(fs.readFileSync(path.join(temp, 'settings.json')));
  assert.deepEqual(settings.packages, [bundle]);
  assert.equal(fs.existsSync(path.join(temp, 'pi-paseo/daemon')), false, 'image seeding does not distribute a daemon identity');
  assert.equal(fs.existsSync(path.join(temp, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(temp, 'pi-paseo/pairing.private.json')), false);
  for (const route of ['api/plugin-paseo/route.js', 'paseo/setup/page.js']) {
    assert.ok(fs.existsSync('/usr/local/lib/node_modules/@agegr/pi-web/.next/server/app/' + route));
  }
  console.log('[build] pinned Paseo runtime, native routes and repeat registration OK');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
