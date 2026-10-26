#!/usr/bin/env node
'use strict';

// Real embedded host, disposable browser profiles, and a fake OS browser opener.
// The opened private URL is consumed only in memory; no credentials enter reports.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const playwright=require(process.env.PLAYWRIGHT_PATH||'playwright');
const engine=process.env.NIMLO_BROWSER||'chromium';
if(!['chromium','webkit'].includes(engine))throw new Error('Unsupported browser engine');
const repo=path.resolve(__dirname,'..'),binary=path.join(repo,'target/release/nimlo-editor');
const fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-signin-'))),workspace=path.join(fixture,'workspace'),bin=path.join(fixture,'bin'),record=path.join(fixture,'opened.json'),failureFlag=path.join(fixture,'opener-fails');
fs.mkdirSync(workspace);fs.mkdirSync(bin);fs.writeFileSync(path.join(workspace,'hello.txt'),'Disposable sign-in fixture\n');
for(const provider of ['codex','claude']){const file=path.join(bin,provider);fs.writeFileSync(file,'#!/bin/sh\nexit 1\n');fs.chmodSync(file,0o700);}
const opener=path.join(bin,process.platform==='darwin'?'open':'xdg-open');
fs.writeFileSync(opener,"#!/usr/bin/env node\nconst fs=require('node:fs');fs.writeFileSync(process.env.NIMLO_OPENER_RECORD+'.tmp',JSON.stringify(process.argv.slice(2)));fs.renameSync(process.env.NIMLO_OPENER_RECORD+'.tmp',process.env.NIMLO_OPENER_RECORD);process.exit(fs.existsSync(process.env.NIMLO_OPENER_FAILURE)?1:0);\n");fs.chmodSync(opener,0o700);
let host,browser,privateUrl,stage='startup',lastOpen=0;const checks=[],errors=[],contexts=[];
const artifacts=path.join(repo,'tests'),report='signin-'+engine+'.json';fs.mkdirSync(artifacts,{recursive:true});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function check(name,fn){stage=name;await fn();checks.push(name);console.log('PASS '+name);}
async function context(options={}){const value=await browser.newContext(options);contexts.push(value);return value;}
async function page(ctx){const p=await ctx.newPage();p.setDefaultTimeout(15000);p.on('pageerror',error=>errors.push(error.message));return p;}
async function signedIn(p){await p.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes'&&!document.getElementById('join-dialog').open&&document.getElementById('pc-welcome').hidden&&document.getElementById('app').dataset.controller==='yes');assert.equal(new URL(p.url()).hash,'');}
async function welcome(p){await p.locator('#pc-welcome').waitFor({state:'visible'});assert(await p.locator('#join-dialog').isHidden());assert(await p.locator('#app').isHidden());}
async function startHost(listen='0.0.0.0:0'){
 host=spawn(path.join(repo,'scripts/run.sh'),['--workspace',workspace,'--state-dir',path.join(fixture,'state'),'--listen',listen],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,NIMLO_OPENER_RECORD:record,NIMLO_OPENER_FAILURE:failureFlag},stdio:['ignore','pipe','pipe']});
 const link=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Host startup timeout')),20000);host.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/[^\s]+\/#token=[a-f0-9]{64}/);if(match){clearTimeout(timer);resolve(match[0]);}});host.on('error',reject);host.once('exit',()=>{clearTimeout(timer);reject(new Error('Host exited before startup'));});});
 lastOpen=Date.now();return link;
}
async function stopHost(){if(!host)return;const child=host;host=null;child.kill('SIGINT');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},8000).unref();});}
async function openedLink(){for(let i=0;i<100&&!fs.existsSync(record);i++)await pause(30);assert(fs.existsSync(record),'Opener did not receive generated link');const args=JSON.parse(fs.readFileSync(record,'utf8'));assert.equal(args.length,1);assert(/^[a-f0-9]{64}$/.test(new URLSearchParams(new URL(args[0]).hash.slice(1)).get('token')));return args[0];}
async function clickOpen(p){await pause(Math.max(0,5200-(Date.now()-lastOpen)));fs.rmSync(record,{force:true});await p.click('#pc-open-editor');lastOpen=Date.now();}
function writeReport(status){fs.writeFileSync(path.join(artifacts,report),JSON.stringify({status,date:new Date().toISOString(),browserEngine:engine,binarySha256:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),sourceOverrides:false,opener:'Disposable fake OS opener; its generated link is opened in actual browser pages to emulate same-profile delivery. No real user profile is controlled.',stage,checks,errors},null,2)+'\n');}
(async()=>{
 privateUrl=await startHost();
 await check('Launcher opens exactly the generated private loopback link',async()=>{assert.equal(await openedLink(),privateUrl);assert.equal(new URL(privateUrl).hostname,'127.0.0.1');});
 browser=await playwright[engine].launch(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}:{headless:true});
 const base=new URL(privateUrl);base.hash='';const canonicalUrl=base.href;base.hostname='localhost';const localUrl=base.href;
 const pcContext=await context(),pc=await page(pcContext);
 await check('Fresh plain localhost resolves to canonical PC entry with one nonmodal Open editor action',async()=>{
  await pc.goto(localUrl);await welcome(pc);assert.equal(new URL(pc.url()).origin,new URL(canonicalUrl).origin);assert(await pc.locator('#pc-open-editor').isVisible());assert(await pc.locator('#launch-link').isHidden());assert(await pc.locator('#join-form').isHidden());assert.equal(await pc.evaluate(()=>document.activeElement.id),'pc-open-editor');assert.equal(await pc.evaluate(async()=> (await fetch('/api/bootstrap')).status),401);
  const button=await pc.locator('#pc-open-editor').boundingBox();assert(button.height>=44);await pc.screenshot({path:path.join(artifacts,'signin-'+engine+'-pc.png')});
  for(const [route,file] of [['/','index.html'],['/editor.js','editor.js'],['/app.js','app.js'],['/style.css','style.css']])assert.equal(await(await pc.request.get(new URL(route,canonicalUrl).href)).text(),fs.readFileSync(path.join(repo,'web',file),'utf8'));
 });
 await check('Reconnect without authentication gives the primary action without unlocking the editor',async()=>{await pc.click('#pc-retry');await pc.waitForFunction(()=>document.getElementById('pc-open-status').textContent.includes('Choose Open editor'));await welcome(pc);assert.equal(await pc.evaluate(async()=> (await fetch('/api/bootstrap')).status),401);});
 await pc.locator('#pc-launch-details summary').click();
 await check('Secondary browser fallback rejects malformed or foreign private links without forwarding credentials',async()=>{
  const credentials=[];pc.on('request',request=>{if(request.headers().authorization)credentials.push(request.headers().authorization);});
  for(const invalid of ['broken',privateUrl.replace('http:','https:'),privateUrl.replace('127.0.0.1','example.invalid'),privateUrl.replace(base.port,'1'),privateUrl.replace('/#','/other#'),privateUrl+'&invite='+('a'.repeat(64))]){await pc.fill('#launch-link',invalid);await pc.click('#launch-submit');await pc.locator('#pc-open-error').waitFor({state:'visible'});assert.equal(await pc.inputValue('#launch-link'),'');await welcome(pc);}
  assert.equal(credentials.length,0);
 });
 await check('An invalid host credential leaves the welcome usable and the editor locked',async()=>{await pc.fill('#launch-link',canonicalUrl+'#token='+('0'.repeat(64)));await pc.click('#launch-submit');await pc.locator('#pc-open-error').waitFor({state:'visible'});assert((await pc.locator('#pc-open-error').textContent()).includes('no longer valid'));await welcome(pc);assert.equal(await pc.inputValue('#launch-link'),'');assert.equal(await pc.evaluate(async()=> (await fetch('/api/bootstrap')).status),401);});
 await check('Fallback signs in, clears secrets and restores a real editable connection',async()=>{await pc.fill('#launch-link',privateUrl);await pc.click('#launch-submit');await signedIn(pc);assert.equal(await pc.inputValue('#launch-link'),'');assert(await pc.locator('#pc-open-error').isHidden());const cookie=(await pcContext.cookies()).find(c=>c.name==='nimlo_neovim_session');assert(cookie&&cookie.httpOnly&&cookie.sameSite==='Strict');await pc.reload();await signedIn(pc);});
 await check('A signed-in PC can type plain localhost again without an entry screen or opener',async()=>{await pc.goto(localUrl);await signedIn(pc);assert.equal(new URL(pc.url()).origin,new URL(canonicalUrl).origin);});
 const hashContext=await context(),hashPage=await page(hashContext);
 await check('Private-link same-document navigation recovers the nonmodal entry page',async()=>{await hashPage.goto(canonicalUrl);await welcome(hashPage);await hashPage.evaluate(hash=>{location.hash=hash;},new URL(privateUrl).hash);await signedIn(hashPage);});
 const siblingContext=await context(),stuck=await page(siblingContext),authenticated=await page(siblingContext);
 await check('A signed-out original tab can reconnect after a sibling signs this browser in',async()=>{await stuck.goto(localUrl);await welcome(stuck);await authenticated.goto(privateUrl);await signedIn(authenticated);await stuck.click('#pc-retry');await signedIn(stuck);});
 await hashContext.close();await siblingContext.close();
 const launchContext=await context(),launchPage=await page(launchContext);
 await check('Open editor invokes the host opener without authorizing the calling page or returning secrets',async()=>{
  await launchPage.goto(localUrl);await welcome(launchPage);const resultPromise=launchPage.waitForResponse(response=>new URL(response.url()).pathname==='/api/pc/open');await clickOpen(launchPage);const response=await resultPromise;assert.equal(response.status(),200);const result=await response.json();assert.equal(result.opened,true);assert(!/[a-f0-9]{64}|#token=|#invite=/.test(JSON.stringify(result)));assert.equal(await launchPage.evaluate(async()=> (await fetch('/api/bootstrap')).status),401);await welcome(launchPage);
  const opened=await openedLink();assert.equal(new URL(opened).origin,new URL(launchPage.url()).origin);
  const target=await page(launchContext);await target.goto(opened);await signedIn(target);await signedIn(launchPage);
 });
 await launchContext.close();
 const otherContext=await context(),otherPage=await page(otherContext);
 await check('An opener in another browser reaches a bounded, editable fallback and stops polling',async()=>{
  await otherPage.goto(canonicalUrl);await welcome(otherPage);let probes=0;otherPage.on('request',request=>{if(new URL(request.url()).pathname==='/api/bootstrap')probes++;});await clickOpen(otherPage);await otherPage.waitForFunction(()=>document.getElementById('pc-open-status').textContent.includes('another browser'));
  await welcome(otherPage);assert(await otherPage.locator('#pc-launch-details').evaluate(el=>el.open));assert(await otherPage.locator('#pc-open-editor').isEnabled());assert.equal(await otherPage.evaluate(async()=> (await fetch('/api/bootstrap')).status),401);const settled=probes;await pause(1300);assert.equal(probes,settled,'PC recovery retained idle polling');assert(probes<=16);await otherPage.screenshot({path:path.join(artifacts,'signin-'+engine+'-other-browser.png')});
 });
 await check('Opener failure leaves a clear retry and private-link fallback at phone widths',async()=>{
  fs.writeFileSync(failureFlag,'fail');try{await otherPage.setViewportSize({width:320,height:360});await clickOpen(otherPage);await otherPage.locator('#pc-open-error').waitFor({state:'visible'});await welcome(otherPage);assert(await otherPage.locator('#pc-open-editor').isEnabled());assert(await otherPage.locator('#pc-launch-details').evaluate(el=>el.open));assert(await otherPage.locator('#launch-link').isVisible());assert.equal(await otherPage.evaluate(async()=> (await fetch('/api/bootstrap')).status),401);assert.equal(await otherPage.evaluate(()=>document.documentElement.scrollWidth),320);await otherPage.screenshot({path:path.join(artifacts,'signin-'+engine+'-opener-failure.png')});}finally{fs.rmSync(failureFlag,{force:true});}
 });
 const aliasContext=await context(),aliasPage=await page(aliasContext);
 await check('An already-authenticated localhost alias retains its cookie and origin',async()=>{const alias=new URL(privateUrl);alias.hostname='localhost';await aliasPage.goto(alias.href);await signedIn(aliasPage);assert.equal(new URL(aliasPage.url()).hostname,'localhost');await aliasPage.reload();await signedIn(aliasPage);});
 await aliasContext.close();
 const draftContext=await context(),draftPage=await page(draftContext);
 await check('Pending alias drafts prevent normalization and the opener keeps that exact local authority',async()=>{
  await draftContext.addInitScript(()=>sessionStorage.setItem('relay-draft:disposable:hello.txt','{"text":"preserved fixture draft"}'));
  await draftPage.goto(localUrl);await welcome(draftPage);assert.equal(new URL(draftPage.url()).hostname,'localhost');await clickOpen(draftPage);const opened=await openedLink();assert.equal(new URL(opened).hostname,'localhost');const target=await page(draftContext);await target.goto(opened);await signedIn(target);await signedIn(draftPage);assert(await draftPage.evaluate(()=>sessionStorage.getItem('relay-draft:disposable:hello.txt')));
 });
 await draftContext.close();
 const remoteContext=await context({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),remote=await page(remoteContext);
 await remote.route('https://nimlo.example.invalid/**',async route=>{const url=new URL(route.request().url());if(url.pathname==='/api/bootstrap')return route.fulfill({status:401,contentType:'application/json',body:'{}'});const file={'/':'index.html','/editor.js':'editor.js','/app.js':'app.js','/style.css':'style.css'}[url.pathname];if(!file)return route.fulfill({status:404,body:''});await route.fulfill({status:200,contentType:file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html',body:await(await pc.request.get(new URL(url.pathname,canonicalUrl).href)).body()});});
 await check('Public entry still requires a full invitation and has no PC opener or token exchange',async()=>{
  await remote.goto('https://nimlo.example.invalid/');await remote.locator('#join-dialog').waitFor({state:'visible'});assert.equal(await remote.locator('#join-title').textContent(),'Open an invitation from your PC');assert(await remote.locator('#pc-welcome').isHidden());assert(await remote.locator('#launch-form').isHidden());assert(await remote.locator('#join-form').isHidden());const credentials=[];remote.on('request',request=>{if(request.headers().authorization)credentials.push(request.headers().authorization);});await remote.evaluate(link=>{document.getElementById('launch-link').value=link;document.getElementById('launch-form').dispatchEvent(new Event('submit',{cancelable:true}));},privateUrl);await remote.locator('#join-error').waitFor({state:'visible'});assert.equal(credentials.length,0);assert.equal(await remote.inputValue('#launch-link'),'');await remote.screenshot({path:path.join(artifacts,'signin-'+engine+'-missing-invitation.png')});
 });
 await check('A PC-token fragment on a public address is stripped without forwarding it',async()=>{const credentials=[];remote.on('request',request=>{if(request.headers().authorization)credentials.push(request.headers().authorization);});await remote.goto('https://nimlo.example.invalid/'+new URL(privateUrl).hash);await remote.waitForFunction(()=>!location.hash);await remote.locator('#join-dialog').waitFor({state:'visible'});assert.equal(credentials.length,0);});
 await check('A complete phone invitation keeps its origin and only the enabled pairing flow',async()=>{const ready=remote.waitForResponse(response=>new URL(response.url()).pathname==='/api/bootstrap'&&response.status()===401);await remote.goto('https://nimlo.example.invalid/#invite='+('b'.repeat(64)));await ready;await remote.waitForFunction(()=>!document.getElementById('join-code').disabled&&!location.hash);assert.equal(await remote.locator('#join-title').textContent(),'Join your PC session');assert(await remote.locator('#pc-welcome').isHidden());assert(await remote.locator('#launch-form').isHidden());assert(await remote.locator('#join-retry').isHidden());assert(await remote.locator('#join-error').isHidden());assert(await remote.locator('#join-form').isVisible());assert.equal(new URL(remote.url()).origin,'https://nimlo.example.invalid');const button=await remote.locator('#join-submit').boundingBox();assert(button.height>=44);await remote.screenshot({path:path.join(artifacts,'signin-'+engine+'-invitation.png')});});
 await check('Host restart has one-click PC recovery, with a new credential and no terminal-copy requirement',async()=>{
  const port=new URL(privateUrl).port,oldPrivate=privateUrl;await stopHost();fs.rmSync(record,{force:true});privateUrl=await startHost('0.0.0.0:'+port);assert.notEqual(privateUrl,oldPrivate);assert.equal(await openedLink(),privateUrl);await pc.reload();await welcome(pc);await clickOpen(pc);const target=await page(pcContext);await target.goto(await openedLink());await signedIn(target);await signedIn(pc);assert(await pc.locator('#launch-link').isHidden());
 });
 assert.deepEqual(errors,[]);writeReport('pass');console.log('PASS sign-in: '+checks.length+' checks; tests/'+report);
})().catch(error=>{const diagnostic=String(error.stack||error).replace(/[a-f0-9]{64}/g,'[redacted]');console.error('FAIL '+stage+': '+diagnostic);errors.push(diagnostic);writeReport('fail');process.exitCode=1;}).finally(async()=>{for(const ctx of contexts)await ctx.close().catch(()=>{});if(browser)await browser.close();await stopHost();fs.rmSync(fixture,{recursive:true,force:true});});
