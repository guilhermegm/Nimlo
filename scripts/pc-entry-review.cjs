#!/usr/bin/env node
'use strict';

// Independent PC-entry critic. Only disposable workspaces, browser profiles,
// fixture providers and a fake OS browser opener are used.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),net=require('node:net'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const playwright=require(process.env.PLAYWRIGHT_PATH||path.resolve(__dirname,'../../mini_gym/node_modules/playwright'));
const engine=process.env.NIMLO_BROWSER||'chromium';
assert(['chromium','webkit'].includes(engine));
const repo=path.resolve(__dirname,'..');
const binary=path.resolve(process.env.NIMLO_BINARY||path.join(repo,'target/release/nimlo-editor'));
const binarySha256=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
const artifacts=path.join(repo,'tests','pc-entry-review-'+engine);fs.mkdirSync(artifacts,{recursive:true});
const fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-pc-entry-critic-')));
fs.chmodSync(fixture,0o700);
const children=new Set(),contexts=[],secrets=new Set(),checks=[],screenshots=[],network=[],findings=[],errors=[],expectedBrowserErrors=[];
let browser,attacker,stage='startup';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function safe(value){let text=String(value);for(const secret of secrets)text=text.split(secret).join('[redacted]');return text.replace(/[a-f0-9]{64}/g,'[redacted]');}
async function until(test,message,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await test())return;await pause(30);}throw new Error(message);}
async function check(name,fn){stage=name;const start=Date.now();await fn();checks.push({name,status:'pass',milliseconds:Date.now()-start});console.log('PASS '+name);}
async function stop(child){if(!child||child.exitCode!==null)return;child.kill('SIGINT');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),pause(2000)]);if(child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}children.delete(child);}
async function startHost(name,mode='ok'){
 const base=path.join(fixture,name),workspace=path.join(base,'workspace'),bin=path.join(base,'bin'),record=path.join(base,'opener.jsonl');
 fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(bin);fs.writeFileSync(path.join(workspace,'hello.txt'),'PC entry disposable fixture\n');
 for(const provider of ['codex','claude']){const file=path.join(bin,provider);fs.writeFileSync(file,'#!/bin/sh\nexit 1\n');fs.chmodSync(file,0o700);}
 const opener=path.join(bin,process.platform==='darwin'?'open':'xdg-open');
 fs.writeFileSync(opener,"#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(process.env.NIMLO_REVIEW_OPENER_RECORD,JSON.stringify({args:process.argv.slice(2),pid:process.pid})+'\\n');const mode=process.env.NIMLO_REVIEW_OPENER_MODE;if(mode==='fail')process.exit(7);if(mode==='hang')setTimeout(()=>process.exit(0),30000);\n");fs.chmodSync(opener,0o700);
 const child=spawn(binary,['--workspace',workspace,'--state-dir',path.join(base,'state'),'--listen','0.0.0.0:0','--origin','https://pc-review.example.invalid'],{cwd:workspace,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,NIMLO_REVIEW_OPENER_RECORD:record,NIMLO_REVIEW_OPENER_MODE:mode},stdio:['ignore','pipe','pipe']});
 children.add(child);
 const privateUrl=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Disposable host startup timeout')),18000);child.stdout.on('data',data=>{output=(output+data).slice(-16384);const match=output.match(/http:\/\/[^\s]+\/#token=[a-f0-9]{64}/);if(match){clearTimeout(timer);resolve(match[0]);}});child.on('error',reject);child.on('exit',()=>{clearTimeout(timer);reject(new Error('Disposable host exited during startup'));});});
 const url=new URL(privateUrl);secrets.add(url.hash.slice(7));
 return {child,base,workspace,record,privateUrl,origin:url.origin,port:Number(url.port),records:()=>fs.existsSync(record)?fs.readFileSync(record,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]};
}
function request(host,options={}){
 const headers={Host:'127.0.0.1:'+host.port,...options.headers};
 return new Promise((resolve,reject)=>{const req=http.request({hostname:options.hostname||'127.0.0.1',port:host.port,path:options.path||'/api/pc/open',method:options.method||'POST',headers,timeout:9000},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('HTTP review timeout')));req.end(options.body||'');});
}
function raw(host,headers){
 return new Promise((resolve,reject)=>{const socket=net.connect(host.port,'127.0.0.1');let text='';socket.setTimeout(9000);socket.on('connect',()=>socket.write('POST /api/pc/open HTTP/1.1\r\n'+headers.join('\r\n')+'\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));socket.on('data',chunk=>text+=chunk);socket.on('end',()=>resolve({status:Number(text.match(/^HTTP\/1\.1 (\d+)/)?.[1]||0),body:text}));socket.on('error',reject);socket.on('timeout',()=>socket.destroy(new Error('Raw request timeout')));});
}
const valid=host=>({Origin:host.origin,'X-Nimlo-Launch':'1','Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'});
function noCredential(response){assert(!response.headers?.['set-cookie'],'PC opening authenticated its HTTP caller');assert(!response.headers?.location,'PC opening disclosed a launch redirect');assert(!/[a-f0-9]{64}/.test(response.body),'Response disclosed a credential');}
async function newContext(viewport={width:1280,height:800}){const ctx=await browser.newContext({viewport});contexts.push(ctx);return ctx;}
async function newPage(ctx){const page=await ctx.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>{const message=safe(error.message),target=page.__expectedPcCors;if(target&&message==='/'+new URL(target).host+'/api/pc/open due to access control checks.')expectedBrowserErrors.push({kind:'Deliberate foreign-origin fetch blocked by CORS',message});else errors.push(message);});page.on('response',response=>{const url=new URL(response.url());if(url.pathname.startsWith('/api/'))network.push({method:response.request().method(),path:url.pathname,status:response.status()});});return page;}
async function shot(page,name){await page.screenshot({path:path.join(artifacts,name+'.png')});screenshots.push(name+'.png');}
async function readyWelcome(page){await page.locator('#pc-welcome').waitFor({state:'visible'});await page.locator('#pc-open-editor').waitFor({state:'visible'});assert.equal(new URL(page.url()).hash,'');assert.notEqual(await page.locator('#app').getAttribute('data-connected'),'yes');}
async function connected(page){await page.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes'&&document.getElementById('pc-welcome').hidden);assert(await page.locator('#pc-welcome').isHidden());}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}

(async()=>{
 const boundary=await startHost('boundary');
 await check('Embedded release assets match the candidate source, without CSS or JS overrides',async()=>{for(const file of ['index.html','editor.js','app.js','style.css']){const response=await request(boundary,{path:file==='index.html'?'/':'/'+file,method:'GET'});assert.equal(response.status,200);assert.equal(response.body,fs.readFileSync(path.join(repo,'web',file),'utf8'));}});
 await check('Local bootstrap exposes only a canonical PC address and static roots preserve fragments',async()=>{
  for(const authority of ['localhost:'+boundary.port,'127.0.0.1:'+boundary.port]){
   const response=await request(boundary,{path:'/api/bootstrap',method:'GET',headers:{Host:authority}});assert.equal(response.status,401);noCredential(response);assert.equal(JSON.parse(response.body).pcOrigin,boundary.origin);
   const root=await request(boundary,{path:'/',method:'GET',headers:{Host:authority}});assert.equal(root.status,200);assert(!root.headers.location,'GET root changed an origin-bound fragment');
  }
  for(const headers of [{'X-Forwarded-For':'127.0.0.1'}, {'CF-Ray':'fixture'}, {Host:'pc-review.example.invalid'}]){
   const response=await request(boundary,{path:'/api/bootstrap',method:'GET',headers});assert.equal(response.status,401);noCredential(response);assert(!Object.hasOwn(JSON.parse(response.body),'pcOrigin'),'Proxy/public request obtained PC metadata');
  }
 });
 await check('Missing, foreign or duplicate origins and form/navigation requests never open a browser',async()=>{
  const variants=[{method:'GET'},{headers:{}},{headers:{'X-Nimlo-Launch':'1'}},{headers:{...valid(boundary),Origin:'null'}},{headers:{...valid(boundary),Origin:'https://attacker.example.invalid'}},{headers:{...valid(boundary),Origin:'http://127.0.0.1:1'}},{headers:{...valid(boundary),'X-Nimlo-Launch':'0'}},{headers:{...valid(boundary),'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}},{headers:{...valid(boundary),'Sec-Fetch-User':'?1'}}];
  for(const variant of variants){const response=await request(boundary,variant);assert(response.status>=400);noCredential(response);}
  for(const duplicate of ['Host','Origin','X-Nimlo-Launch','Sec-Fetch-Site']){
   const headers=['Host: 127.0.0.1:'+boundary.port,'Origin: '+boundary.origin,'X-Nimlo-Launch: 1','Sec-Fetch-Site: same-origin'];headers.push(duplicate+': '+({'Host':'127.0.0.1:'+boundary.port,'Origin':boundary.origin,'X-Nimlo-Launch':'1','Sec-Fetch-Site':'same-origin'}[duplicate]));
   const response=await raw(boundary,headers);assert(response.status>=400,'Duplicate '+duplicate+' admitted');assert(!/[a-f0-9]{64}/.test(response.body));
  }
  assert.equal(boundary.records().length,0);
 });
 await check('Proxy, foreign host and Fetch Metadata variants cannot spend the opener budget',async()=>{
  const variants=[...['Forwarded','X-Forwarded-For','X-Forwarded-Host','X-Real-IP','CF-Connecting-IP','CF-Ray'].map(name=>({...valid(boundary),[name]:'fixture'})),...['cross-site','same-site','none'].map(site=>({...valid(boundary),'Sec-Fetch-Site':site})),{...valid(boundary),'Sec-Fetch-Mode':'no-cors'},{...valid(boundary),'Sec-Fetch-Dest':'image'},{...valid(boundary),Host:'pc-review.example.invalid',Origin:'https://pc-review.example.invalid'},{...valid(boundary),Host:'127.0.0.1:1',Origin:'http://127.0.0.1:1'}];
  for(const headers of variants){const response=await request(boundary,{headers});assert(response.status>=400);noCredential(response);}
  const lan=Object.values(os.networkInterfaces()).flat().find(value=>value&&!value.internal&&value.family==='IPv4');
  if(lan){const response=await request(boundary,{hostname:lan.address,headers:valid(boundary)});assert.equal(response.status,403);noCredential(response);}
  assert.equal(boundary.records().length,0);
 });
 await check('Allowed opening uses only the generated private link and never signs in its caller',async()=>{
  const response=await request(boundary,{headers:{Origin:boundary.origin,'X-Nimlo-Launch':'1'},body:JSON.stringify({url:'https://attacker.example.invalid/$(false)'})});assert.equal(response.status,200);noCredential(response);assert.equal(JSON.parse(response.body).opened,true);
  await until(()=>boundary.records().length===1,'Host opener did not execute');assert.deepEqual(boundary.records()[0].args,[boundary.privateUrl]);
  const bootstrap=await request(boundary,{path:'/api/bootstrap',method:'GET'});assert.equal(bootstrap.status,401);noCredential(bootstrap);
  const concurrent=await Promise.all(Array.from({length:8},()=>request(boundary,{headers:valid(boundary)})));assert(concurrent.every(value=>value.status===429));assert.equal(boundary.records().length,1);
 });
 await stop(boundary.child);
 const hanging=await startHost('hanging','hang');
 await check('A hung OS opener is killed within its deadline and concurrent requests stay bounded',async()=>{
  const start=Date.now(),opening=request(hanging,{headers:valid(hanging)});await until(()=>hanging.records().length===1,'Hung opener never started');
  const others=await Promise.all(Array.from({length:6},()=>request(hanging,{headers:valid(hanging)})));assert(others.every(value=>value.status===429));
  const response=await opening;assert.equal(response.status,504);assert(Date.now()-start<7500,'Opener exceeded bounded deadline');noCredential(response);await until(()=>!alive(hanging.records()[0].pid),'Timed-out opener survived',1500);assert.equal(hanging.records().length,1);
 });
 await stop(hanging.child);
 browser=await playwright[engine].launch(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true}:{headless:true});
 const pcHost=await startHost('browser');const ctx=await newContext(),pc=await newPage(ctx);
 await check('A new plain localhost tab reaches a compact welcome with one usable Open editor action',async()=>{
  await pc.goto('http://localhost:'+pcHost.port+'/');await readyWelcome(pc);assert.equal(new URL(pc.url()).origin,pcHost.origin);assert(await pc.locator('#join-dialog').isHidden());
  assert(await pc.locator('#launch-link').isHidden(),'Terminal-secret paste remains the default task');assert((await pc.locator('#pc-open-editor').textContent()).includes('Open editor'));
  assert.equal((await pc.request.get(pcHost.origin+'/api/bootstrap')).status(),401);assert.equal(pcHost.records().length,0);await shot(pc,'plain-localhost-welcome');
 });
 await check('Opener success cannot claim authentication; a different profile exposes bounded fallback',async()=>{
  const bootstraps=()=>network.filter(event=>event.path==='/api/bootstrap').length;await pc.click('#pc-open-editor');await until(()=>pcHost.records().length===1,'Welcome did not invoke OS opener');
  await until(async()=>await pc.locator('#pc-launch-details').getAttribute('open')!==null,'Different-profile fallback stayed hidden',15000);
  assert(await pc.locator('#pc-welcome').isVisible());assert.notEqual(await pc.locator('#app').getAttribute('data-connected'),'yes');assert.equal((await pc.request.get(pcHost.origin+'/api/bootstrap')).status(),401);
  assert.deepEqual(pcHost.records()[0].args,[pcHost.privateUrl]);assert(await pc.locator('#launch-link').isVisible());await shot(pc,'different-browser-fallback');
  const count=bootstraps();await pause(1500);assert.equal(bootstraps(),count,'Authentication recovery kept polling while idle');
 });
 await check('Another tab using the opened private link makes the original tab usable without copied secrets',async()=>{
  await pc.click('#pc-open-editor');await until(()=>pcHost.records().length===2,'Second opener did not execute');const launched=await newPage(ctx);await launched.goto(pcHost.records()[1].args[0]);
  await connected(launched);await connected(pc);assert.equal(new URL(launched.url()).hash,'');assert.equal(await pc.locator('#launch-link').inputValue(),'');
  const cookie=(await ctx.cookies()).find(value=>value.name==='nimlo_session');assert(cookie&&cookie.httpOnly&&cookie.sameSite==='Strict');assert(!await pc.evaluate(()=>document.cookie.includes('nimlo_session')));await pc.reload();await connected(pc);await shot(pc,'original-tab-recovered');
 });
 await check('An authenticated localhost alias remains on its original origin and reuses its host cookie',async()=>{
  const aliasCtx=await newContext(),alias=await newPage(aliasCtx),url=new URL(pcHost.privateUrl);url.hostname='localhost';await alias.goto(url.href);await connected(alias);assert.equal(new URL(alias.url()).hostname,'localhost');await alias.reload();await connected(alias);assert.equal(new URL(alias.url()).hostname,'localhost');await shot(alias,'authenticated-alias-preserved');
 });
 await check('A stored pending draft prevents fresh-entry normalization from abandoning its localhost origin',async()=>{
  const host=await startHost('stored-alias-draft'),draftCtx=await newContext(),draftPage=await newPage(draftCtx);
  const key='relay-draft:'+host.workspace+':hello.txt',value=JSON.stringify({path:'hello.txt',workspacePath:host.workspace,text:'Stored local alias draft',baseRevision:0,sessionId:'disposable-prior-session'});
  await draftPage.addInitScript(({key,value})=>sessionStorage.setItem(key,value),{key,value});await draftPage.goto('http://localhost:'+host.port+'/');await readyWelcome(draftPage);
  assert.equal(new URL(draftPage.url()).hostname,'localhost');assert.equal(await draftPage.evaluate(key=>sessionStorage.getItem(key),key),value);await shot(draftPage,'stored-draft-alias-welcome');
  await draftPage.click('#pc-open-editor');await until(()=>host.records().length===1,'Draft alias opener did not execute');const expected=new URL(host.privateUrl);expected.hostname='localhost';assert.deepEqual(host.records()[0].args,[expected.href]);
  const opened=await newPage(draftCtx);await opened.goto(expected.href);await connected(opened);await connected(draftPage);assert.equal(new URL(draftPage.url()).hostname,'localhost');assert.equal(await draftPage.evaluate(key=>sessionStorage.getItem(key),key),value);
  await draftCtx.close();await stop(host.child);
 });
 await check('Loaded unacknowledged source survives lost cookies and local browser reopening without an origin hop',async()=>{
  const host=await startHost('loaded-alias-draft'),draftCtx=await newContext();
  await draftCtx.addInitScript(()=>{const Native=window.WebSocket;window.__pcReviewSockets=[];window.__pcReviewDropEdits=false;window.__pcReviewDropped=0;window.WebSocket=class extends Native{constructor(...args){super(...args);window.__pcReviewSockets.push(this);}send(text){let value;try{value=JSON.parse(text);}catch{}if(window.__pcReviewDropEdits&&['edit_file','patch_file'].includes(value?.type)){window.__pcReviewDropped++;return;}super.send(text);}};});
  const draftPage=await newPage(draftCtx),aliasUrl=new URL(host.privateUrl);aliasUrl.hostname='localhost';await draftPage.goto(aliasUrl.href);await connected(draftPage);
  await draftPage.click('#files-toggle');const expand=draftPage.locator('#file-tree .project-expand').first();if(await expand.getAttribute('aria-expanded')!=='true')await expand.click();await draftPage.locator('.tree-entry[data-path="hello.txt"][data-kind="file"]').click();await draftPage.waitForFunction(()=>document.getElementById('code-input').value==='PC entry disposable fixture\n');
  const draft='Unacknowledged alias source must survive reopening\n';await draftPage.evaluate(()=>window.__pcReviewDropEdits=true);await draftPage.fill('#code-input',draft);await draftPage.waitForFunction(()=>window.__pcReviewDropped>0);
  await draftCtx.clearCookies();await draftPage.evaluate(()=>window.__pcReviewSockets.at(-1).close());await readyWelcome(draftPage);assert.equal(new URL(draftPage.url()).hostname,'localhost');
  await draftPage.click('#pc-open-editor');await until(()=>host.records().length===1,'Loaded alias opener did not execute');assert.deepEqual(host.records()[0].args,[aliasUrl.href]);const opened=await newPage(draftCtx);await opened.goto(aliasUrl.href);await connected(opened);await connected(draftPage);
  assert.equal(await draftPage.locator('#code-input').inputValue(),draft);assert.equal(new URL(draftPage.url()).hostname,'localhost');await shot(draftPage,'loaded-draft-alias-recovered');await draftCtx.close();await stop(host.child);
 });
 await check('An older real unauthenticated bootstrap cannot repaint welcome after private-link authentication',async()=>{
  const raceCtx=await newContext(),race=await newPage(raceCtx);let release,held=false;
  const barrier=new Promise(resolve=>release=resolve);
  await race.route('**/api/bootstrap?*',async route=>{if(!held&&!route.request().headers().authorization){held=true;const response=await route.fetch();assert.equal(response.status(),401);await barrier;await route.fulfill({response});}else await route.continue();});
  await race.goto(pcHost.origin);await until(()=>held,'Initial bootstrap was not held');await race.evaluate(hash=>location.hash=hash,new URL(pcHost.privateUrl).hash);await connected(race);release();await pause(200);
  assert.equal(await race.locator('#app').getAttribute('data-connected'),'yes');assert(await race.locator('#pc-welcome').isHidden());assert(await race.locator('#join-dialog').isHidden());await shot(race,'stale-bootstrap-ignored');await race.unrouteAll({behavior:'wait'});
 });
 await check('A foreign local web page cannot trigger the opener through fetch, forms or preflight',async()=>{
  attacker=http.createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><title>Disposable foreign origin</title><iframe name="target"></iframe>');});await new Promise(resolve=>attacker.listen(0,'127.0.0.1',resolve));
  const attackCtx=await newContext();await attackCtx.addCookies(await ctx.cookies());const attackPage=await newPage(attackCtx);await attackPage.goto('http://127.0.0.1:'+attacker.address().port+'/');const count=pcHost.records().length;attackPage.__expectedPcCors=pcHost.origin+'/api/pc/open';
  await attackPage.evaluate(async origin=>{await fetch(origin+'/api/pc/open',{method:'POST',credentials:'include',headers:{'X-Nimlo-Launch':'1'}}).catch(()=>{});await fetch(origin+'/api/pc/open',{method:'POST',mode:'no-cors',credentials:'include',body:'url=ignored'}).catch(()=>{});const form=document.createElement('form');form.method='POST';form.action=origin+'/api/pc/open';form.target='target';document.body.append(form);form.submit();},pcHost.origin);
  await pause(300);assert.equal(pcHost.records().length,count);const preflight=await request(pcHost,{method:'OPTIONS',headers:{Origin:'http://127.0.0.1:'+attacker.address().port,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'X-Nimlo-Launch'}});assert(!preflight.headers['access-control-allow-origin']);
  await new Promise(resolve=>attacker.close(resolve));attacker=null;attackPage.__expectedPcCors=null;
 });
 const failure=await startHost('opener-failure','fail');
 await check('A failed OS opener gives a visible recovery path without granting access',async()=>{
  const failCtx=await newContext({width:390,height:844}),failPage=await newPage(failCtx);await failPage.goto(failure.origin);await readyWelcome(failPage);await failPage.click('#pc-open-editor');await failPage.locator('#pc-open-error').waitFor({state:'visible'});
  assert(await failPage.locator('#pc-welcome').isVisible());assert(await failPage.locator('#launch-link').isVisible());assert.equal((await failPage.request.get(failure.origin+'/api/bootstrap')).status(),401);assert.equal(failure.records().length,1);await shot(failPage,'failed-opener-phone');
  await failPage.setViewportSize({width:320,height:300});await shot(failPage,'failed-opener-narrow');
  const button=await failPage.locator('#pc-open-editor').boundingBox();assert(button&&button.height>=44&&button.x>=0&&button.x+button.width<=320);
  const scroll=await failPage.locator('#pc-welcome').evaluate(element=>({height:element.getBoundingClientRect().height,client:element.clientHeight,content:element.scrollHeight,overflow:getComputedStyle(element).overflowY,viewport:innerHeight}));
  assert(scroll.height<=scroll.viewport+1,'Recovery page exceeds the locked viewport instead of providing a scrollable fallback: '+JSON.stringify(scroll));
  await failPage.mouse.move(160,160);await failPage.mouse.wheel(0,1200);await failPage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const submit=await failPage.locator('#launch-submit').evaluate(element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,receivesTouch:element.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};});
  assert(submit.top>=0&&submit.bottom<=300&&submit.height>=44&&submit.receivesTouch,'Narrow recovery fallback remains unreachable by scrolling: '+JSON.stringify(submit));
  await shot(failPage,'failed-opener-narrow-scrolled');
 });
 await check('A localhost invitation retains its origin and never exposes the PC opener',async()=>{
  const remoteCtx=await newContext({width:390,height:844}),remote=await newPage(remoteCtx);await remote.goto('http://localhost:'+pcHost.port+'/#invite='+('b'.repeat(64)));await remote.locator('#join-form').waitFor({state:'visible'});
  assert.equal(new URL(remote.url()).hostname,'localhost');assert(await remote.locator('#pc-welcome').isHidden());assert(await remote.locator('#pc-open-editor').isHidden());assert(await remote.locator('#launch-form').isHidden());assert(await remote.locator('#join-code').isEnabled());assert.equal(new URL(remote.url()).hash,'');await shot(remote,'alias-invitation-retained');
 });
 await check('No browser exceptions or credential disclosure occurred in the reviewed workflows',async()=>{assert.deepEqual(errors,[]);for(const host of [pcHost,failure])for(const record of host.records())assert.deepEqual(record.args,[host.privateUrl]);});
 console.log('PC ENTRY FUNCTIONAL ACCEPT '+engine+' '+checks.length+' checks');
})().catch(async error=>{
 findings.push({stage,message:safe(error.stack||error)});console.error('PC ENTRY REJECT '+stage+': '+safe(error.message));process.exitCode=1;
}).finally(async()=>{
 fs.writeFileSync(path.join(artifacts,'review.json'),JSON.stringify({status:findings.length?'reject':'functional-accept-pending-visual-review',date:new Date().toISOString(),binarySha256,browserEngine:engine,realHost:true,sourceOverrides:false,disposableWorkspaces:true,fakeOsOpener:true,fakeProviders:true,checks,screenshots,network,findings,browserErrors:errors,expectedBrowserErrors,references:'tests/pc-entry-review-references/provenance.json',limits:['OS default-browser integration is emulated with an actual fake opener executable and real browser private-link navigation.','Physical devices and real platform browser handlers remain untested.','Existing browser profiles, credentials, user projects and live Nimlo hosts are never accessed.']},null,2)+'\n');
 for(const ctx of contexts)await ctx.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});if(attacker)await new Promise(resolve=>attacker.close(resolve));for(const child of [...children])await stop(child);fs.rmSync(fixture,{recursive:true,force:true});
});
