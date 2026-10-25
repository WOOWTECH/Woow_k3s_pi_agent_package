#!/usr/bin/env node
// Build-time patches for pi-web 0.10.0 (compiled Next.js server files) that turn raw English
// provider/storage errors into actionable zh-TW hints, make a saved provider key take effect in
// already-open sessions, and close tool calls that a restart cut off.  Exact-anchor discipline (same
// as patch-models-config.mjs / patch-prompt-errors.mjs): every anchor must occur EXACTLY once or the
// build fails — a pi-web upgrade that moves code must be re-inspected, never silently un-patched.
//
// Findings handled (commercial acceptance 2026-10-16, AI-FIX-PI-3):
//   AI-PI-001-1  POST /api/agent/<id> {type:"compact"} on a small session answered HTTP 500
//                "Nothing to compact (session too small)" (screen: English "Compaction failed ...").
//                Now HTTP 409 + a zh-TW explanation; a token-cap failure says which setting to raise.
//   AI-PI-002-2  A wrong provider key showed the raw "401: {...}" JSON in the conversation, an empty
//                key "Model is not available in the enabled scope: ...".  Both now lead with a zh-TW
//                hint naming the "模型" button; the original text stays after it for support.
//   AI-PI-002-1  (#1461) Saving models-config only wrote the file; sessions already open kept the old
//                provider definition/key until they idled out (>= 600 s, and every retry reset that
//                timer).  PUT /api/models-config now refreshes the model runtime of every open session
//                offline (no network, same call pi-web's own set_model uses).
//   AI-PI-005-3  ENOSPC (full volume) surfaced as raw "Error: ENOSPC: no space left on device, write".
//   AI-PI-005-4  Upload limits were stated inconsistently (nginx 100m, per file 25 MiB, English "25MB",
//                Cloudflare ~100 MB -> intermittent 502/413 page).  Messages are zh-TW with the real numbers; the
//                total limit is 95 MiB so the app answers before Cloudflare does.
//   AI-PI-005-2  A restart during a bash tool call left an assistant tool call without a result: no
//                "interrupted" mark in the UI and the model could not tell what happened.  When a
//                session file is reopened (not alive in this process) and its last entry is a stale
//                assistant tool call, a synthetic error tool result is appended.  Guarded: file idle
//                >= 60 s (PI_WEB_HEAL_MIN_IDLE_MS), last entry only, PI_WEB_HEAL_INTERRUPTED_TOOLS=0 turns it off.
//
// Apply after patch-prompt-errors.mjs (the agent routes' anchors include its __piPromptHint).
//   usage: patch-error-hints.mjs <route.js|chunk.js>...   (kind is detected from the path)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ---- shared helper source (evaluated by tests/patch-error-hints.test.mjs) -------------------------
export const HINT_SRC =
'function __piHint(m){try{if(typeof m!=="string"||m.charAt(0)==="【"||m.indexOf("尚未設定模型")===0)return m;' +
'const o=m.length>400?m.slice(0,400)+"…":m;const w=function(h){return h+"\\n（原文："+o+"）";};' +
'if(/ENOSPC|No space left on device/i.test(m))return w("【儲存空間已滿】這個服務的磁碟已寫滿，無法儲存。請到終端機刪除不需要的檔案或舊對話（例如 du -sh ~/* 找出大檔），或到 PaaS 服務頁擴充容量後再試。");' +
'if(/^(Error:\\s*)?(401|403)\\b/.test(m)||/Authentication Error|Invalid (proxy server )?token|invalid[_ ]api[_ ]key|Incorrect API key|Unauthorized/i.test(m))' +
'return w("【金鑰無效或沒有權限】供應商拒絕了這把 API 金鑰（HTTP 401/403）。請點左下角「模型」，更正該供應商的 API 金鑰並儲存，再重新傳送訊息；若仍失敗請開新對話。");' +
'if(/^Model is not available in the enabled scope/.test(m))return w("【這個模型目前不能使用】找不到可用的 API 金鑰，或該模型已被停用。請點左下角「模型」確認該供應商的 API 金鑰已填入，再重新選擇模型。");' +
'if(/token cap|incomplete/.test(m)&&/^(Compaction failed: )?Summarization failed/.test(m))return w("【壓縮失敗】模型的輸出上限（maxTokens）太小，摘要被截斷。請點左下角「模型」，把該模型的 maxTokens 調高（建議 4096 以上）後再壓縮。");' +
'if(/^(Compaction failed: )?Nothing to compact/.test(m))return w("【不需要壓縮】對話內容還很短（少於保留的最近 20000 token），目前沒有可以壓縮的舊內容。對話變長後再按「壓縮」即可。");' +
'if(/^(Compaction failed: )?Already compacted/.test(m))return w("【已經壓縮過】這段對話剛壓縮完，沒有新的內容需要再壓縮。");' +
'return m;}catch{return m;}}\n' +
'function __piStatus(m){try{return typeof m==="string"&&/^(Compaction failed: )?(Nothing to compact|Already compacted)\\b/.test(m)?409:500;}catch{return 500;}}\n';

