// Run against the exact release package/archive, or inside the finished image.
// No provider calls, daemon startup, login, pairing or network downloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { seedWebClient } from '../rootfs/usr/local/bin/pi-paseo-web-seed.mjs';
const bundle = process.env.PI_PASEO_TEST_BUNDLE || '/opt/woow/pi-paseo-plugin';
const archive = process.env.PI_PASEO_WEB_ARCHIVE || '/opt/woow/pi-paseo-web/client.tar.gz';
const { webClientManifest, webClientStatus, serveWebClient, ensureWebClient } = await import(pathToFileURL(path.join(bundle, 'src/web-client.mjs')));
const manifest = webClientManifest();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-offline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agentDir = path.join(root, 'agent'), stateDir = path.join(root, 'custom-state');
  fs.mkdirSync(agentDir); fs.mkdirSync(stateDir, { mode: 0o700 });
  return { root, agentDir, stateDir };
}
const noDownload = () => { throw Error('runtime network download forbidden'); };
test('fresh offline client serves root, deep links and compressed assets; warm activation is offline', async t => {
  const f = fixture(t);
  assert.equal((await seedWebClient({ bundle, archive, loc: f })).ready, true);
  assert.equal((await ensureWebClient(f, { fetchImpl: noDownload })).ready, true);
  const html = serveWebClient(new Request('http://test/paseo-web/'), f);
  assert.equal(html.status, 200); assert.equal(html.headers.get('cache-control'), 'private, no-store');
  const body = await html.text(); const asset = body.match(/src="([^"]+\.js)"/)[1];
  assert.ok(asset.startsWith('/paseo-web/_expo/'));
  const compressed = serveWebClient(new Request('http://test' + asset, { headers: { 'accept-encoding': 'gzip' } }), f);
  assert.equal(compressed.status, 200); assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  await compressed.arrayBuffer();
  const deep = serveWebClient(new Request('http://test/paseo-web/sessions/example'), f);
  assert.equal(deep.status, 200); assert.equal(await deep.text(), body);
  assert.equal(serveWebClient(new Request('http://test/paseo-web/.installed.json'), f).status, 400);
  assert.equal(fs.statSync(path.join(f.stateDir, 'web-client')).mode & 0o777, 0o700);
  // A healthy cache works even if an operator removes the compressed image asset.
  assert.equal((await seedWebClient({ bundle, archive: path.join(f.root, 'missing'), loc: f })).ready, true);
});
test('upgrade preserves authentication, identity, config and older cache while adding the pinned client', async t => {
  const f = fixture(t);
  const retained = ['auth.json', '.claude/.credentials.json', '.codex/auth.json', 'custom-state/daemon/daemon.json', 'custom-state/state.json', 'custom-state/web-client/old-release/index.html'];
  for (const relative of retained) {
    const file = path.join(f.root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ retained: relative }));
  }
  const before = retained.map(relative => fs.readFileSync(path.join(f.root, relative), 'utf8'));
  assert.equal((await seedWebClient({ bundle, archive, loc: f })).ready, true);
  assert.deepEqual(retained.map(relative => fs.readFileSync(path.join(f.root, relative), 'utf8')), before);
});
test('corrupt archive fails closed without publishing a ready client or changing prior state', async t => {
  const f = fixture(t), bad = path.join(f.root, 'corrupt.tar.gz'); fs.writeFileSync(bad, 'bad archive');
  const retained = path.join(f.stateDir, 'state.json'); fs.writeFileSync(retained, '{"phase":"stopped"}');
  await assert.rejects(seedWebClient({ bundle, archive: bad, loc: f }), { code: 'WEB_CLIENT_CHECKSUM_FAILED' });
  assert.equal(webClientStatus(f).ready, false); assert.equal(fs.readFileSync(retained, 'utf8'), '{"phase":"stopped"}');
  assert.deepEqual(fs.readdirSync(path.join(f.stateDir, 'web-client')), []);
});
test('real startup seeds custom locations offline, keeps disabled/removed/external choices untouched', t => {
  for (const mode of ['fresh', 'managed-upgrade', 'disabled', 'removed', 'external', 'opt-out']) {
    const f = fixture(t), settings = path.join(f.agentDir, 'settings.json');
    const entry = mode === 'external' ? 'git:github.com/WOOWTECH/pi-paseo-plugin@v0.1.8' : mode === 'disabled' ? { source: bundle, extensions: [] } : bundle;
    if (mode !== 'fresh' && mode !== 'opt-out') fs.writeFileSync(settings, JSON.stringify({ model: 'operator-choice', packages: mode === 'removed' ? [] : [entry] }));
    if (mode === 'removed') { fs.mkdirSync(path.join(f.agentDir, 'pi-paseo')); fs.writeFileSync(path.join(f.agentDir, 'pi-paseo/image-seed.json'), '{}'); }
    const trap = path.join(f.root, 'no-network.mjs'); fs.writeFileSync(trap, 'globalThis.fetch = () => {throw Error("unexpected runtime network");};');
    const identity = process.getuid?.() === 0 ? { uid: 1000, gid: 1000 } : {};
    if (identity.uid) for (const dir of [f.root, f.agentDir, f.stateDir]) fs.chownSync(dir, identity.uid, identity.gid);
    const result = spawnSync(process.execPath, ['--import', trap, new URL('../rootfs/usr/local/bin/pi-paseo-seed.mjs', import.meta.url).pathname], {
      env: { ...process.env, HOME: path.join(f.root, 'home'), PI_CODING_AGENT_DIR: f.agentDir, PI_PASEO_STATE_DIR: f.stateDir, PI_PASEO_PLUGIN_ROOT: bundle, PI_PASEO_WEB_ARCHIVE: archive, PI_PASEO_AUTO_SETUP: mode === 'opt-out' ? 'false' : 'true' },
      ...identity, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    assert.equal(webClientStatus(f).ready, ['fresh', 'managed-upgrade'].includes(mode), mode);
    assert.equal(fs.existsSync(path.join(f.stateDir, 'daemon')), false, 'seeding must not create an identity');
    if (mode === 'managed-upgrade') assert.equal(JSON.parse(fs.readFileSync(settings)).model, 'operator-choice');
  }
});
test('archive symlinks and redirected destination directories are rejected', async t => {
  const f = fixture(t), link = path.join(f.root, 'archive-link'); fs.symlinkSync(archive, link);
  await assert.rejects(seedWebClient({ bundle, archive: link, loc: f }), { code: 'UNSAFE_SYMLINK' });
  const target = path.join(f.root, 'other'); fs.mkdirSync(target); fs.symlinkSync(target, path.join(f.stateDir, 'web-client'));
  await assert.rejects(seedWebClient({ bundle, archive, loc: f }), { code: 'UNSAFE_SYMLINK' });
  assert.deepEqual(fs.readdirSync(target), []);
});
