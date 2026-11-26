import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { seed } from '../rootfs/usr/local/bin/pi-paseo-seed.mjs';
function fixture(t, version = '0.1.7') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-image-seed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'pi-paseo-plugin'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(bundle); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: '@woowtech/pi-paseo', version }));
  const settings = path.join(agentDir, 'settings.json');
  return { root, bundle, agentDir, settings, write: value => fs.writeFileSync(settings, JSON.stringify(value)), read: () => JSON.parse(fs.readFileSync(settings)) };
}
test('fresh volume registers once without credentials or identity', t => {
  const f = fixture(t);
  assert.equal(seed(f).active, true); assert.equal(seed(f).reason, 'existing');
  assert.deepEqual(f.read(), { packages: [f.bundle] });
  assert.equal(fs.statSync(f.settings).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.agentDir, 'auth.json')), false);
});
const official = 'git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.9';
const backupOf = f => path.join(f.agentDir, 'settings.json.pre-image-migration.bak');
const receiptOf = f => JSON.parse(fs.readFileSync(path.join(f.agentDir, 'pi-paseo/image-migration.json')));
test('existing settings, disabled package and external installation survive', t => {
  for (const entry of [{ source: '/opt/old/pi-paseo-plugin', extensions: [] }, { source: official, extensions: [] },
    'git:github.com/example/pi-paseo-plugin@v0.1.7']) {
    const f = fixture(t, '0.1.14'), original = { model: 'user-choice', packages: ['another-package', entry] };
    f.write(original); assert.equal(seed(f).active, false); assert.deepEqual(f.read(), original);
    assert.equal(fs.existsSync(backupOf(f)), false);
  }
});
test('an official git pin moves to the bundle once, with one backup and a receipt', t => {
  const f = fixture(t, '0.1.14'), original = JSON.stringify({ model: 'user-choice', packages: [official, 'another-package'] });
  fs.writeFileSync(f.settings, original);
  const first = seed(f);
  assert.equal(first.active, true); assert.equal(first.reason, 'migrated');
  assert.deepEqual(f.read(), { model: 'user-choice', packages: [f.bundle, 'another-package'] });
  assert.equal(fs.readFileSync(backupOf(f), 'utf8'), original);
  assert.deepEqual(receiptOf(f).runs[0].changed, [{ file: 'settings.json', from: official, to: f.bundle, basis: 'ref', version: 'v0.1.9' }]);
  const before = fs.readFileSync(path.join(f.agentDir, 'pi-paseo/image-migration.json'), 'utf8');
  assert.equal(seed(f).reason, 'existing'); assert.equal(seed(f).active, true);
  assert.equal(fs.readFileSync(path.join(f.agentDir, 'pi-paseo/image-migration.json'), 'utf8'), before);
});
test('newer and commit pins stay unless the cloned copy is older', t => {
  for (const [source, installed, migrated, reason] of [
    ['git:github.com/WOOWTECH/pi-paseo-plugin@v0.2.0', null, false, 'newer-than-image'],
    ['git:github.com/WOOWTECH/pi-paseo-plugin@9315fef8', null, false, 'version-unknown'],
    ['git:github.com/WOOWTECH/pi-paseo-plugin@9315fef8', '0.1.11', true, null]]) {
    const f = fixture(t, '0.1.14');
    if (installed) {
      const clone = path.join(f.agentDir, 'git/github.com/WOOWTECH/pi-paseo-plugin'); fs.mkdirSync(clone, { recursive: true });
      fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: '@woowtech/pi-paseo', version: installed }));
    }
    f.write({ packages: [source] });
    assert.equal(seed(f).active, migrated); assert.deepEqual(f.read(), { packages: [migrated ? f.bundle : source] });
    if (reason) assert.equal(receiptOf(f).runs[0].skipped[0].reason, reason);
  }
});
test('Paseo and Omnigent migrations on one boot share a single backup of the original', async t => {
  const { seed: omnigent } = await import('../rootfs/usr/local/bin/pi-omnigent-seed.mjs');
  const f = fixture(t, '0.1.14'), omni = path.join(path.dirname(f.bundle), 'pi-omnigent-plugin');
  fs.mkdirSync(omni); fs.writeFileSync(path.join(omni, 'package.json'), JSON.stringify({ name: '@woowtech/pi-omnigent-plugin', version: '0.3.29' }));
  const original = JSON.stringify({ packages: [official, 'git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.21'] });
  fs.writeFileSync(f.settings, original);
  assert.equal(seed(f).reason, 'migrated');
  assert.equal(omnigent({ agentDir: f.agentDir, bundle: omni, nativeWeb: path.join(f.agentDir, 'absent') }).reason, 'migrated');
  assert.deepEqual(f.read(), { packages: [f.bundle, omni] });
  assert.equal(fs.readFileSync(backupOf(f), 'utf8'), original);
  assert.equal(receiptOf(f).runs[0].backup.created, true);
  const omniReceipt = JSON.parse(fs.readFileSync(path.join(f.agentDir, 'omnigent-plugin/image-migration.json')));
  assert.equal(omniReceipt.runs[0].backup.created, false);
});
test('an unwritable marker does not stop the switch', t => {
  const f = fixture(t, '0.1.14'); f.write({ packages: [official] });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (String(to).endsWith('image-seed.json')) throw Error('EIO'); return rename(from, to); });
  const errors = t.mock.method(console, 'error', () => {});
  const result = seed(f);
  assert.equal(result.reason, 'migrated'); assert.equal(result.active, true, 'the migrated plugin is the active one');
  assert.deepEqual(f.read(), { packages: [f.bundle] }); assert.equal(receiptOf(f).runs.length, 1);
  assert.deepEqual(errors.mock.calls.map(call => call.arguments[0]), ['[pi-paseo] image seed marker could not be written']);
});
test('a seed that fails after the switch puts the old bytes back', t => {
  const f = fixture(t, '0.1.14'), original = JSON.stringify({ packages: [official] }); fs.writeFileSync(f.settings, original);
  // An unexpected failure after settings.json was written: the marker fails and so does the log line about it.
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (String(to).endsWith('image-seed.json')) throw Error('EIO'); return rename(from, to); });
  t.mock.method(console, 'error', () => { throw Error('log sink closed'); });
  assert.throws(() => seed(f), { message: 'setup could not complete (seed-error); settings.json put back to the official git pin (see pi-paseo/image-migration.json)' });
  assert.equal(fs.readFileSync(f.settings, 'utf8'), original);
  const runs = receiptOf(f).runs;
  assert.deepEqual(runs.map(run => run.status), [undefined, 'rolled-back']); assert.deepEqual(runs[1].changes, runs[0].changed);
});
test('credentials in a git URL never reach the receipt or the marker', t => {
  for (const source of ['  https://someone:not-a-real-token@github.com/WOOWTECH/pi-paseo-plugin@v0.1.9', ' git:https://someone:not-a-real-token@github.com/WOOWTECH/pi-paseo-plugin@v9.0.0']) {
    const f = fixture(t, '0.1.14'); f.write({ packages: [source] }); seed(f);
    for (const file of ['pi-paseo/image-migration.json', 'pi-paseo/image-seed.json']) {
      assert.doesNotMatch(fs.readFileSync(path.join(f.agentDir, file), 'utf8'), /not-a-real-token|someone/, `${file}: ${source}`);
    }
  }
});
test('operator opt-out leaves an official pin untouched', t => {
  const f = fixture(t, '0.1.14'); f.write({ packages: [official] });
  assert.equal(seed({ ...f, seedEnabled: false }).reason, 'image-setup-disabled');
  assert.deepEqual(f.read(), { packages: [official] });
});
test('removal is durable across image restarts', t => {
  const f = fixture(t); seed(f); f.write({ packages: [] });
  assert.equal(seed(f).reason, 'user-removed'); assert.deepEqual(f.read(), { packages: [] });
});
test('managed package can be disabled and reenabled through native settings', t => {
  const f = fixture(t); seed(f); f.write({ packages: [{ source: f.bundle, extensions: [] }] });
  assert.equal(seed(f).active, false); f.write({ packages: [f.bundle] }); assert.equal(seed(f).active, true);
});
test('malformed and symlink settings fail without rewriting user data', t => {
  const f = fixture(t); fs.writeFileSync(f.settings, '{bad'); assert.throws(() => seed(f));
  assert.equal(fs.readFileSync(f.settings, 'utf8'), '{bad'); f.write({ packages: 'bad' }); assert.throws(() => seed(f));
  fs.unlinkSync(f.settings); fs.symlinkSync(path.join(f.bundle, 'package.json'), f.settings); assert.throws(() => seed(f));
});
test('operator can opt out before first registration', t => {
  const f = fixture(t); assert.equal(seed({ ...f, seedEnabled: false }).active, false);
  assert.equal(fs.existsSync(f.settings), false); assert.equal(seed(f).active, true);
});

