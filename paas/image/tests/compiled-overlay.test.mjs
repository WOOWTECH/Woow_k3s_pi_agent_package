import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionChunk } from "../patch-pi-web.mjs";
import { KINDS, patchSource } from "../patch-error-hints.mjs";
import { patch as privacy } from "../patch-models-config.mjs";
import { patch as prompt } from "../patch-prompt-errors.mjs";

test("session chunk is discovered by content, including renamed/nested chunks and reruns", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-overlay-"));
  const kind = KINDS.find((k) => k.name === "session-chunk");
  try {
    mkdirSync(join(root, "chunks", "ssr"), { recursive: true });
    writeFileSync(join(root, "chunks", "6429.js"), "unrelated old chunk");
    assert.throws(() => sessionChunk(root), /0 files/);
    const file = join(root, "chunks", "ssr", "session-new-hash.js");
    writeFileSync(file, kind.edits[0][0]);
    assert.equal(sessionChunk(root), file);
    writeFileSync(file, patchSource(kind, kind.edits[0][0]));
    assert.equal(sessionChunk(root), file);
    writeFileSync(join(root, "chunks", "duplicate.js"), kind.edits[0][0]);
    assert.throws(() => sessionChunk(root), /2 files/);
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
