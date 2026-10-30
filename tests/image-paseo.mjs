// Validate the image artifact without login, pairing, model calls or downloads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runtimeReady, runtimeDirectory, RUNTIME_REVISION } from '/opt/woow/pi-paseo-plugin/src/runtime-layout.mjs';
import { withPidTransition, PID_TRANSITION_PROTOCOL } from '/opt/woow/pi-paseo-plugin/src/pid-transition.mjs';
import { webClientStatus } from '/opt/woow/pi-paseo-plugin/src/web-client.mjs';
const loc = { runtimeDir: '/opt/woow/pi-paseo-runtime' };
assert.equal(runtimeReady(loc), true, 'locked Paseo runtime must be ready in the image');
const runtime = runtimeDirectory(loc);
const cli = spawnSync(process.execPath, [path.join(runtime, 'node_modules/@getpaseo/cli/bin/paseo'), '--version'], { encoding: 'utf8', timeout: 30000 });
assert.equal(cli.status, 0); assert.equal(cli.stdout.trim(), '0.11.2');
// The runtime lockfile has no libc field, so npm also installs the musl Claude
// SDK on Debian. The SDK picks the glibc build first; the musl one never runs.
const claudeSdk = path.join(runtime, 'node_modules/@anthropic-ai');
assert.ok(fs.statSync(path.join(claudeSdk, `claude-agent-sdk-linux-${process.arch}`, 'claude')).isFile(), 'glibc Claude SDK binary must ship');
assert.deepEqual(fs.readdirSync(claudeSdk).filter(name => name.endsWith('-musl')), [], 'the unused musl Claude SDK must not ship');
const bundle = '/opt/woow/pi-paseo-plugin';
// Keep in step with `ARG PI_PASEO_VERSION` in the Dockerfile; a mismatch fails the image build here.
assert.equal(JSON.parse(fs.readFileSync(path.join(bundle, 'package.json'))).version, '0.1.15');
assert.equal(RUNTIME_REVISION, '0.11.2-r3-6d8dbe515479');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-image-'));
try {
  // Exercise the baked helper and native writers on each image architecture.
  // This is a private PID-file fixture; it starts no daemon or provider.
  const lockHome = path.join(temp, 'pid-writer-fixture');
  fs.mkdirSync(lockHome, { mode: 0o700 });
  const guard = path.join(lockHome, '.pi-paseo-pid-transition.guard');
  await withPidTransition(lockHome, async () => {
    const competing = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', guard, '/bin/true'], { timeout: 5000 });
    assert.equal(competing.status, 73, 'the baked flock helper must exclude a competing writer');
  });
  const guardInode = fs.statSync(guard).ino;
  for (const copy of ['dist/server/server', 'dist/src/server']) {
    const writer = await import(pathToFileURL(path.join(runtime, 'node_modules/@getpaseo/server', copy, 'pid-lock.js')).href);
    await writer.acquirePidLock(lockHome, '127.0.0.1:1');
    const record = await writer.getPidLockInfo(lockHome);
    assert.equal(record.pid, process.pid);
    assert.equal(record.piPaseoProtocol, PID_TRANSITION_PROTOCOL);
    await writer.updatePidLock(lockHome, { listen: '127.0.0.1:2' });
    await writer.refreshPidLock(lockHome);
    await writer.releasePidLock(lockHome, { ownerPid: process.pid, startedAt: record.startedAt });
    assert.equal(fs.existsSync(path.join(lockHome, 'paseo.pid')), false);
    assert.equal(fs.statSync(guard).ino, guardInode, 'all writers keep the same guard inode');
  }
  const env = { ...process.env, HOME: temp, PI_AGENT_DATA_DIR: temp, PI_CODING_AGENT_DIR: temp, PI_PASEO_PLUGIN_ROOT: bundle };
  for (let boot = 0; boot < 2; boot++) {
    const result = spawnSync(process.execPath, ['/usr/local/bin/pi-paseo-seed.mjs'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, 'bundled registration requires no package manager');
  }
  assert.equal(webClientStatus({stateDir: path.join(temp, 'pi-paseo')}).ready, true, 'offline client must be ready before Pi Web starts');
  const settings = JSON.parse(fs.readFileSync(path.join(temp, 'settings.json')));
  assert.deepEqual(settings.packages, [bundle]);
  assert.equal(fs.existsSync(path.join(temp, 'pi-paseo/daemon')), false, 'image seeding does not distribute a daemon identity');
  assert.equal(fs.existsSync(path.join(temp, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(temp, 'pi-paseo/pairing.private.json')), false);
  for (const route of ['api/plugin-paseo/route.js', 'paseo/setup/page.js', 'paseo-web/[[...path]]/route.js']) {
    assert.ok(fs.existsSync('/usr/local/lib/node_modules/@agegr/pi-web/.next/server/app/' + route));
  }
  console.log('[build] pinned Paseo runtime, native routes and repeat registration OK');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
// An official git pin moves to the bundle before Pi Web starts, once, with a
// backup and a receipt. The checks below run after the migration boot and a
// repeat boot (one receipt run, offline client ready); paseo-web-offline.mjs
// checks the client right after a single migration boot.
const upgrade = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-upgrade-'));
try {
  const pin = 'git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.9';
  fs.writeFileSync(path.join(upgrade, 'settings.json'), JSON.stringify({ packages: [pin] }));
  const env = { ...process.env, HOME: upgrade, PI_AGENT_DATA_DIR: upgrade, PI_CODING_AGENT_DIR: upgrade, PI_PASEO_PLUGIN_ROOT: bundle };
  for (let boot = 0; boot < 2; boot++) {
    const result = spawnSync(process.execPath, ['/usr/local/bin/pi-paseo-seed.mjs'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, 'moving an official pin requires no package manager or network');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(upgrade, 'settings.json'))).packages, [bundle]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(upgrade, 'settings.json.pre-image-migration.bak'))).packages, [pin]);
  const receipt = JSON.parse(fs.readFileSync(path.join(upgrade, 'pi-paseo/image-migration.json')));
  assert.equal(receipt.runs.length, 1); assert.equal(receipt.runs[0].changed[0].from, pin);
  assert.equal(webClientStatus({ stateDir: path.join(upgrade, 'pi-paseo') }).ready, true, 'offline client must be ready after the migration and repeat boots');
  console.log('[build] official Paseo git pin moved to the image bundle; offline client ready');
} finally { fs.rmSync(upgrade, { recursive: true, force: true }); }
