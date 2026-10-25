// Shared helpers for the pi-agent patch e2e (fake OpenAI-compatible provider + a real pi-web server).
// Pure Node >= 22, no dependencies. Used by run.mjs; CI runs it inside the published base image
// (pi-agent/tests/patches.Dockerfile) and developers can run it against any npm-installed pi-web.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function freePort() {
  return await new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

// Fake OpenAI-compatible /v1/chat/completions. `goodKey` is the only accepted bearer token; any
// other token gets a LiteLLM-shaped 401 (the exact shape seen in AI-PI-002).
export async function startProvider({ goodKey = "good-key" } = {}) {
  const seen = [];
  const state = { mode: "text", toolCommand: "sleep 600" };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      seen.push({ url: req.url, auth, ok: auth === goodKey });
      if (auth !== goodKey) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Authentication Error, Invalid proxy server token passed. Received API Key = sk-...wxyz, Unable to find token in cache or `LiteLLM_VerificationTokenTable`", type: "auth_error", param: "None", code: "401" } }));
        return;
      }
      let j = {}; try { j = JSON.parse(body); } catch { /* ignore */ }
      seen[seen.length - 1].messages = Array.isArray(j.messages) ? j.messages.map((m) => m.role) : [];
      const hasToolResult = Array.isArray(j.messages) && j.messages.some((m) => m.role === "tool");
      if (state.mode === "tool" && !hasToolResult) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const c = (delta, fin) => `data: ${JSON.stringify({ id: "c2", object: "chat.completion.chunk", created: 1, model: j.model || "m1", choices: [{ index: 0, delta, finish_reason: fin || null }] })}\n\n`;
        res.write(c({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_orphan_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: state.toolCommand }) } }] }));
        res.write(c({}, "tool_calls"));
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, fin) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: j.model || "m1", choices: [{ index: 0, delta, finish_reason: fin || null }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }));
      res.write(chunk({ content: "PONG-OK" }));
      res.write(chunk({}, "stop"));
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: j.model || "m1", choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  return { port, seen, state, close: () => new Promise((r) => server.close(r)) };
}

export function writeModels(dataDir, providerPort, apiKey, extra = {}) {
  const models = {
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: "openai-completions",
        apiKey,
        models: [{ id: "m1", name: "Fake M1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024, ...extra }],
      },
    },
  };
  writeFileSync(join(dataDir, "models.json"), JSON.stringify(models, null, 2), { mode: 0o600 });
}

// Start `pi-web` from piWebDir (the @agegr/pi-web package directory) with an isolated agent dir.
export async function startPiWeb(piWebDir, { env = {}, root: reuseRoot } = {}) {
  const root = reuseRoot || mkdtempSync(join(tmpdir(), "pi-e2e-"));
  const dataDir = join(root, "data");
  const home = join(dataDir, "home");
  const cwd = join(root, "work");
  for (const d of [dataDir, home, cwd]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  // Never inherit the operator's active Omnigent/Codex/Claude account paths.
  const isolatedEnv = { ...process.env, OMNIGENT_CONFIG_HOME: join(home, ".omnigent"), OMNIGENT_DATA_DIR: join(home, ".omnigent"),
    PI_OMNIGENT_STATE_DIR: join(dataDir, "omnigent-plugin"), CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude") };
  const child = spawn(process.execPath, [join(piWebDir, "bin", "pi-web.js"), "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: home,
    env: { ...isolatedEnv, HOME: home, PI_CODING_AGENT_DIR: dataDir, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", PI_WEB_NO_OPEN: "1", PI_WEB_HOSTNAME: "127.0.0.1", PORT: String(port), NODE_ENV: "production", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group: pi-web.js spawns the Next server as a child, SIGKILL must reach both
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error("pi-web exited early:\n" + log);
    try { const r = await fetch(base + "/api/home", { headers: { host: `127.0.0.1:${port}` } }); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 90000) { child.kill("SIGKILL"); throw new Error("pi-web did not start in 90s:\n" + log); }
    await sleep(500);
  }
  return {
    base, dataDir, home, cwd, port, root, log: () => log,
    async api(method, path, body) {
      const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, json, text, headers: r.headers };
    },
    // Collect SSE events from /api/agent/<id>/events until `until(events)` is true or timeout.
    async events(id, until, timeoutMs = 30000) {
      const ac = new AbortController();
      const events = [];
      const r = await fetch(`${base}/api/agent/${id}/events`, { signal: ac.signal });
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            const m = frame.match(/^data: (.*)$/m); if (m) { try { events.push(JSON.parse(m[1])); } catch { /* ignore */ } }
          }
          if (until(events)) break;
        }
      } catch { /* abort */ } finally { clearTimeout(timer); ac.abort(); }
      return events;
    },
    async stop(sig = "SIGTERM") {
      const kill = (s) => { try { process.kill(-child.pid, s); } catch { /* already gone */ } };
      kill(sig); await sleep(300); kill("SIGKILL"); await sleep(100);
    },
  };
}

// Wait until the session's last assistant message has a final stopReason (stop|error|length|toolUse).
export async function waitIdle(pw, id, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const s = await pw.api("GET", `/api/agent/${id}`);
    if (s.json && s.json.running && s.json.state && !s.json.state.isStreaming && !s.json.state.isPromptRunning) return s.json.state;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(300);
  }
}
