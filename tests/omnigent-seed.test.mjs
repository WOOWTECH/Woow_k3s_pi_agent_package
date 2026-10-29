import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../rootfs/usr/local/bin/pi-omnigent-seed.mjs';
function fixture(t, version = '0.3.11') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-image-seed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'pi-omnigent-plugin'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(bundle); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: '@woowtech/pi-omnigent-plugin', version }));
  const settings = path.join(agentDir, 'settings.json');
  return { bundle, agentDir, settings, write: value => fs.writeFileSync(settings, JSON.stringify(value)), read: () => JSON.parse(fs.readFileSync(settings)) };
}
const official = 'git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.21';
const backupOf = f => path.join(f.agentDir, 'settings.json.pre-image-migration.bak');
const receiptOf = f => JSON.parse(fs.readFileSync(path.join(f.agentDir, 'omnigent-plugin/image-migration.json')));
test('fresh volume registers once without credentials or identity', t => {
  const f = fixture(t);
  assert.equal(seed(f).active, true); assert.equal(seed(f).reason, 'existing');
  assert.deepEqual(f.read(), { packages: [f.bundle] });
  assert.equal(fs.statSync(f.settings).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.agentDir, 'auth.json')), false);
  assert.equal(fs.existsSync(backupOf(f)), false, 'nothing to migrate means no backup');
  assert.equal(fs.existsSync(path.join(f.agentDir, 'omnigent-plugin/image-migration.json')), false);
});
test('existing settings, disabled package and external installation survive', t => {
  for (const entry of [{ source: '/opt/old/pi-omnigent-plugin', extensions: [] }, { source: official, extensions: [] },
    'git:github.com/example/pi-omnigent-plugin@v0.3.11', 'git:gitlab.com/WOOWTECH/pi-omnigent-plugin@v0.3.11']) {
    const f = fixture(t, '0.3.29'), original = { model: 'user-choice', packages: ['another-package', entry] };
    f.write(original); assert.equal(seed(f).active, false); assert.deepEqual(f.read(), original);
    assert.equal(fs.existsSync(backupOf(f)), false);
  }
});
test('an official git pin moves to the bundle once, with one backup and a receipt', t => {
  const f = fixture(t, '0.3.29'), original = JSON.stringify({ model: 'user-choice', packages: ['another-package', official] });
  fs.writeFileSync(f.settings, original);
  const first = seed(f);
  assert.equal(first.active, true); assert.equal(first.reason, 'migrated');
  assert.deepEqual(f.read(), { model: 'user-choice', packages: ['another-package', f.bundle] });
  assert.equal(fs.readFileSync(backupOf(f), 'utf8'), original, 'backup keeps the exact original');
  assert.equal(fs.statSync(backupOf(f)).mode & 0o777, 0o600);
  const receipt = receiptOf(f);
  assert.equal(receipt.runs.length, 1);
  assert.deepEqual(receipt.runs[0].changed, [{ file: 'settings.json', from: official, to: f.bundle, basis: 'ref', version: 'v0.3.21' }]);
  assert.deepEqual(receipt.runs[0].backup, { file: 'settings.json.pre-image-migration.bak', created: true });
  assert.equal(receipt.runs[0].version, '0.3.29');
  const marker = JSON.parse(fs.readFileSync(path.join(f.agentDir, 'omnigent-plugin/image-seed.json')));
  assert.equal(marker.mode, 'managed'); assert.equal(marker.source, f.bundle);
  // Repeat boots change nothing and never back up again.
  const settingsBefore = fs.readFileSync(f.settings, 'utf8'), receiptBefore = JSON.stringify(receiptOf(f));
  fs.writeFileSync(backupOf(f), 'sentinel');
  assert.equal(seed(f).reason, 'existing'); assert.equal(seed(f).active, true);
  assert.equal(fs.readFileSync(f.settings, 'utf8'), settingsBefore);
  assert.equal(JSON.stringify(receiptOf(f)), receiptBefore);
  assert.equal(fs.readFileSync(backupOf(f), 'utf8'), 'sentinel');
});
test('an object entry keeps its filters, and the same tag as the bundle also moves', t => {
  const f = fixture(t, '0.3.29');
  f.write({ packages: [{ source: 'git:https://github.com/WOOWTECH/pi-omnigent-plugin.git@v0.3.29', skills: [] }] });
  assert.equal(seed(f).reason, 'migrated');
  assert.deepEqual(f.read(), { packages: [{ source: f.bundle, skills: [] }] });
});
test('a first-boot external marker no longer keeps an official pin', t => {
  const f = fixture(t, '0.3.29'); f.write({ packages: [official] });
  fs.mkdirSync(path.join(f.agentDir, 'omnigent-plugin'));
  fs.writeFileSync(path.join(f.agentDir, 'omnigent-plugin/image-seed.json'), JSON.stringify({ schema: 1, mode: 'external', source: official }));
  assert.equal(seed(f).active, true); assert.deepEqual(f.read(), { packages: [f.bundle] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.agentDir, 'omnigent-plugin/image-seed.json'))).mode, 'managed');
});
test('newer, unverifiable and duplicated official pins stay and are reported once', t => {
  const cases = [
    [['git:github.com/WOOWTECH/pi-omnigent-plugin@v0.4.0'], 'newer-than-image'],
    [['git:github.com/WOOWTECH/pi-omnigent-plugin@main'], 'version-unknown'],
    [['git:github.com/WOOWTECH/pi-omnigent-plugin'], 'version-unknown'],
    [[official, 'git:github.com/example/pi-omnigent-plugin@v0.3.11'], 'multiple-entries'],
  ];
  for (const [packages, reason] of cases) {
    const f = fixture(t, '0.3.29'); f.write({ packages });
    assert.equal(seed(f).active, false); assert.deepEqual(f.read(), { packages });
    assert.equal(fs.existsSync(backupOf(f)), false);
    assert.equal(receiptOf(f).runs[0].skipped[0].reason, reason);
    assert.equal(receiptOf(f).runs[0].changed.length, 0);
    seed(f); assert.equal(receiptOf(f).runs.length, 1, 'an unchanged skip is not recorded twice');
  }
});
test('a branch or commit pin compares the copy Pi already cloned', t => {
  for (const [installed, migrated] of [['0.3.21', true], ['0.3.29', false], ['0.4.0', false]]) {
    const f = fixture(t, '0.3.29'), source = 'git:github.com/WOOWTECH/pi-omnigent-plugin@9315fef8';
    const clone = path.join(f.agentDir, 'git/github.com/WOOWTECH/pi-omnigent-plugin');
    fs.mkdirSync(clone, { recursive: true });
    fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: '@woowtech/pi-omnigent-plugin', version: installed }));
    f.write({ packages: [source] });
    assert.equal(seed(f).active, migrated, installed);
    assert.deepEqual(f.read(), { packages: [migrated ? f.bundle : source] });
    const run = receiptOf(f).runs[0];
    if (migrated) assert.deepEqual(run.changed[0], { file: 'settings.json', from: source, to: f.bundle, basis: 'installed-copy', version: installed });
    else assert.equal(run.skipped[0].reason, installed === '0.3.29' ? 'not-older-than-image' : 'newer-than-image');
  }
});
test('every Pi git form of the official repository moves; look-alikes do not', t => {
  for (const source of ['git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.1', 'git:git@github.com:WOOWTECH/pi-omnigent-plugin.git@v0.3.1',
    'https://github.com/woowtech/pi-omnigent-plugin@v0.3.1', 'ssh://git@github.com/WOOWTECH/pi-omnigent-plugin.git#v0.3.1']) {
    const f = fixture(t, '0.3.29'); f.write({ packages: [source] });
    assert.equal(seed(f).reason, 'migrated', source); assert.deepEqual(f.read(), { packages: [f.bundle] });
  }
  // Without `git:` or a protocol Pi treats the text as a local path.
  for (const source of ['github.com/WOOWTECH/pi-omnigent-plugin@v0.3.1', 'git:github.com/WOOWTECH/pi-omnigent-plugin-fork@v0.3.1']) {
    const f = fixture(t, '0.3.29'); f.write({ packages: [source] }); seed(f);
    assert.equal(f.read().packages[0], source, source); assert.equal(fs.existsSync(backupOf(f)), false);
  }
});
test('credentials in a git URL never reach the receipt', t => {
  const f = fixture(t, '0.3.29'); f.write({ packages: ['git:https://someone:not-a-real-token@github.com/WOOWTECH/pi-omnigent-plugin@v0.3.1'] });
  assert.equal(seed(f).reason, 'migrated');
  const text = fs.readFileSync(path.join(f.agentDir, 'omnigent-plugin/image-migration.json'), 'utf8');
  assert.doesNotMatch(text, /not-a-real-token|someone/); assert.match(text, /\*\*\*@github\.com/);
});
test('an unwritable receipt does not stop the switch or the launcher preparation', t => {
  const f = fixture(t, '0.3.29'); f.write({ packages: [official] });
  const target = path.join(f.agentDir, 'elsewhere.json'); fs.writeFileSync(target, '{}');
  fs.mkdirSync(path.join(f.agentDir, 'omnigent-plugin')); fs.symlinkSync(target, path.join(f.agentDir, 'omnigent-plugin/image-migration.json'));
  const result = seed(f);
  assert.equal(result.active, true); assert.equal(result.reason, 'migrated');
  assert.deepEqual(f.read(), { packages: [f.bundle] }); assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});
