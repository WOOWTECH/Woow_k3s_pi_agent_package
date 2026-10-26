import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionChunks, jsonResponseModules } from "../patch-pi-web.mjs";
import { KINDS, patchSource } from "../patch-error-hints.mjs";
import { patch as privacy } from "../patch-models-config.mjs";
import { patch as prompt } from "../patch-prompt-errors.mjs";

test("all session chunks are discovered by content, including instrumentation, nested chunks and reruns", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-overlay-"));
  const kind = KINDS.find((k) => k.name === "session-chunk");
  try {
    mkdirSync(join(root, "chunks", "ssr"), { recursive: true });
    writeFileSync(join(root, "chunks", "6429.js"), "unrelated old chunk");
    assert.throws(() => sessionChunks(root), /0 files/);
    const file = join(root, "chunks", "ssr", "session-new-hash.js");
    writeFileSync(file, kind.edits[0][0]);
    assert.deepEqual(sessionChunks(root), [file]);
    writeFileSync(file, patchSource(kind, kind.edits[0][0]));
    assert.deepEqual(sessionChunks(root), [file]);
    // Next emits the same session module for API routes and instrumentation.
    // Both copies need healing; an arbitrary first-file choice misses one path.
    const instrumentation = join(root, "chunks", "instrumentation.js");
    writeFileSync(instrumentation, kind.edits[0][0]);
    assert.deepEqual(sessionChunks(root), [instrumentation, file]);
    writeFileSync(instrumentation, patchSource(kind, kind.edits[0][0]));
    assert.deepEqual(sessionChunks(root), [instrumentation, file]);
    writeFileSync(instrumentation, kind.edits[0][0] + kind.edits[0][0]);
    assert.throws(() => sessionChunks(root), /2 times.*expected 1/);
    writeFileSync(instrumentation, kind.edits[0][0] + kind.edits[0][1]);
    assert.throws(() => sessionChunks(root), /2 times.*expected 1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("privacy and prompt preflight reject moved/duplicate anchors and are repeatable", () => {
  const config = 'async function h(){try{return e.NextResponse.json((0,f.V6)())}catch{}}async function i(a){try{let b=await a.json();return(0,f.IX)(b),0}catch{}}';
  const agent = 'catch(a){return e.NextResponse.json({error:a instanceof Error?a.message:String(a),..."prompt"===';
  for (const [patch, source] of [[privacy, config], [prompt, agent]]) {
    assert.throws(() => patch("unknown"), /0 times/);
    assert.throws(() => patch(source + source), /2 times/);
    const result = patch(source);
    assert.equal(patch(result), result);
  }
});

test("JSON response copies cannot leave an unpatched list-route module in Next's shared cache", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-json-overlay-"));
  const kind = KINDS.find((k) => k.name === "sessions-id");
  try {
    mkdirSync(join(root, "app/api/sessions/[id]"), { recursive: true });
    mkdirSync(join(root, "chunks"));
    const detail = join(root, "app/api/sessions/[id]/route.js");
    const list = join(root, "app/api/sessions/route.js");
    const chunk = join(root, "chunks/renamed-json-response.js");
    assert.throws(() => jsonResponseModules(root), /0 files/);
    for (const file of [detail, list, chunk]) writeFileSync(file, kind.edits[0][0]);
    assert.deepEqual(jsonResponseModules(root), [detail, list, chunk].sort());
    for (const file of [detail, list, chunk]) writeFileSync(file, patchSource(kind, kind.edits[0][0]));
    assert.deepEqual(jsonResponseModules(root), [detail, list, chunk].sort());
    writeFileSync(chunk, kind.edits[0].join(";"));
    assert.throws(() => jsonResponseModules(root), /2 times/);
    writeFileSync(chunk, kind.edits[0][0]);
    writeFileSync(detail, "unknown upstream shape");
    assert.throws(() => jsonResponseModules(root), /detail.*anchor changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
