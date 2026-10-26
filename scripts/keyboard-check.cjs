#!/usr/bin/env node
'use strict';
// Real embedded browser/host test, using disposable files and no AI inference.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const playwright=require(process.env.PLAYWRIGHT_PATH||'playwright');
const engine=process.env.NIMLO_BROWSER||'chromium',repo=path.resolve(__dirname,'..'),binary=path.resolve(repo,process.env.NIMLO_BINARY||'target/release/nimlo-editor');
const sha=crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-keyboard-'))),root=path.join(tmp,'project'),other=path.join(tmp,'other'),bin=path.join(tmp,'bin');
for(const p of [root,other,bin,path.join(root,'src'),path.join(root,'src/deep'),path.join(root,'tools')])fs.mkdirSync(p,{recursive:true});
const source='alpha beta\none two three\n😀 word\nlast line\n';
fs.writeFileSync(path.join(root,'src/alpha.js'),source);fs.writeFileSync(path.join(root,'src/deep/config.js'),'first line\nsecond line\n');
fs.writeFileSync(path.join(root,'tools/config.js'),'other config fixture\n');
fs.writeFileSync(path.join(root,'space name.md'),'space fixture\n');fs.writeFileSync(path.join(root,'<img onerror=alert(1)>.md'),'inert file\n');
for(let i=0;i<100;i++)fs.writeFileSync(path.join(root,'file-'+String(i).padStart(3,'0')+'.txt'),'fixture\n');
fs.writeFileSync(path.join(other,'other.txt'),'other project\n');fs.writeFileSync(path.join(tmp,'outside.txt'),'outside\n');fs.symlinkSync(path.join(tmp,'outside.txt'),path.join(root,'escape.txt'));
for(const provider of ['codex','claude']){fs.writeFileSync(path.join(bin,provider),'#!/bin/sh\necho "Logged in using subscription"\n');fs.chmodSync(path.join(bin,provider),0o700);}
const out=process.env.NIMLO_KEYBOARD_OUTPUT ? path.resolve(process.env.NIMLO_KEYBOARD_OUTPUT) : path.join(repo,'tests','keyboard-'+engine);fs.mkdirSync(out,{recursive:true});
const checks=[],errors=[],screenshots=[];let host,browser,page,url;
function recordSocket(){
  const Original=WebSocket;window.__keys={id:0,sent:[],bootstrap:null,socket:null,holdSearchQuery:null,holdSearchId:null,heldSearchReply:null};
  window.WebSocket=class extends Original{
    constructor(...args){super(...args);window.__keys.socket=this;this.addEventListener('message',e=>{
      const m=JSON.parse(e.data);if(m.type==='bootstrap')window.__keys.bootstrap=m;
      // Delay one real host response to exercise a query changed while loading.
      if(m.requestId&&m.requestId===window.__keys.holdSearchId){window.__keys.heldSearchReply=e.data;e.stopImmediatePropagation();}
    });}
    send(raw){const request=JSON.parse(raw);window.__keys.sent.push({...request,fixturePaletteOpen:document.getElementById('command-dialog')?.open===true});
      if(request.type==='search_project_files'&&request.query===window.__keys.holdSearchQuery)window.__keys.holdSearchId=request.requestId;
      super.send(raw);
    }
  };
}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
async function shot(name){const file=name+'.png';await page.screenshot({path:path.join(out,file)});screenshots.push(file);}
async function rpc(type,fields={}){return page.evaluate(({type,fields})=>new Promise((resolve,reject)=>{const ws=window.__keys.socket,b=window.__keys.bootstrap,id='fixture-'+(++window.__keys.id);const timer=setTimeout(()=>reject(Error('RPC timeout')),10000);const receive=e=>{const m=JSON.parse(e.data);if(m.requestId===id){clearTimeout(timer);ws.removeEventListener('message',receive);m.type==='error'?reject(Error(m.message)):resolve(m);}};ws.addEventListener('message',receive);ws.send(JSON.stringify({type,projectId:b.projectId,generation:b.generation,requestId:id,...fields}));}),{type,fields});}
const shortcut=process.platform==='darwin'?'Meta':'Control';
async function open(commands=false){await page.keyboard.press(shortcut+'+'+(commands?'Shift+':'')+'p');await page.locator('#command-dialog').waitFor({state:'visible'});}
async function run(value){await open(true);await page.fill('#command-input',value);await page.keyboard.press('Enter');await page.locator('#command-dialog').waitFor({state:'hidden'});if(value===':ai')await page.waitForFunction(()=>document.getElementById('app').dataset.view==='ai'&&document.activeElement.id==='prompt');}
async function textIs(value){await page.waitForFunction(value=>document.getElementById('code-input').value===value,value);}
async function position(at){await page.waitForFunction(at=>document.getElementById('code-input').selectionStart===at,at);}
(async()=>{
 host=spawn(binary,['--workspace',root,'--state-dir',path.join(tmp,'state'),'--listen','127.0.0.1:0'],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
 url=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Host timeout')),15000);host.stdout.on('data',data=>{output+=data;const m=output.match(/http:\/\/[^\s]+\/#token=[a-f0-9]{64}/);if(m){clearTimeout(timer);resolve(m[0]);}});host.on('error',reject);});
 browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const context=await browser.newContext({viewport:{width:1280,height:800}});await context.addInitScript(recordSocket);
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.waitForFunction(()=>document.getElementById('app').dataset.controller==='yes');
 const rootId=await page.evaluate(()=>window.__keys.bootstrap.projectId);await rpc('add_project',{path:other});await rpc('select_project',{targetProjectId:rootId});
 await check('Exact embedded assets start with no shell or inference',async()=>{for(const [route,file]of[['/','index.html'],['/editor.js','editor.js'],['/app.js','app.js'],['/style.css','style.css']])assert.equal(await(await page.request.get(new URL(route,url).href)).text(),fs.readFileSync(path.join(repo,'web',file),'utf8'));assert.equal((await page.evaluate(()=>window.__keys.bootstrap)).terminal.running,false);});
 await check('Project search stays idle until a user requests it',async()=>{
   assert.equal(await page.evaluate(()=>window.__keys.sent.filter(e=>e.type==='search_project_files').length),0);
 });
 await check('Files menu exposes New file and a platform-specific Find file shortcut',async()=>{
   await page.click('#files-toggle');await page.locator('#files-menu').waitFor({state:'visible'});
   assert(await page.locator('#files-new-file').isVisible());assert(await page.locator('#files-new-file').isEnabled());
   assert(await page.locator('#find-file').isVisible());assert.equal((await page.locator('#find-file-shortcut').textContent()).replace(/\s/g,''),process.platform==='darwin'?'⌘P':'Ctrl+P');
   await shot('files-actions');await page.click('#files-new-file');await page.locator('#new-dialog').waitFor({state:'visible'});
   assert.equal(await page.evaluate(()=>document.activeElement.id),'new-path');assert(await page.locator('#files-menu').isHidden());
 });
 await check('New file rejects empty, traversal and existing paths without changing disk',async()=>{
   const creates=()=>page.evaluate(()=>window.__keys.sent.filter(e=>e.type==='create_file').length);
   const before=await creates();await page.fill('#new-path','');await page.click('#new-form button[type=submit]');
   assert(await page.locator('#new-dialog').isVisible());assert.equal(await creates(),before);
   assert.equal(await page.locator('#new-path').evaluate(e=>e.validity.valueMissing),true);
   for(const invalid of ['   ','../outside.txt','src/alpha.js']){
     await page.fill('#new-path',invalid);await page.click('#new-form button[type=submit]');await page.locator('#new-error').waitFor({state:'visible'});
     assert((await page.locator('#new-error').textContent()).trim());assert(await page.locator('#new-dialog').isVisible());
   }
   assert.equal(fs.readFileSync(path.join(tmp,'outside.txt'),'utf8'),'outside\n');assert.equal(fs.readFileSync(path.join(root,'src/alpha.js'),'utf8'),source);
 });
 await check('New file creates a nested project file and opens it ready to edit',async()=>{
   await page.fill('#new-path','src/deep/new-note.md');await page.click('#new-form button[type=submit]');await page.locator('#new-dialog').waitFor({state:'hidden'});
   await textIs('');assert.equal(fs.readFileSync(path.join(root,'src/deep/new-note.md'),'utf8'),'');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'code-input');assert.equal(await page.locator('#file-label').textContent(),'new-note.md');
   await page.keyboard.type('Created from Files.');await textIs('Created from Files.');await page.keyboard.press(shortcut+'+s');
   await page.waitForFunction(()=>document.getElementById('dirty-dot').textContent==='');assert.equal(fs.readFileSync(path.join(root,'src/deep/new-note.md'),'utf8'),'Created from Files.');
 });
 await check('File picker bounds results and browses folders using only keys',async()=>{await open();await page.waitForFunction(()=>document.querySelectorAll('.command-result').length===80);assert.equal(await page.locator('.command-result').count(),80);await page.fill('#command-input','sr');await page.waitForFunction(()=>document.querySelector('.command-result')?.textContent.includes('src/'));await page.keyboard.press('Tab');await page.waitForFunction(()=>document.getElementById('command-input').value==='src/');await page.waitForFunction(()=>document.querySelectorAll('.command-result').length===2);await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');await page.locator('#command-dialog').waitFor({state:'hidden'});await textIs(source);assert.equal(await page.evaluate(()=>document.activeElement.id),'code-input');});
 await check('Find file button searches nested basenames and disambiguates duplicate paths',async()=>{
   await page.click('#files-toggle');await page.click('#find-file');await page.locator('#command-dialog').waitFor({state:'visible'});
   assert(await page.locator('#files-menu').isHidden());assert.equal(await page.evaluate(()=>document.activeElement.id),'command-input');
   await page.fill('#command-input','CONFIG');await page.waitForFunction(()=>document.querySelectorAll('.command-result').length===2);
   const paths=await page.locator('.command-result small').allTextContents();assert.deepEqual([...paths].sort(),['src/deep/config.js','tools/config.js']);
   assert((await page.locator('.command-result > span').allTextContents()).every(label=>label==='config.js'));
   const target=paths.indexOf('src/deep/config.js');for(let i=0;i<target;i++)await page.keyboard.press('ArrowDown');
   await page.keyboard.press('Enter');await page.locator('#command-dialog').waitFor({state:'hidden'});await textIs('first line\nsecond line\n');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'code-input');
 });
 await check('Cmd/Ctrl P opens a nested basename without expanding its folders',async()=>{
   await open();await page.fill('#command-input','alpha');await page.keyboard.press('Enter');await page.locator('#command-dialog').waitFor({state:'hidden'});await textIs(source);
   const queries=await page.evaluate(()=>window.__keys.sent.filter(e=>e.type==='search_project_files').map(e=>e.query));assert(queries.includes('alpha'));
 });
 await check('Enter after a fast query change opens the latest requested match',async()=>{
   await page.evaluate(()=>window.__keys.holdSearchQuery='config');await open();await page.fill('#command-input','config');await page.waitForFunction(()=>window.__keys.heldSearchReply!==null);
   await page.fill('#command-input','alpha');await page.keyboard.press('Enter');
   await page.evaluate(()=>{const k=window.__keys,raw=k.heldSearchReply;k.holdSearchQuery=null;k.holdSearchId=null;k.heldSearchReply=null;k.socket.dispatchEvent(new MessageEvent('message',{data:raw}));});
   await page.locator('#command-dialog').waitFor({state:'hidden'});await textIs(source);
   assert.equal(await page.locator('#file-label').textContent(),'alpha.js');
 });
 await check('Fast typing and Enter open nested paths and cited lines',async()=>{await run(':e src/deep/config.js:2');await textIs('first line\nsecond line\n');await position(11);await open();await page.fill('#command-input','src/alpha.js');await page.keyboard.press('Enter');await page.locator('#command-dialog').waitFor({state:'hidden'});await textIs(source);});
 await check('Escape returns native focus and selection without opening work',async()=>{await page.locator('#code-input').evaluate(e=>e.setSelectionRange(6,10));const before=await page.evaluate(()=>window.__keys.sent.filter(e=>['open_file','edit_file','patch_file','ai_start','terminal_start'].includes(e.type)).length);await open();await page.keyboard.press('Escape');await page.locator('#command-dialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>document.activeElement.id),'code-input');assert.deepEqual(await page.locator('#code-input').evaluate(e=>[e.selectionStart,e.selectionEnd]),[6,10]);assert.equal(await page.evaluate(()=>window.__keys.sent.filter(e=>['open_file','edit_file','patch_file','ai_start','terminal_start'].includes(e.type)).length),before);});
 await check('A queued native close event preserves a newer code selection and reopened palette',async()=>{await page.evaluate(()=>{window.__paletteCloses=0;document.getElementById('command-dialog').addEventListener('close',()=>window.__paletteCloses++);});const before=await page.evaluate(()=>window.__keys.sent.filter(e=>['open_file','edit_file','patch_file','ai_start','terminal_start'].includes(e.type)).length);for(const reopen of [false,true]){await open();const expected=await page.evaluate(({reopen,meta})=>{const dialog=document.getElementById('command-dialog'),input=document.getElementById('code-input'),expected=window.__paletteCloses+1;document.querySelector('[data-close="command-dialog"]').click();input.focus({preventScroll:true});input.setSelectionRange(1,4);if(reopen){input.dispatchEvent(new KeyboardEvent('keydown',{key:'p',metaKey:meta,ctrlKey:!meta,bubbles:true,cancelable:true}));const command=document.getElementById('command-input');command.value=':stale-close-regression';command.dispatchEvent(new Event('input',{bubbles:true}));if(!dialog.open)throw Error('Palette did not reopen synchronously');}return expected;},{reopen,meta:process.platform==='darwin'});await page.waitForFunction(expected=>window.__paletteCloses>=expected,expected);assert.deepEqual(await page.locator('#code-input').evaluate(e=>[e.selectionStart,e.selectionEnd]),[1,4]);if(reopen){assert(await page.locator('#command-dialog').isVisible());assert.equal(await page.inputValue('#command-input'),':stale-close-regression');await page.keyboard.press('Escape');await page.locator('#command-dialog').waitFor({state:'hidden'});}assert.equal(await page.evaluate(()=>document.activeElement.id),'code-input');assert.deepEqual(await page.locator('#code-input').evaluate(e=>[e.selectionStart,e.selectionEnd]),[1,4]);}assert.equal(await page.evaluate(()=>window.__keys.sent.filter(e=>['open_file','edit_file','patch_file','ai_start','terminal_start'].includes(e.type)).length),before);});
 await check('Parent navigation and filenames with spaces work without mouse input',async()=>{await open();await page.fill('#command-input','src/deep/');await page.waitForFunction(()=>document.querySelector('.command-result')?.textContent.includes('config.js'));await page.keyboard.press('Alt+ArrowLeft');assert.equal(await page.inputValue('#command-input'),'src/');await page.fill('#command-input','space name.md');await page.keyboard.press('Enter');await page.locator('#command-dialog').waitFor({state:'hidden'});await textIs('space fixture\n');});
 await check('Project command switches files, AI and terminal context together',async()=>{await run(':project other');assert.equal(await page.locator('#project-label').textContent(),'other');await run(':open other.txt');await textIs('other project\n');await run(':ai');assert.equal(await page.locator('#app').getAttribute('data-view'),'ai');assert.equal(await page.locator('#ai-project-label').textContent(),'other');await run(':code');await run(':project project');await run(':e src/alpha.js');await textIs(source);});
 await check('Colon still types normally when Vim navigation is off',async()=>{await page.locator('#code-input').evaluate(e=>e.setSelectionRange(0,0));await page.keyboard.type(':');await textIs(':'+source);await page.keyboard.press(shortcut+'+z');await textIs(source);});
 await check('Opt-in Vim navigation never inserts command keys and handles Unicode',async()=>{await run(':vim on');assert.equal(await page.locator('#editor-mode').textContent(),'NORMAL');await page.locator('#code-input').evaluate(e=>e.setSelectionRange(0,0));await page.keyboard.type('wl');await position(7);await page.keyboard.type('0j');await position(11);await page.keyboard.type('kgg');await position(0);await page.keyboard.type('G');await position(33);await page.keyboard.type('ggjj');await position(25);await page.keyboard.type('l');await position(27);await page.keyboard.type('h');await position(25);await textIs(source);});
 await check('Insert and Escape preserve text; :q protects dirty buffers; :w saves',async()=>{await page.keyboard.type('gg');await page.keyboard.type('iNEW');await page.keyboard.press('Escape');await textIs('NEW'+source);assert.equal(await page.locator('#editor-mode').textContent(),'NORMAL');await page.keyboard.type(':');await page.fill('#command-input',':q');await page.keyboard.press('Enter');await page.locator('#command-error').waitFor({state:'visible'});assert(/save/i.test(await page.locator('#command-error').textContent()));await page.keyboard.press('Escape');await run(':w');assert.equal(fs.readFileSync(path.join(root,'src/alpha.js'),'utf8'),'NEW'+source);await page.keyboard.type('u');await textIs(source);await page.keyboard.press('Control+r');await textIs('NEW'+source);await run(':w');});
 await check('Vim choice persists per browser and closing a saved file uses :q',async()=>{await page.reload();await page.waitForFunction(()=>document.getElementById('app').dataset.controller==='yes');assert.equal(await page.locator('#editor-mode').textContent(),'NORMAL');await run(':q');assert.notEqual(await page.locator('#file-label').textContent(),'alpha.js');assert.equal(await page.locator('.open-file-name').filter({hasText:'alpha.js'}).count(),0);await run(':vim off');assert(await page.locator('#editor-mode').isHidden());await run(':e src/alpha.js');});
 await check('File commands reject traversal, outside roots and symlinks with a recoverable error',async()=>{for(const target of ['../outside.txt',path.join(tmp,'outside.txt'),'escape.txt']){await open(true);await page.fill('#command-input',':e '+target);await page.keyboard.press('Enter');await page.locator('#command-error').waitFor({state:'visible'});assert.equal(await page.inputValue('#command-input'),':e '+target,'Delayed close erased the new command');assert.equal(await page.inputValue('#code-input'),'NEW'+source);await page.keyboard.press('Escape');}assert.equal(fs.readFileSync(path.join(tmp,'outside.txt'),'utf8'),'outside\n');});
 await check('Hostile filenames remain text and unknown commands never execute shell text',async()=>{await open();await page.fill('#command-input','<img');await page.waitForFunction(()=>document.querySelector('.command-result')?.textContent.includes('<img'));assert.equal(await page.locator('#command-results img').count(),0);await page.keyboard.press('Escape');await open(true);await page.fill('#command-input',':!touch '+path.join(tmp,'should-not-exist'));await page.keyboard.press('Enter');await page.locator('#command-error').waitFor({state:'visible'});assert.equal(fs.existsSync(path.join(tmp,'should-not-exist')),false);await page.keyboard.press('Escape');});
 await check('AI, code and an existing terminal are reachable entirely through commands',async()=>{await run(':ai');assert.equal(await page.locator('#app').getAttribute('data-view'),'ai');await run(':terminal');await page.waitForFunction(()=>document.getElementById('terminal-panel').hidden===false);assert.equal(await page.evaluate(()=>document.activeElement.id),'terminal-command');const before=await page.evaluate(()=>window.__keys.sent.filter(e=>e.type==='terminal_start').length);await run(':code');await run(':terminal');assert.equal(await page.evaluate(()=>window.__keys.sent.filter(e=>e.type==='terminal_start').length),before);await run(':code');});
 await check('Finding a file from AI or terminal returns to the code editor',async()=>{
   for(const view of ['ai','terminal']){
     await run(':'+view);await open();await page.fill('#command-input','config');await page.keyboard.press('Enter');await page.locator('#command-dialog').waitFor({state:'hidden'});
     await page.waitForFunction(()=>document.getElementById('app').dataset.view==='code'&&document.activeElement.id==='code-input');
     assert.equal(await page.locator('#file-label').textContent(),'config.js');
   }
   await run(':code');
 });
 await check('Composition and native dialogs fence global keyboard shortcuts',async()=>{await page.locator('#code-input').focus();await page.locator('#code-input').dispatchEvent('compositionstart');await page.keyboard.press(shortcut+'+p');assert(!(await page.locator('#command-dialog').isVisible()));await page.locator('#code-input').dispatchEvent('compositionend');await open(true);await page.keyboard.press(shortcut+'+s');assert(await page.locator('#command-dialog').isVisible());await page.keyboard.press('Escape');});
 await check('Picker is scrollable and fits desktop and short phone viewports',async()=>{for(const size of [{width:1280,height:800},{width:390,height:844},{width:320,height:300}]){await page.setViewportSize(size);await open();await page.waitForFunction(()=>document.querySelectorAll('.command-result').length===80);const m=await page.evaluate(()=>{const d=document.getElementById('command-dialog').getBoundingClientRect(),r=document.getElementById('command-results'),i=document.getElementById('command-input').getBoundingClientRect();return {left:d.left,right:d.right,top:d.top,bottom:d.bottom,width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,inputHeight:i.height,scrollable:r.scrollHeight>r.clientHeight};});assert(m.left>=0&&m.right<=m.width+1&&m.top>=0&&m.bottom<=m.height+1);assert(m.documentWidth<=m.width);assert(m.inputHeight>=44);assert(m.scrollable);await shot('picker-'+size.width+'x'+size.height);await page.keyboard.press('Escape');}});
 await check('New and Find file actions stay visible and touch-sized on short phone viewports',async()=>{
   for(const size of [{width:390,height:844},{width:320,height:300}]){
     await page.setViewportSize(size);await page.click('#files-toggle');await page.locator('#files-menu').waitFor({state:'visible'});
     for(const id of ['files-new-file','find-file']){
       assert(await page.locator('#'+id).isVisible());const bounds=await page.locator('#'+id).evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height};});
       assert(bounds.left>=0&&bounds.right<=size.width&&bounds.top>=0&&bounds.bottom<=size.height);assert(bounds.height>=44);
     }
     await shot('files-actions-'+size.width+'x'+size.height);await page.click('#find-file');await page.locator('#command-dialog').waitFor({state:'visible'});
     await page.keyboard.press('Escape');await page.locator('#command-dialog').waitFor({state:'hidden'});
   }
 });
 await check('Read-only paired devices can find files while both New file actions stay disabled',async()=>{
   const NONE={editFiles:false,terminal:false,ai:false},FULL={editFiles:true,terminal:true,ai:true};
   await rpc('session_access_set',{settings:{allowDevices:true,permissions:NONE},password:null});
   const origin=new URL(url).origin,invitation=await rpc('pair_create',{origin});assert.equal(invitation.type,'pairing');
   const peerContext=await browser.newContext({viewport:{width:1100,height:800}});
   try{
     await peerContext.addInitScript(recordSocket);const response=await peerContext.request.post(origin+'/api/pair',{headers:{Origin:origin},data:{invite:invitation.invite,code:invitation.code}});
     assert.equal(response.status(),200);const peer=await peerContext.newPage();peer.on('pageerror',e=>errors.push(e.message));await peer.goto(origin);
     await peer.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes'&&!document.getElementById('join-dialog').open);
     assert(await peer.locator('#files-new-file').isDisabled());assert(await peer.locator('#new-file').isDisabled());
     await peer.click('#files-toggle');assert(await peer.locator('#files-new-file').isVisible());assert(await peer.locator('#find-file').isEnabled());
     await peer.click('#find-file');await peer.fill('#command-input','config');await peer.keyboard.press('Enter');await peer.locator('#command-dialog').waitFor({state:'hidden'});
     assert.equal(await peer.locator('#file-label').textContent(),'config.js');assert(await peer.locator('#code-input').evaluate(e=>e.readOnly));
     assert.equal(await peer.evaluate(()=>window.__keys.sent.filter(e=>e.type==='create_file').length),0);
   }finally{await peerContext.close();await rpc('session_access_set',{settings:{allowDevices:true,permissions:FULL},password:null});}
 });
 await check('No AI request, rendering errors or background file scan',async()=>{assert.deepEqual(errors,[]);const sent=await page.evaluate(()=>window.__keys.sent);assert.equal(sent.filter(e=>e.type==='ai_start').length,0);assert(sent.filter(e=>e.type==='list_project_files').every(e=>['','src','src/deep','tools'].includes(e.directory)));assert(sent.filter(e=>e.type==='search_project_files').every(e=>e.fixturePaletteOpen&&e.query.trim().length>0),'Project-wide search ran without an open, nonempty picker query');});
 console.log('KEYBOARD PASS '+engine+' '+checks.length);
})().catch(async e=>{errors.push(e.message);console.error('KEYBOARD FAIL '+e.stack);if(page)await shot('failure').catch(()=>{});process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(out,'review.json'),JSON.stringify({status:errors.length?'fail':'pass',date:new Date().toISOString(),binarySha256:sha,harnessSha256:crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),browserEngine:engine,checks,errors,screenshots,sourceOverrides:false,isolatedTemporaryWorkspace:true,realInferenceRequests:0,limits:['Physical phones and native mobile keyboards were not exercised.','Vim navigation is a documented subset, not full Vim compatibility.']},null,2)+'\n');if(browser)await browser.close();if(host){host.kill('SIGINT');await new Promise(resolve=>{host.once('exit',resolve);setTimeout(()=>{host.kill('SIGKILL');resolve();},1500).unref();});}fs.rmSync(tmp,{recursive:true,force:true});});
