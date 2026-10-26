#!/usr/bin/env node
'use strict';

// Real host + embedded UI, with disposable project/recovery roots. The optional
// test-only state getter returns metadata; it never creates a second source map.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const playwright=require(process.env.PLAYWRIGHT_PATH || path.resolve(__dirname,'../../mini_gym/node_modules/playwright'));
const WebSocket=require(process.env.NIMLO_WS_MODULE || path.resolve(__dirname,'../../mini_gym/node_modules/ws'));
const repo=path.resolve(__dirname,'..'),binary=path.resolve(repo,process.env.NIMLO_BINARY || 'target/release/nimlo-editor');
const engine=process.env.NIMLO_BROWSER || 'chromium';
assert(['chromium','webkit'].includes(engine),'Use Chromium or WebKit');
const out=path.resolve(process.env.LAZY_FILES_OUTPUT || path.join(repo,'target/lazy-files-review',engine));
const fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-lazy-files-')));
const workspace=path.join(fixture,'project'),stateDir=path.join(fixture,'state'),bin=path.join(fixture,'bin');
const checks=[],errors=[],measurements=[],contexts=[],peers=new Set(),secrets=new Set();
const shortcut=process.platform==='darwin' ? 'Meta' : 'Control';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sources=new Map();
let host,browser,context,page,launchUrl,origin,failure,stage='startup';
for(const directory of [workspace,bin,out])fs.mkdirSync(directory,{recursive:true});
for(let n=0;n<40;n++)sources.set('saved-'+String(n).padStart(2,'0')+'.txt',('file '+n+' ').padEnd(256*1024-1,'x')+'\n');
for(const [file,text] of [['dirty.txt','Keep unsaved 日本😀\n'],['second-dirty.txt','Another unsaved file\n'],['pending.txt','Pending local source\n'],['composing.txt','Composition source\n'],['device.txt','Device source\n'],['history.txt','Original 日本😀\n'],['workflow.txt','Close fixture\n']])sources.set(file,text);
for(const [file,text] of sources)fs.writeFileSync(path.join(workspace,file),text);
for(const provider of ['codex','claude'])fs.writeFileSync(path.join(bin,provider),'#!/bin/sh\nprintf "Logged in using subscription\\n"\n',{mode:0o700});

