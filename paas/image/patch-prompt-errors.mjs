#!/usr/bin/env node
// Build-time patch for pi-web's /api/agent/new and /api/agent/[id] routes (Next.js compiled route.js).
//
// A fresh PaaS pi-agent has no model and no provider key. Sending a message then fails in
// pi with "No API key found for the selected model." (or "No model selected." /
// "No models available.") followed by "Use /login …" and two absolute paths into
// node_modules. pi-web shows that text in a 5-second toast: English, pointing at a TUI
// slash command and at files the tenant cannot open. Issue #1357: tenants read it as
// "the service does nothing".
//
// The patch keeps the response shape (status 500, code "prompt_rejected", accepted:false,
// so pi-web still restores the draft) and only rewrites the `error` text of those three
// pi messages into a zh-TW hint that names the pi-web UI ("模型" in the bottom-left), with
// the first English line kept for support. Any other error passes through unchanged.
// Exact-match discipline (same as patch-models-config.mjs): the anchor must occur EXACTLY
// once per file, else the build fails — a pi-web upgrade that moves the code must be
// re-inspected, never silently un-patched.
import { readFileSync, writeFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) { console.error("usage: patch-prompt-errors.mjs <route.js>..."); process.exit(2); }

const OLD = 'catch(a){return e.NextResponse.json({error:a instanceof Error?a.message:String(a),..."prompt"===';
const NEW = 'catch(a){return e.NextResponse.json({error:__piPromptHint(a instanceof Error?a.message:String(a)),..."prompt"===';
const HINT = "尚未設定模型：請點左下角「模型」，登入供應商（OAuth）或填入 API 金鑰，" +
  "再到輸入框下方選擇模型後重新傳送。";
const HELPER =
  'function __piPromptHint(m){try{if(typeof m!=="string")return m;' +
  'const f=m.split("\\n")[0].trim();' +
  'if(/^No API key found for /.test(f)||/^No model selected\\b/.test(f)||/^No models available\\b/.test(f))' +
  `{return ${JSON.stringify(HINT)}+"（"+f+"）";}return m;}catch{return m;}}\n`;

for (const file of files) {
  let src = readFileSync(file, "utf8");
  if (src.includes("__piPromptHint")) { console.log(`[patch] already applied: ${file}`); continue; }
  const n = src.split(OLD).length - 1;
  if (n !== 1) { console.error(`[patch] FAIL: prompt-error anchor occurs ${n} times (expected 1) in ${file}`); process.exit(1); }
  src = HELPER + src.replace(OLD, NEW);
  writeFileSync(file, src);
  console.log(`[patch] prompt errors: no-model/no-key messages become a zh-TW hint (${file})`);
}
