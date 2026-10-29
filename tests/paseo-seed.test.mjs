import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../rootfs/usr/local/bin/pi-paseo-seed.mjs';
function fixture(t, version = '0.1.7') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-image-seed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'pi-paseo-plugin'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(bundle); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: '@woowtech/pi-paseo', version }));
  const settings = path.join(agentDir, 'settings.json');
  return { bundle, agentDir, settings, write: value => fs.writeFileSync(settings, JSON.stringify(value)), read: () => JSON.parse(fs.readFileSync(settings)) };
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
