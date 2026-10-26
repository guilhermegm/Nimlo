'use strict';
// Actual embedded host and browser clients; generated files, fake providers,
// local network only. Invitation/launch credentials stay in memory, never reports.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const playwright=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const engine=process.env.NIMLO_BROWSER || 'chromium';
assert(['chromium','webkit'].includes(engine));
const binary=path.resolve(process.env.NIMLO_BINARY || 'target/release/nimlo-editor');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-pairing-entry-'));
const out=path.resolve('tests/pairing-entry-'+engine);fs.mkdirSync(out,{recursive:true});
const checks=[],errors=[],contexts=[];let host,browser,stage='startup';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await delay(25);}throw Error(label);}
async function check(name,fn){stage=name;await fn();checks.push(name);console.log('PASS '+name);}
async function page(options={}){const ctx=await browser.newContext(options);contexts.push(ctx);const p=await ctx.newPage();p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));return p;}
async function connected(p){await p.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes'&&!document.getElementById('join-dialog').open);}
async function invitation(pc){await pc.waitForFunction(()=>/^\d{6}$/.test(document.getElementById('pair-code').textContent));return {url:await pc.locator('#pair-urls a').getAttribute('href'),code:(await pc.locator('#pair-code').textContent()).trim()};}
async function paste(p,url){await p.fill('#join-link',url);await p.click('#join-link-submit');}
async function openFile(p){await p.click('#files-toggle');const root=p.locator('#file-tree .project-root').first();if(await root.locator('.project-expand').getAttribute('aria-expanded')!=='true')await root.locator('.project-expand').click();await root.locator('.tree-entry[data-kind="file"][data-path="hello.txt"]').click();await p.waitForFunction(()=>document.getElementById('file-label').textContent==='hello.txt'&&document.getElementById('files-menu').hidden);}
function report(status){fs.writeFileSync(path.join(out,'review.json'),JSON.stringify({status,date:new Date().toISOString(),binarySha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),harnessSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),engine,stage,checks,errors,sourceOverrides:false,fixtureOnly:true,inferenceRequests:0,limitations:['Desktop-hosted browser emulation, not a physical phone.','Local real pairing plus public-entry browser routing; no public connector is started.','Clipboard is controlled for success/denial cases; real operating-system clipboard delivery is not measured.']},null,2)+'\n');}
(async()=>{
 const bin=path.join(fixture,'bin');fs.mkdirSync(bin);for(const name of ['codex','claude'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o700});
 fs.writeFileSync(path.join(fixture,'hello.txt'),'Shared fixture\n');const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,SHELL:'/bin/sh'};delete env.ENV;delete env.BASH_ENV;
 host=spawn(binary,['--workspace',fixture,'--state-dir',path.join(fixture,'.state'),'--listen','0.0.0.0:0'],{env,stdio:['ignore','pipe','pipe']});
 let launch,buffer='';host.stdout.on('data',b=>{buffer=(buffer+b).slice(-12000);const m=buffer.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/);if(m){launch=m[0];buffer='';}});host.stderr.on('data',()=>{});await until(()=>launch,'Fixture startup');
 browser=await playwright[engine].launch(engine==='chromium'?{executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}:{headless:true});
 const pc=await page({viewport:{width:1100,height:800}});await pc.goto(launch);await connected(pc);
 for(const [route,name] of [['/','index.html'],['/editor.js','editor.js'],['/app.js','app.js'],['/style.css','style.css']])assert.equal(await(await pc.request.get(new URL(route,launch).href)).text(),fs.readFileSync(path.join('web',name),'utf8'));
 await pc.click('#connection-state');await pc.click('#pair-phone');await pc.click('#pair-local');let current=await invitation(pc);const origin=new URL(current.url).origin;
 await check('Visible invitation is complete and copy delivers the exact capability link',async()=>{
  assert.equal(await pc.locator('#pair-urls a').textContent(),current.url);assert.match(new URL(current.url).hash,/^#invite=[a-f0-9]{64}$/);
  await pc.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedInvitation=text;}}}));
  await pc.click('#pair-copy');assert.equal(await pc.evaluate(()=>window.__copiedInvitation),current.url);assert.equal(await pc.locator('#pair-copy').textContent(),'Copied');
 });
 await check('Denied clipboard exposes a selected complete-link fallback',async()=>{
  await pc.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('Fixture denial');}}}));
  await pc.click('#pair-copy');assert(await pc.locator('#pair-manual').isVisible());assert.equal(await pc.inputValue('#pair-link'),current.url);
  assert(await pc.locator('#pair-link').evaluate(el=>el.selectionStart===0&&el.selectionEnd===el.value.length));assert(await pc.locator('#pair-error').isVisible());
  await pc.screenshot({path:path.join(out,'pc-invitation.png'),mask:[pc.locator('#pair-urls'),pc.locator('#pair-link'),pc.locator('#pair-code')]});
 });
 const phone=await page({viewport:{width:390,height:844},isMobile:true,hasTouch:true});let pairRequests=0,authorizations=0;phone.on('request',r=>{if(new URL(r.url()).pathname==='/api/pair')pairRequests++;if(r.headers().authorization)authorizations++;});
 await check('Bare phone address has a usable invitation field and remains unauthorized',async()=>{
  await phone.goto(origin+'/');await phone.locator('#join-link-form').waitFor({state:'visible'});assert(await phone.locator('#join-form').isHidden());assert.equal(await phone.evaluate(async()=> (await fetch('/api/bootstrap')).status),401);
  await phone.screenshot({path:path.join(out,'phone-recover-link.png')});
  await phone.setViewportSize({width:320,height:300});assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth),320);const box=await phone.locator('#join-link-submit').boundingBox();assert(box.height>=44);await phone.locator('#join-link-submit').scrollIntoViewIfNeeded();await phone.screenshot({path:path.join(out,'phone-recover-short.png')});await phone.setViewportSize({width:390,height:844});
 });
 await check('Incomplete, private PC and unsafe invitation URLs cannot exchange credentials',async()=>{
  for(const invalid of [origin+'/',launch,origin+'/#token='+('a'.repeat(64)),'javascript:alert(1)',origin+'/other#invite='+('a'.repeat(64)),origin+'/?x=1#invite='+('a'.repeat(64)),origin+'/#invite='+('a'.repeat(64))+'&token='+('b'.repeat(64))]){
   await paste(phone,invalid);await phone.locator('#join-error').waitFor({state:'visible'});assert(await phone.locator('#join-link-form').isVisible());assert.equal(await phone.inputValue('#join-link'),'');
  }
  assert.equal(pairRequests,0);assert.equal(authorizations,0);
 });
 await check('Pasted complete link reaches code entry and survives a refresh without its hash',async()=>{
  await paste(phone,current.url);await phone.locator('#join-form').waitFor({state:'visible'});assert.equal(new URL(phone.url()).hash,'');assert(await phone.locator('#join-link-form').isHidden());const expiry=await phone.evaluate(()=>JSON.parse(sessionStorage.getItem('relay-pending-invitation')).expiresAt);
  await phone.reload();await phone.locator('#join-form').waitFor({state:'visible'});assert(await phone.locator('#join-code').isEnabled());assert.equal(pairRequests,0);
  assert.equal(await phone.evaluate(()=>JSON.parse(sessionStorage.getItem('relay-pending-invitation')).expiresAt),expiry);
  await phone.screenshot({path:path.join(out,'phone-code-after-refresh.png')});
 });
 await check('Expired pending invitation is discarded and shows link recovery',async()=>{
  await phone.evaluate(()=>{const key='relay-pending-invitation',v=JSON.parse(sessionStorage.getItem(key));v.expiresAt=Date.now()-1;sessionStorage.setItem(key,JSON.stringify(v));});
  await phone.reload();await phone.locator('#join-link-form').waitFor({state:'visible'});assert.equal(await phone.evaluate(()=>sessionStorage.getItem('relay-pending-invitation')),null);assert.equal(pairRequests,0);
 });
 await check('Replaced invitation has a direct recovery path using the new link and code',async()=>{
  await paste(phone,current.url);await pc.click('#pair-refresh');const fresh=await invitation(pc);assert.notEqual(fresh.url,current.url);
  await phone.fill('#join-code',current.code);await phone.click('#join-submit');await phone.locator('#join-error').waitFor({state:'visible'});
  await phone.click('#join-change');await phone.locator('#join-link-form').waitFor({state:'visible'});await paste(phone,fresh.url);await phone.fill('#join-code',fresh.code);await phone.click('#join-submit');await connected(phone);current=fresh;
  assert.equal(await phone.evaluate(()=>sessionStorage.getItem('relay-pending-invitation')),null);assert.equal(new URL(phone.url()).hash,'');
  await phone.reload();await connected(phone);
 });
 await check('Additional independently paired browser joins the same session',async()=>{
  await pc.click('#pair-refresh');const fresh=await invitation(pc);const other=await page({viewport:{width:1024,height:760}});phone.__other=other;
  await other.goto(fresh.url);await other.locator('#join-form').waitFor({state:'visible'});await other.reload();await other.locator('#join-form').waitFor({state:'visible'});await other.fill('#join-code',fresh.code);await other.click('#join-submit');await connected(other);
  const a=await phone.evaluate(async()=> (await(await fetch('/api/bootstrap')).json()).sessionId),b=await other.evaluate(async()=> (await(await fetch('/api/bootstrap')).json()).sessionId);assert.equal(a,b);
 });
 await check('Session shortcut shows all three online browsers and safe access controls',async()=>{
  await pc.click('[data-close="pair-dialog"]');await pc.waitForFunction(()=>document.getElementById('session-count').textContent==='3');await pc.click('#connection-state');assert(await pc.locator('#session-menu').isVisible());assert(await pc.locator('#files-menu').isHidden());assert.equal(await pc.locator('#device-list .device').count(),3);
  assert.equal(await pc.locator('#device-summary').textContent(),'3 connected browsers');assert.equal(await pc.locator('#device-list button').count(),4);assert.equal(await pc.locator('#device-list [data-device-action=permissions]').count(),2);assert.equal(await pc.locator('#device-list [data-device-action=revoke]').count(),2);assert(await pc.locator('#session-permissions').isVisible());assert(await pc.locator('#session-permissions').isEnabled());assert.equal(await pc.locator('#device-list .device').filter({hasText:'PC host'}).count(),1);assert.equal(await pc.locator('#device-list .device').filter({hasText:'PC host'}).locator('button').count(),0);assert.equal(await pc.locator('#connection-state').getAttribute('aria-expanded'),'true');await pc.screenshot({path:path.join(out,'pc-three-devices.png')});await pc.click('#connection-state');assert(await pc.locator('#session-menu').isHidden());
 });
 await check('Both paired browsers can edit and save the host project',async()=>{
  for(const [p,text] of [[phone,'Phone edit\n'],[phone.__other,'Other device edit\n']]){await openFile(p);assert(await p.locator('#code-input').isEditable());await p.fill('#code-input',text);await p.click('#save-button');await until(()=>fs.readFileSync(path.join(fixture,'hello.txt'),'utf8')===text,'Paired save');}
 });
 await check('Both paired browsers use the same actual host shell',async()=>{
  await phone.click('#mobile-terminal');await phone.locator('#terminal-command').waitFor({state:'visible'});await phone.fill('#terminal-command','NIMLO_PAIR_PROOF=shared; printf phone > phone-proof');await phone.click('#terminal-run');await until(()=>fs.existsSync(path.join(fixture,'phone-proof')),'Phone shell');
  const other=phone.__other;await other.click('#terminal-shortcut-toggle');await other.locator('#terminal-screen').focus();await other.keyboard.type('printf %s "$NIMLO_PAIR_PROOF" > other-proof');await other.keyboard.press('Enter');await until(()=>fs.existsSync(path.join(fixture,'other-proof')),'Other shell');
  assert.equal(fs.readFileSync(path.join(fixture,'other-proof'),'utf8'),'shared');
 });
 await check('Phone session list is accessible and signing out preserves other devices and shell',async()=>{
  await phone.click('#connection-state');assert(await phone.locator('#session-menu').isVisible());assert.equal(await phone.locator('#device-list .device').count(),3);assert.equal(await phone.locator('#device-list button').count(),1);assert.equal(await phone.locator('#device-list [data-device-action=permissions]').count(),0);assert(await phone.locator('#session-permissions').isHidden());assert(await phone.locator('#pair-phone').isHidden());assert(await phone.locator('#revoke-devices').isHidden());await phone.screenshot({path:path.join(out,'phone-three-devices.png')});await phone.locator('#device-list .device').filter({hasText:'You'}).getByRole('button',{name:'Sign out',exact:true}).click();await phone.locator('#join-link-form').waitFor({state:'visible'});await pc.waitForFunction(()=>document.getElementById('session-count').textContent==='2');
  const value=await phone.__other.evaluate(async()=> (await(await fetch('/api/bootstrap')).json()));assert.equal(value.access,'shared');assert.equal(value.terminal.running,true);
 });
 // Exercise exact embedded public UI without DNS or a public connector.
 const remote=await page({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 await remote.route('https://nimlo.fixture.invalid/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/api/bootstrap')return route.fulfill({status:401,contentType:'application/json',body:'{}'});const file={'/':'index.html','/editor.js':'editor.js','/app.js':'app.js','/style.css':'style.css'}[u.pathname];if(!file)return route.fulfill({status:404});const r=await pc.request.get(new URL(u.pathname,launch).href);await route.fulfill({status:200,contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html',body:await r.body()});});
 await check('Public HTTPS entry and invitation refresh keep the same recovery behavior',async()=>{
  await remote.goto('https://nimlo.fixture.invalid/');await remote.locator('#join-link-form').waitFor({state:'visible'});await remote.goto('https://nimlo.fixture.invalid/#invite='+('b'.repeat(64)));await remote.locator('#join-form').waitFor({state:'visible'});assert.equal(new URL(remote.url()).hash,'');await remote.reload();await remote.locator('#join-form').waitFor({state:'visible'});assert(await remote.locator('#join-code').isEnabled());await remote.click('#join-change');await remote.locator('#join-link-form').waitFor({state:'visible'});
 });
 await check('Pasting an invitation for a changed address navigates to its own host and pairs',async()=>{
  await pc.click('#connection-state');await pc.click('#pair-phone');await pc.click('#pair-local');const fresh=await invitation(pc);
  await paste(remote,fresh.url);await remote.locator('#join-form').waitFor({state:'visible'});assert.equal(new URL(remote.url()).origin,new URL(fresh.url).origin);assert.equal(new URL(remote.url()).hash,'');await remote.fill('#join-code',fresh.code);await remote.click('#join-submit');await connected(remote);
  const a=await remote.evaluate(async()=> (await(await fetch('/api/bootstrap')).json()).sessionId),b=await phone.__other.evaluate(async()=> (await(await fetch('/api/bootstrap')).json()).sessionId);assert.equal(a,b);
 });
 assert.deepEqual(errors,[]);report('pass');console.log('PASS pairing entry '+engine+': '+checks.length+' checks');
})().catch(e=>{const msg=String(e.stack||e).replace(/[a-f0-9]{64}/g,'[private]').replace(/http:\/\/[^\s]+/g,'[fixture address]');errors.push(msg);console.error('FAIL '+stage+': '+msg);report('fail');process.exitCode=1;}).finally(async()=>{
 for(const ctx of contexts)await ctx.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});
 if(host&&host.exitCode===null){host.kill('SIGINT');await Promise.race([new Promise(r=>host.once('exit',r)),delay(3000)]);if(host.exitCode===null)host.kill('SIGKILL');}
 fs.rmSync(fixture,{recursive:true,force:true});
});
