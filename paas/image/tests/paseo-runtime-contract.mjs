import assert from "node:assert/strict";
import { readFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const runtimeContract = JSON.parse(readFileSync(new URL("./paseo-runtime-contract.json", import.meta.url)));
export const pidLockCopies = ["dist/server/server", "dist/src/server"];
export const hashFile = file => createHash("sha256").update(readFileSync(file)).digest("hex");

// Inspect the installed payload before activation can run its idempotent installer.
// Expected hashes come from the released, reviewed r3 artifact, not the image's
// own constants. A stale/unpatched second official module must fail too.
export function verifyRuntimeSnapshot(snapshot) {
  for (const field of ["revision", "lockSha256", "pidLockPatchId"]) {
    assert.equal(snapshot.receipt[field], runtimeContract[field], `runtime receipt ${field}`);
  }
  assert.equal(snapshot.lockSha256, runtimeContract.lockSha256, "runtime lockfile");
  for (const name of ["cli", "server"]) assert.equal(snapshot.versions[name], runtimeContract.officialVersion, name);
  for (const copy of pidLockCopies) {
    for (const [name, expected] of [["pid-lock.js", runtimeContract.pidLockSha256], ["pi-paseo-pid-transition.mjs", runtimeContract.transitionSha256]]) {
      assert.equal(snapshot.files[`${copy}/${name}`], expected, `${copy}/${name} differs from released r3`);
    }
  }
}

export function verifyRuntimeArtifact(root) {
  const json = file => JSON.parse(readFileSync(join(root, file)));
  const receipt = json(".pi-paseo-runtime.json");
  const versions = Object.fromEntries(["cli", "server"].map(name =>
    [name, json(`node_modules/@getpaseo/${name}/package.json`).version]));
  const files = {};
  for (const copy of pidLockCopies) {
    for (const name of ["pid-lock.js", "pi-paseo-pid-transition.mjs"]) {
      const file = join(root, "node_modules/@getpaseo/server", copy, name);
      assert.ok(lstatSync(file).isFile(), `${copy}/${name} must be a regular file`);
      files[`${copy}/${name}`] = hashFile(file);
    }
  }
  verifyRuntimeSnapshot({ receipt, versions, files, lockSha256: hashFile(join(root, "package-lock.json")) });
  return { revision: receipt.revision, pidLockPatchId: receipt.pidLockPatchId, files };
}
