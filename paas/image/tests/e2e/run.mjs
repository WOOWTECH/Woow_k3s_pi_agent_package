#!/usr/bin/env node
// e2e of the pi-agent PaaS patches against a REAL pi-web server (compiled Next.js app) with a fake
// OpenAI-compatible provider.  usage: node run.mjs <pi-web package dir> [--baseline] [--out result.json]
//   default            asserts the patched behaviour (CI uses this on the patched image tree)
//   --baseline         runs the same scenarios against an UNPATCHED tree and asserts the ORIGINAL
//                      behaviour (proves each scenario reproduces the defect before the fix)
import { writeFileSync, readFileSync, readdirSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startProvider, startPiWeb, writeModels, sleep, waitIdle } from "./lib.mjs";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out");
const baseline = args.includes("--baseline");
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
if (!dir) { console.error("usage: run.mjs <pi-web dir> [--baseline] [--out file]"); process.exit(2); }

const results = [];
function check(scenario, name, ok, detail) {
  results.push({ scenario, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${scenario}] ${name}${ok ? "" : "  -> " + String(detail).slice(0, 300)}`);
}
const has = (s, t) => typeof s === "string" && s.includes(t);
const MODEL_CFG = (port, key, extra = {}) => ({ providers: { fake: { baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: key, models: [{ id: "m1", name: "Fake M1", contextWindow: 8192, maxTokens: 1024, ...extra }] } } });
const lastAssistantError = (sess) => {
  const ents = [];
  const walk = (n) => { for (const x of n) { ents.push(x.entry); walk(x.children || []); } };
  walk(sess.tree || []);
  return ents.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.message).pop();
};

const prov = await startProvider({ goodKey: "good-key" });
let pw = await startPiWeb(dir, { env: { PI_WEB_HEAL_MIN_IDLE_MS: "0" } });
try {
  // ---------- S0 privacy: actual GET/PUT round trips, never persist a mask ----------
  writeModels(pw.dataDir, prov.port, "initial-fixture-key");
  let config = await pw.api("GET", "/api/models-config");
  check("S0", baseline ? "ORIGINAL: GET exposes provider key" : "GET masks provider key", config.json?.providers?.fake?.apiKey === (baseline ? "initial-fixture-key" : "__PI_REDACTED__:-key"), "provider key projection mismatch");
  await pw.api("PUT", "/api/models-config", config.json);
  const saved = () => JSON.parse(readFileSync(join(pw.dataDir, "models.json"), "utf8"));
  check("S0", "GET/PUT round trip preserves the existing key", saved().providers.fake.apiKey === "initial-fixture-key", "round-trip changed key");
  if (!baseline) {
    config.json.providers.fake.apiKey = "replacement-fixture";
    await pw.api("PUT", "/api/models-config", config.json);
    check("S0", "new real key replaces the old key", saved().providers.fake.apiKey === "replacement-fixture", "replacement failed");
    config.json.providers.missing = { ...config.json.providers.fake, apiKey: "__PI_REDACTED__:fake" };
    await pw.api("PUT", "/api/models-config", config.json);
    check("S0", "mask without an existing key is dropped", !Object.hasOwn(saved().providers.missing, "apiKey"), "mask persisted");
  }
  // ---------- S1 wrong key: conversation error text (AI-PI-002-2) + #1461 (AI-PI-002-1) ----------
  writeModels(pw.dataDir, prov.port, "bad-key");
  let r = await pw.api("POST", "/api/agent/new", { cwd: pw.cwd, type: "ensure_session", provider: "fake", modelId: "m1" });
  const sid = r.json && r.json.sessionId;
  check("S1", "session created", r.status === 200 && sid, r.text);
  const evP = pw.events(sid, (ev) => ev.some((e) => e.type === "agent_end"), 20000);
  await sleep(300);
  r = await pw.api("POST", `/api/agent/${sid}`, { type: "prompt", message: "hello" });
  const ev = await evP;
  const endMsg = ev.filter((e) => e.type === "message_end" && e.message && e.message.role === "assistant" && e.message.stopReason === "error").pop();
  const errText = endMsg && endMsg.message.errorMessage;
  if (baseline) check("S1", "ORIGINAL: raw English 401 JSON reaches the UI event stream", has(errText, "401:") && !has(errText, "【"), errText);
  else {
    check("S1", "event stream error is a zh-TW key hint naming the 模型 button", has(errText, "【金鑰無效或沒有權限】") && has(errText, "「模型」"), errText);
    check("S1", "original provider text kept after the hint (support)", has(errText, "原文") && has(errText, "401:"), errText);
    check("S1", "no key material in the hint beyond what the provider returned", !has(errText, "bad-key") && !has(errText, "good-key"), errText);
  }
  await waitIdle(pw, sid);
  const sess1 = (await pw.api("GET", `/api/sessions/${sid}`)).json;
  const reloaded = lastAssistantError(sess1);
  check("S1", baseline ? "ORIGINAL: reloaded history shows raw 401" : "reloaded history (GET /api/sessions/<id>) shows the same zh-TW hint",
    baseline ? has(reloaded && reloaded.errorMessage, "401:") && !has(reloaded.errorMessage, "【") : has(reloaded && reloaded.errorMessage, "【金鑰無效或沒有權限】"), reloaded && reloaded.errorMessage);
  const ctx = (await pw.api("GET", `/api/sessions/${sid}/context`)).text;
  check("S1", baseline ? "ORIGINAL: context route raw" : "context route also rewrites", baseline ? !has(ctx, "【金鑰無效") : has(ctx, "【金鑰無效或沒有權限】"), ctx.slice(0, 200));
  // the stored session file keeps the ORIGINAL text (the hint is a view-layer rewrite)
  const sessDir = join(pw.dataDir, "sessions");
  const files = []; const walkDir = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); f.isDirectory() ? walkDir(p) : files.push(p); } }; walkDir(sessDir);
  const raw = files.map((f) => readFileSync(f, "utf8")).join("\n");
  check("S1", "session file on disk keeps the original provider text", has(raw, '401: {') && !has(raw, "【金鑰"), raw.slice(0, 120));

  // ---------- S2 #1461: fix the key in models-config, resend in the SAME open session ----------
  const before = prov.seen.length;
  r = await pw.api("PUT", "/api/models-config", MODEL_CFG(prov.port, "good-key"));
  check("S2", "PUT /api/models-config accepted", r.status === 200, r.text);
  const ev2P = pw.events(sid, (e) => e.some((x) => x.type === "agent_end"), 20000);
  await sleep(300);
  r = await pw.api("POST", `/api/agent/${sid}`, { type: "prompt", message: "again" });
  const ev2 = await ev2P;
  const used = prov.seen.slice(before).map((s) => s.auth);
  const ok2 = ev2.some((e) => e.type === "message_end" && e.message && e.message.role === "assistant" && e.message.stopReason === "stop");
  if (baseline) check("S2", "ORIGINAL (#1461): open session still sends the OLD key after the fix", used.length > 0 && used.every((k) => k === "bad-key") && !ok2, JSON.stringify(used));
  else check("S2", "open session uses the NEW key on the next message (no idle wait, no new session)", used.length > 0 && used.every((k) => k === "good-key") && ok2, JSON.stringify(used));

  // ---------- S3 compact on a small session (AI-PI-001-1) ----------
  await waitIdle(pw, sid);
  r = await pw.api("POST", `/api/agent/${sid}`, { type: "compact" });
  if (baseline) check("S3", "ORIGINAL: HTTP 500 'Nothing to compact (session too small)'", r.status === 500 && has(r.json && r.json.error, "Nothing to compact"), r.text);
  else {
    check("S3", "small-session compact is HTTP 409 (not a server error)", r.status === 409, r.text);
    check("S3", "message is zh-TW and explains why", has(r.json && r.json.error, "【不需要壓縮】") && has(r.json.error, "Nothing to compact"), r.text);
  }
  // token-cap failure wording is covered by the unit test (needs a real summariser run to reproduce)

  // ---------- S4 empty key => scope error (AI-PI-002-2) ----------
  writeModels(pw.dataDir, prov.port, "");
  r = await pw.api("POST", "/api/agent/new", { cwd: pw.cwd, type: "prompt", message: "hi", provider: "fake", modelId: "m1" });
  if (baseline) check("S4", "ORIGINAL: English 'Model is not available in the enabled scope'", has(r.json && r.json.error, "Model is not available in the enabled scope") && !has(r.json.error, "【"), r.text);
  else {
    check("S4", "empty-key error is a zh-TW hint naming the 模型 button, original kept", has(r.json && r.json.error, "【這個模型目前不能使用】") && has(r.json.error, "Model is not available in the enabled scope"), r.text);
    check("S4", "response shape unchanged (prompt_rejected, accepted:false)", r.json.code === "prompt_rejected" && r.json.accepted === false, r.text);
  }
  writeModels(pw.dataDir, prov.port, "good-key");

  // ---------- S6 upload limits (AI-PI-005-4) ----------
  let upSeq = 0;
  const upload = async (sizes) => {
    const fd = new FormData(); upSeq += 1;
    sizes.forEach((n, i) => fd.append("files", new Blob([Buffer.alloc(n, 97)]), `u${upSeq}-${i}.bin`));
    const rr = await fetch(`${pw.base}/api/files/${encodeURIComponent(pw.cwd)}?type=upload`, { method: "POST", body: fd });
    const text = await rr.text(); let json; try { json = JSON.parse(text); } catch { /* html */ }
    return { status: rr.status, json, text };
  };
  const MiB = 1024 * 1024;
  let up = await upload([1 * MiB]);
  check("S6", "a 1 MiB upload still works", up.status === 200 || up.status === 207, up.text.slice(0, 200));
  up = await upload([26 * MiB]);
  if (baseline) check("S6", "ORIGINAL: per-file limit message is English '25MB'", up.status === 413 && has(up.json && up.json.error, "25MB or smaller") && !has(up.json.error, "【"), up.text.slice(0, 200));
  else check("S6", "26 MiB file: HTTP 413, zh-TW message with the real per-file limit", up.status === 413 && has(up.json && up.json.error, "【檔案太大】") && has(up.json.error, "25 MiB"), up.text.slice(0, 200));
  up = await upload([24 * MiB, 24 * MiB, 24 * MiB, 24 * MiB]); // 96 MiB total: over 95 MiB, under the old 100 MiB
  if (baseline) check("S6", "ORIGINAL: 96 MiB total is accepted (then Cloudflare would answer 502/413 at ~100 MB)", up.status === 200 || up.status === 207, up.text.slice(0, 200));
  else check("S6", "96 MiB total: HTTP 413 from the app (zh-TW, 95 MiB), not left to Cloudflare", up.status === 413 && has(up.json && up.json.error, "【上傳總量太大】") && has(up.json.error, "95 MiB"), up.text.slice(0, 200));

  // ---------- S5 restart cut a bash tool call off (AI-PI-005-2) ----------
  prov.state.mode = "tool"; prov.state.toolCommand = "sleep 4242";
  await pw.api("PUT", "/api/models-config", MODEL_CFG(prov.port, "good-key"));
  r = await pw.api("POST", "/api/agent/new", { cwd: pw.cwd, type: "ensure_session", provider: "fake", modelId: "m1" });
  const sid5 = r.json.sessionId;
  const evP5 = pw.events(sid5, (e) => e.some((x) => x.type === "tool_execution_start"), 20000);
  await sleep(300);
  await pw.api("POST", `/api/agent/${sid5}`, { type: "prompt", message: "run the long command" });
  const ev5 = await evP5;
  check("S5", "tool call started (bash sleep 4242 running)", ev5.some((e) => e.type === "tool_execution_start"), JSON.stringify(ev5.map((e) => e.type)));
  const root = pw.root;
  await pw.stop("SIGKILL");
  spawnSync("pkill", ["-f", "^sleep 4242$"]);
  prov.state.mode = "text";
  await sleep(500);
  pw = await startPiWeb(dir, { root, env: { PI_WEB_HEAL_MIN_IDLE_MS: "0" } });
  // opening the live stream recreates the session wrapper from the file => heal point
  await pw.events(sid5, (e) => e.some((x) => x.type === "connected"), 15000);
  const sess5 = (await pw.api("GET", `/api/sessions/${sid5}`)).json;
  const ents = []; const walk5 = (n) => { for (const x of n) { ents.push(x.entry); walk5(x.children || []); } }; walk5(sess5.tree || []);
  const tr = ents.filter((e) => e.type === "message" && e.message.role === "toolResult");
  if (baseline) check("S5", "ORIGINAL: tool call stays without any result after restart", tr.length === 0, JSON.stringify(tr).slice(0, 200));
  else {
    check("S5", "an 'interrupted' error tool result closes the orphan call", tr.length === 1 && tr[0].message.isError === true && tr[0].message.toolCallId === "call_orphan_1" && has(JSON.stringify(tr[0].message.content), "【已中斷】"), JSON.stringify(tr).slice(0, 300));
    const before5 = prov.seen.length;
    const evP5b = pw.events(sid5, (e) => e.some((x) => x.type === "agent_end"), 20000);
    await sleep(300);
    r = await pw.api("POST", `/api/agent/${sid5}`, { type: "prompt", message: "what happened?" });
    await evP5b;
    const roles = (prov.seen[before5] && prov.seen[before5].messages) || [];
    check("S5", "follow-up prompt works and the model request now carries the tool result", r.status === 200 && roles.includes("tool"), JSON.stringify(roles));
  }
  // guard: a file touched less than the idle threshold ago is NOT healed (another writer may own it)
  await pw.stop();
  if (!baseline) {
    // create a fresh orphan and reopen with the DEFAULT 60 s guard
    pw = await startPiWeb(dir, { root });
    prov.state.mode = "tool"; prov.state.toolCommand = "sleep 4243";
    r = await pw.api("POST", "/api/agent/new", { cwd: pw.cwd, type: "ensure_session", provider: "fake", modelId: "m1" });
    const sid6 = r.json.sessionId;
    const evP6 = pw.events(sid6, (e) => e.some((x) => x.type === "tool_execution_start"), 20000);
    await sleep(300);
    await pw.api("POST", `/api/agent/${sid6}`, { type: "prompt", message: "long again" });
    await evP6;
    await pw.stop("SIGKILL"); spawnSync("pkill", ["-f", "^sleep 4243$"]); prov.state.mode = "text";
    pw = await startPiWeb(dir, { root });
    await pw.events(sid6, (e) => e.some((x) => x.type === "connected"), 15000);
    const s6 = (await pw.api("GET", `/api/sessions/${sid6}`)).json;
    const e6 = []; const w6 = (n) => { for (const x of n) { e6.push(x.entry); w6(x.children || []); } }; w6(s6.tree || []);
    check("S5", "recently written session file (< 60 s) is left alone by default", e6.filter((e) => e.type === "message" && e.message.role === "toolResult").length === 0, "healed too early");
  }
} finally {
  spawnSync("pkill", ["-f", "^sleep 424[23]$"]);
  await pw.stop(); await prov.close();
  rmSync(pw.root, { recursive: true, force: true });
}
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (${baseline ? "baseline: original defects reproduced" : "patched"})`);
if (outFile) writeFileSync(outFile, JSON.stringify({ mode: baseline ? "baseline" : "patched", pi_web_dir: dir, results }, null, 2));
process.exit(failed.length ? 1 : 0);
