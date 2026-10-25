import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { installMissing, installProfiles } = await import('/opt/woow/pi-agent-shared-runtime/src/runtime.mjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-discovery-'));
const previousPath = process.env.PATH, previousOptIn = process.env.PI_SHARED_INSTALL_MISSING_CLI;
try {
  const loc = { home: temporary, data: temporary, state: path.join(temporary, 'state') };
  process.env.PATH = path.join(temporary, 'bin');
  delete process.env.PI_SHARED_INSTALL_MISSING_CLI;
  let calls = 0;
  const missing = installMissing(loc, () => { calls++; throw Error('unexpected executable call'); });
  assert.equal(calls, 0, 'fresh setup must not invoke npm or download any engine');
  assert.equal(missing.claude.status, 'not-installed'); assert.equal(missing.codex.status, 'not-installed');
  installProfiles(loc);
  for (const name of ['claude', 'codex']) assert.equal(fs.existsSync(path.join(temporary, '.local/pi-shared/bin', name)), false, 'absent engines must not get misleading wrappers');
  fs.mkdirSync(process.env.PATH);
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(process.env.PATH, name), '#!/bin/sh\n', { mode: 0o755 });
  const found = installMissing(loc, (_command, args) => { assert.deepEqual(args, ['--version']); return 'fixture-1.0.0'; });
  for (const name of ['claude', 'codex']) { assert.equal(found[name].status, 'available'); assert.equal(found[name].installed, false); }
  console.log('[build] installed-engine discovery only; no implicit CLI downloads OK');
} finally {
  process.env.PATH = previousPath;
  if (previousOptIn === undefined) delete process.env.PI_SHARED_INSTALL_MISSING_CLI; else process.env.PI_SHARED_INSTALL_MISSING_CLI = previousOptIn;
  fs.rmSync(temporary, { recursive: true, force: true });
}