function safe(error){let value=String(error.stack || error);for(const secret of secrets)value=value.split(secret).join('[private]');return value.replace(/[a-f0-9]{64}/gi,'[hash]');}
async function until(fn,label,timeout=12000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await fn();if(value)return value;await pause(15);}throw Error('Timeout: '+label);}
async function check(name,run){stage=name;await run();checks.push(name);console.log('PASS '+name);}
async function startHost(){
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,SHELL:'/bin/sh'};delete env.ENV;delete env.BASH_ENV;
  host=spawn(binary,['--workspace',workspace,'--state-dir',stateDir,'--listen','127.0.0.1:0'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
  let output='',stderr='';host.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-2000);});
  launchUrl=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Fixture host startup: '+safe(stderr))),15000);
    host.stdout.on('data',bytes=>{output=(output+bytes).slice(-12000);const found=output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=([a-f0-9]{64})/);if(found){clearTimeout(timer);secrets.add(found[1]);resolve(found[0]);output='';}});
    host.once('error',error=>{clearTimeout(timer);reject(error);});host.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture host exited '+code+': '+safe(stderr)));});
  });origin=new URL(launchUrl).origin;
}
async function stopHost(){
  if(!host || host.exitCode!==null || host.signalCode!==null)return;
  const done=new Promise(resolve=>host.once('exit',resolve));host.kill('SIGINT');await Promise.race([done,pause(3000)]);
  if(host.exitCode===null && host.signalCode===null){host.kill('SIGKILL');await Promise.race([done,pause(2000)]);}
}
function captureSocket(){
  const Native=WebSocket;
  window.__lazyWire={socket:null,holdSend:false,holdReplies:false,outbound:[],inbound:[],events:[],sent:[]};
  window.WebSocket=class extends Native{
    constructor(...args){super(...args);const wire=window.__lazyWire;wire.socket=this;this.addEventListener('message',event=>{
      const value=JSON.parse(event.data),file=value.file;
      if(wire.holdReplies && value.requestId && ['file_patch','file_state'].includes(value.type)){event.stopImmediatePropagation();wire.inbound.push(event.data);return;}
      wire.events.push({type:value.type,path:value.path || file?.path,requestId:value.requestId,loadedPaths:value.loadedPaths,paths:value.paths});if(wire.events.length>256)wire.events.shift();
    });}
    send(raw){const value=JSON.parse(raw),wire=window.__lazyWire;wire.sent.push({type:value.type,path:value.path,requestId:value.requestId});if(wire.sent.length>128)wire.sent.shift();if(wire.holdSend && ['edit_file','patch_file'].includes(value.type)){wire.outbound.push(raw);return;}super.send(raw);}
  };
  window.__releaseLazyWire=()=>{const wire=window.__lazyWire;wire.holdSend=false;wire.holdReplies=false;for(const raw of wire.outbound.splice(0))Native.prototype.send.call(wire.socket,raw);for(const raw of wire.inbound.splice(0))wire.socket.dispatchEvent(new MessageEvent('message',{data:raw}));};
}
async function newPage(){
  context=await browser.newContext({viewport:{width:1120,height:720}});contexts.push(context);await context.addInitScript(captureSocket);
  // Serve the exact embedded asset plus a scalar-only observer inside its IIFE.
  // No product diagnostic API or persistent source-content mirror is added.
  await context.route('**/app.js',async route=>{
    try {
    const response=await route.fetch(),source=await response.text();assert.equal(hash(source),hash(fs.readFileSync(path.join(repo,'web/app.js'),'utf8')),'Stale embedded app.js');
    const anchor='\n})();';assert(source.endsWith(anchor+'\n') || source.endsWith(anchor),'App observer anchor');
    const observer=`\nwindow.__lazyState=()=>({path:state.path,projectId:state.projectId,generation:state.generation,sessionId:state.sessionId,workspacePath:state.workspacePath,recentFiles:state.recentFiles?Array.from(state.recentFiles):[],composing:!!composition,docs:Array.from(state.docs.values(),doc=>({path:doc.path,revision:doc.revision,dirty:!!doc.dirty,conflict:!!doc.conflict,closed:!!doc.closed,needsReview:!!doc.needsReview,local:doc.localText!=null,inflight:!!doc.inflight,contentBytes:new TextEncoder().encode(doc.content||'').length,localBytes:doc.localText==null?0:new TextEncoder().encode(doc.localText).length})),drafts:draftStore.usage(),renderPath:codeRender.doc?.path||null,renderBytes:codeRender.text?.length||0,typingPath:typing.doc?.path||null,findPath:fileFind?.doc?.path||null});\n`;
    const at=source.lastIndexOf(anchor);await route.fulfill({response,body:source.slice(0,at)+observer+source.slice(at)});
    } catch(error) { errors.push(safe(error));await route.abort().catch(()=>{}); }
  });
  page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(safe(error)));
  await page.goto(launchUrl);await page.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes' && !document.getElementById('join-dialog').open && typeof window.__lazyState==='function');
}
const inspect=()=>page.evaluate(()=>window.__lazyState());
async function snapshot(){const meta=await inspect(),response=await context.request.get(origin+'/api/bootstrap?'+new URLSearchParams({projectId:meta.projectId}));assert.equal(response.status(),200);return response.json();}
async function textIs(file,text=sources.get(file)){await page.waitForFunction(({file,text})=>window.__lazyState().path===file && document.getElementById('code-input').nimloEditor.value===text,{file,text});}
async function rpc(type,fields={}){
  return page.evaluate(({type,fields})=>new Promise((resolve,reject)=>{
    const socket=window.__lazyWire.socket,state=window.__lazyState(),requestId='lazy-ui-'+crypto.randomUUID();
    const timer=setTimeout(()=>{socket.removeEventListener('message',receive);reject(Error('RPC timeout '+type));},10000);
    function receive(event){const value=JSON.parse(event.data);if(value.requestId===requestId){clearTimeout(timer);socket.removeEventListener('message',receive);resolve(value);}}
    socket.addEventListener('message',receive);socket.send(JSON.stringify({type,projectId:state.projectId,generation:state.generation,requestId,...fields}));
  }),{type,fields});
}
async function success(type,fields={}){const result=await rpc(type,fields);assert.notEqual(result.type,'error',result.message);return result;}
async function open(file,text=sources.get(file)){await success('open_file',{path:file});await textIs(file,text);await until(async()=>!(await inspect()).docs.some(doc=>doc.inflight),'settled open');}
async function clickShortcut(file,text=sources.get(file)){
  if(await page.locator('#files-menu').isHidden())await page.click('#files-toggle');
  const row=page.locator('.open-file[data-path="'+file+'"]');
  await row.locator('button').first().click();await textIs(file,text);
}
async function edit(text){await page.locator('#code-input').focus();await page.keyboard.press(shortcut+'+a');await page.keyboard.insertText(text);await page.waitForFunction(text=>document.getElementById('code-input').nimloEditor.value===text,text);}
async function cleanClient(expected){await until(async()=>{const value=await inspect();return value.docs.length===expected.length && expected.every(file=>value.docs.some(doc=>doc.path===file));},'client loaded paths '+expected.join(','));}
async function connectPeer(){
  const cookie=(await context.cookies(origin)).map(item=>item.name+'='+item.value).join('; ');secrets.add(cookie);
  const peer={socket:null,sequence:0,pending:new Map(),generation:null,projectId:null};
  const socket=new WebSocket(origin.replace(/^http/,'ws')+'/ws?clientId=lazy-peer-'+crypto.randomBytes(8).toString('hex')+'&patches=1',{headers:{Origin:origin,Cookie:cookie}});peer.socket=socket;peers.add(peer);
  socket.on('error',()=>{});socket.on('message',raw=>{const value=JSON.parse(raw);if(value.type==='bootstrap'){peer.generation=value.generation;peer.projectId=value.projectId;}if(value.type==='control')peer.generation=value.generation;const waiting=peer.pending.get(value.requestId);if(waiting){clearTimeout(waiting.timer);peer.pending.delete(value.requestId);waiting.resolve(value);}});
  await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});await until(()=>peer.projectId,'peer bootstrap');
  peer.request=(type,fields={})=>new Promise((resolve,reject)=>{const requestId='lazy-peer-'+(++peer.sequence),timer=setTimeout(()=>{peer.pending.delete(requestId);reject(Error('Peer RPC timeout '+type));},10000);peer.pending.set(requestId,{resolve,reject,timer});socket.send(JSON.stringify({type,requestId,projectId:peer.projectId,generation:peer.generation,...fields}));});return peer;
}
async function peerSuccess(peer,type,fields={}){const value=await peer.request(type,fields);assert.notEqual(value.type,'error',value.message);return value;}
async function discardDevice(file){
  await page.evaluate(()=>{for(const dialog of document.querySelectorAll('dialog[open]'))if(dialog.id!=='join-dialog')dialog.close();});
  if(await page.locator('#files-menu').isHidden())await page.click('#files-toggle');
  let confirmed=false;
  const accept=dialog=>{confirmed=true;dialog.accept().catch(()=>{});};page.once('dialog',accept);
  try {
    await page.getByRole('button',{name:'Close '+file,exact:true}).click();
    await until(async()=>!(await inspect()).docs.some(doc=>doc.path===file),'discard fixture local draft');
    assert(confirmed,'Discarding a device draft requires explicit confirmation');
  } finally { page.off('dialog',accept); }
}

