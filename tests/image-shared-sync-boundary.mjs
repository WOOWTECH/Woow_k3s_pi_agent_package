// Exact-image, no-provider-call regression. Stream into node --input-type=module
// or run the baked copy. All fixtures remain under /tmp; use network none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';

const bundle = '/opt/woow/pi-agent-shared-runtime';
const cli = path.join(bundle, 'bin/cli.mjs');
const sdkRoot = '/usr/local/lib/node_modules/@agegr/pi-web';
const sdkManifest = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'node_modules/@earendil-works/pi-coding-agent/package.json'), 'utf8'));
const sdkEntry = path.join(sdkRoot, 'node_modules/@earendil-works/pi-coding-agent', sdkManifest.exports?.['.']?.import || sdkManifest.module || sdkManifest.main);
console.log(JSON.stringify({ gate: 'shared-sync-extension-boundary', sdk: sdkManifest.version, modelCalls: 0 }));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-sync-boundary-'));
  const home = path.join(root, 'home'), data = path.join(root, 'data'), bin = path.join(root, 'bin');
  const marker = path.join(root, 'extension-events.jsonl');
  const state = path.join(data, 'shared-runtime');
  for (const dir of [home, bin, state, path.join(data, 'extensions'), path.join(data, 'skills/fixture-skill')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(data, 'skills/fixture-skill/SKILL.md'), '---\nname: fixture-skill\ndescription: image synchronization boundary fixture\n---\nRead only fixture.\n');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ packages: [bundle] }));
  fs.writeFileSync(path.join(data, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  const sentinel = name => fs.writeFileSync(path.join(data, 'extensions', name + '.ts'), `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({extension:${JSON.stringify(name)},phase:process.env.AC_PROVIDER_FIXTURE === '1' ? 'provider' : 'synchronization'})+'\\n'); export default function () {}`);
  sentinel('initial');
  const provider = `#!/usr/bin/node
const fs=require('node:fs');
(async()=>{
 if(process.argv.includes('--version')) { console.log('fixture-1.0.0'); return; }
 if(process.argv.includes('status')) { console.log(JSON.stringify({loggedIn:false})); return; }
 if(!process.argv.includes('--probe-provider')) throw Error('unexpected fixture command');
 if(process.env.PI_SHARED_BRIDGE==='1') throw Error('bridge mode leaked to provider child');
 process.env.AC_PROVIDER_FIXTURE='1';
 const pi=await import(${JSON.stringify(sdkEntry)});
 const loader=new pi.DefaultResourceLoader({cwd:${JSON.stringify(home)},agentDir:${JSON.stringify(data)},settingsManager:pi.SettingsManager.create(${JSON.stringify(home)},${JSON.stringify(data)})});
 await loader.reload();
 console.log(JSON.stringify({providerFixture:true,bridge:process.env.PI_SHARED_BRIDGE || null,userExtensions:loader.getExtensions().extensions.length}));
})().catch(e=>{console.error(e);process.exitCode=1});
`;
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), provider, { mode: 0o755 });
  const env = { PATH: bin + ':/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', PI_SHARED_HOME: home,
    PI_SHARED_DATA_DIR: data, PI_CODING_AGENT_DIR: data, PI_AGENT_DATA_DIR: data, PI_SHARED_SDK_ROOT: sdkRoot,
    PI_SHARED_BRIDGE: '0', PI_SHARED_INTERNAL: '0', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', DO_NOT_TRACK: '1' };
  return { root, home, data, marker, state, env, sentinel,
    events: () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function invoke(f, args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: f.home, env: f.env, encoding: 'utf8', timeout: 45000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return result;
}
function synchronized(f) {
  const report = JSON.parse(fs.readFileSync(path.join(f.state, 'last-sync.json'), 'utf8'));
  assert.ok(report.skills.some(s => s.name === 'fixture-skill'), 'real SDK skills remain available');
  assert.ok(report.mcpNames.includes('pi_shared_memory'), 'global MCP registration remains available');
  return report;
}
async function until(check, timeout = 45000) {
  const limit = Date.now() + timeout;
  while (Date.now() < limit) {
    try { if (check()) return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('timed out waiting for actual watcher synchronization');
}

for (const args of [['sync', '--global'], ['initialize'], ['boot', '--current', '--once']]) {
  test(`image ${args.join(' ')} keeps resource scans extension-free`, () => {
    const f = fixture();
    try {
      invoke(f, args); synchronized(f);
      assert.deepEqual(f.events(), [], 'user extension imported during resource scan');
    } finally { f.cleanup(); }
  });
}

test('image boot watcher refresh keeps new extensions unimported', async () => {
  const f = fixture(); let child; let output = '';
  try {
    child = spawn(process.execPath, [cli, 'boot', '--current'], { cwd: f.home, env: f.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    await until(() => JSON.parse(fs.readFileSync(path.join(f.state, 'watch-state.json'), 'utf8')).status === 'active');
    const prior = synchronized(f).date;
    f.sentinel('added-after-boot');
    fs.writeFileSync(path.join(f.data, 'settings.json'), JSON.stringify({ packages: [bundle], imageFixtureRevision: 2 }));
    await until(() => synchronized(f).date !== prior);
    assert.equal(child.exitCode, null, output);
    assert.deepEqual(f.events(), [], 'watcher imported user extensions');
  } finally {
    if (child && child.exitCode === null) {
      process.kill(-child.pid, 'SIGTERM');
      await until(() => child.exitCode !== null || child.signalCode !== null, 10000).catch(() => process.kill(-child.pid, 'SIGKILL'));
    }
    f.cleanup();
  }
});

for (const provider of ['claude', 'codex']) {
  test(`image run-cli ${provider} refresh is isolated while provider extensions still load`, () => {
    const f = fixture();
    try {
      const result = invoke(f, ['run-cli', provider, '--probe-provider']); synchronized(f);
      assert.ok(result.stdout.includes('"providerFixture":true'), 'owned provider child actually executed');
      const events = f.events();
      assert.ok(events.some(e => e.phase === 'provider'), 'positive control: normal SDK loader still imports user extensions');
      assert.ok(events.every(e => e.phase === 'provider'), 'pre-launch synchronization imported user extensions');
    } finally { f.cleanup(); }
  });
}
