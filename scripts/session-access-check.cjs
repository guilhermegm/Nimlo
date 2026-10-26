#!/usr/bin/env node
'use strict';
// Exercise the embedded release host and real browser UI in a disposable local
// workspace. Providers only answer authentication checks; no inference runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const {spawn} = require('node:child_process');
const WebSocket = require(process.env.NIMLO_WS_MODULE || path.resolve(__dirname, '../../mini_gym/node_modules/ws'));
const playwright = require(process.env.PLAYWRIGHT_PATH || path.resolve(__dirname, '../../mini_gym/node_modules/playwright'));
const engine = process.env.NIMLO_BROWSER || 'chromium';
assert(['chromium', 'webkit'].includes(engine));
const repo = path.resolve(__dirname, '..');
const binary = path.resolve(repo, process.env.NIMLO_BINARY || 'target/release/nimlo-editor');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-session-access-')));
const workspace = path.join(fixture, 'workspace');
const stateDir = path.join(fixture, 'state');
const bin = path.join(fixture, 'bin');
const home = path.join(fixture, 'home');
const providerLog = path.join(fixture, 'provider-invocations.txt');
const out = path.join(repo, 'tests', 'session-access-' + engine);
const FULL = {editFiles:true, terminal:true, ai:true};
const NONE = {editFiles:false, terminal:false, ai:false};
const PASSWORD = 'fixture password 7!';
const checks = [], errors = [], contexts = [], peers = [];
let host, browser, origin, rootToken, rootCookie, pc, pcPage, phonePage;
let stage = 'startup';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {if (await fn()) return; await delay(25);}
  throw new Error(label);
}
async function check(name, run) {stage=name; await run(); checks.push(name); console.log('PASS ' + name);}
function sanitized(value) {
  return String(value).replace(/[a-f0-9]{64}/gi, '[private]').replaceAll(PASSWORD, '[password]');
}
async function request(route, {cookie, token, method='GET', body, requestOrigin} = {}) {
  const headers = {Host:new URL(origin).host};
  if (cookie) headers.Cookie=cookie;
  if (token) headers.Authorization='Bearer ' + token;
  if (requestOrigin) headers.Origin=requestOrigin;
  const data = body === undefined ? undefined : JSON.stringify(body);
  if (data !== undefined) {headers['Content-Type']='application/json'; headers['Content-Length']=Buffer.byteLength(data);}
  return new Promise((resolve, reject) => {
    const req=http.request(new URL(route, origin), {method, headers}, response => {
      let raw=''; response.on('data', bytes => {raw+=bytes;}); response.on('end', () => {
        let value; try {value=JSON.parse(raw);} catch {value=null;}
        resolve({status:response.statusCode, value, cookie:response.headers['set-cookie']?.[0].split(';')[0]});
      });
    });
    req.on('error', reject); req.setTimeout(12000, () => req.destroy(new Error('HTTP fixture timed out'))); req.end(data);
  });
}
async function stopHost() {
  if (!host || host.exitCode !== null) return;
  const process = host; const exited = new Promise(resolve => process.once('exit', resolve));
  process.kill('SIGINT'); await Promise.race([exited, delay(3000)]);
  if (process.exitCode === null) {process.kill('SIGKILL'); await Promise.race([exited, delay(2000)]);}
}
async function startHost() {
  origin=null; rootToken=null; rootCookie=null;
  const env={...process.env, HOME:home, PATH:bin + path.delimiter + process.env.PATH, SHELL:'/bin/sh', NIMLO_FIXTURE_PROVIDER_LOG:providerLog};
  delete env.ENV; delete env.BASH_ENV;
  host=spawn(binary, ['--workspace', workspace, '--state-dir', stateDir, '--listen', '127.0.0.1:0'], {env, stdio:['ignore','pipe','pipe']});
  let output='', stderr='';
  host.stdout.on('data', bytes => {
    output=(output+bytes).slice(-12000); const match=output.match(/(http:\/\/127\.0\.0\.1:\d+)\/#token=([a-f0-9]{64})/);
    if (match) {origin=match[1]; rootToken=match[2]; output='';}
  });
  host.stderr.on('data', bytes => {stderr=(stderr+bytes).slice(-2000);});
  await until(() => {if (host.exitCode !== null) throw new Error('Fixture host exited: ' + sanitized(stderr)); return origin;}, 'Host launch failed');
  const launch=await request('/api/bootstrap', {token:rootToken}); assert.equal(launch.status, 200); rootCookie=launch.cookie;
}
async function connect(id, cookie) {
  const socket=new WebSocket(origin.replace(/^http/, 'ws') + '/ws?clientId=' + id + '&name=Access%20fixture', {headers:{Origin:origin, Cookie:cookie}});
  const peer={socket, events:[], pending:new Map(), sequence:0, closeCode:null, initial:null}; peers.push(peer);
  socket.on('message', raw => {
    const value=JSON.parse(raw); peer.events.push(value); if (peer.events.length > 160) peer.events.shift();
    if (value.type === 'bootstrap') peer.initial=value;
    const waiter=peer.pending.get(value.requestId);
    if (waiter) {peer.pending.delete(value.requestId); clearTimeout(waiter.timer); waiter.resolve(value);}
  });
  socket.on('error', () => {});
  socket.on('close', code => {
    peer.closeCode=code;
    for (const waiter of peer.pending.values()) {clearTimeout(waiter.timer); waiter.reject(new Error('Fixture session closed'));}
    peer.pending.clear();
  });
  await new Promise((resolve, reject) => {socket.once('open', resolve); socket.once('error', reject);});
  await until(() => peer.initial, 'Missing bootstrap for ' + id);
  peer.command=(type, fields={}) => new Promise((resolve, reject) => {
    const requestId=String(++peer.sequence), timer=setTimeout(() => {peer.pending.delete(requestId); reject(new Error('Command timeout: ' + type));}, 12000);
    peer.pending.set(requestId, {resolve,reject,timer});
    socket.send(JSON.stringify({type, generation:peer.initial.generation, projectId:peer.initial.projectId, ...fields, requestId}));
  });
  return peer;
}
async function newPage(options={}, cookie=null) {
  const context=await browser.newContext(options); contexts.push(context);
  if (cookie) {const index=cookie.indexOf('='); await context.addCookies([{name:cookie.slice(0,index), value:cookie.slice(index+1), url:origin, httpOnly:true, sameSite:'Strict'}]);}
  const page=await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(sanitized(error.message)));
  return page;
}
async function connected(page) {await page.waitForFunction(() => document.getElementById('app').dataset.connected === 'yes' && !document.getElementById('join-dialog').open);}
async function openSession(page) {
  if (await page.locator('#session-menu').isHidden()) await page.click('#connection-state');
  await page.locator('#session-menu').waitFor({state:'visible'});
}
async function openAccess(page) {await openSession(page); await page.click('#session-permissions'); await page.locator('#session-access-dialog').waitFor({state:'visible'});}
async function saveAccess(page, permissions, {allowDevices=true, password}={}) {
  await openAccess(page); await page.locator('#access-allow-devices').setChecked(allowDevices);
  for (const [key,id] of [['editFiles','access-edit-files'],['terminal','access-terminal'],['ai','access-ai']]) await page.locator('#'+id).setChecked(permissions[key]);
  if (password !== undefined) await page.fill('#access-password', password);
  await page.click('#session-access-submit'); await page.locator('#session-access-dialog').waitFor({state:'hidden'});
}
async function setPolicy(permissions, {allowDevices=true, password=null}={}) {
  const result=await pc.command('session_access_set', {settings:{allowDevices,permissions}, password}); assert.notEqual(result.type, 'error', result.message);
  return result;
}
const invitation=() => pc.command('pair_create', {origin});
const submit=(value, password, code=value.code) => request('/api/pair', {method:'POST', requestOrigin:origin, body:{invite:value.invite, code, ...(password === undefined ? {} : {password})}});
async function pairDevice(id, password) {
  const value=await invitation(); assert.equal(value.type, 'pairing'); const response=await submit(value, password); assert.equal(response.status, 200, response.value?.message);
  return {peer:await connect(id, response.cookie), cookie:response.cookie};
}
function effective(peer) {
  return [...peer.events].reverse().find(event => event.permissions)?.permissions;
}
async function expectPermissions(peer, permissions) {
  await until(() => Object.keys(permissions).every(key => effective(peer)?.[key] === permissions[key]), 'Effective device permissions did not update: '+JSON.stringify({current:effective(peer),expected:permissions,closeCode:peer.closeCode}));
}
async function denied(peer, type, fields={}) {
  const response=await peer.command(type, fields); assert.equal(response.type, 'error', 'Restricted command was accepted: ' + type);
  assert(['permission','host_only','permission_denied'].includes(response.code), 'Unexpected restriction code for '+type+': '+response.code);
}
async function openFile(peer) {const value=await peer.command('open_file', {path:'note.txt'}); assert.equal(value.type,'file_state'); return value.file;}
async function changedFile(peer, content) {
  const file=await openFile(peer); const changed=await peer.command('edit_file', {path:file.path, baseRevision:file.revision, content}); assert.equal(changed.type,'file_state');
  assert.equal((await peer.command('save_file', {path:file.path, revision:changed.file.revision})).type,'file_state');
  assert.equal(fs.readFileSync(path.join(workspace,'note.txt'),'utf8'),content);
}
function privateRecords() {
  const records=[];
  const walk=directory => {if (!fs.existsSync(directory)) return; for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {const filename=path.join(directory,entry.name); if (entry.isDirectory()) walk(filename); else if (entry.isFile() && entry.name.endsWith('.json')) records.push({filename,raw:fs.readFileSync(filename,'utf8')});}};
  walk(stateDir); return records;
}
function report(status) {
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'review.json'),JSON.stringify({status,date:new Date().toISOString(),binarySha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),harnessSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),engine,stage,checks,errors,fixtureOnly:true,inferenceRequests:0,limitations:['Browser viewport emulation; no physical phone is used.','Local real sockets and pairing; no public tunnel is started.']},null,2)+'\n');
}
async function run() {
  for (const directory of [workspace,bin,home,out]) fs.mkdirSync(directory,{recursive:true});
  // Log an accidental inference invocation and fail instead of invoking a real
  // provider inherited from the developer's PATH or signed-in home directory.
  const fake='#!/bin/sh\nprintf "%s\\n" "$*" >> "$NIMLO_FIXTURE_PROVIDER_LOG"\nexit 1\n';
  for (const name of ['codex','claude']) fs.writeFileSync(path.join(bin,name),fake,{mode:0o700});
  fs.writeFileSync(path.join(workspace,'note.txt'),'Original fixture\n');
  await startHost(); pc=await connect('access-desktop',rootCookie);
  browser=await playwright[engine].launch(engine==='chromium' ? {executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true} : {headless:true});
  pcPage=await newPage({viewport:{width:1100,height:800}}); await pcPage.goto(origin+'/#token='+rootToken); await connected(pcPage);
  let phone, phoneTab, phoneCookie;
  await check('Host session exposes editable permission controls and full host access',async () => {
    assert.equal(pc.initial.isHost,true); assert.deepEqual(pc.initial.permissions,FULL);
    await openAccess(pcPage); assert(await pcPage.locator('#access-allow-devices').isChecked());
    for (const id of ['access-edit-files','access-terminal','access-ai']) {assert(await pcPage.locator('#'+id).isChecked()); assert(await pcPage.locator('#'+id).isEnabled());}
    assert.equal(await pcPage.inputValue('#access-password'),''); await pcPage.click('[data-close="session-access-dialog"]');
  });
  await check('Default pairing needs no password and paired files and shell work',async () => {
    const paired=await pairDevice('access-phone'); phone=paired.peer; phoneCookie=paired.cookie;
    phoneTab=await connect('access-phone-tab',phoneCookie); assert.equal(phone.initial.isHost,false); assert.deepEqual(phone.initial.permissions,FULL);
    await changedFile(phone,'Paired fixture\n');
    assert.equal((await phone.command('terminal_start')).type,'terminal_state');
    assert.equal((await phone.command('terminal_input',{data:'printf terminal-fixture > terminal-proof.txt\r'})).type,'ack');
    await until(() => fs.existsSync(path.join(workspace,'terminal-proof.txt')), 'Allowed paired shell did not run');
    assert.equal(fs.readFileSync(path.join(workspace,'terminal-proof.txt'),'utf8'),'terminal-fixture');
    assert.equal((await phone.command('ai_status')).type,'ai_state');
    phonePage=await newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true},phoneCookie); await phonePage.goto(origin); await connected(phonePage);
    await until(async () => (await phonePage.inputValue('#code-input')) === 'Paired fixture\n', 'Phone file did not open');
  });
  await check('Saving session limits updates all existing device tabs and preserves host access',async () => {
    await saveAccess(pcPage,NONE,{password:PASSWORD}); await expectPermissions(phone,NONE); await expectPermissions(phoneTab,NONE);
    await phonePage.waitForFunction(() => document.getElementById('code-input').readOnly && document.getElementById('new-file').disabled && document.getElementById('ai-send').disabled && document.getElementById('terminal-command').disabled);
    assert.equal((await pc.command('ping')).type,'pong'); assert.deepEqual(effective(pc),FULL);
    await openSession(phonePage); assert(await phonePage.locator('#session-permissions').isHidden()); assert(await phonePage.locator('#pair-phone').isDisabled());
    await phonePage.screenshot({path:path.join(out,'phone-restricted-session.png')}); await phonePage.click('#session-menu-close');
  });
  await check('Restricted peers cannot mutate files, run a shell, use AI or elevate permissions',async () => {
    const file=await openFile(phone);
    for (const [type,fields] of [
      ['edit_file',{path:file.path,baseRevision:file.revision,content:'Denied fixture\n'}],
      ['patch_file',{path:file.path,baseRevision:file.revision,start:0,deleteCount:0,insert:'Denied'}],
      ['create_file',{path:'denied.txt'}],['save_file',{path:file.path,revision:file.revision}],
      ['close_file',{path:file.path,revision:file.revision,discard:true}],
      ['terminal_start',{}],['terminal_input',{data:'touch denied.txt\r'}],['terminal_history',{}],
      ['ai_start',{provider:'codex',prompt:'Denied fixture'}],['ai_status',{}],
      ['pair_create',{origin}],['session_access_set',{settings:{allowDevices:true,permissions:FULL},password:null}],
      ['device_permissions_set',{targetClientId:'access-phone',permissions:FULL}],
      ['internet_start',{}],['add_project',{path:home}],
    ]) await denied(phone,type,fields);
    assert.equal(fs.existsSync(path.join(workspace,'denied.txt')),false); assert.equal(fs.readFileSync(path.join(workspace,'note.txt'),'utf8'),'Paired fixture\n');
    await denied(phoneTab,'edit_file',{path:file.path,baseRevision:file.revision,content:'Denied tab\n'});
  });
  await check('HTTP snapshots without a client identifier honor token restrictions',async () => {
    const response=await request('/api/bootstrap',{cookie:phoneCookie}); assert.equal(response.status,200); assert.deepEqual(response.value.permissions,NONE);
    assert(!response.value.terminal || !response.value.terminal.running); assert(!JSON.stringify(response.value.terminal).includes('terminal-fixture'));
    assert(!response.value.ai || !response.value.ai.messages?.length); assert(!response.value.providers?.length); assert(!response.value.aiSettings);
    assert(!JSON.stringify(response.value).includes(PASSWORD)); assert(!JSON.stringify(response.value).includes('$argon2id$'));
    const spoofed=await request('/api/bootstrap?clientId=access-desktop',{cookie:phoneCookie}); assert.equal(spoofed.status,200); assert.equal(spoofed.value.isHost,false); assert.deepEqual(spoofed.value.permissions,NONE);
    assert(!spoofed.value.terminal?.running); assert(!spoofed.value.aiSettings);
  });
  await check('Restricted sockets do not receive later host terminal or AI state',async () => {
    const before=phone.events.length;
    assert.equal((await pc.command('terminal_input',{data:'printf broadcast-private-fixture\r'})).type,'ack');
    await delay(300);
    const delivered=phone.events.slice(before); assert(!delivered.some(event => ['terminal_state','terminal_history','ai_state','provider_state','ai_settings'].includes(event.type)));
    assert(!JSON.stringify(delivered).includes('broadcast-private-fixture'));
  });
  await check('Pairing password remains an extra factor alongside invitation and code',async () => {
    const value=await invitation();
    assert.equal((await submit(value)).status,401); assert.equal((await submit(value,'wrong fixture password')).status,401);
    const wrongCode=value.code==='000000' ? '111111' : '000000'; assert.equal((await submit(value,PASSWORD,wrongCode)).status,401);
    const response=await submit(value,PASSWORD); assert.equal(response.status,200); assert(response.cookie);
    assert.equal((await submit(value,PASSWORD)).status,401);
  });
  await check('Repeated wrong passwords exhaust the invitation attempt budget',async () => {
    const value=await invitation(); for (let index=0;index<5;index++) assert.equal((await submit(value,'wrong fixture password')).status,401);
    assert.equal((await submit(value,PASSWORD)).status,401);
  });
  await check('Session limits cap per-device grants and restoring limits preserves device choices',async () => {
    await setPolicy(FULL);
    const rights={editFiles:true,terminal:false,ai:true};
    assert.notEqual((await pc.command('device_permissions_set',{targetClientId:'access-phone',permissions:rights})).type,'error');
    await expectPermissions(phone,rights); await expectPermissions(phoneTab,rights);
    await changedFile(phone,'Editor-only device fixture\n'); await denied(phone,'terminal_start'); await denied(phone,'ai_start',{provider:'codex',prompt:'No terminal permission'});
    await setPolicy(NONE); await expectPermissions(phone,NONE); await setPolicy(FULL); await expectPermissions(phone,rights);
    const anonymous=await request('/api/bootstrap',{cookie:phoneCookie}); assert.deepEqual(anonymous.value.permissions,rights);
  });
  await check('Device dialog changes every tab sharing its credential and live phone controls',async () => {
    await openSession(pcPage); await pcPage.click('button[data-client-id="access-phone"][data-device-action="permissions"]');
    await pcPage.locator('#device-access-dialog').waitFor({state:'visible'}); assert(await pcPage.locator('#device-edit-files').isChecked()); assert(!await pcPage.locator('#device-terminal').isChecked());
    for (const id of ['device-edit-files','device-terminal','device-ai']) await pcPage.locator('#'+id).uncheck();
    await pcPage.screenshot({path:path.join(out,'desktop-device-permissions.png')}); await pcPage.click('#device-access-submit');
    await pcPage.locator('#device-access-dialog').waitFor({state:'hidden'}); await expectPermissions(phone,NONE); await expectPermissions(phoneTab,NONE);
    await phonePage.waitForFunction(() => document.getElementById('code-input').readOnly && document.getElementById('ai-send').disabled);
    await denied(phoneTab,'terminal_start');
  });
  await check('Session permission dialog fits a narrow phone viewport with usable save controls',async () => {
    await pcPage.setViewportSize({width:390,height:844}); await openAccess(pcPage);
    assert.equal(await pcPage.evaluate(() => document.documentElement.scrollWidth),390);
    const box=await pcPage.locator('#session-access-dialog').boundingBox(); assert(box.x>=0 && box.x+box.width<=390.5);
    await pcPage.locator('#session-access-submit').scrollIntoViewIfNeeded(); const save=await pcPage.locator('#session-access-submit').boundingBox(); assert(save.height>=40);
    assert.equal(await pcPage.inputValue('#access-password'),''); assert(await pcPage.locator('#access-remove-password-row').isVisible());
    await pcPage.screenshot({path:path.join(out,'phone-session-permissions.png')}); await pcPage.click('[data-close="session-access-dialog"]'); await pcPage.setViewportSize({width:1100,height:800});
  });
  await check('Changing or removing the password cancels invitations and updates pairing',async () => {
    const pending=await invitation(); await setPolicy(FULL,{password:''}); assert.equal((await submit(pending,PASSWORD)).status,401);
    const fresh=await invitation(); assert.equal((await submit(fresh)).status,200);
    await setPolicy(FULL,{password:PASSWORD});
    const records=privateRecords(); assert(records.some(record => record.raw.includes('$argon2id$'))); assert(records.every(record => !record.raw.includes(PASSWORD)));
    for (const record of records.filter(record => record.raw.includes('$argon2id$'))) assert.equal(fs.statSync(record.filename).mode & 0o777,0o600);
  });
  await check('Disallowing devices revokes existing credentials while the PC host keeps working',async () => {
    const pending=await invitation(); await setPolicy({editFiles:true,terminal:false,ai:false},{allowDevices:false});
    await until(() => phone.closeCode!==null && phoneTab.closeCode!==null, 'Connected paired devices survived disable'); assert.equal(phone.closeCode,1008); assert.equal(phoneTab.closeCode,1008);
    assert.equal((await request('/api/bootstrap',{cookie:phoneCookie})).status,401); assert.equal((await submit(pending,PASSWORD)).status,403);
    assert.equal((await pc.command('ping')).type,'pong'); assert.equal((await pc.command('pair_create',{origin})).type,'error');
    await phonePage.waitForFunction(() => document.getElementById('app').dataset.connected === 'no');
    assert.equal((await pc.command('terminal_history')).type,'terminal_history');
  });
  await check('Access settings and password survive a host restart without plaintext storage',async () => {
    for (const context of contexts) await context.close(); contexts.length=0;
    await stopHost(); await startHost(); pc=await connect('access-restarted-desktop',rootCookie);
    const snapshot=pc.initial; assert.equal(snapshot.isHost,true); assert.deepEqual(snapshot.permissions,FULL); assert.equal(snapshot.accessSettings.allowDevices,false); assert.equal(snapshot.accessSettings.passwordSet,true);
    assert.deepEqual(snapshot.accessSettings.permissions,{editFiles:true,terminal:false,ai:false});
    await setPolicy({editFiles:true,terminal:false,ai:false});
    const invite=await invitation(); assert.equal((await submit(invite,'wrong fixture password')).status,401); const response=await submit(invite,PASSWORD); assert.equal(response.status,200);
    const restarted=await connect('access-restarted-phone',response.cookie); assert.deepEqual(restarted.initial.permissions,{editFiles:true,terminal:false,ai:false});
    assert(privateRecords().every(record => !record.raw.includes(PASSWORD)));
  });
  await check('No real AI inference or uncaught browser error occurs',async () => {
    const invocations=fs.existsSync(providerLog) ? fs.readFileSync(providerLog,'utf8') : '';
    assert(!invocations.split('\n').some(line => /(?:app-server|--input-format|--output-format|\bexec\b)/.test(line)), 'A fake inference process was invoked');
    assert.deepEqual(errors,[]);
  });
  report('pass');
}
run().catch(error => {errors.push(sanitized(error.stack || error)); console.error(sanitized(error.stack || error)); process.exitCode=1; report('fail');}).finally(async () => {
  for (const peer of peers) peer.socket.terminate();
  for (const context of contexts) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await stopHost(); fs.rmSync(fixture,{recursive:true,force:true});
});
