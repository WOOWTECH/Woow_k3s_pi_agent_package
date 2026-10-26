import test from "node:test";
import assert from "node:assert/strict";
import { runtimeContract as expected, pidLockCopies, verifyRuntimeSnapshot } from "./paseo-runtime-contract.mjs";

const fixture = () => ({ receipt: { revision: expected.revision, lockSha256: expected.lockSha256, pidLockPatchId: expected.pidLockPatchId },
  versions: { cli: "0.11.2", server: "0.11.2" }, lockSha256: expected.lockSha256,
  files: Object.fromEntries(pidLockCopies.flatMap(copy => [[`${copy}/pid-lock.js`, expected.pidLockSha256],
    [`${copy}/pi-paseo-pid-transition.mjs`, expected.transitionSha256]])) });

test("r3 provenance rejects legacy or incomplete readiness and changed lockfile", () => {
  verifyRuntimeSnapshot(fixture());
  for (const field of ["revision", "lockSha256", "pidLockPatchId"]) {
    const input = fixture(); delete input.receipt[field];
    assert.throws(() => verifyRuntimeSnapshot(input), new RegExp(field));
  }
  const old = fixture(); old.receipt.revision = "0.11.2-r2-6d8dbe515479";
  assert.throws(() => verifyRuntimeSnapshot(old), /revision/);
  const lock = fixture(); lock.lockSha256 = "0".repeat(64);
  assert.throws(() => verifyRuntimeSnapshot(lock), /lockfile/);
});

test("both official PID writers and transition helpers must match the reviewed release", () => {
  for (const file of Object.keys(fixture().files)) {
    for (const replacement of [undefined, "0".repeat(64)]) {
      const input = fixture(); input.files[file] = replacement;
      assert.throws(() => verifyRuntimeSnapshot(input), /differs from released r3/);
    }
  }
});

test("the receipt alone cannot authorize a different installed official CLI or server", () => {
  for (const name of ["cli", "server"]) {
    const input = fixture(); input.versions[name] = "0.11.1";
    assert.throws(() => verifyRuntimeSnapshot(input), new RegExp(name));
  }
});