export const REPLACER_SRC =
'function __piErrReplacer(k,v){try{if(k==="errorMessage"&&typeof v==="string"&&this&&typeof this==="object"&&' +
'(this.stopReason==="error"||this.type==="prompt_error"||this.type==="auto_retry_start"||this.type==="compaction_end"||this.type==="auto_compaction_end"||this.type==="startup_error"))return __piHint(v);}catch{}return v;}\n' +
'function __piNeedErr(a){try{const t=a&&a.type;return t==="message_end"||t==="turn_end"||t==="agent_end"||t==="prompt_error"||t==="auto_retry_start"||t==="compaction_end"||t==="auto_compaction_end"||t==="startup_error"||(t==="message_update"&&a.assistantMessageEvent&&a.assistantMessageEvent.type==="error");}catch{return false;}}\n';

export const REFRESH_SRC =
'async function __piRefreshSessions(){try{const m=globalThis.__piSessions;if(!m)return;for(const s of Array.from(m.values())){try{' +
'const rt=s&&s.inner&&s.inner.modelRuntime;if(rt&&typeof rt.refresh==="function")await rt.refresh({allowNetwork:false});}catch{}}}catch{}}\n';

export const HEAL_SRC =
'function __piHeal(sm){try{if(process.env.PI_WEB_HEAL_INTERRUPTED_TOOLS==="0")return sm;const es=sm.getEntries();const last=es[es.length-1];' +
'if(!last||last.type!=="message"||!last.message||last.message.role!=="assistant"||last.message.stopReason!=="toolUse")return sm;' +
'const calls=(Array.isArray(last.message.content)?last.message.content:[]).filter(c=>c&&c.type==="toolCall"&&typeof c.id==="string");if(!calls.length)return sm;' +
'const file=sm.getSessionFile&&sm.getSessionFile();const mi=Number(process.env.PI_WEB_HEAL_MIN_IDLE_MS);const minIdle=Number.isFinite(mi)&&mi>=0?mi:60000;' +
'if(file){const st=process.getBuiltinModule("node:fs").statSync(file);if(Date.now()-st.mtimeMs<minIdle)return sm;}' +
'for(const c of calls){sm.appendMessage({role:"toolResult",toolCallId:c.id,toolName:c.name,isError:true,timestamp:Date.now(),' +
'content:[{type:"text",text:"【已中斷】服務在這個工具執行到一半時重新啟動，指令沒有跑完，也沒有取得結果。請確認結果後再決定是否重跑。（interrupted: the service restarted before this tool call finished; no output was captured）"}]});}' +
'}catch(e){try{console.warn("[pi-web] could not close interrupted tool calls:",e&&e.message);}catch{}}return sm;}\n';

