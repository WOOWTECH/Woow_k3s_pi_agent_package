#!/usr/bin/env node
// One overlay entry point for both PR and release builds. Preflight the entire
// compiled tree before writing; an upstream layout change must fail closed.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { patch as privacy } from "./patch-models-config.mjs";
import { patch as prompt } from "./patch-prompt-errors.mjs";
import { patch as oauth } from "./patch-chatgpt-device-id.mjs";
import { KINDS, patchSource } from "./patch-error-hints.mjs";

const ROUTES = [
  "api/models-config", "api/agent/new", "api/agent/[id]",
  "api/agent/[id]/events", "api/sessions/[id]", "api/sessions/[id]/context",
  "api/files/[...path]", "api/auth/login/[provider]",
];

function* javascriptFiles(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, ent.name);
    if (ent.isDirectory()) yield* javascriptFiles(file);
    else if (ent.isFile() && ent.name.endsWith(".js")) yield file;
  }
}

export function sessionChunk(serverDir) {
  const kind = KINDS.find((k) => k.name === "session-chunk");
  const matches = [...javascriptFiles(join(serverDir, "chunks"))].filter((file) => {
    const source = readFileSync(file, "utf8");
    return kind.edits[0].some((anchor) => source.includes(anchor));
  });
  if (matches.length !== 1) throw new Error(`session chunk anchor found in ${matches.length} files (expected 1)`);
  return matches[0];
}

export function planPatches(packageDir) {
  const serverDir = join(resolve(packageDir), ".next/server");
  const files = ROUTES.map((route) => join(serverDir, "app", route, "route.js"));
  files.push(sessionChunk(serverDir));
  return files.map((file) => {
    const original = readFileSync(file, "utf8");
    let source = original;
    if (file.endsWith("/api/models-config/route.js")) source = privacy(source);
    if (/\/api\/agent\/(?:new|\[id\])\/route.js$/.test(file)) source = prompt(source);
    const kind = KINDS.find((k) => k.test.test(file));
    if (kind) source = patchSource(kind, source, file);
    if (file.endsWith("/api/auth/login/[provider]/route.js")) source = oauth(source);
    const syntax = spawnSync(process.execPath, ["--check"], { input: source, encoding: "utf8" });
    if (syntax.status !== 0) throw new Error(`invalid patched JavaScript in ${file}: ${syntax.stderr || syntax.error}`);
    return { file, original, source };
  });
}

export function applyPatches(packageDir) {
  const plan = planPatches(packageDir);
  for (const { file, source, original } of plan) {
    if (source !== original) writeFileSync(file, source);
  }
  return plan.map(({ file }) => file);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: patch-pi-web.mjs <pi-web package directory>");
  for (const file of applyPatches(process.argv[2])) console.log(`[patch] verified ${file}`);
}
