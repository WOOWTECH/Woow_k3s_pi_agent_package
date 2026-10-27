// Run inside the built image before publication. No host/server login or model
// request is made: only real SDK registration and launcher routing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omnigent-image-'));
try {
  const env = { ...process.env, HOME: temporary, PI_AGENT_DATA_DIR: temporary, PI_CODING_AGENT_DIR: temporary };
  const run = () => {
    const result = spawnSync(process.execPath, ['/usr/local/bin/pi-omnigent-seed.mjs'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, 'real SDK must register the plugin and prepare a managed launcher');
  };
  run(); run();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary, 'settings.json'))).packages, ['/opt/woow/pi-omnigent-plugin']);
  assert.equal(fs.existsSync(path.join(temporary, 'omnigent-plugin/onboarding.json')), false, 'startup must not create onboarding state');
  const sessionsDir = path.join(temporary, 'sessions');
  const sessions = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir, { recursive: true }).filter(file => file.endsWith('.jsonl')) : [];
  assert.equal(sessions.length, 0, 'startup must not create a conversation');
  assert.ok(!fs.existsSync(path.join(temporary, '.omnigent/config.yaml')), 'no host identity or login is distributed');
  const root = spawnSync(process.execPath, ['/usr/local/bin/pi-omnigent-seed.mjs', '--resolve-root'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(root.status, 0); assert.equal(root.stdout, '/opt/woow/pi-omnigent-plugin');
  console.log('[build] real SDK settings-only registration and repeat boot OK');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
