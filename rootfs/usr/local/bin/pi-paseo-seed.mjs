#!/usr/bin/env node
// Register the image bundle once; credentials and host identity never come from
// the image. Explicit disable/removal and an externally installed package win.
// An official GitHub git pin is moved to the bundle before Pi Web starts (see
// pi-plugin-pin-migration.mjs), so no old supervisor sees the source switch.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { seedWebClient } from './pi-paseo-web-seed.mjs';
import { officialGitPin, planPinMigration, applyPinMigration, recordMigration, readSettings, undoPinMigration,
  redactSource } from './pi-plugin-pin-migration.mjs';

const name = '@woowtech/pi-paseo';
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
// main() prints the message of a SetupFailure only: fixed text and reason codes,
// never settings or error payloads.
class SetupFailure extends Error {}
export function seed({ agentDir, bundle, home = path.join(agentDir, "home"), seedEnabled = true }) {
  const pkg = read(path.join(bundle, 'package.json'), null);
  if (pkg?.name !== name) throw Error('image bundle missing or invalid');
  const file = path.join(agentDir, 'settings.json');
  const markerFile = path.join(agentDir, 'pi-paseo', 'image-seed.json');
  const receipt = path.join(agentDir, 'pi-paseo', 'image-migration.json');
  let { settings, original } = readSettings(file);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
      ('packages' in settings && !Array.isArray(settings.packages))) throw Error('invalid Pi settings');
  const matches = (item, base) => {
    const source = sourceOf(item);
    if (typeof source !== 'string') return false;
    if (source === bundle || /(?:^|[/:])pi-paseo-plugin(?:\.git)?(?:@[^/]*)?\/?$/i.test(source)
        || officialGitPin(source, 'pi-paseo-plugin')
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
  const mark = value => { try { write(markerFile, value); } catch { console.error('[pi-paseo] image seed marker could not be written'); } };
  const plan = planPinMigration({ packages: settings.packages || [], repository: 'pi-paseo-plugin', name, bundle, version: pkg.version,
    agentDir, isPlugin: item => matches(item, agentDir), projectOverride: Boolean(projectEntry) });
  const migration = applyPinMigration({ agentDir, file, settings, original, plan, write });
  const migrated = migration.run.changed.length > 0;
  try {
    if (migrated) {
      settings = migration.settings;
      entry = settings.packages.find(item => matches(item, agentDir));
    }
    const packages = settings.packages || [];
    // A missing receipt must not keep the offline web client from being prepared.
    try {
      recordMigration({ file: receipt, run: migration.run, plugin: name, bundle, version: pkg.version, read, write });
    } catch { console.error('[pi-paseo] image migration receipt could not be written'); }
    if (entry) {
      if (!marker || migrated) mark({ schema: 1, mode: sourceOf(entry) === bundle ? 'managed' : 'external', source: redactSource(sourceOf(entry)) });
      return { active: !projectEntry && sourceOf(entry) === bundle && !disabled(entry),
        reason: disabled(entry) ? 'disabled' : migrated ? 'migrated' : 'existing', source: sourceOf(entry) };
    }
    if (marker) return { active: false, reason: 'user-removed' };
    if (exists(path.join(agentDir, 'pi-paseo/state.json'))) {
      mark({ schema: 1, mode: 'existing-state', source: bundle });
      return { active: false, reason: 'existing-state' };
    }
    write(file, { ...settings, packages: [...packages, bundle] });
    mark({ schema: 1, mode: 'managed', source: bundle, version: pkg.version });
    return { active: true, reason: 'registered', source: bundle };
  } catch (error) {
    // settings.json lists the bundle now; a seed that cannot finish puts the bytes read above back.
    if (!migrated) throw error;
    const restored = undoPinMigration({ file, original, reason: 'seed-error', changes: migration.run.changed, receipt,
      plugin: name, bundle, version: pkg.version, read, write });
    throw new SetupFailure(`setup could not complete (seed-error); ${restored
      ? 'settings.json put back to the official git pin (see pi-paseo/image-migration.json)'
      : 'settings.json could not be put back and still lists the image plugin'}`);
  }
}

async function main() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DATA_DIR || '/data/pi-agent';
  const bundle = process.env.PI_PASEO_PLUGIN_ROOT || '/opt/woow/pi-paseo-plugin';
  const result = seed({ agentDir, bundle, home: process.env.HOME, seedEnabled: process.env.PI_PASEO_AUTO_SETUP !== 'false' });
  // Not a reason to undo a switch: no old copy runs here, and the plugin's own
  // activation installs the client (from the network) when it is still missing.
  if (result.active) await seedWebClient({ bundle }).catch(() => {
    throw new SetupFailure(`offline web client not ready${result.reason === 'migrated' ? '; the official git pin now points to the image plugin' : ''}; open Paseo settings`);
  });
  // Native Pi Web instrumentation restores the runtime. Pairing stays in
  // Settings and does not create or open a conversation.
  console.log(`[pi-paseo] ${result.reason}`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    // A failure after a settings.json write is a SetupFailure; others wrote nothing.
    console.error(`[pi-paseo] ${error instanceof SetupFailure ? error.message : 'setup could not complete; settings.json unchanged; open Paseo settings'}`);
    process.exitCode = 1;
  });
}
