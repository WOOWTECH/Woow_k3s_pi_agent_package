#!/usr/bin/env node
// Register the image bundle once; credentials and host identity never come from
// the image. Explicit disable/removal and an externally installed package win.
// An official GitHub git pin is moved to the bundle before Pi Web starts (see
// pi-plugin-pin-migration.mjs), so an image upgrade keeps the existing login.
// When that boot cannot put the bundled launcher in place, the exact old
// settings.json comes back before Pi Web starts (see boot()).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { officialGitPin, planPinMigration, applyPinMigration, recordMigration, backupOnce, readSettings,
  undoPinMigration, redactSource } from './pi-plugin-pin-migration.mjs';

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
// main() prints the message of a SetupFailure only: fixed text and reason codes,
// never settings or error payloads.
class SetupFailure extends Error {}
const putBack = restored => restored
  ? 'settings.json put back to the official git pin (see omnigent-plugin/image-migration.json)'
  : 'settings.json could not be put back and still lists the image plugin';
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
  const receipt = path.join(agentDir, 'omnigent-plugin', 'image-migration.json');
  let { settings, original } = readSettings(file);
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
  // The marker only records the first image setup; like the receipt it must not stop the boot.
  const mark = value => { try { write(markerFile, value); } catch { console.error('[pi-omnigent] image seed marker could not be written'); } };
  const plan = planPinMigration({ packages: settings.packages || [], repository: 'pi-omnigent-plugin', name, bundle, version: pkg.version,
    agentDir, isPlugin: item => matches(item, agentDir), projectOverride: Boolean(projectEntry) });
  const migration = applyPinMigration({ agentDir, file, settings, original, plan, write });
  const migrated = migration.run.changed.length > 0;
  // settings.json now lists the bundle. If this boot cannot finish, the bytes read
  // above go back before Pi Web starts the old plugin's launcher (see boot()).
  const undo = migrated ? reason => undoPinMigration({ file, original, reason, changes: migration.run.changed, receipt,
    plugin: name, bundle, version: pkg.version, read, write }) : null;
  try {
    if (migrated) {
      settings = migration.settings;
      entry = settings.packages.find(item => matches(item, agentDir));
    }
    const packages = settings.packages || [];
    if (entry) {
      if (!marker || migrated) mark({ schema: 1, mode: sourceOf(entry) === bundle ? 'managed' : 'external', source: redactSource(sourceOf(entry)) });
      const active = !projectEntry && sourceOf(entry) === bundle && !disabled(entry);
      // Bookkeeping after the switch must not stop main() from rewriting the launcher.
      let launcher = null;
      if (active) try { launcher = repairLauncher({ stateDir, home, nativeWeb }); } catch {}
      try {
        recordMigration({ file: receipt, run: { ...migration.run, ...(launcher ? { launcher } : {}) }, plugin: name, bundle, version: pkg.version, read, write });
      } catch { console.error('[pi-omnigent] image migration receipt could not be written'); }
      return { active, reason: disabled(entry) ? 'disabled' : migrated ? 'migrated' : 'existing', source: sourceOf(entry), ...(undo ? { undo } : {}) };
    }
    if (marker) return { active: false, reason: 'user-removed' };
    if (exists(path.join(agentDir, 'omnigent-plugin/state.json'))) {
      mark({ schema: 1, mode: 'existing-state', source: bundle });
      return { active: false, reason: 'existing-state' };
    }
    write(file, { ...settings, packages: [...packages, bundle] });
    mark({ schema: 1, mode: 'managed', source: bundle, version: pkg.version });
    return { active: true, reason: 'registered', source: bundle };
  } catch (error) {
    if (!undo) throw error;
    throw new SetupFailure(`setup could not complete (seed-error); ${putBack(undo('seed-error'))}`);
  }
}

// installHost() can fail after it replaced ~/.local/bin/pi-web; such a launcher
// already starts the bundle, which must then stay registered.
function launchesBundle(home, bundle) {
  try { return fs.readFileSync(path.join(home, '.local/bin/pi-web'), 'utf8').includes(JSON.stringify(path.join(bundle, 'bin/cli.mjs'))); }
  catch { return false; }
}
/** seed(), then the Pi Web launcher. pi-web-start.sh runs ~/.local/bin/pi-web
 *  even when this fails. If a pin was moved on this boot and that launcher still
 *  starts the old plugin, the old copy would find itself unregistered and reset
 *  the Omnigent sign-in, so the exact old settings.json is put back first. */
export async function boot({ installHost, prepareLauncher = true, ...options }) {
  const result = seed(options);
  if (!prepareLauncher || !result.active) return result;
  let status;
  try { status = (await installHost())?.status; } catch {}
  if (['installed', 'composable-wrapper'].includes(status)) return result;
  const reason = `launcher-${typeof status === 'string' && /^[a-z][a-z-]{0,39}$/.test(status) ? status : 'error'}`;
  if (!result.undo || launchesBundle(options.home ?? path.join(options.agentDir, 'home'), options.bundle)) {
    throw new SetupFailure(`Pi Web launcher not ready (${reason}); inspect the plugin in Pi Web`);
  }
  throw new SetupFailure(`Pi Web launcher not ready (${reason}); ${putBack(result.undo(reason))}`);
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
  const result = await boot({ agentDir, bundle, home: process.env.HOME, seedEnabled: process.env.PI_OMNIGENT_AUTO_SETUP !== 'false',
    stateDir: process.env.PI_OMNIGENT_STATE_DIR || path.join(agentDir, 'omnigent-plugin'),
    prepareLauncher: process.env.PI_OMNIGENT_SEED_ONLY !== '1',
    // Prepare the launcher without creating a setup conversation. Binding is
    // available only from Settings → Omnigent after Pi Web starts.
    installHost: async () => (await import(pathToFileURL(path.join(bundle, 'src/web.mjs')).href)).installHost() });
  console.log(`[pi-omnigent] ${result.reason}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // Never echo settings or error payloads that could contain credentials. A
    // failure after a settings.json write is a SetupFailure; others wrote nothing.
    console.error(`[pi-omnigent] ${error instanceof SetupFailure ? error.message : 'setup could not complete; settings.json unchanged; inspect the plugin in Pi Web'}`);
    process.exitCode = 1;
  });
}
