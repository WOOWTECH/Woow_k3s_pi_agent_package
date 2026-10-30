// Move official GitHub git pins of an image-bundled plugin to the bundle before
// Pi Web starts. No old plugin copy is running at that point, so the switch is
// not observed as an off/on cycle and the plugin keeps its consent and pairing.
// Disabled entries, refs newer than the bundle, project-level choices and every
// other source (forks, local checkouts) are left exactly as they are. A seed
// that cannot finish the boot puts the exact old settings.json bytes back.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const SETTINGS_BACKUP = 'settings.json.pre-image-migration.bak';
const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const sourceOf = item => typeof item === 'string' ? item : item?.source;
const disabled = item => typeof item === 'object' && Array.isArray(item.extensions) && !item.extensions.length;
// A fresh name per write: a file left by an interrupted boot (container PIDs
// repeat) never blocks this write or passes for its result.
const temporaryFor = file => `${file}.${process.pid}.${randomUUID()}.tmp`;

/** A receipt or marker must not copy credentials that a git URL may carry. officialGitPin()
 *  matches the trimmed text, so the user information of the trimmed URL is masked. */
export const redactSource = source => source.trim().replace(/^((?:git:\s*)?[a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, '$1***@');

/** Pi settings and the exact bytes they were parsed from, kept so a boot can put them back. */
export function readSettings(file) {
  if (!fs.existsSync(file)) return { settings: {}, original: null };
  if (fs.lstatSync(file).isSymbolicLink()) throw Error('metadata must not be a symlink');
  const original = fs.readFileSync(file);
  return { settings: JSON.parse(original.toString('utf8')), original };
}

/** Replace a file with exact bytes: a complete temporary copy is renamed over it. */
function replaceFile(file, bytes) {
  const temporary = temporaryFor(file);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Git forms (`git:` shorthand or an explicit protocol URL) for github.com/WOOWTECH/<repository>; see the README for the list. */
export function officialGitPin(source, repository) {
  if (typeof source !== 'string') return null;
  let value = source.trim();
  if (/^git:(?!\/\/)/.test(value)) value = value.slice(4).trim();
  else if (!/^(?:https?|ssh|git):\/\//i.test(value)) return null; // Pi reads anything else as a local path
  const match = value.match(/^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|github\.com\/)([^/]+)\/([^/@#]+?)(?:\.git)?\/?(?:[@#](.+))?$/i);
  if (!match || match[1].toLowerCase() !== 'woowtech' || match[2].toLowerCase() !== repository) return null;
  return { owner: match[1], repo: match[2], ref: match[3] || null };
}

/** Semantic-version order (-1, 0, 1); null when either side is not a release version. */
export function compareVersions(left, right) {
  const a = RELEASE.exec(left || ''), b = RELEASE.exec(right || '');
  if (!a || !b) return null;
  for (const i of [1, 2, 3]) if (Number(a[i]) !== Number(b[i])) return Number(a[i]) < Number(b[i]) ? -1 : 1;
  if (!a[4] || !b[4]) return !a[4] && !b[4] ? 0 : a[4] ? -1 : 1;
  const x = a[4].split('.'), y = b[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
    if (xn && yn && Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (!xn && x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

// A release tag names exactly one version. A branch, commit or missing ref is
// judged by the copy Pi already cloned, and only a strictly older copy is
// replaced: a commit made after a release still carries that release's version.
function pinVersion(pin, agentDir, name) {
  if (pin.ref && RELEASE.test(pin.ref)) return { version: pin.ref, basis: 'ref', exact: true };
  try {
    const file = path.join(agentDir, 'git', 'github.com', pin.owner, pin.repo, 'package.json');
    if (fs.lstatSync(file).isSymbolicLink()) return null;
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return pkg.name === name && RELEASE.test(pkg.version) ? { version: pkg.version, basis: 'installed-copy', exact: false } : null;
  } catch { return null; }
}

export function planPinMigration({ packages, repository, name, bundle, version, agentDir, isPlugin, projectOverride = false, skip: seedOnly = false }) {
  const plan = { packages: [...packages], changed: [], skipped: [] };
  const pins = packages.map((item, index) => ({ item, index, pin: officialGitPin(sourceOf(item), repository) })).filter(entry => entry.pin);
  if (!pins.length) return plan;
  // A seed-only run does not switch the launcher, so it must not move pins either.
  if (seedOnly) {
    for (const { item } of pins) plan.skipped.push({ file: 'settings.json', source: redactSource(sourceOf(item)), reason: 'seed-only' });
    return plan;
  }
  const entries = packages.filter(item => {
    if (officialGitPin(sourceOf(item), repository)) return true;
    try { return isPlugin(item); } catch { return false; }
  }).length;
  for (const { item, index, pin } of pins) {
    const source = redactSource(sourceOf(item));
    const skip = reason => plan.skipped.push({ file: 'settings.json', source, reason });
    if (projectOverride) { skip('project-setting'); continue; }
    if (disabled(item)) { skip('disabled'); continue; }
    if (entries > 1) { skip('multiple-entries'); continue; }
    const pinned = pinVersion(pin, agentDir, name);
    const order = pinned ? compareVersions(pinned.version, version) : null;
    if (order === null) { skip('version-unknown'); continue; }
    if (order > 0 || (order === 0 && !pinned.exact)) { skip(order > 0 ? 'newer-than-image' : 'not-older-than-image'); continue; }
    plan.packages[index] = typeof item === 'string' ? bundle : { ...item, source: bundle };
    plan.changed.push({ file: 'settings.json', from: source, to: bundle, basis: pinned.basis, version: pinned.version });
  }
  return plan;
}

/** Keep the settings from before the first migration. The copy is complete before it
 *  appears (temporary file, then link), and unlike rename() the link fails instead of
 *  replacing a backup, so a later migration of either plugin never overwrites it. */
export function backupOnce(file, backup, bytes = fs.readFileSync(file)) {
  const temporary = temporaryFor(backup);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, backup); }
    catch (error) {
      if (error.code === 'EEXIST') return false;
      // A volume without hard links: the seeds run one after the other, so look, then rename.
      try { fs.lstatSync(backup); return false; } catch {}
      fs.renameSync(temporary, backup);
    }
    return true;
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Rewrite settings.json only when the plan changes an entry; returns the settings Pi will read.
 *  `original` is the bytes the plan was made from (see readSettings); the backup copies them. */
export function applyPinMigration({ agentDir, file, settings, original, plan, write }) {
  if (!plan.changed.length) return { settings, run: { changed: [], skipped: plan.skipped } };
  const created = backupOnce(file, path.join(agentDir, SETTINGS_BACKUP), original ?? fs.readFileSync(file));
  const next = { ...settings, packages: plan.packages };
  write(file, next);
  return { settings: next, run: { changed: plan.changed, skipped: plan.skipped, backup: { file: SETTINGS_BACKUP, created } } };
}

/** Append a run to the receipt only when something changed, a switch was undone, or the skipped list differs from the last run. */
export function recordMigration({ file, run, plugin, bundle, version, read, write }) {
  const previous = read(file, null);
  const runs = Array.isArray(previous?.runs) ? previous.runs : [];
  if (!run.status && !run.changed.length && !run.launcher
      && (!run.skipped.length || JSON.stringify(runs.at(-1)?.skipped) === JSON.stringify(run.skipped))) return false;
  write(file, { schema: 1, plugin, runs: [...runs, { at: new Date().toISOString(), bundle, version, ...run }].slice(-20) });
  return true;
}

/** Put back the exact settings.json bytes this boot replaced and record a `rolled-back` (or
 *  `rollback-failed`) run with the reason code and the changes it undid. Never throws;
 *  returns whether settings.json was put back. */
export function undoPinMigration({ file, original, reason, changes, receipt, plugin, bundle, version, read, write }) {
  let restored = true;
  try { replaceFile(file, original); } catch { restored = false; }
  try {
    recordMigration({ file: receipt, run: { status: restored ? 'rolled-back' : 'rollback-failed', reason, changes }, plugin, bundle, version, read, write });
  } catch {} // the seed's log line still says what happened
  return restored;
}
