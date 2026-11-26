// Owned full-image QA only. Merely importing this file runs no installer/SDK.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = '/opt/woow/pi-omnigent-plugin';
const STATE = '/qa/s';
const TOOL = `${STATE}/uv/tools/omnigent`;
const PYTHON = `${TOOL}/bin/python`;
const BIN = `${STATE}/bin/omnigent`;
const UV = `${STATE}/bootstrap/bin/uv`;
const COMMON = `${TOOL}/lib/python3.12/site-packages/omnigent/native/native_bridge_common.py`;
const BEFORE = '2a80d492f6f844a8da0e7dbb3e8aaec396a2bbd525f6d042ddc3cf2eed6bccc6';
const AFTER = '68f4c2a3c0a3aa75436a15828e325bd279995435d83931d93b12516cca303962';
const sha = raw => createHash('sha256').update(raw).digest('hex');
const absent = () => ({ available: false, path: null });

export function validateInstall(result, calls, phase) {
  assert.equal(result.ok, true);
  assert.equal(result.changed, phase !== 'final');
  assert.equal(result.maintenancePreservation.ok, true);
  assert.equal(result.maintenancePreservation.sourceSha256, AFTER);
  assert.equal(result.maintenancePreservation.state, phase === 'final' ? 'verified' : 'applied');
  assert.deepEqual(calls.map(c => c.kind), phase === 'final' ? ['guard'] : ['uv', 'guard']);
  const guard = calls.at(-1);
  assert.equal(guard.code, 0);
  assert.equal(guard.value.sdkImported, false);
  assert.equal(guard.value.consoleScriptValidated, true);
  assert.equal(guard.value.pythonExecutable, PYTHON);
  assert.equal(guard.value.sourceSha256, AFTER);
  if (phase !== 'final') {
    assert.equal(calls[0].copyMode, 'copy');
    assert.equal(guard.sourceBefore.sha256, BEFORE);
    assert.equal(guard.sourceBefore.nlink, 1);
    assert.equal(guard.sourceAfter.sha256, AFTER);
    assert.equal(guard.sourceAfter.nlink, 1);
    assert.equal(guard.cacheAndOtherUnchanged, true);
  }
}

export function validateRefusal(result, calls, reason) {
  assert.match(reason, /^[a-z0-9][a-z0-9-]{0,63}$/);
  assert.equal(result.ok, false);
  assert.equal(result.changed, false);
  assert.equal(result.maintenancePreservation.code, 'MAINTENANCE_PRESERVATION_REQUIRED');
  assert.equal(result.maintenancePreservation.reason, reason);
  assert.deepEqual(calls.map(c => c.kind), ['guard']);
  assert.notEqual(calls[0].code, 0);
  assert.equal(calls[0].value.ok, false);
  assert.equal(calls[0].value.code, 'MAINTENANCE_PRESERVATION_REQUIRED');
  assert.equal(calls[0].value.reason, reason);
  assert.equal(calls[0].guardInputUnchanged, true);
  assert.ok(result.steps.some(s => s.dependency === 'omnigent' && s.action === 'maintenance-preservation' && s.status === 'blocked'));
}

function pinnedPlugin(pins) {
  assert.equal(pins.pluginArchiveSha256, 'a5eb78fedabb3671cc4d70cc88e5826e1bf6d60075eba444288f3c4478a1ff58');
  for (const [relative, pin] of Object.entries(pins.pluginFiles)) {
    const file = path.join(ROOT, relative);
    for (let parent = path.dirname(file); parent !== '/'; parent = path.dirname(parent)) {
      assert.ok(fs.lstatSync(parent).isDirectory(), 'plugin parent redirected');
    }
    const s = fs.lstatSync(file);
    assert.ok(s.isFile() && s.nlink === 1 && s.size === pin.bytes && (s.mode & 0o777) === pin.mode);
    assert.equal(sha(fs.readFileSync(file)), pin.sha256, relative);
  }
  assert.equal(JSON.parse(fs.readFileSync(`${ROOT}/package.json`)).version, pins.pluginVersion);
}

