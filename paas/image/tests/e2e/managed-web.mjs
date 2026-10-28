#!/usr/bin/env node
// Real compiled Pi Web + published Paseo assets, uid 1000, isolated state.
// Never activate the daemon, pair a host, read operator accounts or send a model request.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { startPiWeb } from "./lib.mjs";
import { contract, verifyWebManifest, verifyCompiledRoute } from "../managed-web-contract.mjs";

assert.equal(process.getuid(), 1000, "managed web smoke must execute as uid 1000");
const piWebDir = resolve(process.argv[2] || "/usr/local/lib/node_modules/@agegr/pi-web");
const pluginDir = resolve(process.argv[3] || process.env.PI_PASEO_PLUGIN_ROOT || "/opt/woow/pi-paseo-plugin");
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
verifyWebManifest(readJson(join(pluginDir, "package.json")), readJson(join(pluginDir, "runtime/web-client.json")));
verifyCompiledRoute(piWebDir);
const { ensureWebClient, managedPairUrl } = await import(pathToFileURL(join(pluginDir, "src/web-client.mjs")));
const { seedWebClient } = await import(pathToFileURL(process.env.PASEO_WEB_SEED_MODULE || "/usr/local/bin/pi-paseo-web-seed.mjs"));
const root = mkdtempSync(join(tmpdir(), "pi-managed-web-"));
const data = join(root, "data"), home = join(data, "home"), stateDir = join(data, "pi-paseo");
const password = randomBytes(24).toString("hex");
mkdirSync(home, { recursive: true });
const settings = packages => writeFileSync(join(data, "settings.json"), JSON.stringify({ packages }));
settings([]); // Let startup recovery finish with no enabled plugin; this test does not start agents.
let pw;
try {
  const installed = await seedWebClient({ bundle: pluginDir, loc: { stateDir },
    archive: process.env.PASEO_WEB_ARCHIVE || "/opt/woow/pi-paseo-web/client.tar.gz" });
  assert.equal(installed.ready, true);
  const cache = join(stateDir, "web-client", contract.webClient.sha256);
  assert.equal(statSync(cache).uid, 1000);
  const hash = content => createHash("sha256").update(content).digest("hex");
  const indexHash = hash(readFileSync(join(cache, "index.html")));
  const start = () => startPiWeb(piWebDir, { root, readyPath: "/api/web-auth", env: {
    PI_WEB_PASSWORD: password, PI_PASEO_PLUGIN_ROOT: pluginDir,
  } });
  pw = await start();
  settings([pluginDir]);
  const get = async (path, headers = {}, method = "GET") => {
    let result = await fetch(pw.base + path, { method, headers, redirect: "manual" });
    // Next normalizes a trailing slash before running the auth proxy.
    if (result.status === 308) {
      const target = new URL(result.headers.get("location"), pw.base);
      assert.equal(target.origin, pw.base);
      assert.equal(target.pathname, path.replace(/\/$/, ""));
      await result.arrayBuffer();
      result = await fetch(target, { method, headers, redirect: "manual" });
    }
    return result;
  };
  const deny = async path => {
    const result = await get(path);
    assert.equal(result.status, 307, `${path} must require Pi Web login`);
    assert.equal(new URL(result.headers.get("location"), pw.base).pathname, "/login");
    await result.arrayBuffer();
  };
  for (const path of ["/paseo-web", "/paseo-web/", "/paseo-web/pi-paseo-build.json", "/paseo-web/hosts/test/agents/test"]) await deny(path);
  const login = await fetch(pw.base + "/api/web-auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("pi_web_session="));
  const headers = { cookie };
  const shell = await get("/paseo-web/", headers);
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-type"), /text\/html/);
  assert.match(shell.headers.get("cache-control"), /private.*no-store/);
  assert.equal(shell.headers.get("referrer-policy"), "no-referrer");
  const html = await shell.text();
  assert.equal(hash(html), indexHash, "must serve the published Paseo shell, not Pi Web's fallback page");
  const assets = [...html.matchAll(/(?:src|href)="(\/paseo-web\/_expo\/[^"?]+\.(?:js|css))"/g)].map(m => m[1]);
  assert.ok(assets.some(path => path.endsWith(".js")), "shell must load its compiled Paseo entry under the managed prefix");
  for (const path of new Set(assets)) {
    await deny(path);
    const asset = await get(path, headers);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type"), path.endsWith(".js") ? /javascript/ : /css/);
    assert.match(asset.headers.get("cache-control"), /private.*immutable/);
    const bytes = Buffer.from(await asset.arrayBuffer());
    assert.equal(hash(bytes), hash(readFileSync(join(cache, path.slice("/paseo-web/".length)))));
  }
  const build = await get("/paseo-web/pi-paseo-build.json", headers);
  assert.equal(build.status, 200);
  const meta = await build.json();
  for (const key of ["version", "sourceCommit", "repairCommit", "basePath"]) assert.equal(meta[key], contract.webClient[key]);
  const deep = await get("/paseo-web/hosts/test/agents/test", headers);
  assert.equal(deep.status, 200);
  assert.equal(hash(await deep.text()), indexHash, "deep-link refresh must return the same shell");
  const head = await get("/paseo-web/", headers, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await get("/paseo-web/.installed.json", headers)).status, 400);
  assert.equal((await get("/paseo-web/_expo/absent.js", headers)).status, 404);
  const untrustedStatus = await new Promise((accept, reject) => {
    // Node fetch normalizes Host; use a real HTTP request for this negative control.
    const request = http.get(pw.base + "/paseo-web", { headers: { ...headers, host: "untrusted.invalid" } }, response => {
      response.resume(); response.on("end", () => accept(response.statusCode));
    });
    request.on("error", reject);
  });
  assert.equal(untrustedStatus, 403);
  assert.equal(managedPairUrl("https://app.paseo.sh/#synthetic-test-only"), "/paseo-web/welcome#synthetic-test-only");
  settings([]);
  assert.equal((await get("/paseo-web/", headers)).status, 404, "removed/disabled package cannot expose its cached client");
  await pw.stop(); pw = null;
  // A restart must reuse the uid-owned cache with no redownload, and keep auth active.
  assert.equal((await ensureWebClient({ stateDir }, { fetchImpl: async () => { throw new Error("unexpected download"); } })).ready, true);
  pw = await start(); settings([pluginDir]);
  await deny("/paseo-web/");
  const resumed = await get("/paseo-web/", headers);
  assert.equal(resumed.status, 200, "valid session remains usable after process restart");
  assert.equal(hash(await resumed.text()), indexHash);
  console.log(JSON.stringify({ passed: true, uid: process.getuid(), pluginVersion: contract.paseoVersion,
    webClient: meta, checks: ["compiled-route", "offline-image-seed", "checksum-install", "uid-owned-cache", "protected-shell-and-assets",
      "authenticated-content-hashes", "deep-link-refresh", "host-guard", "package-removal", "restart-cache-and-auth"],
    daemonActivated: false, modelRequests: 0 }));
} finally {
  if (pw) await pw.stop();
  rmSync(root, { recursive: true, force: true });
}