test('legacy removal before image migration remains removed', t => {
  const f = fixture(t); f.write({ packages: [] });
  fs.mkdirSync(path.join(f.agentDir, 'pi-paseo'));
  fs.writeFileSync(path.join(f.agentDir, 'pi-paseo/state.json'), '{}');
  assert.equal(seed(f).reason, 'existing-state'); assert.deepEqual(f.read(), { packages: [] });
  assert.equal(seed(f).reason, 'user-removed');
});
test('git suffix and custom local installation do not create duplicate plugins', t => {
  for (const kind of ['git', 'local']) {
    const f = fixture(t);
    const local = path.join(f.agentDir, 'custom-checkout'); fs.mkdirSync(local);
    fs.writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: '@woowtech/pi-paseo' }));
    const source = kind === 'git' ? 'git:https://github.com/example/pi-paseo-plugin.git@v0.1.7' : './custom-checkout';
    f.write({ packages: [source] }); assert.equal(seed(f).active, false); assert.deepEqual(f.read(), { packages: [source] });
  }
});
test('a home project disable choice wins over a new global image default', t => {
  const f = fixture(t); const dir = path.join(f.agentDir, 'home/.pi'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ packages: [{ source: f.bundle, extensions: [] }] }));
  assert.equal(seed(f).active, false); assert.equal(fs.existsSync(f.settings), false);
});

