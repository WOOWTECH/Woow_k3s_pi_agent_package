#!/usr/bin/env node
// Actual baked r3 daemon; no plugin/runtime copy, patch, npm install or model call.
// CI runs this in a disposable uid1000 container with --network none. Only the
// private QA PID receipt is altered for a controlled birth-identity fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { contract } from "../managed-web-contract.mjs";
import { runtimeContract, verifyRuntimeArtifact, hashFile } from "../paseo-runtime-contract.mjs";

assert.equal(process.getuid(), 1000, "native recovery must run as uid1000");
assert.equal(process.platform, "linux");
// The PR patch-layer lacks derivative CLI links. Full overlay/candidate callers
// explicitly opt in to checking those links after the derivative installs them.
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === "--assert-final-clis"));
const assertFinalClis = process.argv[2] === "--assert-final-clis";
const plugin = "/opt/woow/pi-paseo-plugin";
const runtimeDir = "/opt/woow/pi-paseo-runtime";
const runtimeRoot = join(runtimeDir, "releases", runtimeContract.revision);
assert.equal(JSON.parse(fs.readFileSync(join(plugin, "package.json"))).version, contract.paseoVersion);
const beforeArtifact = verifyRuntimeArtifact(runtimeRoot);
const root = fs.mkdtempSync(join(tmpdir(), "pi-paseo-recovery-"));
// Do not inherit operator credentials or alternate provider/config paths.
for (const key of Object.keys(process.env)) if (!["PATH", "LANG", "TZ"].includes(key)) delete process.env[key];
Object.assign(process.env, { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"),
  PI_AGENT_DATA_DIR: join(root, "agent"), PI_PASEO_STATE_DIR: join(root, "state"),
  PI_PASEO_RUNTIME_DIR: runtimeDir, OMNIGENT_CONFIG_HOME: join(root, "home/.omnigent"),
  OMNIGENT_DATA_DIR: join(root, "home/.omnigent"), PI_PASEO_PORT: "27669",
  NEXT_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "1" });
