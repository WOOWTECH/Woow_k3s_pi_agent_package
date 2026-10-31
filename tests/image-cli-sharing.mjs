// Image acceptance (disposable container, no network): the bundled Claude Code and Codex
// are the pinned versions, and a Pi skill plus a Pi Web global MCP server reach both CLIs
// through the bundled shared runtime. Everything happens in a throwaway HOME and data dir.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNTIME = '/opt/woow/pi-agent-shared-runtime';
const SKILL = 'woow-share-probe';
const SERVER = 'woow_share_probe';
const MARKER = 'WOOW_MCP_PROBE_OK';
const pinned = name => {
  const pkg = JSON.parse(fs.readFileSync(`/opt/pi-clis/${name}/package.json`, 'utf8'));
  return Object.values(pkg.dependencies)[0];
};
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-sharing-'));
const home = path.join(temporary, 'home');
const data = path.join(temporary, 'data');
fs.mkdirSync(home, { recursive: true });
const env = {
  ...process.env, HOME: home, PI_SHARED_HOME: home, PI_SHARED_DATA_DIR: data,
  PATH: '/usr/local/bin:/usr/bin:/bin', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
};
const run = (command, args, timeout = 60_000) => {
  const result = spawnSync(command, args, { env, cwd: home, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` };
};

// A JSON-RPC client over a child's stdio; `framing` adds the JSON-RPC 2.0 envelope (MCP) or not (Codex app-server).
function rpcClient(command, args, childEnv, { jsonrpc = true } = {}) {
  const child = spawn(command, args, { env: childEnv, cwd: home, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiters = new Map();
  let buffer = '', id = 0;
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try { const message = JSON.parse(line); if (message.id !== undefined) waiters.get(message.id)?.(message); } catch {}
    }
  });
  const envelope = body => JSON.stringify(jsonrpc ? { jsonrpc: '2.0', ...body } : body) + '\n';
  return {
    call(method, params, timeout = 60_000) {
      const n = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${command} ${method} timed out`)), timeout);
        waiters.set(n, message => { clearTimeout(timer); resolve(message); });
        child.stdin.write(envelope({ id: n, method, params }));
      });
    },
    notify(method) { child.stdin.write(envelope({ method })); },
    close() { child.kill(); },
  };
}

