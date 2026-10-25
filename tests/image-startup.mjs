// Run inside the built image before publication. No host/server login or model
// request is made: only real SDK registration, session persistence and routing.
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
    assert.equal(result.status, 0, 'real SDK must create onboarding and a managed launcher');
    return JSON.parse(fs.readFileSync(path.join(temporary, 'omnigent-plugin/onboarding.json')));
  };
  const first = run(), second = run();
  assert.equal(first.sessionId, second.sessionId, 'restart must not duplicate onboarding');
  assert.ok(fs.existsSync(first.sessionFile), 'onboarding must be visible in the persisted session index');
  const text = fs.readFileSync(first.sessionFile, 'utf8');
  assert.ok(text.includes('Omnigent 連線設定'));
  assert.ok(!text.includes('"role":"assistant"'), 'no model response is generated during image seeding');
  assert.ok(!fs.existsSync(path.join(temporary, '.omnigent/config.yaml')), 'no host identity or login is distributed');
  const root = spawnSync(process.execPath, ['/usr/local/bin/pi-omnigent-seed.mjs', '--resolve-root'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(root.status, 0); assert.equal(root.stdout, '/opt/woow/pi-omnigent-plugin');
  console.log('[build] real SDK first-boot onboarding and repeat boot OK');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