const state = await import(join(plugin, "src/state.mjs"));
const layout = await import(join(plugin, "src/runtime-layout.mjs"));
const runtime = await import(join(plugin, "src/runtime.mjs"));
const identity = await import(join(plugin, "src/daemon-identity.mjs"));
const { seedWebClient } = await import("/usr/local/bin/pi-paseo-web-seed.mjs");
const loc = state.locations();
const recordFile = join(loc.paseoHome, "paseo.pid");
const proofFile = join(loc.stateDir, "daemon-instance.private.json");
const read = file => JSON.parse(fs.readFileSync(file));
const supervisors = () => fs.readdirSync("/proc").filter(name => {
  if (!/^\d+$/.test(name)) return false;
  try {
    return fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0")[0] === "Paseo Supervisor"
      && fs.readFileSync(`/proc/${name}/environ`, "utf8").split("\0").includes(`PASEO_HOME=${loc.paseoHome}`);
  } catch (error) { if (["ENOENT", "ESRCH", "EACCES"].includes(error.code)) return false; throw error; }
}).map(Number);
const procBrief = pid => {
  try {
    const lines = fs.readFileSync(`/proc/${pid}/status`, "utf8").split("\n");
    return Object.fromEntries(lines.filter(line => /^(Name|State|PPid):/.test(line))
      .map(line => line.split(/:\s*/, 2)));
  } catch (error) { return { error: error.code || error.name }; }
};
let phase = "setup";
let observedPid = null;
const reportPhase = next => {
  phase = next;
  console.error(JSON.stringify({ recoveryPhase: phase, init: procBrief(1),
    daemon: observedPid === null ? null : procBrief(observedPid) }));
};
setInterval(() => {
  console.error(JSON.stringify({ recoveryPhase: phase, elapsed: "heartbeat",
    init: procBrief(1), daemon: observedPid === null ? null : procBrief(observedPid),
    supervisors: supervisors().map(procBrief) }));
}, 30000).unref();
const healthy = result => {
  assert.equal(result.daemon.reachable, true);
  assert.equal(result.daemon.owned, true);
  assert.deepEqual(supervisors(), [result.daemon.pid]);
};
const checks = [];
let sentinel;
try {
  for (const folder of [loc.home, loc.agentDir, loc.stateDir]) state.privateDirectory(folder);
  assert.equal(layout.RUNTIME_REVISION, runtimeContract.revision);
  assert.equal(layout.runtimeReady(loc), true, "baked r3 must be ready before activation");
  if (assertFinalClis) for (const name of ["claude", "codex", "pi"])
    fs.accessSync(`/usr/local/bin/${name}`, fs.constants.X_OK);
  assert.equal((await seedWebClient({ bundle: plugin, loc })).ready, true);
  state.updateState({ onboardingSessionId: "isolated-native-recovery-fixture" });
  reportPhase("first-activate");
  const initial = await runtime.activate(); observedPid = initial.daemon.pid; healthy(initial);
  reportPhase("first-active");
  const proof = read(proofFile), original = read(recordFile);
  assert.equal(original.piPaseoProtocol, runtimeContract.protocol);
  assert.equal(proof.lock.pid, initial.daemon.pid);
  assert.deepEqual(proof.process, identity.readLinuxBirth(initial.daemon.pid));
  assert.equal(fs.statSync(proofFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(loc.paseoHome).mode & 0o777, 0o700);
  checks.push("baked-r3-unchanged", "actual-kernel-birth-proof", "private-proof-and-home", "single-supervisor");
  const pair = await runtime.pair(); assert.match(pair.url, /^\/paseo-web\/welcome#offer=/);
  const privateFiles = ["pairing.private.json"].map(name => join(loc.stateDir, name));
  privateFiles.push(join(loc.paseoHome, "server-id"));
  const privateHashes = privateFiles.map(hashFile);
  const installation = state.readState().installationId;
  const authHash = JSON.stringify(read(join(loc.paseoHome, "config.json")).auth);
  reportPhase("first-normal-stop");
  try { await runtime.deactivate(); }
  catch (error) {
    // A failed stop stays a hard failure. Only bounded /proc metadata is printed;
    // this distinguishes a live daemon from an unreaped zombie in CI.
    console.error(JSON.stringify({ phase: "first-normal-stop", code: error.code,
      daemon: procBrief(initial.daemon.pid), init: procBrief(1), supervisors: supervisors().map(procBrief) }));
    throw error;
  }
  reportPhase("first-stopped");
  assert.equal(supervisors().length, 0);
  assert.equal(fs.existsSync(recordFile), false);
  await delay(50); // Ensure a distinct birth tick for the controlled fixture.
  sentinel = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  await once(sentinel, "spawn");
  const birth = identity.readLinuxBirth(sentinel.pid); assert.ok(birth);
  assert.notEqual(birth.startTicks, proof.process.startTicks);
  const controlled = { ...original, pid: sentinel.pid };
  fs.writeFileSync(recordFile, JSON.stringify(controlled), { mode: 0o600 });
  const inode = fs.statSync(recordFile);
  proof.lock.pid = sentinel.pid; proof.pidFile = { dev: inode.dev, ino: inode.ino };
  state.atomicJson(proofFile, proof);
  const oldHash = hashFile(recordFile);
  assert.equal((await runtime.status()).diagnosticCode, "DAEMON_NOT_OWNED");
  assert.equal(hashFile(recordFile), oldHash, "status must not reclaim");
  reportPhase("controlled-recovery");
  const recovered = await runtime.activate(); observedPid = recovered.daemon.pid; healthy(recovered);
  assert.notEqual(recovered.daemon.pid, sentinel.pid);
  assert.deepEqual(identity.readLinuxBirth(sentinel.pid), birth, "foreign sentinel must survive unchanged");
  assert.equal(state.readState().installationId, installation);
  assert.equal(state.readState().onboardingSessionId, "isolated-native-recovery-fixture");
  assert.deepEqual(privateFiles.map(hashFile), privateHashes);
  assert.equal(JSON.stringify(read(join(loc.paseoHome, "config.json")).auth), authHash);
  const quarantine = fs.readdirSync(loc.paseoHome).filter(name => name.startsWith(".paseo.pid.stale-"));
  assert.equal(quarantine.length, 1);
  assert.equal(hashFile(join(loc.paseoHome, quarantine[0])), oldHash);
  const repeat = await runtime.activate(); healthy(repeat); assert.equal(repeat.daemon.pid, recovered.daemon.pid);
  checks.push("status-readonly", "controlled-old-birth-recovery", "foreign-pid-survives", "auth-pairing-installation-preserved", "repeat-activate-same-pid");
  reportPhase("recovery-normal-stop");
  await runtime.deactivate(); assert.equal(supervisors().length, 0);
  // Legacy negative: a foreign record without prior birth proof remains intact.
  fs.rmSync(proofFile); fs.writeFileSync(recordFile, JSON.stringify(controlled), { mode: 0o600 });
  const unprovenHash = hashFile(recordFile);
  await assert.rejects(() => runtime.activate(), { code: "DAEMON_NOT_OWNED" });
  assert.equal(hashFile(recordFile), unprovenHash);
  assert.deepEqual(identity.readLinuxBirth(sentinel.pid), birth);
  assert.equal(supervisors().length, 0);
  assert.equal(fs.readdirSync(loc.paseoHome).filter(name => name.startsWith(".paseo.pid.stale-")).length, 1);
  fs.rmSync(recordFile); // Remove only the synthetic test-owned fixture.
  await runtime.deactivate();
  assert.equal((await runtime.status()).enabled, false);
  assert.equal(supervisors().length, 0);
  checks.push("legacy-unproven-refused", "disabled-remains-stopped");
  const activateCode = `import fs from "node:fs";
    const {activate}=await import(${JSON.stringify(join(plugin, "src/runtime.mjs"))});
    fs.writeSync(2, "PASEO_COLD_START_BEGIN\\n");
    try {
      const s=await activate();
      fs.writeSync(1, "PASEO_COLD_START_RESULT " + JSON.stringify({pid:s.daemon.pid,owned:s.daemon.owned,reachable:s.daemon.reachable}) + "\\n");
    } catch (error) {
      fs.writeSync(2, "PASEO_COLD_START_ERROR " + JSON.stringify({code:error.code || error.name}) + "\\n");
      process.exitCode=1;
    }`;
  const coldStart = async index => {
    // A detached daemon may inherit stdout/stderr. execFile waits for pipe close,
    // even after its direct CLI child exits. Use a private file and wait for exit.
    const capture = join(root, `cold-start-${index}.log`);
    const fd = fs.openSync(capture, "w", 0o600);
    let child;
    try {
      child = spawn(process.execPath, ["--input-type=module", "-e", activateCode],
        { env: process.env, stdio: ["ignore", fd, fd] });
    } finally { fs.closeSync(fd); }
    const startedAt = Date.now();
    let timedOut = false;
    let termTimer, killTimer;
    try {
      const exit = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
        termTimer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
          killTimer.unref();
        }, 180000);
      });
      const output = fs.readFileSync(capture, "utf8");
      const marker = output.split("\n").find(line => line.startsWith("PASEO_COLD_START_RESULT "));
      const errorMarker = output.split("\n").find(line => line.startsWith("PASEO_COLD_START_ERROR "));
      console.error(JSON.stringify({ recoveryPhase: "cold-start-child-exit", index, exit,
        elapsedMs: Date.now() - startedAt, timedOut,
        childBegan: output.includes("PASEO_COLD_START_BEGIN"), resultWritten: !!marker,
        childError: errorMarker?.slice("PASEO_COLD_START_ERROR ".length) || null }));
      assert.equal(timedOut, false, `cold start ${index} timed out`);
      assert.equal(exit.code, 0, `cold start ${index} exited unexpectedly`);
      assert.ok(marker, `cold start ${index} did not return a daemon PID`);
      const value = JSON.parse(marker.slice("PASEO_COLD_START_RESULT ".length));
      assert.equal(value.owned, true); assert.equal(value.reachable, true);
      return value.pid;
    } finally {
      clearTimeout(termTimer); clearTimeout(killTimer);
      fs.rmSync(capture, { force: true });
    }
  };
  reportPhase("two-process-cold-start");
  const outcomes = await Promise.allSettled([coldStart(1), coldStart(2)]);
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  const pids = outcomes.map(outcome => outcome.value);
  observedPid = pids[0];
  assert.equal(pids[0], pids[1]); assert.deepEqual(supervisors(), [pids[0]]);
  healthy(await runtime.status());
  assert.equal(state.readState().installationId, installation);
  assert.deepEqual(privateFiles.map(hashFile), privateHashes);
  reportPhase("cold-start-normal-stop");
  await runtime.deactivate(); assert.equal(supervisors().length, 0);
  checks.push("two-process-cold-start-single-supervisor", "normal-stop-start-preserves-identity");
  assert.deepEqual(verifyRuntimeArtifact(runtimeRoot), beforeArtifact, "activation must not repair an unverified image");
  console.log(JSON.stringify({ passed: true, uid: process.getuid(), pluginVersion: contract.paseoVersion,
    runtime: beforeArtifact, checks, actualKernelPidReuseInduced: false, controlledReceiptFixture: true,
    productCodeModified: false, finalClisChecked: assertFinalClis, modelCalls: 0, pairUrlPrinted: false }));
} finally {
  reportPhase("cleanup");
  try { await runtime.deactivate(); assert.equal(supervisors().length, 0, "owned QA daemon cleanup"); }
  finally {
    if (sentinel && sentinel.exitCode === null) { const ended = once(sentinel, "exit"); sentinel.stdin.end(); await ended; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
