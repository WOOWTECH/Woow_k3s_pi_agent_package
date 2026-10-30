import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { officialGitPin, compareVersions, planPinMigration, backupOnce, undoPinMigration, redactSource }
  from '../rootfs/usr/local/bin/pi-plugin-pin-migration.mjs';
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pin-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const json = {
  read: (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback,
  write: (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); },
};
const plugin = { repository: 'pi-omnigent-plugin', name: '@woowtech/pi-omnigent-plugin', bundle: '/opt/woow/pi-omnigent-plugin', version: '0.3.29' };

test('official pins are recognised in the documented git forms', () => {
  const forms = {
    'git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.21': 'v0.3.21',
    'git: github.com/WOOWTECH/pi-omnigent-plugin@v0.3.21': 'v0.3.21',
    'git:https://github.com/WOOWTECH/pi-omnigent-plugin.git@v0.3.11': 'v0.3.11',
    'git:git@github.com:WOOWTECH/pi-omnigent-plugin.git@9315fef8': '9315fef8',
    'https://github.com/woowtech/PI-OMNIGENT-PLUGIN': null,
    'https://token@github.com/WOOWTECH/pi-omnigent-plugin/@main': 'main',
    'ssh://git@github.com/WOOWTECH/pi-omnigent-plugin.git#v0.3.1': 'v0.3.1',
    'git://github.com/WOOWTECH/pi-omnigent-plugin@v0.3.21': 'v0.3.21',
  };
  for (const [source, ref] of Object.entries(forms)) assert.equal(officialGitPin(source, 'pi-omnigent-plugin')?.ref, ref, source);
  for (const source of ['github.com/WOOWTECH/pi-omnigent-plugin@v0.3.21', 'git:github.com/example/pi-omnigent-plugin@v0.3.21',
    'git:gitlab.com/WOOWTECH/pi-omnigent-plugin', 'git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.9', 'npm:@woowtech/pi-omnigent-plugin',
    '/opt/woow/pi-omnigent-plugin', 'git:github.com/WOOWTECH/pi-omnigent-plugin/extra@v1.0.0', 'https://github.com:443/WOOWTECH/pi-omnigent-plugin', undefined,
    // Other spellings are left alone (no switch); the README lists the recognised forms.
    'git:WOOWTECH/pi-omnigent-plugin@v0.3.1', 'git:www.github.com/WOOWTECH/pi-omnigent-plugin@v0.3.1', 'https://www.github.com/WOOWTECH/pi-omnigent-plugin@v0.3.1',
    'https://github.com/WOOWTECH/pi-omnigent-plugin/tree/v0.3.1', 'ssh://git@github.com:22/WOOWTECH/pi-omnigent-plugin.git', 'git@github.com:WOOWTECH/pi-omnigent-plugin.git']) {
    assert.equal(officialGitPin(source, 'pi-omnigent-plugin'), null, String(source));
  }
});
test('credentials never reach the plan, whatever whitespace surrounds the source', () => {
  for (const [source, from] of [
    ['  https://user:TOKEN@github.com/WOOWTECH/pi-omnigent-plugin@v0.3.1', 'https://***@github.com/WOOWTECH/pi-omnigent-plugin@v0.3.1'],
    ['\tgit: https://user:TOKEN@github.com/WOOWTECH/pi-omnigent-plugin@v0.3.1\n', 'git: https://***@github.com/WOOWTECH/pi-omnigent-plugin@v0.3.1'],
    [' git:ssh://user:TOKEN@github.com/WOOWTECH/pi-omnigent-plugin.git#v0.3.1', 'git:ssh://***@github.com/WOOWTECH/pi-omnigent-plugin.git#v0.3.1'],
  ]) {
    const plan = planPinMigration({ ...plugin, packages: [source], agentDir: '/nonexistent', isPlugin: () => false });
    assert.equal(plan.changed[0].from, from, source);
    const newer = planPinMigration({ ...plugin, packages: [source.replace('v0.3.1', 'v9.0.0')], agentDir: '/nonexistent', isPlugin: () => false });
    assert.equal(newer.skipped[0].reason, 'newer-than-image');
    assert.doesNotMatch(JSON.stringify([plan.changed, newer.skipped]), /TOKEN|user:/, source);
  }
  // The whole user information goes, up to the last @ before the path; other sources keep their text.
  assert.equal(redactSource('https://user:p@ss@github.com/x@v1'), 'https://***@github.com/x@v1');
  assert.equal(redactSource('git+https://user:TOKEN@example.com/x'), 'git+https://***@example.com/x');
  for (const source of ['git:git@github.com:WOOWTECH/x.git@v1', 'npm:@woowtech/pi-omnigent-plugin@0.3.29', 'https://github.com/WOOWTECH/x@v1', './checkout@v1']) {
    assert.equal(redactSource(source), source);
  }
});
test('release versions follow semantic-version order', () => {
  const ordered = ['0.1.9', 'v0.1.10', '0.3.29-alpha', '0.3.29-alpha.1', '0.3.29-alpha.beta', '0.3.29-beta.2', '0.3.29-beta.11', '0.3.29-rc.1', '0.3.29', '0.3.30-rc.1', '1.0.0'];
  for (let i = 0; i < ordered.length; i++) for (let j = 0; j < ordered.length; j++) {
    assert.equal(compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
  }
  assert.equal(compareVersions('v0.3.29', '0.3.29+build.7'), 0);
  for (const value of ['main', '9315fef8', '0.3', '', undefined]) assert.equal(compareVersions(value, '0.3.29'), null, String(value));
});
test('the plan never edits the caller array and only touches official pins', () => {
  const packages = Object.freeze(['npm:other', 'git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.5', Object.freeze({ source: 'git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.5' })]);
  const plan = planPinMigration({ packages, repository: 'pi-paseo-plugin', name: '@woowtech/pi-paseo', bundle: '/opt/woow/pi-paseo-plugin',
    version: '0.1.14', agentDir: '/nonexistent', isPlugin: () => { throw Error('unreadable'); } });
  assert.deepEqual(plan.skipped.map(item => item.reason), ['multiple-entries', 'multiple-entries'], 'two official entries are ambiguous');
  const single = planPinMigration({ packages: packages.slice(0, 2), repository: 'pi-paseo-plugin', name: '@woowtech/pi-paseo',
    bundle: '/opt/woow/pi-paseo-plugin', version: '0.1.14', agentDir: '/nonexistent', isPlugin: () => false });
  assert.deepEqual(single.packages, ['npm:other', '/opt/woow/pi-paseo-plugin']);
  assert.deepEqual(packages[1], 'git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.5');
});
test('the backup is written whole, once, and never replaced', t => {
  const root = directory(t), file = path.join(root, 'settings.json'), backup = path.join(root, 'settings.json.pre-image-migration.bak');
  fs.writeFileSync(file, '{"packages":["first"]}');
  assert.equal(backupOnce(file, backup), true);
  assert.equal(fs.readFileSync(backup, 'utf8'), '{"packages":["first"]}');
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(backupOnce(file, backup, Buffer.from('{"packages":["later"]}')), false, 'a later migration keeps the first copy');
  assert.equal(fs.readFileSync(backup, 'utf8'), '{"packages":["first"]}');
  const dangling = path.join(root, 'dangling.bak'); fs.symlinkSync(path.join(root, 'nowhere'), dangling);
  assert.equal(backupOnce(file, dangling), false, 'an existing link is never written through');
  assert.equal(fs.existsSync(path.join(root, 'nowhere')), false);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left');
  // A volume without hard links still gets one whole copy, and still only once.
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(Error('EPERM: operation not permitted, link'), { code: 'EPERM' }); });
  const other = path.join(root, 'other.bak');
  assert.equal(backupOnce(file, other), true); assert.equal(fs.readFileSync(other, 'utf8'), '{"packages":["first"]}');
  assert.equal(backupOnce(file, other, Buffer.from('later')), false); assert.equal(fs.readFileSync(other, 'utf8'), '{"packages":["first"]}');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), []);
});
test('undo puts the exact bytes back and records the reason code', t => {
  const root = directory(t), file = path.join(root, 'settings.json'), receipt = path.join(root, 'omnigent-plugin/image-migration.json');
  const original = Buffer.from('{\n    "packages": ["git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.21"]\n}');
  fs.writeFileSync(file, '{"packages":["/opt/woow/pi-omnigent-plugin"]}');
  const changes = [{ file: 'settings.json', from: 'git:github.com/WOOWTECH/pi-omnigent-plugin@v0.3.21', to: plugin.bundle, basis: 'ref', version: 'v0.3.21' }];
  assert.equal(undoPinMigration({ ...json, file, original, reason: 'launcher-conflict', changes, receipt, plugin: plugin.name, bundle: plugin.bundle, version: plugin.version }), true);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.endsWith('.tmp')), []);
  const run = json.read(receipt).runs[0];
  assert.deepEqual([run.status, run.reason, run.changes, run.bundle, run.version], ['rolled-back', 'launcher-conflict', changes, plugin.bundle, plugin.version]);
  // A settings path that cannot be replaced is reported, not thrown.
  const blocked = path.join(root, 'blocked'); fs.mkdirSync(path.join(blocked, 'settings.json'), { recursive: true });
  fs.writeFileSync(path.join(blocked, 'settings.json', 'keep'), '');
  assert.equal(undoPinMigration({ ...json, file: path.join(blocked, 'settings.json'), original, reason: 'seed-error', changes, receipt,
    plugin: plugin.name, bundle: plugin.bundle, version: plugin.version }), false);
  assert.deepEqual(json.read(receipt).runs.map(item => item.status), ['rolled-back', 'rollback-failed']);
});
