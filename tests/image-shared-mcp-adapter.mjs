// Run the shipped regression using this image's installed SDK. No model calls,
// credentials, tenant mounts or network are needed; fixtures live under /tmp.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const bundle = '/opt/woow/pi-agent-shared-runtime';
const sdkRoot = '/usr/local/lib/node_modules/@agegr/pi-web';
const testFile = path.join(bundle, 'tests/mcp-adapter.test.mjs');
const sdk = JSON.parse(fs.readFileSync(path.join(sdkRoot, 'node_modules/@earendil-works/pi-coding-agent/package.json')));
const shared = JSON.parse(fs.readFileSync(path.join(bundle, 'package.json')));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'image-shared-mcp-'));
try {
  const result = spawnSync(process.execPath, ['--test', testFile], {
    cwd: home,
    env: { ...process.env, HOME: home, PI_SHARED_HOME: home,
      PI_SHARED_DATA_DIR: path.join(home, 'agent'), PI_CODING_AGENT_DIR: path.join(home, 'agent'),
      PI_SHARED_SDK_ROOT: sdkRoot, PI_SHARED_INTERNAL: '1' },
    encoding: 'utf8', timeout: 150_000, maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'installed cold/warm MCP bridge regression failed');
  for (const line of ['# tests 1', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0']) {
    assert.ok(result.stdout.split(/\r?\n/).includes(line), `missing complete test result: ${line}`);
  }
  console.log(JSON.stringify({ gate: 'shared-mcp-cold-warm', passed: true,
    installedTest: testFile, sharedVersion: shared.version, sdk: sdk.version, modelCalls: 0 }));
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