// The Paseo target opens the official app, so the image prepares no web client. Agent Connect 0.1.9-0.1.22 left
// <stateDir>/web-client/<sha256> (and .stage-<uuid>) behind; the plugin removes those itself when it activates.
// The next two guard helper behavior. Only the startup-script test below detects
// the retired client preparation step, which used to run outside seed().
const retiredClient = f => path.join(f.agentDir, 'pi-paseo/web-client');
// Dirent.parentPath needs Node 20.12; the older name `path` covers the runners that have not got it.
const tree = directory => fs.readdirSync(directory, { recursive: true, withFileTypes: true })
  .map(entry => { const file = path.join(entry.parentPath ?? entry.path, entry.name); return file + (entry.isFile() ? ':' + fs.readFileSync(file, 'utf8') : ''); }).sort();
test('a fresh volume gets no web client directory', t => {
  const f = fixture(t, '0.1.23');
  assert.equal(seed(f).reason, 'registered'); assert.equal(seed(f).reason, 'existing');
  assert.equal(fs.existsSync(retiredClient(f)), false);
});
test('an old plugin pin migrates and its web client state is neither required, recreated nor removed', t => {
  const f = fixture(t, '0.1.23');
  const release = path.join(retiredClient(f), 'a'.repeat(64)), staging = path.join(retiredClient(f), '.stage-00000000-0000-4000-8000-000000000000');
  for (const directory of [release, staging]) fs.mkdirSync(path.join(directory, '_expo'), { recursive: true });
  fs.writeFileSync(path.join(release, 'index.html'), '<!doctype html>'); fs.writeFileSync(path.join(release, '_expo/entry.js'), 'retired client');
  fs.writeFileSync(path.join(f.agentDir, 'pi-paseo/state.json'), '{"phase":"stopped"}');
  f.write({ model: 'user-choice', packages: ['git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.22'] });
  const before = tree(retiredClient(f));
  assert.equal(seed(f).reason, 'migrated'); assert.equal(seed(f).reason, 'existing');
  assert.deepEqual(f.read(), { model: 'user-choice', packages: [f.bundle] });
  assert.deepEqual(tree(retiredClient(f)), before);
  assert.equal(fs.readFileSync(path.join(f.agentDir, 'pi-paseo/state.json'), 'utf8'), '{"phase":"stopped"}');
  // The same volume with its client directory deleted (the plugin already cleaned up) boots identically.
  fs.rmSync(retiredClient(f), { recursive: true }); assert.equal(seed(f).reason, 'existing');
  assert.equal(fs.existsSync(retiredClient(f)), false);
});
// What an upgraded tenant's volume really holds, at the paths the seed and the plugin use: PI_CODING_AGENT_DIR for Pi's
// logins and the plugin's own state (preferences, pairing, daemon identity, Paseo's home), HOME for the provider CLIs'
// logins, and the retired client. The startup script must leave every one of them byte for byte as it was.
const AGENT_FILES = ['auth.json', 'pi-paseo/state.json', 'pi-paseo/preferences.json', 'pi-paseo/pairing.private.json', 'pi-paseo/daemon-instance.private.json',
  'pi-paseo/daemon/daemon.json', 'pi-paseo/daemon/config.json', 'pi-paseo/daemon/daemon-keypair.json', 'pi-paseo/daemon/server-id',
  'pi-paseo/daemon/agents/retained-agent.json', 'pi-paseo/web-client/' + 'b'.repeat(64) + '/index.html'];
