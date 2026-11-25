// Validate the image artifact without login, pairing, model calls or downloads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runtimeReady, runtimeDirectory, RUNTIME_REVISION } from '/opt/woow/pi-paseo-plugin/src/runtime-layout.mjs';
import { withPidTransition, PID_TRANSITION_PROTOCOL } from '/opt/woow/pi-paseo-plugin/src/pid-transition.mjs';
const loc = { runtimeDir: '/opt/woow/pi-paseo-runtime' };
assert.equal(runtimeReady(loc), true, 'locked Paseo runtime must be ready in the image');
const runtime = runtimeDirectory(loc);
const bundle = '/opt/woow/pi-paseo-plugin';
const omnigent = '/opt/woow/pi-omnigent-plugin';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts)));
// The runtime manifest names the Paseo release its lockfile installs. The Dockerfile pins each
// archive's version and digest and candidate-packages/manifest.json records the runtime revision
// (checked against the archive by tests/test_publication_packages.py), so nothing here repeats them.
const paseoVersion = readJson(bundle, 'runtime/package.json').dependencies['@getpaseo/cli'];
const lockSha = sha256(fs.readFileSync(path.join(bundle, 'runtime/package-lock.json')));
const cli = spawnSync(process.execPath, [path.join(runtime, 'node_modules/@getpaseo/cli/bin/paseo'), '--version'], { encoding: 'utf8', timeout: 30000 });
assert.equal(cli.status, 0); assert.equal(cli.stdout.trim(), paseoVersion);
// The runtime lockfile has no libc field, so npm also installs the musl Claude
// SDK on Debian. The SDK picks the glibc build first; the musl one never runs.
const claudeSdk = path.join(runtime, 'node_modules/@anthropic-ai');
assert.ok(fs.statSync(path.join(claudeSdk, `claude-agent-sdk-linux-${process.arch}`, 'claude')).isFile(), 'glibc Claude SDK binary must ship');
assert.deepEqual(fs.readdirSync(claudeSdk).filter(name => name.endsWith('-musl')), [], 'the unused musl Claude SDK must not ship');
// The runtime directory, its receipt and the revision all derive from the Paseo release and the exact lockfile.
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
assert.match(RUNTIME_REVISION, new RegExp(`^${escaped(paseoVersion)}-r[0-9]+-${lockSha.slice(0, 12)}$`));
assert.equal(path.basename(runtime), RUNTIME_REVISION);
assert.equal(readJson(runtime, '.pi-paseo-runtime.json').revision, RUNTIME_REVISION);
assert.equal(readJson(runtime, '.pi-paseo-runtime.json').lockSha256, lockSha);
// Agent Connect and the Omnigent plugin's combined Pi Web adapter are one pair: the adapter pins exactly
// one Agent Connect version and its adapter patch, so the two archives move together.
const pairing = readJson(omnigent, 'integrations/pi-web/combined.adapter-meta.json').paseo;
const agentConnect = readJson(bundle, 'package.json');
assert.deepEqual([pairing.packageName, pairing.packageVersion], [agentConnect.name, agentConnect.version], 'Agent Connect must be the exact version the combined adapter pins');
assert.equal(pairing.adapterPatchSha256, sha256(fs.readFileSync(path.join(bundle, 'host/adapter.patch'))));
// The bundled /paseo-web client is retired: nothing of it ships, and no Paseo target needs it.
for (const retired of ['src/web-client.mjs', 'runtime/web-client.json']) assert.equal(fs.existsSync(path.join(bundle, retired)), false, retired);
assert.equal(fs.existsSync('/opt/woow/pi-paseo-web'), false, 'no bundled Paseo web client archive');
const expectedBrand = {server: '17ea88357d2f25caab81ad63d32804fe41158c1d70e8e4f549c4fc7173fe8d68', helper: '036471982ccbbb5a7c3418631518025b245ac50e1c0b1a29c3824d16ba069733', patchId: '20f860e40bfb9d654182fd996f4f1999f2b73fe2f2f924519bc344a5592e89f2'};
const brandDirectory = path.join(runtime, 'node_modules/@getpaseo/server/dist/server/server');
for (const [name, expected] of [['websocket-server.js', expectedBrand.server], ['pi-paseo-brand-identity.mjs', expectedBrand.helper]]) {
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(brandDirectory, name))).digest('hex'), expected, name);
}
assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, '.pi-paseo-runtime.json'))).brandIdentityPatchId, expectedBrand.patchId);
for (const selected of ['woowtech', 'apporo', 'paseo']) {
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', 'const m=await import(process.argv[1]);console.log(m.agentConnectBrand.id)', pathToFileURL(path.join(brandDirectory, 'pi-paseo-brand-identity.mjs')).href], {env: {...process.env, PI_PASEO_CONNECTION_TARGET:selected}, encoding:'utf8', timeout:5000});
  assert.equal(probe.status, 0); assert.equal(probe.stdout.trim(), selected);
}
console.log('[build] exact server brand patch and three selected identities OK');
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
  assert.equal(fs.existsSync(path.join(temp, 'pi-paseo/web-client')), false, 'a fresh volume gets no Paseo web client directory');
  const settings = JSON.parse(fs.readFileSync(path.join(temp, 'settings.json')));
  assert.deepEqual(settings.packages, [bundle]);
  assert.equal(fs.existsSync(path.join(temp, 'pi-paseo/daemon')), false, 'image seeding does not distribute a daemon identity');
  assert.equal(fs.existsSync(path.join(temp, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(temp, 'pi-paseo/pairing.private.json')), false);
  const routes = '/usr/local/lib/node_modules/@agegr/pi-web/.next/server/app/';
  for (const route of ['api/plugin-paseo/route.js', 'paseo/setup/page.js']) assert.ok(fs.existsSync(routes + route), route);
  assert.equal(fs.existsSync(routes + 'paseo-web'), false, 'the retired /paseo-web route is not built');
  console.log('[build] pinned Paseo runtime, native routes and repeat registration OK');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
// An official git pin moves to the bundle before Pi Web starts, once, with a
// backup and a receipt. The checks below run after the migration boot and a
// repeat boot (one receipt run). The volume also holds the web client state an
// older image or plugin left behind: the seed must neither need, recreate nor
// remove it, because the plugin deletes it itself when it activates.
const upgrade = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-upgrade-'));
try {
  // 0.1.9 is the first Agent Connect release that downloaded the bundled web client.
  const pin = 'git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.9';
  fs.writeFileSync(path.join(upgrade, 'settings.json'), JSON.stringify({ packages: [pin] }));
  const retired = path.join(upgrade, 'pi-paseo/web-client');
  const release = path.join(retired, 'a'.repeat(64)), staging = path.join(retired, '.stage-00000000-0000-4000-8000-000000000000');
  for (const directory of [release, staging]) fs.mkdirSync(path.join(directory, '_expo'), { recursive: true });
  fs.writeFileSync(path.join(release, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(release, '_expo/entry.js'), 'retired client');
  fs.writeFileSync(path.join(release, '.installed.json'), '{"retired":true}');
  fs.writeFileSync(path.join(upgrade, 'pi-paseo/state.json'), '{"phase":"stopped"}');
  const listing = directory => fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .map(entry => path.join(entry.parentPath, entry.name) + (entry.isFile() ? ':' + sha256(fs.readFileSync(path.join(entry.parentPath, entry.name))) : '')).sort();
  const retiredBefore = listing(retired);
  const env = { ...process.env, HOME: upgrade, PI_AGENT_DATA_DIR: upgrade, PI_CODING_AGENT_DIR: upgrade, PI_PASEO_PLUGIN_ROOT: bundle };
  for (let boot = 0; boot < 2; boot++) {
    const result = spawnSync(process.execPath, ['/usr/local/bin/pi-paseo-seed.mjs'], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, 'moving an official pin requires no package manager or network');
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(upgrade, 'settings.json'))).packages, [bundle]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(upgrade, 'settings.json.pre-image-migration.bak'))).packages, [pin]);
  const receipt = JSON.parse(fs.readFileSync(path.join(upgrade, 'pi-paseo/image-migration.json')));
  assert.equal(receipt.runs.length, 1); assert.equal(receipt.runs[0].changed[0].from, pin);
  assert.deepEqual(listing(retired), retiredBefore, 'the seed leaves an older web client state directory exactly as it found it');
  assert.equal(fs.readFileSync(path.join(upgrade, 'pi-paseo/state.json'), 'utf8'), '{"phase":"stopped"}');
  console.log('[build] official Paseo git pin moved to the image bundle; an older web client directory is left for the plugin to remove');
} finally { fs.rmSync(upgrade, { recursive: true, force: true }); }