test('a project-level choice keeps the global official pin as it is', t => {
  const f = fixture(t, '0.3.29'); f.write({ packages: [official] });
  const dir = path.join(f.agentDir, 'home/.pi'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ packages: [{ source: f.bundle, extensions: [] }] }));
  assert.equal(seed(f).active, false); assert.deepEqual(f.read(), { packages: [official] });
  assert.equal(receiptOf(f).runs[0].skipped[0].reason, 'project-setting');
});
test('operator opt-out leaves an official pin untouched', t => {
  const f = fixture(t, '0.3.29'); f.write({ packages: [official] });
  assert.equal(seed({ ...f, seedEnabled: false }).reason, 'image-setup-disabled');
  assert.deepEqual(f.read(), { packages: [official] }); assert.equal(fs.existsSync(backupOf(f)), false);
});
test('a stale Pi Web copy in host.json is replaced by the image Pi Web; other launchers stay', t => {
  const cases = [['.local/share/pi-omnigent-web/pi-web/bin/pi-web.js', 'volume-ui-copy'], ['.local/share/pi-paseo/pi-web/bin/pi-web.js', 'volume-ui-copy'],
    ['missing/pi-web', 'missing'], ['custom/pi-web', null]];
  for (const [relative, reason] of cases) {
    const f = fixture(t, '0.3.29'), home = path.join(f.agentDir, 'home'), state = path.join(f.agentDir, 'omnigent-plugin');
    const nativeWeb = path.join(f.agentDir, 'native-pi-web'), realWeb = path.join(home, relative);
    fs.writeFileSync(nativeWeb, '#!/bin/sh\n', { mode: 0o755 });
    if (reason !== 'missing') { fs.mkdirSync(path.dirname(realWeb), { recursive: true }); fs.writeFileSync(realWeb, '#!/bin/sh\n', { mode: 0o755 }); }
    fs.mkdirSync(state, { recursive: true });
    const host = { version: 1, realWeb, shim: path.join(home, '.local/bin/pi-web'), mode: 'chained-path-wrapper', backup: path.join(state, 'launchers/pi-web-before-omnigent') };
    fs.writeFileSync(path.join(state, 'host.json'), JSON.stringify(host));
    f.write({ packages: [official] });
    assert.equal(seed({ ...f, home, nativeWeb }).active, true);
    const after = JSON.parse(fs.readFileSync(path.join(state, 'host.json')));
    assert.deepEqual(after, reason ? { ...host, realWeb: nativeWeb } : host, relative);
    const run = receiptOf(f).runs[0];
    if (reason) {
      assert.deepEqual(run.launcher, { file: path.join(state, 'host.json'), field: 'realWeb', from: realWeb, to: nativeWeb, reason });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'host.json.pre-image-migration.bak'))), host);
    } else assert.equal(run.launcher, undefined);
    seed({ ...f, home, nativeWeb }); assert.equal(receiptOf(f).runs.length, 1);
  }
});
test('the launcher record is left alone while the image bundle is not the active plugin', t => {
  const f = fixture(t, '0.3.29'), state = path.join(f.agentDir, 'omnigent-plugin'), nativeWeb = path.join(f.agentDir, 'native-pi-web');
  fs.writeFileSync(nativeWeb, '#!/bin/sh\n', { mode: 0o755 }); fs.mkdirSync(state);
  const host = JSON.stringify({ version: 1, realWeb: path.join(f.agentDir, 'missing/pi-web') });
  fs.writeFileSync(path.join(state, 'host.json'), host);
  f.write({ packages: [{ source: f.bundle, extensions: [] }] });
  assert.equal(seed({ ...f, nativeWeb }).active, false);
  assert.equal(fs.readFileSync(path.join(state, 'host.json'), 'utf8'), host);
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
  fs.mkdirSync(path.join(f.agentDir, 'omnigent-plugin'));
  fs.writeFileSync(path.join(f.agentDir, 'omnigent-plugin/state.json'), '{}');
  assert.equal(seed(f).reason, 'existing-state'); assert.deepEqual(f.read(), { packages: [] });
  assert.equal(seed(f).reason, 'user-removed');
});
test('git suffix and custom local installation do not create duplicate plugins', t => {
  for (const kind of ['git', 'local']) {
    const f = fixture(t);
    const local = path.join(f.agentDir, 'custom-checkout'); fs.mkdirSync(local);
    fs.writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: '@woowtech/pi-omnigent-plugin' }));
    const source = kind === 'git' ? 'git:https://github.com/example/pi-omnigent-plugin.git@v0.3.11' : './custom-checkout';
    f.write({ packages: [source] }); assert.equal(seed(f).active, false); assert.deepEqual(f.read(), { packages: [source] });
  }
});
test('a home project disable choice wins over a new global image default', t => {
  const f = fixture(t); const dir = path.join(f.agentDir, 'home/.pi'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ packages: [{ source: f.bundle, extensions: [] }] }));
  assert.equal(seed(f).active, false); assert.equal(fs.existsSync(f.settings), false);
});
test('the image seed never creates or opens a setup conversation', () => {
  const source = fs.readFileSync(new URL('../rootfs/usr/local/bin/pi-omnigent-seed.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /ensureOnboarding|readOnboarding/);
  const start = fs.readFileSync(new URL('../rootfs/usr/local/bin/pi-web-start.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(start, /ensureOnboarding|onboarding/i);
});