const HOME_FILES = ['.claude/.credentials.json', '.codex/auth.json',
  '.local/share/pi-paseo/runtime/releases/0.11.2-r4-4cf9d40940bf/.pi-paseo-runtime.json'];
const volumeFiles = (f, home) => [...AGENT_FILES.map(name => path.join(f.agentDir, name)), ...HOME_FILES.map(name => path.join(home, name))];
const NO_NETWORK = 'globalThis.fetch = () => { throw Error("unexpected runtime network"); };';
function startup(f, home, mode) {
  const trap = path.join(f.root, 'no-network.mjs'); fs.writeFileSync(trap, NO_NETWORK);
  return spawnSync(process.execPath, ['--import', trap, new URL('../rootfs/usr/local/bin/pi-paseo-seed.mjs', import.meta.url).pathname], {
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: f.agentDir, PI_PASEO_PLUGIN_ROOT: f.bundle,
      PI_PASEO_WEB_ARCHIVE: path.join(f.root, 'no-such-archive.tar.gz'), PI_PASEO_AUTO_SETUP: mode === 'opt-out' ? 'false' : 'true' },
    encoding: 'utf8', timeout: 60000,
  });
}
test('the startup script leaves an upgraded volume untouched and creates no identity, login or client on a fresh one', t => {
  const entries = { external: 'git:github.com/example/pi-paseo-plugin@v0.1.8', 'official-pin': 'git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.8',
    'newer-pin': 'git:github.com/WOOWTECH/pi-paseo-plugin@v99.0.0' };
  for (const mode of ['fresh', 'managed-upgrade', 'disabled', 'removed', 'external', 'official-pin', 'newer-pin', 'opt-out']) {
    // An upgraded volume always has a settings.json that lists the plugin; one with plugin state but no settings is a legacy removal (tested above).
    for (const upgraded of mode === 'fresh' ? [false] : [true, false]) {
      const label = `${mode}/${upgraded ? 'upgraded' : 'new'} volume`;
      const f = fixture(t, '0.1.24'), home = path.join(f.root, 'home');
      const entry = mode === 'disabled' ? { source: f.bundle, extensions: [] } : entries[mode] || f.bundle;
      if (mode !== 'fresh' && mode !== 'opt-out') f.write({ model: 'operator-choice', packages: mode === 'removed' ? [] : [entry] });
      if (mode === 'removed') { fs.mkdirSync(path.join(f.agentDir, 'pi-paseo'), { recursive: true }); fs.writeFileSync(path.join(f.agentDir, 'pi-paseo/image-seed.json'), '{}'); }
      const files = volumeFiles(f, home);
      if (upgraded) for (const file of files) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ retained: path.basename(file) })); }
      const before = files.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
      const result = startup(f, home, mode);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.match(result.stdout, /^\[pi-paseo\] \S+\n$/, label); assert.equal(result.stderr, '', label);
      // Upgraded: all of it unchanged. New: none of it appears (no identity, pairing, login or web client is distributed).
      assert.deepEqual(files.map(file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null), before, `${label}: the volume's own files are untouched`);
      if (!upgraded) for (const name of ['pi-paseo/daemon', 'pi-paseo/web-client', 'pi-paseo/preferences.json', 'pi-paseo/pairing.private.json', 'pi-paseo/daemon-instance.private.json', 'auth.json']) {
        assert.equal(fs.existsSync(path.join(f.agentDir, name)), false, `${label}: ${name} must not appear`);
      }
      if (!upgraded) for (const name of ['.claude', '.codex']) assert.equal(fs.existsSync(path.join(home, name)), false, `${label}: ${name} must not appear`);
      if (['managed-upgrade', 'official-pin'].includes(mode)) assert.equal(f.read().model, 'operator-choice');
      if (mode === 'official-pin') assert.deepEqual(f.read().packages, [f.bundle], 'an older official pin moves to the bundle');
      if (['external', 'newer-pin', 'disabled'].includes(mode)) assert.deepEqual(f.read().packages, [entry], label);
      if (mode === 'fresh') assert.deepEqual(f.read(), { packages: [f.bundle] });
      if (mode === 'opt-out') assert.equal(fs.existsSync(f.settings), false);
    }
  }
});
