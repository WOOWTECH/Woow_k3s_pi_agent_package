import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../rootfs/usr/local/bin/pi-omnigent-seed.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-image-seed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'pi-omnigent-plugin'), agentDir = path.join(root, 'agent');
  fs.mkdirSync(bundle); fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: '@woowtech/pi-omnigent-plugin', version: '0.3.11' }));
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
test('existing settings, disabled package and external installation survive', t => {
  for (const entry of [{ source: '/opt/old/pi-omnigent-plugin', extensions: [] }, 'git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.11']) {
    const f = fixture(t), original = { model: 'user-choice', packages: ['another-package', entry] };
    f.write(original); assert.equal(seed(f).active, false); assert.deepEqual(f.read(), original);
  }
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
    const source = kind === 'git' ? 'git:https://github.com/WOOWTECH/pi-omnigent-plugin.git@v0.3.11' : './custom-checkout';
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
