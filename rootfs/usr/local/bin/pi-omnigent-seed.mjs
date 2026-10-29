#!/usr/bin/env node
// Register the image bundle once; credentials and host identity never come from
// the image. Explicit disable/removal and an externally installed package win.
// An official GitHub git pin is moved to the bundle before Pi Web starts (see
// pi-plugin-pin-migration.mjs), so an image upgrade keeps the existing login.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { officialGitPin, planPinMigration, applyPinMigration, recordMigration, backupOnce } from './pi-plugin-pin-migration.mjs';

const name = '@woowtech/pi-omnigent-plugin';
const nativePiWeb = '/usr/local/bin/pi-web';
// Pi Web copies that older plugin installers built on the volume. This image
// already ships Pi Web with the native Omnigent and Paseo settings pages.
const volumeCopies = ['.local/share/pi-omnigent-web', '.local/share/pi-paseo'];
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
function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}
// The plugin launcher keeps starting host.json's realWeb. When that is a Pi Web
// copy left on the volume (or a path that no longer exists), point it at the
// image's Pi Web; the copy itself stays on disk. Other launchers are kept.
function repairLauncher({ stateDir, home, nativeWeb }) {
  const file = path.join(stateDir, 'host.json');
  let host;
  try { host = read(file, null); } catch { return null; }
  if (!host || typeof host !== 'object' || typeof host.realWeb !== 'string' || host.realWeb === nativeWeb) return null;
  const real = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
  const targets = [path.resolve(host.realWeb), real(host.realWeb)];
  const roots = volumeCopies.flatMap(directory => [path.resolve(home, directory), path.join(real(home), directory)]);
  const copy = targets.some(target => roots.some(root => target.startsWith(root + path.sep)));
  const reason = copy ? 'volume-ui-copy' : !exists(host.realWeb) ? 'missing' : null;
  if (!reason || !executable(nativeWeb)) return null;
  backupOnce(file, `${file}.pre-image-migration.bak`);
  write(file, { ...host, realWeb: nativeWeb });
  return { file, field: 'realWeb', from: host.realWeb, to: nativeWeb, reason };
}
export function seed({ agentDir, bundle, home = path.join(agentDir, "home"), seedEnabled = true,
  stateDir = path.join(agentDir, 'omnigent-plugin'), nativeWeb = nativePiWeb }) {
  const pkg = read(path.join(bundle, 'package.json'), null);
  if (pkg?.name !== name) throw Error('image bundle missing or invalid');
  const file = path.join(agentDir, 'settings.json');
  const markerFile = path.join(agentDir, 'omnigent-plugin', 'image-seed.json');
  let settings = read(file, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      ('packages' in settings && !Array.isArray(settings.packages))) throw Error('invalid Pi settings');
  const matches = (item, base) => {
    const source = sourceOf(item);
    if (typeof source !== 'string') return false;
    if (source === bundle || /(?:^|[/:])pi-omnigent-plugin(?:\.git)?(?:@[^/]*)?\/?$/i.test(source)
        || officialGitPin(source, 'pi-omnigent-plugin')
        || source === `npm:${name}` || source.startsWith(`npm:${name}@`)) return true;
    if (!source.includes(':')) return read(path.resolve(base, source, 'package.json'), null)?.name === name;
    return false;
  };
  const project = read(path.join(home, '.pi/settings.json'), {});
  if (!project || typeof project !== 'object' || Array.isArray(project)
      || ('packages' in project && !Array.isArray(project.packages))) throw Error('invalid project settings');
  // A project-level choice has precedence over the global image default.
  const projectEntry = (project.packages || []).find(item => matches(item, home));
  let entry = projectEntry || (settings.packages || []).find(item => matches(item, agentDir));
  const marker = read(markerFile, null);
  if (!seedEnabled) return { active: false, reason: 'image-setup-disabled' };
  const plan = planPinMigration({ packages: settings.packages || [], repository: 'pi-omnigent-plugin', name, bundle, version: pkg.version,
    agentDir, isPlugin: item => matches(item, agentDir), projectOverride: Boolean(projectEntry) });
  const migration = applyPinMigration({ agentDir, file, settings, plan, write });
  const migrated = migration.run.changed.length > 0;
  if (migrated) {
    settings = migration.settings;
    entry = settings.packages.find(item => matches(item, agentDir));
  }
  const packages = settings.packages || [];
  if (entry) {
    if (!marker || migrated) write(markerFile, { schema: 1, mode: sourceOf(entry) === bundle ? 'managed' : 'external', source: sourceOf(entry) });
    const active = !projectEntry && sourceOf(entry) === bundle && !disabled(entry);
    // Bookkeeping after the switch must not stop main() from rewriting the launcher.
    let launcher = null;
    if (active) try { launcher = repairLauncher({ stateDir, home, nativeWeb }); } catch {}
    try {
      recordMigration({ file: path.join(agentDir, 'omnigent-plugin', 'image-migration.json'),
        run: { ...migration.run, ...(launcher ? { launcher } : {}) }, plugin: name, bundle, version: pkg.version, read, write });
    } catch { console.error('[pi-omnigent] image migration receipt could not be written'); }
    return { active, reason: disabled(entry) ? 'disabled' : migrated ? 'migrated' : 'existing', source: sourceOf(entry) };
  }
  if (marker) return { active: false, reason: 'user-removed' };
  if (exists(path.join(agentDir, 'omnigent-plugin/state.json'))) {
    write(markerFile, { schema: 1, mode: 'existing-state', source: bundle });
    return { active: false, reason: 'existing-state' };
  }
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
  const result = seed({ agentDir, bundle, home: process.env.HOME, seedEnabled: process.env.PI_OMNIGENT_AUTO_SETUP !== 'false',
    stateDir: process.env.PI_OMNIGENT_STATE_DIR || path.join(agentDir, 'omnigent-plugin') });
  if (process.env.PI_OMNIGENT_SEED_ONLY !== '1' && result.active) {
    const web = await import(pathToFileURL(path.join(bundle, 'src/web.mjs')).href);
    // Prepare the launcher without creating a setup conversation. Binding is
    // available only from Settings → Omnigent after Pi Web starts.
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
