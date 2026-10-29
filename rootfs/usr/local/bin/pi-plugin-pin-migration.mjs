// Move official GitHub git pins of an image-bundled plugin to the bundle before
// Pi Web starts. No old plugin copy is running at that point, so the switch is
// not observed as an off/on cycle and the plugin keeps its consent and pairing.
// Disabled entries, refs newer than the bundle, project-level choices and every
// other source (forks, local checkouts) are left exactly as they are.
import fs from 'node:fs';
import path from 'node:path';

export const SETTINGS_BACKUP = 'settings.json.pre-image-migration.bak';
const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const sourceOf = item => typeof item === 'string' ? item : item?.source;
const disabled = item => typeof item === 'object' && Array.isArray(item.extensions) && !item.extensions.length;
// A receipt must not copy credentials that a git URL may carry.
const redact = source => source.replace(/^((?:git:\s*)?(?:https?|ssh|git):\/\/)[^@/]+@/i, '$1***@');

/** Pi's git forms (`git:` shorthand or an explicit protocol URL) for github.com/WOOWTECH/<repository>. */
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

export function planPinMigration({ packages, repository, name, bundle, version, agentDir, isPlugin, projectOverride = false }) {
  const plan = { packages: [...packages], changed: [], skipped: [] };
  const pins = packages.map((item, index) => ({ item, index, pin: officialGitPin(sourceOf(item), repository) })).filter(entry => entry.pin);
  if (!pins.length) return plan;
  const entries = packages.filter(item => {
    if (officialGitPin(sourceOf(item), repository)) return true;
    try { return isPlugin(item); } catch { return false; }
  }).length;
  for (const { item, index, pin } of pins) {
    const source = redact(sourceOf(item));
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

/** Copy a file once; an existing backup (from either plugin's migration) is never replaced. */
export function backupOnce(file, backup) {
  try { fs.writeFileSync(backup, fs.readFileSync(file), { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}

/** Rewrite settings.json only when the plan changes an entry; returns the settings Pi will read. */
export function applyPinMigration({ agentDir, file, settings, plan, write }) {
  if (!plan.changed.length) return { settings, run: { changed: [], skipped: plan.skipped } };
  const created = backupOnce(file, path.join(agentDir, SETTINGS_BACKUP));
  const next = { ...settings, packages: plan.packages };
  write(file, next);
  return { settings: next, run: { changed: plan.changed, skipped: plan.skipped, backup: { file: SETTINGS_BACKUP, created } } };
}

/** Append a run to the receipt only when something changed or the skipped list differs from the last run. */
export function recordMigration({ file, run, plugin, bundle, version, read, write }) {
  const previous = read(file, null);
  const runs = Array.isArray(previous?.runs) ? previous.runs : [];
  if (!run.changed.length && !run.launcher
      && (!run.skipped.length || JSON.stringify(runs.at(-1)?.skipped) === JSON.stringify(run.skipped))) return false;
  write(file, { schema: 1, plugin, runs: [...runs, { at: new Date().toISOString(), bundle, version, ...run }].slice(-20) });
  return true;
}
