import { test } from 'node:test';
import assert from 'node:assert/strict';
import { officialGitPin, compareVersions, planPinMigration } from '../rootfs/usr/local/bin/pi-plugin-pin-migration.mjs';

test('official pins are recognised in every git form Pi accepts', () => {
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
    '/opt/woow/pi-omnigent-plugin', 'git:github.com/WOOWTECH/pi-omnigent-plugin/extra@v1.0.0', 'https://github.com:443/WOOWTECH/pi-omnigent-plugin', undefined]) {
    assert.equal(officialGitPin(source, 'pi-omnigent-plugin'), null, String(source));
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
