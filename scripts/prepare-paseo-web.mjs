// Build-only download; runtime seeding never uses a network fetch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { seedWebClient } from '../rootfs/usr/local/bin/pi-paseo-web-seed.mjs';
const bundle = process.env.PI_PASEO_PLUGIN_ROOT || '/opt/woow/pi-paseo-plugin';
const { webClientManifest } = await import(pathToFileURL(path.join(bundle, 'src/web-client.mjs')));

const archive = process.env.PI_PASEO_WEB_ARCHIVE || '/opt/woow/pi-paseo-web/client.tar.gz';
const manifest = webClientManifest();
const url = new URL(manifest.url);
if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/WOOWTECH/paseo/releases/download/') || url.username || url.password || url.search || url.hash) throw Error('Unexpected web archive origin');
fs.mkdirSync(path.dirname(archive), { recursive: true, mode: 0o755 });
const result = spawnSync('curl', ['-fSL', '--retry', '5', '--retry-all-errors', '--max-time', '180', '--max-filesize', String(192 * 1024 * 1024), '-o', archive, url.href], { stdio: 'inherit' });
if (result.status !== 0) throw Error('Web archive download failed');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paseo-web-build-'));
try {
  const ready = await seedWebClient({ bundle, archive, loc: { stateDir } });
  if (!ready.ready) throw Error('Web archive validation failed');
  fs.chmodSync(archive, 0o644);
  console.log(`[build] verified Paseo Web ${ready.version}; compressed archive bundled for offline startup`);
} finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
