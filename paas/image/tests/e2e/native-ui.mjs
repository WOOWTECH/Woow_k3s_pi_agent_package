#!/usr/bin/env node
// Native route + bundled plugin smoke. Isolated HOME, no remote login/model call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPiWeb } from "./lib.mjs";
import { contract } from "../managed-web-contract.mjs";

const piWebDir = resolve(process.argv[2] || "/usr/local/lib/node_modules/@agegr/pi-web");
const pluginDir = resolve(process.argv[3] || process.env.PI_OMNIGENT_PLUGIN_ROOT || "/opt/woow/pi-omnigent-plugin");
const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
assert.equal(manifest.name, "@woowtech/pi-omnigent-plugin");
assert.equal(manifest.version, contract.omnigentVersion);
const root = mkdtempSync(join(tmpdir(), "pi-native-ui-"));
const data = join(root, "data"), home = join(data, "home"), state = join(data, "omnigent-plugin");
mkdirSync(home, { recursive: true });
writeFileSync(join(data, "settings.json"), JSON.stringify({ packages: [pluginDir] }));
const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: data, PI_OMNIGENT_STATE_DIR: state,
  OMNIGENT_CONFIG_HOME: join(home, ".omnigent"), OMNIGENT_DATA_DIR: join(home, ".omnigent"),
  CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
  PI_OMNIGENT_PLUGIN_ROOT: pluginDir, PI_OMNIGENT_SDK_ROOT: piWebDir,
  PI_OMNIGENT_AUTO_SETUP: "true", PI_OMNIGENT_SEED_ONLY: "0" };
const onboardingFile = join(state, "onboarding.json");
const conversations = () => {
  const sessions = join(data, "sessions");
  return existsSync(sessions) ? readdirSync(sessions, { recursive: true }).filter(file => file.endsWith(".jsonl")).sort() : [];
};
// Settings -> Omnigent is the only binding entry. No boot path (image seed, Pi Web
// start/restart, opening Settings) may create or reuse a setup conversation.
const assertSettingsOnly = step => {
  assert.equal(existsSync(onboardingFile), false, `${step} must not create onboarding metadata`);
  assert.deepEqual(conversations(), [], `${step} must not create a conversation`);
};
// The image seed is what Pi Web's launcher runs on every boot; it is the path that
// created the setup conversation in root 0.3.18 (Omnigent 0.3.27).
const seed = () => {
  const result = spawnSync(process.execPath, ["/usr/local/bin/pi-omnigent-seed.mjs"],
    { env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, `image Omnigent seed failed: ${result.stderr}`);
};
let pw;
try {
  assertSettingsOnly("a fresh volume");
  seed();
  assertSettingsOnly("the image seed");
  seed();
  assertSettingsOnly("a repeated image seed");
  console.log("PASS native UI: image seed registers the plugin without creating a setup conversation");
  pw = await startPiWeb(piWebDir, { root, env });
  const view = await pw.api("GET", "/api/omnigent");
  assert.equal(view.status, 200, view.text);
  assert.equal(view.headers.get("cache-control"), "no-store");
  assert.equal(view.json.installed, true);
  assert.equal(view.json.active, true);
  assert.equal(view.json.version, contract.omnigentVersion);
  assert.equal(view.json.server, null);
  assert.equal(view.json.loginConfirmed, false);
  assert.equal(view.json.host.connected, false);
  assert.equal("onboardingUrl" in view.json, false);
  assertSettingsOnly("Pi Web startup");
  console.log("PASS native UI: bundled plugin is active; binding remains in Settings without a setup conversation");
  const missing = await pw.api("POST", "/api/omnigent", { action: "connect", username: "fixture" });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, "INVALID_SETUP");
  const crossSite = await fetch(pw.base + "/api/omnigent", { method: "POST", headers: { "content-type": "application/json", origin: "https://untrusted.invalid" }, body: JSON.stringify({ action: "disconnect", confirm: true }) });
  assert.equal(crossSite.status, 403);
  console.log("PASS native UI: missing credentials and cross-site mutation rejected before side effects");
  const page = await pw.api("GET", "/omnigent");
  assert.equal(page.status, 200, "native /omnigent page must be included in the compiled image");
  // AppShell renders inside Suspense; its translated title is client-rendered.
  // Verify the actual route-specific asset, not text absent from initial SSR.
  const pageChunk = page.text.match(/src="([^"\s]*\/chunks\/app\/omnigent\/page-[^"\s]+\.js)"/);
  assert.ok(pageChunk, "native page must reference its own compiled client entry");
  const chunk = await pw.api("GET", pageChunk[1]);
  assert.equal(chunk.status, 200, "native page client entry must be served");
  assert.match(chunk.headers.get("content-type") || "", /javascript/);
  assert.ok(chunk.text.length > 100, "native page client entry must not be empty");
  assertSettingsOnly("opening Settings");
  console.log("PASS native UI: /omnigent settings page and its client entry are served");
  await pw.stop(); pw = undefined;
  seed();
  pw = await startPiWeb(piWebDir, { root, env });
  const restarted = await pw.api("GET", "/api/omnigent");
  assert.equal(restarted.status, 200, restarted.text);
  assert.equal(restarted.json.active, true);
  assertSettingsOnly("a restart");
  console.log("PASS native UI: restart keeps the binding in Settings without a setup conversation");
} finally {
  if (pw) await pw.stop();
  rmSync(root, { recursive: true, force: true });
}