try {
  // 1. The pinned CLIs are on the system PATH.
  for (const name of ['claude', 'codex']) {
    const { code, out } = run(name, ['--version']);
    assert.equal(code, 0, `${name} --version failed`);
    assert.ok(out.includes(pinned(name)), `${name} must be ${pinned(name)}, got ${out.trim()}`);
  }

  // 2. A skill and a global MCP server stored the way Pi Web stores them.
  fs.mkdirSync(path.join(data, 'skills', SKILL), { recursive: true });
  fs.writeFileSync(path.join(data, 'skills', SKILL, 'SKILL.md'),
    `---\nname: ${SKILL}\ndescription: Acceptance probe proving Pi skills reach Claude Code and Codex.\n---\nReply with WOOW_SKILL_PROBE_OK.\n`);
  const probe = path.join(temporary, 'probe-mcp.mjs');
  fs.writeFileSync(probe, `import readline from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: '${SERVER}', version: '1.0.0' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'probe_echo', description: 'Return a fixed marker', inputSchema: { type: 'object', properties: {} } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: '${MARKER}' }] } });
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});\n`);
  fs.writeFileSync(path.join(data, 'mcp.json'), JSON.stringify({ mcpServers: { [SERVER]: { command: process.execPath, args: [probe] } } }, null, 2));

  // 3. Pi Web's startup registers the bundled shared runtime, which finds the CLIs and syncs them.
  const seed = spawnSync('/usr/local/bin/pi-shared-runtime-seed.sh', [], {
    env: { ...env, PI_AGENT_DATA_DIR: data, PI_SHARED_RUNTIME_SEED_ONLY: '1' }, encoding: 'utf8', timeout: 60_000 });
  assert.equal(seed.status, 0, `shared runtime seed failed: ${seed.stdout}${seed.stderr}`);
  const packages = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).packages || [];
  assert.ok(packages.includes(RUNTIME), 'the bundled shared runtime must be registered in Pi settings');
  const init = run(process.execPath, [path.join(RUNTIME, 'bin/cli.mjs'), 'initialize'], 120_000);
  assert.equal(init.code, 0, `shared runtime initialize failed: ${init.out.slice(-400)}`);
  const report = JSON.parse(fs.readFileSync(path.join(data, 'shared-runtime/last-initialize.json'), 'utf8'));
  for (const name of ['claude', 'codex']) assert.equal(report.cli[name]?.status, 'available', `${name} not found by the shared runtime`);
  assert.equal(report.status, 'ready', `shared runtime status ${report.status}`);

  for (const dir of ['.claude/skills', '.codex/skills', '.agents/skills']) {
    const link = path.join(home, dir, SKILL);
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(data, 'skills', SKILL)), `${dir} must link the Pi skill`);
  }
  const claudeConfig = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  const bridge = claudeConfig.mcpServers?.pi_shared_runtime;
  assert.ok(bridge?.command, 'Claude ~/.claude.json must register pi_shared_runtime');
  assert.match(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8'), /^\[mcp_servers\.pi_shared_runtime\]/m, 'Codex config must register pi_shared_runtime');

  // 4. The CLIs themselves read that configuration.
  const codexList = run('codex', ['mcp', 'list']);
  assert.ok(codexList.out.includes('pi_shared_runtime'), `codex mcp list: ${codexList.out.slice(0, 300)}`);
  const claudeList = run('claude', ['mcp', 'list'], 180_000);
  assert.match(claudeList.out, /pi_shared_runtime:.*Connected/, `claude mcp list: ${claudeList.out.slice(0, 300)}`);

  const codex = rpcClient('codex', ['app-server'], env, { jsonrpc: false });
  try {
    await codex.call('initialize', { clientInfo: { name: 'pi-image-acceptance', version: '1' } });
    codex.notify('initialized');
    const skills = await codex.call('skills/list', { cwds: [home] });
    assert.ok(JSON.stringify(skills.result ?? skills.error).includes(SKILL), 'Codex skills/list must include the Pi skill');
  } finally { codex.close(); }

  // 5. The Pi Web global MCP tool answers through the bridge Claude and Codex are configured with.
  const mcp = rpcClient(bridge.command, bridge.args || [], { ...env, ...(bridge.env || {}) });
  try {
    await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pi-image-acceptance', version: '1' } }, 120_000);
    mcp.notify('notifications/initialized');
    const tools = (await mcp.call('tools/list', {}, 120_000)).result?.tools || [];
    assert.ok(tools.some(tool => tool.name === 'pi_global_mcp'), `bridge tools: ${tools.map(tool => tool.name).join(', ')}`);
    const answer = await mcp.call('tools/call', { name: 'pi_global_mcp', arguments: { tool: `${SERVER}_probe_echo` } }, 120_000);
    const text = (answer.result?.content || []).map(item => item.text).join(' ');
    assert.ok(text.includes(MARKER), `global MCP call through the bridge returned: ${text.slice(0, 200) || JSON.stringify(answer.error)}`);
  } finally { mcp.close(); }

  // 6. Claude Code, Codex and Pi use the shared MCP servers at the same time. Each CLI starts its own
  // bridge (a Pi SDK session with Pi Web's MCP adapter, the same code path Pi uses), so three bridge
  // processes call the same global MCP tool concurrently while `claude mcp list` health-checks the bridge.
  assert.ok(fs.readFileSync(path.join(home, '.codex/config.toml'), 'utf8').includes(bridge.args?.[0] || 'bridge.mjs'),
    'Codex must start the same bridge as Claude');
  const parallel = ['claude', 'codex', 'pi'].map(() => rpcClient(bridge.command, bridge.args || [], { ...env, ...(bridge.env || {}) }));
  try {
    await Promise.all(parallel.map(client => client.call('initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pi-image-acceptance', version: '1' } }, 180_000)));
    parallel.forEach(client => client.notify('notifications/initialized'));
    const health = new Promise(resolve => {
      const child = spawn('claude', ['mcp', 'list'], { env, cwd: home, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on('close', () => { clearTimeout(timer); resolve(output); });
    });
    const [answers, listing] = await Promise.all([
      Promise.all(parallel.map(client => client.call('tools/call', { name: 'pi_global_mcp', arguments: { tool: `${SERVER}_probe_echo` } }, 180_000))),
      health,
    ]);
    answers.forEach((answer, index) => {
      const text = (answer.result?.content || []).map(item => item.text).join(' ');
      assert.ok(text.includes(MARKER), `concurrent call ${index + 1} returned: ${text.slice(0, 200) || JSON.stringify(answer.error)}`);
    });
    assert.match(listing, /pi_shared_runtime:.*Connected/, `claude mcp list during concurrent calls: ${listing.slice(0, 300)}`);
  } finally { parallel.forEach(client => client.close()); }

  console.log(`[accept] Claude Code ${pinned('claude')} and Codex ${pinned('codex')} share Pi skills and global MCP, also concurrently, OK`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
