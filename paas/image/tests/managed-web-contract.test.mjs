import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contract, verifyWebManifest, verifyCompiledRoute } from "./managed-web-contract.mjs";

test("managed candidate rejects old plugins, different web artifact, and missing repair provenance", () => {
  const pkg = { name: "@woowtech/pi-paseo", version: contract.paseoVersion };
  verifyWebManifest(pkg, contract.webClient);
  assert.throws(() => verifyWebManifest({ ...pkg, version: "0.1.7" }, contract.webClient));
  for (const key of Object.keys(contract.webClient)) {
    assert.throws(() => verifyWebManifest(pkg, { ...contract.webClient, [key]: "unexpected" }), new RegExp(key));
  }
});

test("a source file or manifest entry alone cannot stand in for the compiled production route", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-managed-contract-"));
  try {
    const server = join(root, ".next/server");
    mkdirSync(server, { recursive: true });
    const manifest = join(server, "app-paths-manifest.json");
    writeFileSync(manifest, "{}");
    assert.throws(() => verifyCompiledRoute(root), /production route/);
    writeFileSync(manifest, JSON.stringify({ "/paseo-web/[[...path]]/route": "app/paseo-web/[[...path]]/route.js" }));
    assert.throws(() => verifyCompiledRoute(root), /ENOENT/);
    mkdirSync(join(server, "app/paseo-web/[[...path]]"), { recursive: true });
    writeFileSync(join(server, "app/paseo-web/[[...path]]/route.js"), "module.exports={}");
    verifyCompiledRoute(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
