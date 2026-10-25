#!/usr/bin/env node
// Register the image bundle once; credentials and host identity never come from
// the image. Explicit disable/removal and an externally installed package win.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const name = '@woowtech/pi-omnigent-plugin';
const sourceOf = item => typeof item === 'string' ? item : item?.source;
const disabled = item => typeof item === 'object' && Array.isArray(item.extensions) && !item.extensions.length;
const exists = file => fs.existsSync(file);
function read(file, fallback) {
  if (!exists(file)) return fallback;
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('metadata must not be a symlink');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (exists(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('metadata must not be a symlink');
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
export function seed({ agentDir, bundle, seedEnabled = true }) {
  const pkg = read(path.join(bundle, 'package.json'), null);
  if (pkg?.name !== name) throw Error('image bundle missing or invalid');
  const file = path.join(agentDir, 'settings.json');
  const markerFile = path.join(agentDir, 'omnigent-plugin', 'image-seed.json');
  const settings = read(file, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      ('packages' in settings && !Array.isArray(settings.packages))) throw Error('invalid Pi settings');
  const packages = settings.packages || [];
  const entry = packages.find(item => {
    const source = sourceOf(item);
    if (typeof source !== 'string') return false;
    return source === bundle || /(?:^|\/)pi-omnigent-plugin(?:@|$)/.test(source) || source.startsWith(`npm:${name}`);
  });
  const marker = read(markerFile, null);
  if (!seedEnabled) return { active: false, reason: 'image-setup-disabled' };
  if (entry) {
    if (!marker) write(markerFile, { schema: 1, mode: sourceOf(entry) === bundle ? 'managed' : 'external', source: sourceOf(entry) });
    return { active: sourceOf(entry) === bundle && !disabled(entry), reason: disabled(entry) ? 'disabled' : 'existing', source: sourceOf(entry) };
  }
  if (marker) return { active: false, reason: 'user-removed' };
  write(file, { ...settings, packages: [...packages, bundle] });
  write(markerFile, { schema: 1, mode: 'managed', source: bundle, version: pkg.version });
  return { active: true, reason: 'registered', source: bundle };
}

async function main() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DATA_DIR || '/data/pi-agent';
  const bundle = process.env.PI_OMNIGENT_PLUGIN_ROOT || '/opt/woow/pi-omnigent-plugin';
  if (process.argv.includes('--resolve-root')) {
    const web = await import(pathToFileURL(path.join(bundle, 'src/web.mjs')).href);
    const sdk = await web.loadPiSdk();
    const settings = sdk.SettingsManager.create(process.env.HOME, agentDir, { projectTrusted: false });
    const manager = new sdk.DefaultPackageManager({ cwd: process.env.HOME, agentDir, settingsManager: settings });
    const entry = manager.listConfiguredPackages().find(item => {
      try { return item.installedPath && read(path.join(item.installedPath, 'package.json'), null)?.name === name; }
      catch { return false; }
    });
    process.stdout.write(entry?.installedPath || bundle);
    return;
  }
  const result = seed({ agentDir, bundle, seedEnabled: process.env.PI_OMNIGENT_AUTO_SETUP !== 'false' });
  if (process.env.PI_OMNIGENT_SEED_ONLY !== '1' && result.active) {
    const web = await import(pathToFileURL(path.join(bundle, 'src/web.mjs')).href);
    // Complete registration and the visible conversation before the server reads
    // its session index. launch-web starts background preparation after listening.
    await web.ensureOnboarding();
    const host = await web.installHost();
    if (!['installed', 'composable-wrapper'].includes(host.status)) throw Error('web launcher unavailable');
  }
  console.log(`[pi-omnigent] ${result.reason}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    // Never echo settings or error payloads that could contain credentials.
    console.error('[pi-omnigent] setup could not complete; existing settings preserved; inspect the plugin in Pi Web');
    process.exitCode = 1;
  });
}
