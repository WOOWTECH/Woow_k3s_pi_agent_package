#!/usr/bin/env node
// Exercise fail-closed preflight and chunk discovery against the ACTUAL image
// compilation, without changing that tree. The production patch runs afterwards.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { applyPatches, planPatches, sessionChunks, jsonResponseModules } from "../patch-pi-web.mjs";

const source = resolve(process.argv[2] || "/usr/local/lib/node_modules/@agegr/pi-web");
const root = mkdtempSync(join(tmpdir(), "pi-patch-preflight-"));
try {
  for (const { file, original } of planPatches(source)) {
    const target = join(root, relative(source, file));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, original);
  }
  const server = join(root, ".next/server");
  const sessions = sessionChunks(server);
  const responses = jsonResponseModules(server);
  const session = sessions[0];
  const renamed = join(server, "chunks", "renamed-native-session.js");
  renameSync(session, renamed);
  assert.deepEqual(sessionChunks(server), [...sessions.slice(1), renamed].sort());
  const route = join(server, "app/api/auth/login/[provider]/route.js");
  const originalRoute = readFileSync(route, "utf8");
  const originals = planPatches(root).map(({ file, original }) => [file, original]);
  writeFileSync(route, 'throw new Error("upstream route moved");');
  assert.throws(() => applyPatches(root), /anchor changed/);
  for (const [file, content] of originals) if (file !== route) assert.equal(readFileSync(file, "utf8"), content, "preflight failure must not leave a partial overlay");
  writeFileSync(route, originalRoute);
  const files = applyPatches(root);
  assert.equal(files.length, new Set([...originals.map(([file]) => file)]).size);
  for (const file of responses) {
    assert.match(readFileSync(file, "utf8"), /JSON\.stringify\(b,__piErrReplacer\)/);
  }
  for (const file of sessionChunks(server)) {
    assert.match(readFileSync(file, "utf8"), /__piHeal\(e\.SessionManager\.open/);
  }
  const first = files.map(file => readFileSync(file, "utf8"));
  applyPatches(root);
  assert.deepEqual(files.map(file => readFileSync(file, "utf8")), first);
  console.log(`PASS actual compiled overlay: ${sessions.length} session chunks, ${responses.length} JSON response modules, renamed chunk, fail-closed preflight, all ${files.length} outputs parse, repeat application unchanged`);
} finally { rmSync(root, { recursive: true, force: true }); }