function fileIdentity(file) {
  const s = fs.lstatSync(file);
  assert.ok(s.isFile());
  return { sha256: sha(fs.readFileSync(file)), nlink: s.nlink, mode: s.mode,
    uid: s.uid, gid: s.gid, dev: s.dev, ino: s.ino, size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
}

export async function main(input) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, input.platform === 'linux/amd64' ? 'x64' : 'arm64');
  assert.equal(process.geteuid(), 1000);
  assert.equal(process.getegid(), 1000);
  process.umask(0o022);
  pinnedPlugin(input.pins); // Before importing even the pinned plugin installer.
  const { installDependencies, runCommand } = await import(pathToFileURL(`${ROOT}/src/installer.mjs`));
  const baseEnv = { HOME: '/qa/h', PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1',
    UV_NO_CONFIG: 'true', UV_NO_PROGRESS: '1', UV_NO_BUILD: '1', PIP_CONFIG_FILE: '/dev/null',
    PIP_INDEX_URL: 'https://pypi.org/simple', UV_DEFAULT_INDEX: 'https://pypi.org/simple',
    PIP_NO_INPUT: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1',
    UV_CACHE_DIR: `${STATE}/uv-cache`, UV_PYTHON_INSTALL_DIR: `${STATE}/python` };
  const commands = [];
  async function command(binary, args, options, kind) {
    const result = await runCommand(binary, args, options);
    commands.push({ kind, code: result.code, signal: result.signal ?? null,
      stdoutSha256: sha(result.stdout || ''), stderrSha256: sha(result.stderr || '') });
    assert.equal(result.code, 0, `${kind} failed: ${result.error ?? result.code}`);
    return result;
  }
  if (input.phase === 'prefetch') {
    assert.equal(fs.existsSync(TOOL), false, 'fresh managed SDK already exists');
    for (const directory of ['/qa/h', STATE, '/qa/warm']) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const env = { ...baseEnv, UV_LINK_MODE: 'copy', UV_TOOL_DIR: '/qa/warm/tools', UV_TOOL_BIN_DIR: '/qa/warm/bin' };
    await command('/usr/bin/python3', ['-m', 'pip', 'install', '--target', `${STATE}/bootstrap`,
      '--only-binary=:all:', '--no-cache-dir', '--disable-pip-version-check', 'uv==0.12.10'], { env, timeoutMs: 600_000 }, 'uv-bootstrap');
    const version = await command(UV, ['--version'], { env, timeoutMs: 10_000 }, 'uv-version');
    assert.match(version.stdout, /^uv 0\.12\.10(?:\s|$)/);
    await command(UV, ['python', 'install', '3.12'], { env, timeoutMs: 600_000 }, 'owned-python-prefetch');
    await command(UV, ['tool', 'install', '--python', '3.12', '--no-build', 'omnigent==0.16.0'],
      { env, timeoutMs: 600_000 }, 'wheel-cache-prefetch');
    assert.equal(fs.existsSync(TOOL), false, 'prefetch populated actual managed SDK');
    assert.equal(fileIdentity('/qa/warm/tools/omnigent/lib/python3.12/site-packages/omnigent/native/native_bridge_common.py').sha256, BEFORE);
    return { schema: 'k3s-owned-maintenance-prefetch/v1', passed: true, phase: 'prefetch', commands,
      packageFetchOnly: true, maintenanceAcceptance: false, SDKImported: false };
  }
  assert.equal(input.phase, 'offline');
  assert.equal(fs.existsSync(TOOL), false, 'fresh SDK proof cannot reuse an existing managed SDK');
  const env = { ...baseEnv, UV_LINK_MODE: 'hardlink', UV_OFFLINE: '1', UV_PYTHON_DOWNLOADS: 'never' };
  async function check(action, selectedPython = '/usr/bin/python3') {
    const value = await command(selectedPython, ['-I', '-B', '-c', input.checker, action,
      ...(action === 'readback' ? [input.platform] : [])], { env, timeoutMs: 200_000 }, action);
    return JSON.parse(value.stdout);
  }
  const sysProbe = await command('/usr/bin/python3', ['-I', '-B', '-c', 'import json,sys;print(json.dumps({"version":".".join(map(str,sys.version_info[:3]))}))'],
    { env, timeoutMs: 10_000 }, 'system-python-identity');
  const systemVersion = JSON.parse(sysProbe.stdout).version;
  const find = async () => Object.fromEntries(['omnigent', 'uv', 'python', 'claude', 'codex', 'pi', 'tmux', 'bwrap', 'node', 'npm'].map(name =>
    [name, name === 'omnigent' ? (fs.existsSync(BIN) && fs.existsSync(PYTHON) ? { available: true, path: BIN, python: PYTHON } : absent())
      : name === 'uv' ? { available: true, path: UV }
      : name === 'python' ? { available: true, path: '/usr/bin/python3', version: systemVersion } : absent()]));
  const watched = () => [COMMON, `${TOOL}/bin/omnigent`, `${TOOL}/lib/python3.12/site-packages/omnigent-0.16.0.dist-info/METADATA`,
    ...['', '.opt-1', '.opt-2'].map(opt => `${path.dirname(COMMON)}/__pycache__/native_bridge_common.cpython-312${opt}.pyc`)];
  const capture = () => watched().map(fileIdentity);
  let phase = 'fresh';
  let calls = [];
  async function run(binary, args, options) {
    if (binary === UV) {
      assert.deepEqual(args, ['tool', 'install', '--python', '3.12', ...(phase === 'force' ? ['--force'] : []), 'omnigent==0.16.0']);
      assert.equal(options.env.UV_LINK_MODE, 'copy');
      assert.equal(options.env.UV_OFFLINE, '1');
      const result = await runCommand(binary, args, options);
      calls.push({ kind: 'uv', code: result.code, copyMode: options.env.UV_LINK_MODE });
      return result;
    }
    assert.equal(binary, PYTHON, 'unapproved installer command');
    assert.deepEqual(args, ['-I', '-B', `${ROOT}/src/maintenance_preservation.py`, '--omnigent-bin', BIN, '--state-dir', STATE]);
    const sourceBefore = fileIdentity(COMMON);
    const positiveInstall = phase === 'fresh' || phase === 'force';
    const beforeCache = positiveInstall ? await check('snapshot') : null;
    const beforeInput = positiveInstall ? null : capture();
    const response = await runCommand(binary, args, options); // Actual guard; no fake maintenance callback.
    const value = JSON.parse(response.stdout);
    const sourceAfter = fileIdentity(COMMON);
    const afterCache = positiveInstall ? await check('snapshot') : null;
    if (positiveInstall) assert.deepEqual(afterCache, beforeCache, 'guard changed cache or other actual install');
    else assert.deepEqual(capture(), beforeInput, 'guard changed existing/negative inputs');
    calls.push({ kind: 'guard', code: response.code, value, sourceBefore, sourceAfter,
      cacheAndOtherUnchanged: positiveInstall ? true : undefined,
      cacheAndOther: beforeCache, guardInputUnchanged: positiveInstall ? undefined : true });
    return response;
  }
  const invoke = update => installDependencies({ update, env, home: env.HOME, stateDir: STATE,
    run, discover: find, platform: process.platform, arch: process.arch });
  const installs = [];
  for (phase of ['fresh', 'force']) {
    calls = [];
    const result = await invoke(phase === 'force');
    validateInstall(result, calls, phase);
    const readback = await check('readback', PYTHON);
    assert.equal(env.UV_LINK_MODE, 'hardlink', 'ambient environment mutated');
    installs.push({ phase, result, calls, readback });
  }
  const beforeNegatives = await check('snapshot');
  const negativeCases = [];
  const refusalReasons = { 'source-drift': 'unknown-installed-source', 'shared-source-inode': 'unsafe-source-file',
    'console-script-drift': 'unsupported-python-console-script', 'unchecked-pyc': 'unverified-or-stale-bytecode' };
  for (const [name, reason] of Object.entries(refusalReasons)) {
    const saved = watched().map(file => [file, fs.readFileSync(file)]);
    const alias = '/qa/owned-negative-alias';
    try {
      if (name === 'source-drift') fs.appendFileSync(COMMON, '\n# owned negative\n');
      if (name === 'shared-source-inode') fs.linkSync(COMMON, alias);
      if (name === 'console-script-drift') fs.appendFileSync(`${TOOL}/bin/omnigent`, '\n# owned negative\n');
      if (name === 'unchecked-pyc') {
        const file = watched()[3], raw = fs.readFileSync(file);
        raw.writeUInt32LE(1, 4); fs.writeFileSync(file, raw);
      }
      phase = 'negative'; calls = [];
      const result = await invoke(false);
      validateRefusal(result, calls, reason);
      negativeCases.push({ name, refused: true, actualGuard: true, inputUnchanged: true });
    } finally {
      if (fs.existsSync(alias)) fs.unlinkSync(alias);
      for (const [file, raw] of saved) fs.writeFileSync(file, raw);
    }
  }
  phase = 'final'; calls = [];
  const finalResult = await invoke(false);
  validateInstall(finalResult, calls, 'final');
  const finalReadback = await check('readback', PYTHON);
  const afterNegatives = await check('snapshot');
  assert.deepEqual(afterNegatives, beforeNegatives, 'negative/final guards changed cache or other actual install');
  pinnedPlugin(input.pins);
  return { schema: 'k3s-owned-maintenance-gate/v1', passed: true, platform: input.platform,
    pluginArchiveSha256: input.pins.pluginArchiveSha256, pluginFilesVerified: Object.keys(input.pins.pluginFiles).length,
    installs, negativeCases, finalReadback, finalGuard: finalResult.maintenancePreservation,
    cacheAndOtherAfterNegatives: afterNegatives, network: 'none', uid: 1000,
    discovery: 'owned known paths only; no SDK/engine CLI execution', SDKImported: false, providerCalls: 0, tenantData: false };
}

if (typeof INPUT !== 'undefined') {
  try { console.log(JSON.stringify(await main(INPUT))); }
  catch (error) { console.error(JSON.stringify({ phase: INPUT.phase, failure: String(error.message).slice(0, 500) })); process.exitCode = 1; }
}