// ---- anchors ---------------------------------------------------------------------------------------
const ID_OLD = 'catch(a){return e.NextResponse.json({error:__piPromptHint(a instanceof Error?a.message:String(a)),..."prompt"===c&&!h?{code:"prompt_rejected",accepted:!1}:{}},{status:500})}';
const ID_NEW = 'catch(a){const __m=a instanceof Error?a.message:String(a);return e.NextResponse.json({error:__piHint(__piPromptHint(__m)),..."prompt"===c&&!h?{code:"prompt_rejected",accepted:!1}:{}},{status:__piStatus(__m)})}';
const NEW_OLD = 'catch(a){return e.NextResponse.json({error:__piPromptHint(a instanceof Error?a.message:String(a)),..."prompt"===b&&!c?{code:"prompt_rejected",accepted:!1}:{}},{status:500})}';
const NEW_NEW = 'catch(a){const __m=a instanceof Error?a.message:String(a);return e.NextResponse.json({error:__piHint(__piPromptHint(__m)),..."prompt"===b&&!c?{code:"prompt_rejected",accepted:!1}:{}},{status:__piStatus(__m)})}';
const EV_OLD = "w=(a,b)=>{v(`data: ${JSON.stringify(a)}\n\n`,b)}";
const EV_NEW = "w=(a,b)=>{v(`data: ${JSON.stringify(a,__piNeedErr(a)?__piErrReplacer:void 0)}\n\n`,b)}";
const SESS_OLD = "function d(a,b,c={}){var e;let f,g=JSON.stringify(b),h=Buffer.byteLength(g)>=1024";
const SESS_NEW = "function d(a,b,c={}){var e;let f,g=JSON.stringify(b,__piErrReplacer),h=Buffer.byteLength(g)>=1024";
const CTX_OLD = "return e.NextResponse.json({context:l,tail:m,before:n??null})";
const CTX_NEW = "return e.NextResponse.json(JSON.parse(JSON.stringify({context:l,tail:m,before:n??null},__piErrReplacer)))";
const MC_PUT_OLD = "return(0,f.IX)(b),e.NextResponse.json({success:!0})}";
const MC_PUT_NEW = "return(0,f.IX)(b),await __piRefreshSessions(),e.NextResponse.json({success:!0})}";
const MC_ERR_OLD = "{status:409});return e.NextResponse.json({error:String(a)},{status:500})}}";
const MC_ERR_NEW = "{status:409});return e.NextResponse.json({error:__piHint(String(a))},{status:500})}}";
const HEAL_OLD = 'if(b)f=e.SessionManager.open(b,void 0);else{if(!c)throw Error("cwd is required for a new session");';
const HEAL_NEW = 'if(b)f=__piHeal(e.SessionManager.open(b,void 0));else{if(!c)throw Error("cwd is required for a new session");';

// File upload (POST /api/files/<dir>?type=upload): per file 25 MiB, total 100 MiB, English "25MB"/"100MB".
// The sum limit becomes 95 MiB = 99,614,720 bytes, deliberately below Cloudflare's 100 MB (decimal) request
// cap, so a too-big batch gets THIS message instead of a Cloudflare 502/413 page (AI-PI-005-4).
const UP_TOTAL_MSG = "【上傳總量太大】一次上傳的檔案合計上限 95 MiB（Cloudflare 對單一請求的限制約 100 MB），請分批上傳。（Uploads must total 100MB or less）";
const UP_FILE_MSG = "【檔案太大】每個檔案上限 25 MiB，請壓縮或分開上傳。（Each upload must be 25MB or smaller）";
const UP1_OLD = 'if(a instanceof r.H)return e.NextResponse.json({error:"Uploads must total 100MB or less"},{status:413})';
const UP1_NEW = `if(a instanceof r.H)return e.NextResponse.json({error:${JSON.stringify(UP_TOTAL_MSG)}},{status:413})`;
const UP2_OLD = 'm.some(a=>a.size>0x1900000))return e.NextResponse.json({error:"Each upload must be 25MB or smaller"},{status:413})';
const UP2_NEW = `m.some(a=>a.size>0x1900000))return e.NextResponse.json({error:${JSON.stringify(UP_FILE_MSG)}},{status:413})`;
const UP3_OLD = 'm.reduce((a,b)=>a+b.size,0)>0x6400000)return e.NextResponse.json({error:"Uploads must total 100MB or less"},{status:413})';
const UP3_NEW = `m.reduce((a,b)=>a+b.size,0)>0x5f00000)return e.NextResponse.json({error:${JSON.stringify(UP_TOTAL_MSG)}},{status:413})`;

