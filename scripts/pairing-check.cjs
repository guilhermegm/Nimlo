'use strict';
// Local, disposable regression tests for Nimlo's pairing/session boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const {spawn} = require('node:child_process');
const WebSocket = require(process.env.NIMLO_WS_MODULE || 'ws');
const binary = path.resolve(process.env.NIMLO_BINARY || 'target/release/nimlo-editor');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-pairing-check-'));
const publicOrigin = 'https://nimlo.fixture.invalid';
const checks = [], peers = [];
let host, origin, rootToken, rootCookie;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await delay(25); }
  throw new Error(label);
}
async function request(route, {remote = false, token, cookie, method = 'GET', body, requestOrigin, rawBody} = {}) {
  const headers = {Host:remote ? new URL(publicOrigin).host : new URL(origin).host};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (cookie) headers.Cookie = cookie;
  if (requestOrigin) headers.Origin = requestOrigin;
  if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = 'application/json';
  const data=rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  if(data!==undefined) headers['Content-Length']=Buffer.byteLength(data);
  return new Promise((resolve,reject) => {
    // fetch may normalize Host to its URL authority; this fixture deliberately
    // uses node:http to exercise a proxy-preserved public Host over loopback.
    const req=http.request(new URL(origin+route),{method,headers},response => {
      let text='';response.on('data',bytes=>{text+=bytes;});response.on('end',()=>{
        let value;try{value=JSON.parse(text);}catch{value=null;}
        const responseHeaders=new Headers();for(const [key,value] of Object.entries(response.headers)) if(value!==undefined) responseHeaders.set(key,Array.isArray(value)?value.join(','):value);
        resolve({status:response.statusCode,value,cookie:response.headers['set-cookie']?.[0].split(';')[0],headers:responseHeaders});
      });
    });req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('HTTP fixture timed out')));req.end(data);
  });
}
async function connect(id, cookie, remote = false) {
  const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/ws?clientId=' + id + '&name=Fixture', {
    headers:{Host:remote ? new URL(publicOrigin).host : new URL(origin).host, Origin:remote ? publicOrigin : origin, Cookie:cookie},
  });
  const peer = {socket, events:[], pending:new Map(), sequence:0, closeCode:null}; peers.push(peer);
  socket.on('message', raw => {
    const value = JSON.parse(raw); peer.events.push(value); if (peer.events.length > 128) peer.events.shift();
    const waiter = peer.pending.get(value.requestId);
    if (waiter) { peer.pending.delete(value.requestId); clearTimeout(waiter.timer); waiter.resolve(value); }
  });
  socket.on('error', () => {});
  socket.on('close', code => {peer.closeCode = code; for (const waiter of peer.pending.values()) {clearTimeout(waiter.timer); waiter.reject(new Error('Session closed'));} peer.pending.clear();});
  await new Promise((resolve,reject) => {socket.once('open', resolve); socket.once('error', reject);});
  await until(() => peer.events.some(value => value.type === 'bootstrap'), 'Missing session bootstrap');
  peer.initial = peer.events.find(value => value.type === 'bootstrap');
  peer.command = (type, fields = {}) => new Promise((resolve,reject) => {
    const requestId = String(++peer.sequence), timer = setTimeout(() => {peer.pending.delete(requestId);reject(new Error('Command timeout: ' + type));}, 8000);
    peer.pending.set(requestId, {resolve,reject,timer}); socket.send(JSON.stringify({type, generation:peer.initial.generation, ...fields, requestId}));
  });
  return peer;
}
async function rejectedUpgrade({remote = false, cookie, token, id = 'rejected-fixture'}, expected) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(origin.replace(/^http/, 'ws') + '/ws?clientId=' + id + (token ? '&token=' + token : ''), {
      headers:{Host:remote ? new URL(publicOrigin).host : new URL(origin).host, Origin:remote ? publicOrigin : origin, ...(cookie ? {Cookie:cookie} : {})},
    });
    const timer = setTimeout(() => {socket.terminate();reject(new Error('Rejected upgrade timed out'));}, 8000);
    socket.on('unexpected-response', (_,response) => {clearTimeout(timer); response.resume();socket.terminate();try {assert.equal(response.statusCode, expected);resolve();} catch(error) {reject(error);}});
    socket.on('open', () => {clearTimeout(timer);socket.terminate();reject(new Error('Unexpected accepted upgrade'));});
    socket.on('error', () => {});
  });
}
async function check(name, run) {await run(); checks.push({name,status:'pass'}); console.log('PASS ' + name);}
async function run() {
  const bin = path.join(fixture,'bin'); fs.mkdirSync(bin); fs.mkdirSync(path.join(fixture,'home'));
  for (const name of ['codex','claude']) fs.writeFileSync(path.join(bin,name), '#!/bin/sh\nexit 1\n', {mode:0o700});
  fs.writeFileSync(path.join(fixture,'note.txt'), 'Original\n');
  host = spawn(binary, ['--workspace',fixture,'--state-dir',path.join(fixture,'state'),'--listen','127.0.0.1:0','--origin',publicOrigin], {
    env:{...process.env, HOME:path.join(fixture,'home'), PATH:bin+path.delimiter+process.env.PATH, SHELL:'/bin/sh'}, stdio:['ignore','pipe','pipe'],
  });
  let output = ''; host.stdout.on('data', bytes => {
    output = (output + bytes).slice(-12000);
    const match = output.match(/(http:\/\/127\.0\.0\.1:\d+)\/#token=([a-f0-9]{64})/);
    if (match) {origin = match[1]; rootToken = match[2];output = '';}
  }); host.stderr.on('data', () => {});
  await until(() => origin, 'Host launch failed');
  await check('query tokens cannot authenticate HTTP or WebSocket', async () => {
    assert.equal((await request('/api/bootstrap?token=' + rootToken)).status, 401);
    await rejectedUpgrade({token:rootToken},401);
  });
  const launch = await request('/api/bootstrap',{token:rootToken}); assert.equal(launch.status,200); rootCookie = launch.cookie;
  const pc = await connect('pairing-desktop',rootCookie);
  await check('private PC credentials cannot authenticate the public authority', async () => {
    assert.equal((await request('/api/bootstrap',{remote:true,token:rootToken})).status,401);
    assert.equal((await request('/api/bootstrap',{remote:true,cookie:'__Host-nimlo_session='+rootToken})).status,401);
    await rejectedUpgrade({remote:true,cookie:'__Host-nimlo_session='+rootToken},401);
  });
  const invitation = () => pc.command('pair_create',{origin:publicOrigin});
  const submit = (invite,code,fields={}) => request('/api/pair',{remote:true,method:'POST',body:{invite,code},requestOrigin:publicOrigin,...fields});
  let first = await invitation();
  await check('missing and foreign Origin cannot consume a valid invitation', async () => {
    assert.equal((await submit(first.invite,first.code,{requestOrigin:null})).status,403);
    assert.equal((await submit(first.invite,first.code,{requestOrigin:'https://foreign.invalid'})).status,403);
  });
  await check('public requests without the invitation cannot burn the code or lock out the phone', async () => {
    for(let i=0;i<24;i++) assert.equal((await submit(i%2 ? 'a'.repeat(64) : undefined, first.code)).status,401);
  });
  await check('an invitation cannot be exchanged through a different accepted origin', async () => {
    assert.equal((await submit(first.invite,first.code,{remote:false,requestOrigin:origin})).status,401);
  });
  let phoneCookie;
  await check('a valid link and code still pair after unrelated failed requests', async () => {
    const response = await submit(first.invite,first.code); assert.equal(response.status,200); phoneCookie=response.cookie;
    const cookie=response.headers.get('set-cookie'); assert.match(cookie,/^__Host-nimlo_session=/);
    for(const attribute of ['Secure','HttpOnly','SameSite=Strict','Path=/']) assert(cookie.includes(attribute)); assert(!cookie.includes('Domain='));
  });
  await check('invitation and code are single use', async () => {assert.equal((await submit(first.invite,first.code)).status,401);});
  await check('paired credentials cannot be replayed through localhost', async () => {
    assert.equal((await request('/api/bootstrap',{cookie:phoneCookie})).status,401);
    const value=phoneCookie.split('=')[1];assert.equal((await request('/api/bootstrap',{cookie:'nimlo_session='+value})).status,401);
    await rejectedUpgrade({cookie:'nimlo_session='+value},401);
  });
  const phone = await connect('pairing-phone',phoneCookie,true);
  const phoneTab = await connect('pairing-phone-tab',phoneCookie,true);
  await check('paired device identity cannot replace the PC connection', async () => {await rejectedUpgrade({remote:true,cookie:phoneCookie,id:'pairing-desktop'},403);});
  await check('every paired device retains full editor and host terminal access', async () => {
    assert.equal(phone.initial.access,'shared'); assert.equal(phone.initial.pickerAvailable,false);
    const opened=await phone.command('open_file',{path:'note.txt'}); assert.equal(opened.type,'file_state');
    const edited=await phone.command('edit_file',{path:'note.txt',baseRevision:opened.file.revision,content:'Paired save\n'}); assert.equal(edited.type,'file_state');
    assert.equal((await phone.command('save_file',{path:'note.txt',revision:edited.file.revision})).type,'file_state');
    assert.equal(fs.readFileSync(path.join(fixture,'note.txt'),'utf8'),'Paired save\n');
    assert.equal((await phone.command('terminal_start')).type,'terminal_state');
    assert.equal((await phone.command('terminal_input',{data:"printf paired > pairing-proof.txt\r"})).type,'ack');
    await until(() => {try {return fs.readFileSync(path.join(fixture,'pairing-proof.txt'),'utf8')==='paired';} catch {return false;}}, 'Paired shell did not run');
    assert.equal(fs.readFileSync(path.join(fixture,'pairing-proof.txt'),'utf8'),'paired');
  });
  await check('five wrong codes bound to a known invitation invalidate that invitation', async () => {
    const value=await invitation(), wrong=value.code==='000000'?'111111':'000000';
    for(let i=0;i<5;i++) assert.equal((await submit(value.invite,wrong)).status,401);
    assert.equal((await submit(value.invite,value.code)).status,401);
  });
  let otherCookie, other;
  await check('rotation invalidates the previous link without burning its replacement', async () => {
    const old=await invitation(), fresh=await invitation();assert.notEqual(old.invite,fresh.invite);
    assert.equal((await submit(old.invite,old.code)).status,401);
    const response=await submit(fresh.invite,fresh.code);assert.equal(response.status,200);otherCookie=response.cookie;
    other=await connect('pairing-other-phone',otherCookie,true);
  });
  const pending = await invitation();
  await check('device revocation closes all tabs using its credential with policy close code', async () => {
    assert.equal((await pc.command('revoke_device',{targetClientId:'pairing-phone'})).type,'ack');
    const opened=await pc.command('open_file',{path:'note.txt'});
    const sentinel='Post-revocation document';
    const changed=await pc.command('edit_file',{path:'note.txt',baseRevision:opened.file.revision,content:sentinel}); assert.equal(changed.type,'file_state');
    assert.equal((await request('/api/bootstrap',{remote:true,cookie:phoneCookie})).status,401);
    await until(() => phone.closeCode!==null && phoneTab.closeCode!==null,'Revoked sockets did not close');
    assert.equal(phone.closeCode,1008); assert.equal(phoneTab.closeCode,1008);
    assert(!phone.events.some(event=>event.file?.content===sentinel)); assert(!phoneTab.events.some(event=>event.file?.content===sentinel));
    assert.equal((await request('/api/bootstrap',{remote:true,cookie:phoneCookie})).status,401);
    await rejectedUpgrade({remote:true,cookie:phoneCookie,id:'pairing-phone'},401);
  });
  await check('revocation also cancels any outstanding invitation', async () => {assert.equal((await submit(pending.invite,pending.code)).status,401);});
  await check('revocation preserves other devices and the running host shell', async () => {
    assert.equal((await other.command('ping')).type,'pong');assert.equal((await pc.command('ping')).type,'pong');
    assert.equal((await request('/api/bootstrap',{cookie:rootCookie})).value.terminal.running,true);
  });
  await check('a revoked browser can pair again with the same client identifier', async () => {
    const value=await invitation(), response=await submit(value.invite,value.code);assert.equal(response.status,200);
    const rejoined=await connect('pairing-phone',response.cookie,true);assert.equal(rejoined.initial.access,'shared');
  });
  await check('paired device can sign itself out without ending the PC session', async () => {
    await other.command('revoke_device',{targetClientId:'pairing-other-phone'}).catch(()=>{});
    await until(() => other.closeCode!==null,'Self logout did not close the socket');assert.equal(other.closeCode,1008);
    assert.equal((await request('/api/bootstrap',{remote:true,cookie:otherCookie})).status,401);
    assert.equal((await pc.command('ping')).type,'pong');
  });
  await check('revoke all closes paired devices and leaves the host usable', async () => {
    assert.equal((await pc.command('revoke_all_devices')).type,'ack');
    await until(() => peers.filter(peer=>peer!==pc).every(peer=>peer.closeCode!==null),'A paired device survived revoke-all');
    assert.equal((await pc.command('ping')).type,'pong');assert.equal((await request('/api/bootstrap',{cookie:rootCookie})).value.terminal.running,true);
    assert.equal((await pc.command('revoke_device',{targetClientId:'pairing-desktop'})).code,'host_session');
  });
  await check('pairing request bodies are bounded and errors carry browser protection headers', async () => {
    const oversized=await request('/api/pair',{remote:true,method:'POST',requestOrigin:publicOrigin,rawBody:JSON.stringify({code:'123456',invite:'x'.repeat(5000)})});
    assert.equal(oversized.status,413);assert.equal(oversized.headers.get('cache-control'),'no-store');
    const unauth=await request('/api/bootstrap',{remote:true});assert.equal(unauth.status,401);assert.equal(unauth.headers.get('x-frame-options'),'DENY');
    assert.match(unauth.headers.get('strict-transport-security'),/max-age=/);assert.match(unauth.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  });
  const report={buildSha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),checks,passed:checks.length,failed:0,fixtureOnly:true,aiInferenceRequests:0};
  fs.writeFileSync('tests/pairing.json',JSON.stringify(report,null,2)+'\n');
}
run().catch(error => {console.error(String(error.stack||error).replace(/[a-f0-9]{64}/g,'[private]'));process.exitCode=1;}).finally(async () => {
  for(const peer of peers) peer.socket.terminate();
  if(host && host.exitCode===null) {host.kill('SIGINT');await Promise.race([new Promise(resolve=>host.once('exit',resolve)),delay(3000)]);if(host.exitCode===null) host.kill('SIGKILL');}
  fs.rmSync(fixture,{recursive:true,force:true});
});
