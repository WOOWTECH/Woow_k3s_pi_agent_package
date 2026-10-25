import test from "node:test";
import assert from "node:assert/strict";
import { HINT_SRC, REPLACER_SRC, KINDS, patchSource } from "../patch-error-hints.mjs";

const mk = new Function(HINT_SRC + REPLACER_SRC + "return {__piHint,__piStatus,__piErrReplacer,__piNeedErr};");
const { __piHint: hint, __piStatus: status, __piErrReplacer: replacer, __piNeedErr: needErr } = mk();

test("provider 401/403 become a zh-TW key hint that keeps the original text", () => {
  for (const m of ['401: {"message":"Authentication Error, Invalid proxy server token passed."}', "Error: 403: forbidden", "Incorrect API key provided: sk-...abcd", "Unauthorized"]) {
    const h = hint(m);
    assert.match(h, /^【金鑰無效或沒有權限】/);
    assert.match(h, /「模型」/);
    assert.ok(h.includes(m.slice(0, 20)), "original kept for support");
  }
});

test("empty key / not in enabled scope", () => {
  const h = hint("Model is not available in the enabled scope: qa203/xiaomi/mimo-v2.6-flash");
  assert.match(h, /^【這個模型目前不能使用】/);
  assert.ok(h.includes("qa203/xiaomi/mimo-v2.6-flash"));
});

test("ENOSPC and raw 'No space left on device'", () => {
  for (const m of ["Error: ENOSPC: no space left on device, write", "No space left on device"]) assert.match(hint(m), /^【儲存空間已滿】/);
});

test("compaction messages: small session, already compacted, token cap", () => {
  assert.match(hint("Nothing to compact (session too small)"), /^【不需要壓縮】/);
  assert.match(hint("Compaction failed: Nothing to compact (session too small)"), /^【不需要壓縮】/);
  assert.match(hint("Already compacted"), /^【已經壓縮過】/);
  const cap = hint("Summarization failed: generation hit the token cap and the summary is incomplete");
  assert.match(cap, /^【壓縮失敗】/);
  assert.match(cap, /maxTokens/);
  assert.equal(status("Nothing to compact (session too small)"), 409);
  assert.equal(status("Compaction failed: Already compacted"), 409);
  assert.equal(status("Summarization failed: generation hit the token cap"), 500);
  assert.equal(status("some other failure"), 500);
  assert.equal(status(undefined), 500);
});

test("idempotent, ignores unrelated text and non-strings, truncates long originals", () => {
  const once = hint("401: bad");
  assert.equal(hint(once), once);
  assert.equal(hint("尚未設定模型：請點左下角「模型」"), "尚未設定模型：請點左下角「模型」");
  assert.equal(hint("Directory does not exist: /x"), "Directory does not exist: /x");
  assert.equal(hint(undefined), undefined);
  assert.equal(hint(42), 42);
  const long = hint("401: " + "x".repeat(5000));
  assert.ok(long.length < 900, "original is capped");
});

test("a text that merely mentions 401 later in a sentence is not rewritten", () => {
  assert.equal(hint("Build finished in 401 ms"), "Build finished in 401 ms");
});

test("JSON replacer rewrites only error assistant messages and error events", () => {
  const msg = { role: "assistant", stopReason: "error", errorMessage: "401: x" };
  const ok = { role: "assistant", stopReason: "stop", errorMessage: "401: not an error turn" };
  const out = JSON.parse(JSON.stringify({ a: msg, b: ok, e: { type: "prompt_error", errorMessage: "ENOSPC" }, n: { text: "401: user text" } }, replacer));
  assert.match(out.a.errorMessage, /^【金鑰無效/);
  assert.equal(out.b.errorMessage, "401: not an error turn");
  assert.match(out.e.errorMessage, /^【儲存空間已滿】/);
  assert.equal(out.n.text, "401: user text");
  assert.equal(needErr({ type: "message_end" }), true);
  assert.equal(needErr({ type: "message_update", assistantMessageEvent: { type: "error" } }), true);
  assert.equal(needErr({ type: "message_update", assistantMessageEvent: { type: "text_delta" } }), false);
  assert.equal(needErr({ type: "tool_execution_update" }), false);
});

// ---- anchor discipline ------------------------------------------------------------------------------
const kind = (n) => KINDS.find((k) => k.name === n);

test("every kind: missing or duplicated anchor fails the build, re-applying is a no-op", () => {
  for (const k of KINDS) {
    const good = '"use strict";' + k.edits.map(([o]) => o).join(";") + ";";
    const patched = patchSource(k, good, k.name);
    assert.ok(patched.includes(k.mark), `${k.name} helper inserted`);
    assert.ok(patched.startsWith('"use strict";'), `${k.name} keeps the strict directive first`);
    assert.equal(patchSource(k, patched, k.name), patched, `${k.name} idempotent`);
    for (const [o] of k.edits) {
      assert.throws(() => patchSource(k, good.replace(o, "REMOVED"), k.name), /occurs 0 times/);
      assert.throws(() => patchSource(k, good + o, k.name), /occurs 2 times/);
    }
  }
});

test("path detection matches only the intended files", () => {
  const p = (f) => KINDS.find((k) => k.test.test(f))?.name;
  assert.equal(p("/x/.next/server/app/api/agent/[id]/route.js"), "agent-id");
  assert.equal(p("/x/.next/server/app/api/agent/new/route.js"), "agent-new");
  assert.equal(p("/x/.next/server/app/api/agent/[id]/events/route.js"), "agent-events");
  assert.equal(p("/x/.next/server/app/api/sessions/[id]/route.js"), "sessions-id");
  assert.equal(p("/x/.next/server/app/api/sessions/[id]/context/route.js"), "sessions-context");
  assert.equal(p("/x/.next/server/app/api/models-config/route.js"), "models-config");
  assert.equal(p("/x/.next/server/chunks/6429.js"), "session-chunk");
  assert.equal(p("/x/.next/server/app/api/files/[...path]/route.js"), "files-upload");
  assert.equal(p("/x/.next/server/chunks/1234.js"), "session-chunk");
  assert.equal(p("/x/.next/server/chunks/ssr/session-abc.js"), "session-chunk");
  assert.equal(p("/x/.next/server/app/api/unknown/route.js"), undefined);
  assert.ok(kind("agent-id").edits[0][1].includes("__piStatus"));
});