export const KINDS = [
  { name: "agent-id", test: /\/api\/agent\/\[id\]\/route\.js$/, helpers: HINT_SRC, edits: [[ID_OLD, ID_NEW]], mark: "__piStatus" },
  { name: "agent-new", test: /\/api\/agent\/new\/route\.js$/, helpers: HINT_SRC, edits: [[NEW_OLD, NEW_NEW]], mark: "__piStatus" },
  { name: "agent-events", test: /\/api\/agent\/\[id\]\/events\/route\.js$/, helpers: HINT_SRC + REPLACER_SRC, edits: [[EV_OLD, EV_NEW]], mark: "__piErrReplacer" },
  { name: "sessions-id", test: /\/api\/sessions\/\[id\]\/route\.js$/, helpers: HINT_SRC + REPLACER_SRC, edits: [[SESS_OLD, SESS_NEW]], mark: "__piErrReplacer" },
  { name: "sessions-context", test: /\/api\/sessions\/\[id\]\/context\/route\.js$/, helpers: HINT_SRC + REPLACER_SRC, edits: [[CTX_OLD, CTX_NEW]], mark: "__piErrReplacer" },
  { name: "models-config", test: /\/api\/models-config\/route\.js$/, helpers: HINT_SRC + REFRESH_SRC, edits: [[MC_PUT_OLD, MC_PUT_NEW], [MC_ERR_OLD, MC_ERR_NEW]], mark: "__piRefreshSessions" },
  { name: "files-upload", test: /\/api\/files\/\[\.\.\.path\]\/route\.js$/, helpers: "", edits: [[UP1_OLD, UP1_NEW], [UP2_OLD, UP2_NEW], [UP3_OLD, UP3_NEW]], mark: "【上傳總量太大】" },
  // The chunk name is a compiler detail. The orchestrator discovers it by its
  // unique session-open anchor and still requires exactly one match.
  { name: "session-chunk", test: /\/chunks\/(?:[^/]+\/)*[^/]+\.js$/, helpers: HEAL_SRC, edits: [[HEAL_OLD, HEAL_NEW]], mark: "__piHeal" },
];

const count = (hay, needle) => hay.split(needle).length - 1;

// Pure: returns the patched source or throws.  `already` -> unchanged.
export function patchSource(kind, src, fileLabel = kind.name) {
  if (src.includes(kind.mark)) return src;
  for (const [o] of kind.edits) {
    const n = count(src, o);
    if (n !== 1) throw new Error(`[patch] FAIL: ${kind.name} anchor occurs ${n} times (expected 1) in ${fileLabel}: ${o.slice(0, 70)}...`);
  }
  let out = src;
  for (const [o, n] of kind.edits) out = out.replace(o, () => n);
  // The helpers go on top.  A leading "use strict" directive must stay first, so insert after it.
  const m = out.match(/^(\s*"use strict";)/);
  return m ? m[1] + "\n" + kind.helpers + out.slice(m[1].length) : kind.helpers + out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) { console.error("usage: patch-error-hints.mjs <route.js|chunk.js>..."); process.exit(2); }
  for (const file of files) {
    const kind = KINDS.find((k) => k.test.test(file));
    if (!kind) { console.error(`[patch] FAIL: no patch kind matches ${file}`); process.exit(2); }
    try {
      const src = readFileSync(file, "utf8");
      const out = patchSource(kind, src, file);
      if (out === src) console.log(`[patch] already applied (${kind.name}): ${file}`);
      else { writeFileSync(file, out); console.log(`[patch] error hints (${kind.name}): ${file}`); }
    } catch (e) { console.error(String(e.message || e)); process.exit(1); }
  }
}