(async()=>{
  await startHost();browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});await newPage();
  await check('Forty saved files can be visited without retaining their source buffers',async()=>{
    for(let n=0;n<40;n++){
      const file='saved-'+String(n).padStart(2,'0')+'.txt';await open(file);await cleanClient([file]);
      const server=await snapshot();assert.deepEqual(server.openFiles.map(doc=>doc.path),[file]);assert(server.recentFiles.length<=32);assert(Buffer.byteLength(server.recentFiles.join(''))<=16*1024);
    }
    const server=await snapshot(),client=await inspect();assert.equal(server.recentFiles.length,32);assert.equal(client.recentFiles.length,32);
    assert(!server.recentFiles.includes('saved-00.txt'));assert(server.recentFiles.includes('saved-39.txt'));
    const retainedBytes=server.openFiles.reduce((sum,doc)=>sum+Buffer.byteLength(doc.content),0);
    measurements.push({case:'forty-saved-files',visitedFiles:40,visitedSourceBytes:40*256*1024,serverLoadedFiles:server.openFiles.length,serverContentBytes:retainedBytes,clientLoadedFiles:client.docs.length,clientContentBytes:client.docs.reduce((sum,doc)=>sum+doc.contentBytes,0),shortcutCount:server.recentFiles.length,bootstrapBytes:Buffer.byteLength(JSON.stringify(server)),scope:'Retained document source bytes, not total process or OS memory'});
    assert.equal(retainedBytes,256*1024);assert.equal(client.docs[0].contentBytes,retainedBytes);
    for(const retainedPath of [client.renderPath,client.typingPath,client.findPath])assert(!retainedPath || retainedPath==='saved-39.txt','A render/search/typing cache retained an inactive clean file');
  });
  await check('Reopening a shortcut reads external disk changes and uses a fresh revision',async()=>{
    await open('saved-38.txt');const old=(await inspect()).docs[0].revision;await open('saved-39.txt');
    const text='Changed outside Nimlo 日本😀\n';fs.writeFileSync(path.join(workspace,'saved-38.txt'),text);sources.set('saved-38.txt',text);
    await clickShortcut('saved-38.txt');await cleanClient(['saved-38.txt']);assert((await inspect()).docs[0].revision>old);
    const stale=await rpc('edit_file',{path:'saved-38.txt',baseRevision:old,content:'stale old buffer'});assert.equal(stale.type,'error');await textIs('saved-38.txt');assert.equal(fs.readFileSync(path.join(workspace,'saved-38.txt'),'utf8'),text);
  });
  await check('Saved-file shortcuts preserve Undo and Redo while source buffers stay unloaded',async()=>{
    const file='history.txt',original=sources.get(file),saved='Saved 日本😀\n',changed='Later edit\n';
    await open(file);await edit(saved);await page.keyboard.press(shortcut+'+s');
    await page.waitForFunction(()=>document.getElementById('save-button').hidden);
    await edit(changed);await page.keyboard.press(shortcut+'+z');await textIs(file,saved);
    await open('saved-39.txt');await cleanClient(['saved-39.txt']);
    assert.deepEqual((await snapshot()).openFiles.map(doc=>doc.path),['saved-39.txt']);
    await clickShortcut(file,saved);await page.locator('#code-input').focus();
    await page.keyboard.press(shortcut+'+Shift+z');await textIs(file,changed);
    await page.keyboard.press(shortcut+'+z');await textIs(file,saved);
    await page.keyboard.press(shortcut+'+z');await textIs(file,original);
    await page.keyboard.press(shortcut+'+Shift+z');await textIs(file,saved);
    assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),saved);sources.set(file,saved);
    await open('saved-39.txt');await success('close_file',{path:file,revision:0,discard:false});
    await open(file);const result=await rpc('undo_file',{path:file,revision:(await inspect()).docs.find(doc=>doc.path===file).revision});
    assert.equal(result.type,'error');assert.equal(result.code,'history');await open('saved-39.txt');
  });
  await check('Close File offers Cancel, Save and Don’t Save without changing disk on cancellation',async()=>{
    const file='workflow.txt',original=sources.get(file),changed='Save this change 日本😀\n';
    await open(file);await edit(changed);await until(async()=>!(await inspect()).docs.find(doc=>doc.path===file)?.inflight,'settled close fixture');
    if(await page.locator('#files-menu').isHidden())await page.click('#files-toggle');
    await page.getByRole('button',{name:'Close '+file,exact:true}).click();
    await page.locator('#close-file-dialog').waitFor({state:'visible'});
    await page.click('#close-file-dialog button[value=cancel]');await page.locator('#close-file-dialog').waitFor({state:'hidden'});
    await textIs(file,changed);assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),original);
    await page.evaluate(()=>window.nimloDesktop.closeFile());await page.locator('#close-file-dialog').waitFor({state:'visible'});
    await page.keyboard.press('Escape');await page.locator('#close-file-dialog').waitFor({state:'hidden'});await textIs(file,changed);
    await page.evaluate(()=>window.nimloDesktop.closeFile());await page.locator('#close-file-dialog').waitFor({state:'visible'});
    await page.click('#close-file-save');await until(async()=>!(await inspect()).docs.some(doc=>doc.path===file),'saved file closes');
    assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),changed);sources.set(file,changed);
    await open(file);await edit('Discard this change\n');await page.evaluate(()=>window.nimloDesktop.closeFile());
    await page.locator('#close-file-dialog').waitFor({state:'visible'});await page.click('#close-file-dialog button[value=discard]');
    await until(async()=>!(await inspect()).docs.some(doc=>doc.path===file),'discarded file closes');
    assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),changed);await open('saved-39.txt');
  });
  await check('A concurrent edit cannot be discarded using an older Close File decision',async()=>{
    const file='workflow.txt',changed='Concurrent device edit\n';
    await open(file);await edit('First draft\n');await page.evaluate(()=>window.nimloDesktop.closeFile());
    await page.locator('#close-file-dialog').waitFor({state:'visible'});
    const doc=(await inspect()).docs.find(doc=>doc.path===file);
    await success('edit_file',{path:file,baseRevision:doc.revision,content:changed});await textIs(file,changed);
    await page.click('#close-file-dialog button[value=discard]');
    await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('changed while you were deciding'));
    await textIs(file,changed);assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),sources.get(file));
    await page.evaluate(()=>window.nimloDesktop.closeFile());await page.locator('#close-file-dialog').waitFor({state:'visible'});
    await page.click('#close-file-save');await until(async()=>!(await inspect()).docs.some(doc=>doc.path===file),'newer draft saved before close');
    assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),changed);sources.set(file,changed);await open('saved-39.txt');
  });
  await check('A deleted shortcut reports an error while preserving the selected file',async()=>{
    await open('saved-39.txt');fs.unlinkSync(path.join(workspace,'saved-38.txt'));const before=await inspect();
    const result=await rpc('select_file',{path:'saved-38.txt'});assert.equal(result.type,'error');await textIs('saved-39.txt');
    assert.deepEqual((await snapshot()).openFiles.map(doc=>doc.path),['saved-39.txt']);assert.equal((await inspect()).path,before.path);
    fs.writeFileSync(path.join(workspace,'saved-38.txt'),sources.get('saved-38.txt'));
  });
  await check('Unsaved inactive files remain loaded and recover after a host restart',async()=>{
    for(const file of ['dirty.txt','second-dirty.txt']){await open(file);const state=await inspect(),doc=state.docs.find(doc=>doc.path===file);await success('edit_file',{path:file,baseRevision:doc.revision,content:sources.get(file)+'UNSAVED\n'});}
    await open('saved-39.txt');await cleanClient(['dirty.txt','second-dirty.txt','saved-39.txt']);
    const before=await snapshot();assert.equal(before.openFiles.filter(doc=>doc.dirty).length,2);
    for(const file of ['dirty.txt','second-dirty.txt'])assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),sources.get(file));
    await page.close({runBeforeUnload:false});await context.close();await stopHost();await startHost();await newPage();
    const recovered=await snapshot();assert.deepEqual(recovered.openFiles.map(doc=>doc.path).sort(),['dirty.txt','second-dirty.txt','saved-39.txt'].sort());
    for(const file of ['dirty.txt','second-dirty.txt']){const doc=recovered.openFiles.find(doc=>doc.path===file);assert.equal(doc.content,sources.get(file)+'UNSAVED\n');assert(doc.dirty);}
    assert(recovered.recentFiles.length<=32);await textIs('saved-39.txt');
    measurements.push({case:'restart-with-unsaved-files',serverLoadedFiles:recovered.openFiles.length,dirtyFiles:recovered.openFiles.filter(doc=>doc.dirty).length,shortcutCount:recovered.recentFiles.length});
  });
  const peer=await connectPeer();
  await check('An inactive file is unloaded after its save without discarding pending request state',async()=>{
    await open('pending.txt');await page.evaluate(()=>window.__lazyWire.holdReplies=true);const text=sources.get('pending.txt')+'Acknowledged input\n';await edit(text);
    await until(async()=>{const value=await peerSuccess(peer,'file_sync',{path:'pending.txt'});return value.file.content===text;},'host acknowledged pending edit');
    await until(async()=>(await inspect()).docs.find(doc=>doc.path==='pending.txt')?.inflight,'held edit request');
    await peerSuccess(peer,'open_file',{path:'saved-39.txt'});await textIs('saved-39.txt');
    const current=await peerSuccess(peer,'file_sync',{path:'pending.txt'});await peerSuccess(peer,'save_file',{path:'pending.txt',revision:current.file.revision});
    assert((await inspect()).docs.some(doc=>doc.path==='pending.txt' && doc.inflight),'Request state was dropped before it settled');
    await page.evaluate(()=>window.__releaseLazyWire());await cleanClient(['dirty.txt','second-dirty.txt','saved-39.txt']);
    assert.equal(fs.readFileSync(path.join(workspace,'pending.txt'),'utf8'),text);sources.set('pending.txt',text);
    assert.deepEqual((await snapshot()).openFiles.map(doc=>doc.path).sort(),['dirty.txt','second-dirty.txt','saved-39.txt'].sort());
  });
  await check('A peer opening another file preserves unsent local text as a device draft',async()=>{
    await open('pending.txt');await page.evaluate(()=>window.__lazyWire.holdSend=true);const text=sources.get('pending.txt')+'Device-only typing\n';await edit(text);
    await page.waitForFunction(()=>window.__lazyWire.outbound.length>0);await peerSuccess(peer,'open_file',{path:'saved-39.txt'});await textIs('saved-39.txt');
    const draft=(await inspect()).docs.find(doc=>doc.path==='pending.txt');assert(draft?.local && draft.closed);assert.equal(draft.localBytes,Buffer.byteLength(text));
    assert.equal(fs.readFileSync(path.join(workspace,'pending.txt'),'utf8'),sources.get('pending.txt'));
    await page.evaluate(()=>window.__releaseLazyWire());await until(async()=>!(await inspect()).docs.find(doc=>doc.path==='pending.txt')?.inflight,'failed pending edit settled');
    const kept=(await inspect()).docs.find(doc=>doc.path==='pending.txt');assert(kept?.local && kept.closed);assert((await inspect()).drafts.count>=1);await discardDevice('pending.txt');
  });
  await check('Synthetic composition remains attached to its original file during a peer selection',async()=>{
    await open('composing.txt');const text=sources.get('composing.txt')+'日本';
    await page.evaluate(text=>{const input=document.getElementById('code-input');input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));input.nimloEditor.value=text;input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'日本',isComposing:true}));},text);
    await peerSuccess(peer,'open_file',{path:'saved-39.txt'});const during=await inspect();assert(during.composing);assert.equal(during.path,'composing.txt');assert(during.docs.find(doc=>doc.path==='composing.txt')?.local);
    assert.equal(await page.locator('#code-input').evaluate(input=>input.nimloEditor.value),text);
    await page.evaluate(()=>document.getElementById('code-input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'日本'})));
    await textIs('saved-39.txt');const draft=(await inspect()).docs.find(doc=>doc.path==='composing.txt');assert(draft?.closed && draft.local && draft.needsReview);assert.equal(draft.localBytes,Buffer.byteLength(text));
    assert.equal(fs.readFileSync(path.join(workspace,'composing.txt'),'utf8'),sources.get('composing.txt'));await discardDevice('composing.txt');
  });
  await check('An existing device draft restores for review when its unloaded shortcut is reopened',async()=>{
    await open('device.txt');await open('saved-39.txt');const meta=await inspect(),text='Previously unsent device text 日本😀\n';
    await page.evaluate(({meta,text})=>sessionStorage.setItem('relay-draft:'+meta.workspacePath+':device.txt',JSON.stringify({path:'device.txt',workspacePath:meta.workspacePath,sessionId:'prior-session',baseRevision:1,text})),{meta,text});
    await success('open_file',{path:'device.txt'});await page.waitForFunction(()=>document.getElementById('conflict-dialog').open);const draft=(await inspect()).docs.find(doc=>doc.path==='device.txt');assert(draft?.local && draft.needsReview);assert.equal(draft.localBytes,Buffer.byteLength(text));
    assert.equal(fs.readFileSync(path.join(workspace,'device.txt'),'utf8'),sources.get('device.txt'));
  });
  await check('The real UI reports no browser exceptions',async()=>{assert.deepEqual(errors,[]);});
})().catch(async error=>{process.exitCode=1;errors.push(stage+': '+safe(error));console.error(errors.at(-1));
  if(page && !page.isClosed())failure=await page.evaluate(()=>({state:window.__lazyState?.(),dialogs:Array.from(document.querySelectorAll('dialog[open]'),dialog=>dialog.id),rows:Array.from(document.querySelectorAll('.open-file'),row=>({path:row.dataset.path,status:row.dataset.state,closeDisabled:row.lastElementChild?.disabled})),notice:document.getElementById('notice')?.textContent})).catch(()=>null);
}).finally(async()=>{
  for(const peer of peers){for(const waiting of peer.pending.values()){clearTimeout(waiting.timer);waiting.reject(Error('Fixture finished'));}peer.pending.clear();peer.socket.terminate();}
  for(const item of contexts)await item.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});await stopHost();
  const report={status:process.exitCode?'fail':'pass',engine,checks,measurements,errors,failure,assets:{appJs:hash(fs.readFileSync(path.join(repo,'web/app.js')))},fixtureOnly:true,measurementLimit:'Content-byte accounting excludes allocator, WebKit, native wrapper and OS caches. Composition race uses synthetic events, not physical IME qualification.'};
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('Report '+path.join(out,'report.json'));
});
