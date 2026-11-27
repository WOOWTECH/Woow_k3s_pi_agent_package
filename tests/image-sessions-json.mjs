import { verifySessionsHttpJson } from './sessions-http-json-acceptance.mjs';

const result = await verifySessionsHttpJson({
  baseUrl: process.env.SESSIONS_HTTP_BASE_URL ?? 'http://127.0.0.1:30141',
  agentDir: process.env.PI_CODING_AGENT_DIR ?? '/data/pi-agent',
  piWebRoot: process.env.PI_WEB_ROOT ?? '/usr/local/lib/node_modules/@agegr/pi-web',
});
console.log(JSON.stringify({ schema: 'k3s-sessions-http-json-acceptance/v1', passed: true, ...result }));
