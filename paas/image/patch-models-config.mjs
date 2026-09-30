#!/usr/bin/env node
// Build-time patch for pi-web's /api/models-config route (Next.js compiled route.js).
//
// Upstream returns models.json VERBATIM — including every provider's apiKey — to any
// caller that passes the auth-proxy (READINESS.md B3). The browser never needs the
// real value: the Models page only shows it back in an <input>. So:
//   GET  → every providers.*.apiKey (non-empty string) becomes "__PI_REDACTED__:<last4>"
//   POST → any apiKey that still carries that prefix is restored from the on-disk
//          models.json before writing (so a UI save round-trip can never overwrite the
//          key with the mask), or dropped if there is no on-disk value.
// Exact-match discipline (same as upstream's fix-unicode-space-paths.mjs): each anchor
// must occur EXACTLY once, else the build fails loudly — a pi-web upgrade that moves
// the code must be re-inspected, never silently un-patched.
import { readFileSync, writeFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { console.error("usage: patch-models-config.mjs <route.js>"); process.exit(2); }
let src = readFileSync(file, "utf8");

const GET_OLD  = 'async function h(){return e.NextResponse.json((0,f.V6)())}';
const GET_NEW  = 'async function h(){return e.NextResponse.json(__piRedact((0,f.V6)()))}';
const POST_OLD = 'async function i(a){try{let b=await a.json();return(0,f.IX)(b),';
const POST_NEW = 'async function i(a){try{let b=__piRestore(await a.json(),(0,f.V6)());return(0,f.IX)(b),';
const HELPERS =
  'const __PI_MASK="__PI_REDACTED__:";' +
  'function __piRedact(c){try{const o=JSON.parse(JSON.stringify(c));const p=o&&o.providers;' +
  'if(p&&typeof p==="object"){for(const k of Object.keys(p)){const v=p[k]&&p[k].apiKey;' +
  'if(typeof v==="string"&&v.length>0){p[k].apiKey=__PI_MASK+v.slice(-4);}}}return o;}catch{return c;}}' +
  'function __piRestore(n,c){try{const p=n&&n.providers,q=c&&c.providers;' +
  'if(p&&typeof p==="object"){for(const k of Object.keys(p)){const v=p[k]&&p[k].apiKey;' +
  'if(typeof v==="string"&&v.startsWith(__PI_MASK)){if(q&&q[k]&&typeof q[k].apiKey==="string"){p[k].apiKey=q[k].apiKey;}' +
  'else{delete p[k].apiKey;}}}}return n;}catch{return n;}}\n';

function once(hay, needle, what) {
  const n = hay.split(needle).length - 1;
  if (n !== 1) { console.error(`[patch] FAIL: ${what} anchor occurs ${n} times (expected 1) in ${file}`); process.exit(1); }
}
if (src.includes("__PI_REDACTED__")) { console.log("[patch] already applied"); process.exit(0); }
once(src, GET_OLD, "GET"); once(src, POST_OLD, "POST");
src = HELPERS + src.replace(GET_OLD, GET_NEW).replace(POST_OLD, POST_NEW);
writeFileSync(file, src);
console.log(`[patch] models-config: GET redacts providers.*.apiKey, POST restores masked keys (${file})`);
