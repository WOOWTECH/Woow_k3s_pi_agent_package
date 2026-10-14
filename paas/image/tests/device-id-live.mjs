// Run inside the image: exercises the real SDK and durable agent directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {patch} from '../patch-chatgpt-device-id.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-device-id-'));
try {
 const module=path.join(dir,'identity.mjs');
 const source=patch('await d.login(c,"oauth",{signal:j.signal}),(0,f.kn)()');
 fs.writeFileSync(module,source.slice(0,source.indexOf('\n'))+'\nconsole.log(await __piChatGPTDeviceId());');
 fs.symlinkSync('/usr/local/lib/node_modules/@agegr/pi-web/node_modules',path.join(dir,'node_modules'),'dir');
 const env={...process.env,PI_CODING_AGENT_DIR:path.join(dir,'agent')};
 const run=()=>{const r=spawnSync(process.execPath,[module],{env,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();};
 const a=run(),b=run();if(a!==b||!/[a-f0-9-]{36}/i.test(a))throw Error('identity must be durable UUID');
 console.log('PASS: actual SDK creates one persistent UUID across process restarts');
}finally{fs.rmSync(dir,{recursive:true,force:true});}

// Exercise the actual OAuth provider, stop at the authorization URL. No account
// login, token exchange, browser approval or remote model request occurs.
const {openaiChatGPTOAuth}=await import('/usr/local/lib/node_modules/@agegr/pi-web/node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js');
const controller=new AbortController();let missing=false;
try{await openaiChatGPTOAuth.login({signal:controller.signal,notify(){},prompt:async()=>''});}catch(e){missing=e.message.includes('requires a device ID');}
if(!missing)throw Error('expected original missing-device error');
const id='12345678-1234-4234-8234-123456789abc';let authorization=false;
try{await openaiChatGPTOAuth.login({signal:controller.signal,notify(event){if(event.type==='auth_url'){const url=new URL(event.url);authorization=url.searchParams.get('ext_agent_host_id')==='urn:uuid:'+id;controller.abort();}},prompt:async()=>{throw Error('test stops before account approval');}},{getDeviceId:()=>id});}catch{}
if(!authorization)throw Error('OAuth did not reach authorization with installation UUID');
console.log('PASS: missing callback reproduced; actual OAuth reaches authorization when callback supplied');
