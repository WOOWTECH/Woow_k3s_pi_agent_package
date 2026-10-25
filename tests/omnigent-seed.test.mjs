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
