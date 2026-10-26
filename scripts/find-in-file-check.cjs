#!/usr/bin/env node
'use strict';

// Exercise the real embedded editor and host in a disposable workspace. Search
// must remain local, preserve file bytes, and navigate whole-document offsets.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const playwright=require(process.env.PLAYWRIGHT_PATH || 'playwright');
const engine=process.env.NIMLO_BROWSER || 'chromium';
assert(['chromium','webkit'].includes(engine),'Use Chromium or WebKit');
const repo=path.resolve(__dirname,'..');
const binary=path.resolve(repo,process.env.NIMLO_BINARY || 'target/release/nimlo-editor');
const out=path.resolve(process.env.FIND_IN_FILE_OUTPUT || path.join(repo,'target/find-in-file-review',engine));
const fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-find-in-file-')));
const workspace=path.join(fixture,'project');
const bin=path.join(fixture,'bin');
const home=path.join(fixture,'home');
const providerLog=path.join(fixture,'provider-probes.txt');
const shortcut=process.platform==='darwin' ? 'Meta' : 'Control';
const normal='Alpha alpha ALPHA\nliteral .* [x] (a)+\n日本😀 one\ncafé CAFÉ\nlast alpha\n';
const lowNeedle='日本😀TaRGet';
const lowPrefix='😀 café\tconst x = 42; '.repeat(18000);
const lowline=lowPrefix+lowNeedle+'\n'+('wide\t日本 😀 '.repeat(12000))+lowNeedle+'\nend';
const tall=('retained line\n').repeat(11000)+'offscreen-needle\nend';
const dense='a'.repeat(1_000_000)+'\nEND';
const sources={'normal.txt':normal,'other.txt':'Other project file\nalpha once\n','few-unicode.txt':lowline,'many-lines.txt':tall,'dense.txt':dense};
const checks=[],errors=[],measurements=[],screenshots=[],contexts=[];
let host,browser,page,url,currentPath,stage='startup';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sanitized=value=>String(value).replace(/[a-f0-9]{64}/gi,'[private]');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
for(const directory of [workspace,bin,home,out])fs.mkdirSync(directory,{recursive:true});
for(const [file,source] of Object.entries(sources))fs.writeFileSync(path.join(workspace,file),source);
for(const provider of ['codex','claude'])fs.writeFileSync(path.join(bin,provider),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$NIMLO_FIND_PROVIDER_LOG"\nprintf "Logged in using subscription\\n"\n',{mode:0o700});

function captureSocket(){
  const Original=WebSocket;
  window.__findReview={documents:{},activePath:null,sent:[],socket:null,bootstrap:null,id:0};
  window.WebSocket=class extends Original{
    constructor(...args){
      super(...args); window.__findReview.socket=this;
      this.addEventListener('message',event=>{
        const message=JSON.parse(event.data),capture=window.__findReview;
        if(message.type==='bootstrap'){
          capture.bootstrap=message; capture.activePath=message.activePath;
          for(const file of message.openFiles || [])capture.documents[file.path]={...file};
        }
        if(message.type==='file_state')capture.documents[message.file.path]={...message.file};
        if(message.type==='file_patch'){
          const previous=capture.documents[message.file.path];
          if(previous?.revision===message.baseRevision){
            const patch=message.patch;
            capture.documents[message.file.path]={...previous,...message.file,content:previous.content.slice(0,patch.start)+patch.insert+previous.content.slice(patch.start+patch.deleteCount)};
          }
        }
        if(message.type==='file_closed')delete capture.documents[message.path];
        if(message.type==='active_file')capture.activePath=message.path;
        if(message.activePath!==undefined)capture.activePath=message.activePath;
      });
    }
    send(raw){const message=JSON.parse(raw);window.__findReview.sent.push({type:message.type,path:message.path,requestId:message.requestId});super.send(raw);}
  };
}
async function check(name,run){stage=name;await run();checks.push(name);console.log('PASS '+name);}
async function textIs(text,target=page){await target.waitForFunction(text=>document.getElementById('code-input').nimloEditor.value===text,text);}
async function select(start,end=start,direction='none',target=page){
  await target.evaluate(({start,end,direction})=>{
    const input=document.getElementById('code-input'),editor=input.nimloEditor;
    editor.setSelectionRange(start,end,direction);editor.reveal();input.focus({preventScroll:true});
  },{start,end,direction});
}
async function selectionIs(start,end=start,target=page){
  await target.waitForFunction(({start,end})=>{
    const editor=document.getElementById('code-input').nimloEditor;
    return editor.selectionStart===start && editor.selectionEnd===end;
  },{start,end});
}
async function palette(command){
  await page.keyboard.press(shortcut+'+Shift+p');await page.locator('#command-dialog').waitFor({state:'visible'});
  await page.fill('#command-input',command);await page.keyboard.press('Enter');await page.locator('#command-dialog').waitFor({state:'hidden'});
}
async function openPath(file){
  await closeFind();currentPath=file;await palette(':e '+file);
  await page.waitForFunction(file=>window.__findReview.activePath===file && !document.getElementById('code-input').readOnly,file);
  await page.locator('#code-input').focus();await textIs(sources[file]);
}
async function openFind(target=page,modifier=shortcut){
  await target.keyboard.press(modifier+'+f');await target.locator('#file-find').waitFor({state:'visible'});
  await target.waitForFunction(()=>document.activeElement.id==='file-find-input');
}
async function closeFind(target=page){
  if(await target.locator('#file-find').isVisible()){
    await target.locator('#file-find-input').focus();await target.keyboard.press('Escape');await target.locator('#file-find').waitFor({state:'hidden'});
  }
}
async function query(value,target=page){await target.fill('#file-find-input',value);}
async function queryFromStart(value,target=page){await target.evaluate(()=>window.nimloEditor.setSelectionRange(0,0));await query(value,target);}
async function countIs(current,total,target=page){
  await target.waitForFunction(({current,total})=>{
    const text=document.getElementById('file-find-count').textContent.trim();
    const numbers=text.match(/[\d,]+/g)?.map(value=>Number(value.replaceAll(',',''))) || [];
    return numbers.length===2 && numbers[0]===current && numbers[1]===total;
  },{current,total});
}
async function noMutations(target=page){
  return target.evaluate(()=>window.__findReview.sent.filter(message=>['edit_file','patch_file','undo_file','redo_file','save_file','ai_start','terminal_start','terminal_input'].includes(message.type)));
}
async function rpc(type,fields={},target=page){
  return target.evaluate(({type,fields})=>new Promise((resolve,reject)=>{
    const review=window.__findReview,socket=review.socket,b=review.bootstrap,requestId='find-fixture-'+(++review.id);
    const timer=setTimeout(()=>{socket.removeEventListener('message',receive);reject(Error('Fixture RPC timeout: '+type));},10000);
    const receive=event=>{const reply=JSON.parse(event.data);if(reply.requestId===requestId){clearTimeout(timer);socket.removeEventListener('message',receive);reply.type==='error' ? reject(Error(reply.message)) : resolve(reply);}};
    socket.addEventListener('message',receive);socket.send(JSON.stringify({type,projectId:b.projectId,generation:b.generation,requestId,...fields}));
  }),{type,fields});
}
async function newContext(){const context=await browser.newContext({viewport:{width:1120,height:720}});contexts.push(context);await context.addInitScript(captureSocket);return context;}
async function newPage(context,launchUrl){
  const target=await context.newPage();target.setDefaultTimeout(10000);target.on('pageerror',error=>errors.push(sanitized(error.message)));
  await target.goto(launchUrl);await target.waitForFunction(()=>document.getElementById('app').dataset.connected==='yes' && !document.getElementById('join-dialog').open && window.__findReview.bootstrap!==null);return target;
}
async function startHost(){
  const env={...process.env,HOME:home,PATH:bin+path.delimiter+process.env.PATH,NIMLO_FIND_PROVIDER_LOG:providerLog};delete env.ENV;delete env.BASH_ENV;
  host=spawn(binary,['--workspace',workspace,'--state-dir',path.join(fixture,'state'),'--listen','127.0.0.1:0'],{env,stdio:['ignore','pipe','pipe']});
  let output='',stderr='';host.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-2000);});
  url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Fixture host timed out: '+sanitized(stderr))),15000);
    host.stdout.on('data',bytes=>{output=(output+bytes).slice(-12000);const match=output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/);if(match){clearTimeout(timer);resolve(match[0]);output='';}});
    host.once('error',error=>{clearTimeout(timer);reject(error);});host.once('exit',code=>{clearTimeout(timer);reject(Error('Fixture host exited '+code+': '+sanitized(stderr)));});
  });
}
async function stopHost(){
  if(!host || host.exitCode!==null || host.signalCode!==null)return;
  const exited=new Promise(resolve=>host.once('exit',resolve));host.kill('SIGINT');await Promise.race([exited,delay(3000)]);
  if(host.exitCode===null && host.signalCode===null){host.kill('SIGKILL');await Promise.race([exited,delay(2000)]);}
}
async function shot(name){const file=name+'.png';await page.screenshot({path:path.join(out,file)});screenshots.push(file);}

(async()=>{
  await startHost();browser=await playwright[engine].launch({headless:true,...(engine==='chromium' ? {executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'} : {})});
  const context=await newContext();page=await newPage(context,url);await page.waitForFunction(()=>document.getElementById('app').dataset.controller==='yes');
  await check('Release serves the exact current embedded editor assets',async()=>{
    for(const [route,file] of [['/','index.html'],['/editor.js','editor.js'],['/app.js','app.js'],['/style.css','style.css']])assert.equal(await(await page.request.get(new URL(route,url).href)).text(),fs.readFileSync(path.join(repo,'web',file),'utf8'),'Stale embedded '+file);
    assert(await page.locator('#file-find').isHidden());
  });
  await openPath('normal.txt');
  await check('Cmd/Ctrl F focuses search and prefills the selected source text',async()=>{
    await select(0,5);await openFind();assert.equal(await page.inputValue('#file-find-input'),'Alpha');
    assert.deepEqual(await page.locator('#file-find-input').evaluate(input=>[input.selectionStart,input.selectionEnd]),[0,5]);
    await selectionIs(0,5);await countIs(1,4);await shot('find-normal');
  });
  await check('Enter and Shift Enter move through case-insensitive matches and wrap',async()=>{
    await page.keyboard.press('Enter');await selectionIs(6,11);await countIs(2,4);
    await page.keyboard.press('Shift+Enter');await selectionIs(0,5);await countIs(1,4);
    const last=normal.lastIndexOf('alpha');await page.keyboard.press('Shift+Enter');await selectionIs(last,last+5);await countIs(4,4);
    await page.keyboard.press('Enter');await selectionIs(0,5);await countIs(1,4);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'file-find-input');
  });
  await check('Match case is optional and resets neither text nor editor history',async()=>{
    assert.equal(await page.locator('#file-find-case').getAttribute('aria-pressed'),'false');
    await queryFromStart('alpha');await page.click('#file-find-case');
    assert.equal(await page.locator('#file-find-case').getAttribute('aria-pressed'),'true');
    await page.waitForFunction(()=>/of 2$/.test(document.getElementById('file-find-count').textContent.trim()));
    const selected=await page.evaluate(()=>window.nimloEditor.value.slice(window.nimloEditor.selectionStart,window.nimloEditor.selectionEnd));assert.equal(selected,'alpha');
    await page.click('#file-find-case');assert.equal(await page.locator('#file-find-case').getAttribute('aria-pressed'),'false');
    await page.waitForFunction(()=>/of 4$/.test(document.getElementById('file-find-count').textContent.trim()));await textIs(normal);
  });
  await check('Search treats regular-expression punctuation as literal text',async()=>{
    await query('.*');const at=normal.indexOf('.*');await selectionIs(at,at+2);await countIs(1,1);
    for(const needle of ['[x]','(a)+']){await query(needle);const at=normal.indexOf(needle);await selectionIs(at,at+needle.length);await countIs(1,1);}
  });
  await check('No-match and empty searches have a clear status and do not edit source',async()=>{
    const before=await noMutations();await query('this text does not exist');
    await page.waitForFunction(()=>/no (?:results|matches)|0\s*(?:of|\/)\s*0/i.test(document.getElementById('file-find-count').textContent));
    assert(await page.locator('#file-find-next').isDisabled());assert(await page.locator('#file-find-previous').isDisabled());
    await page.keyboard.press('Enter');await page.keyboard.press('Shift+Enter');await textIs(normal);
    await query('');assert(await page.locator('#file-find-next').isDisabled());assert(await page.locator('#file-find-previous').isDisabled());
    assert.deepEqual(await noMutations(),before);
  });
  await check('Closing search returns code focus at the selected match',async()=>{
    await query('last');const at=normal.indexOf('last');await selectionIs(at,at+4);await page.keyboard.press('Escape');
    await page.locator('#file-find').waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement.id==='code-input');await selectionIs(at,at+4);
    await openFind();await query('literal');const literal=normal.indexOf('literal');await selectionIs(literal,literal+7);await page.click('#file-find-close');
    await page.locator('#file-find').waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement.id==='code-input');await selectionIs(literal,literal+7);
  });
  await check('A multiline selection does not replace the search field with document text',async()=>{
    const remembered=await page.inputValue('#file-find-input');await select(0,normal.length,'forward');await openFind();
    assert.equal(await page.inputValue('#file-find-input'),remembered);assert.equal(await page.locator('#file-find-input').getAttribute('maxlength'),'1024');await textIs(normal);await closeFind();
  });
  await check('Both command and control find shortcuts reach the editor search',async()=>{
    for(const modifier of ['Meta','Control']){await select(0);await openFind(page,modifier);await queryFromStart('alpha');await countIs(1,4);await closeFind();}
  });
  await check('The Files action and Cmd/Ctrl G shortcuts expose the same search',async()=>{
    await select(0);await page.click('#files-toggle');await page.click('#find-in-file');
    assert(await page.locator('#files-menu').isHidden());await page.locator('#file-find').waitFor({state:'visible'});await queryFromStart('alpha');await countIs(1,4);
    await page.keyboard.press(shortcut+'+g');await selectionIs(6,11);await countIs(2,4);
    await page.keyboard.press(shortcut+'+Shift+g');await selectionIs(0,5);await countIs(1,4);await closeFind();
  });
  await check('Cmd/Ctrl G from a closed search navigates once without skipping a match',async()=>{
    await select(0);await openFind();await queryFromStart('alpha');await closeFind();await select(0);
    await page.keyboard.press(shortcut+'+g');await page.locator('#file-find').waitFor({state:'visible'});await selectionIs(0,5);await countIs(1,4);
    await closeFind();await select(0,5);await page.keyboard.press(shortcut+'+g');await selectionIs(6,11);await countIs(2,4);await closeFind();
  });
  await check('Search shortcuts do not move the code selection while writing an AI prompt',async()=>{
    await select(0);await openFind();await queryFromStart('alpha');await countIs(1,4);await palette(':ai');await page.fill('#prompt','A local unsent alpha draft');
    await page.keyboard.press(shortcut+'+g');await page.keyboard.press(shortcut+'+Shift+g');await selectionIs(0,5);await countIs(1,4);assert.equal(await page.inputValue('#prompt'),'A local unsent alpha draft');
    assert.equal(await page.evaluate(()=>document.getElementById('app').dataset.view),'ai');await page.keyboard.press(shortcut+'+f');await selectionIs(0,5);assert.equal(await page.inputValue('#prompt'),'A local unsent alpha draft');
    await page.fill('#prompt','');await palette(':code');await closeFind();
  });
  await check('The native Find bridge reveals code and navigates from the AI view',async()=>{
    await select(0);await openFind();await queryFromStart('alpha');await palette(':ai');
    assert.equal(await page.evaluate(()=>window.nimloDesktop.findNext()),true);await page.waitForFunction(()=>document.getElementById('app').dataset.view==='code');await selectionIs(6,11);await countIs(2,4);
    assert.equal(await page.evaluate(()=>window.nimloDesktop.findPrevious()),true);await selectionIs(0,5);await countIs(1,4);await closeFind();
  });
  await check('Native Undo and Redo use shared document history',async()=>{
    await select(0);await page.keyboard.insertText('changed ');await textIs('changed '+normal);
    assert.equal(await page.evaluate(()=>window.nimloDesktop.undo()),true);await textIs(normal);
    assert.equal(await page.evaluate(()=>window.nimloDesktop.redo()),true);await textIs('changed '+normal);
    assert.equal(await page.evaluate(()=>window.nimloDesktop.undo()),true);await textIs(normal);
  });
  await check('Native history leaves text fields alone and native Save respects dialogs and composition',async()=>{
    await select(0,5);await openFind();const before=await noMutations();
    assert.equal(await page.evaluate(()=>window.nimloDesktop.undo()),false);
    assert.equal(await page.evaluate(()=>window.nimloDesktop.redo()),false);
    assert.deepEqual(await noMutations(),before);await closeFind();
    await page.keyboard.press(shortcut+'+Shift+p');await page.locator('#command-dialog').waitFor({state:'visible'});
    assert.equal(await page.evaluate(()=>window.nimloDesktop.save()),false);
    assert.equal(await page.evaluate(()=>window.nimloDesktop.undo()),false);
    await page.keyboard.press('Escape');await page.locator('#command-dialog').waitFor({state:'hidden'});
    await page.evaluate(()=>{document.getElementById('app').dataset.composing='true';});
    try{
      assert.equal(await page.evaluate(()=>window.nimloDesktop.save()),false);
      assert.equal(await page.evaluate(()=>window.nimloDesktop.undo()),true);
      await page.waitForTimeout(50);assert.deepEqual(await noMutations(),before);await textIs(normal);
    }finally{await page.evaluate(()=>{document.getElementById('app').dataset.composing='false';});}
  });
  await check('The compact search remains usable in a narrow viewport',async()=>{
    await page.setViewportSize({width:320,height:300});await select(0);await openFind();await queryFromStart('alpha');await countIs(1,4);
    const bounds=await page.locator('#file-find').evaluate(bar=>{const r=bar.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width};});
    assert(bounds.left>=-1 && bounds.right<=321 && bounds.top>=-1 && bounds.bottom<=301,JSON.stringify(bounds));
    for(const id of ['file-find-input','file-find-next','file-find-previous','file-find-close'])assert(await page.locator('#'+id).isVisible(),id);
    await shot('find-narrow');measurements.push({case:'narrow-search-toolbar',...bounds});await closeFind();await page.setViewportSize({width:1120,height:720});
  });
  await check('Find navigation and saving preserve file content and edit history',async()=>{
    const before=await noMutations();await select(0);await openFind();await queryFromStart('ALPHA');await page.click('#file-find-next');await page.click('#file-find-previous');await closeFind();
    await textIs(normal);assert.deepEqual(await noMutations(),before);
    await page.keyboard.press(shortcut+'+s');await page.waitForFunction(()=>document.getElementById('dirty-dot').textContent==='');
    assert.equal(fs.readFileSync(path.join(workspace,'normal.txt'),'utf8'),normal);
    const after=await noMutations();assert(after.slice(before.length).every(message=>message.type==='save_file'));
  });
  await check('Switching files never leaves matches or offsets from the previous file',async()=>{
    await select(0);await openFind();await query('Alpha');await countIs(1,4);
    await rpc('open_file',{path:'other.txt'});await page.waitForFunction(()=>window.__findReview.activePath==='other.txt');await textIs(sources['other.txt']);currentPath='other.txt';
    if(await page.locator('#file-find').isVisible()){
      await queryFromStart('alpha');const at=sources['other.txt'].indexOf('alpha');await selectionIs(at,at+5);await countIs(1,1);await closeFind();
    }else{await select(0);await openFind();await queryFromStart('alpha');const at=sources['other.txt'].indexOf('alpha');await selectionIs(at,at+5);await countIs(1,1);await closeFind();}
  });
  await openPath('normal.txt');
  await check('Acknowledged edits in another window invalidate stale match counts and offsets',async()=>{
    const other=await newPage(context,url);
    try{
      await textIs(normal,other);await select(0);await openFind();await queryFromStart('alpha');await countIs(1,4);
      await select(0,normal.length,'forward',other);await other.keyboard.insertText('prefix alpha\n');
      await textIs('prefix alpha\n');const at='prefix '.length;await page.waitForFunction(()=>/^(?:1 of 1|1 match)$/.test(document.getElementById('file-find-count').textContent.trim()));await page.locator('#file-find-input').focus();await page.keyboard.press('Enter');await countIs(1,1);await selectionIs(at,at+5);
      await select(0,'prefix alpha\n'.length,'forward',other);await other.keyboard.insertText('nothing here\n');await textIs('nothing here\n');
      await page.waitForFunction(()=>/no (?:results|matches)|0\s*(?:of|\/)\s*0/i.test(document.getElementById('file-find-count').textContent));assert(await page.locator('#file-find-next').isDisabled());
      await select(0,'nothing here\n'.length,'forward',other);await other.keyboard.insertText(normal);await textIs(normal);await page.waitForFunction(()=>/of 4$|^4 matches$/.test(document.getElementById('file-find-count').textContent.trim()));
    }finally{await other.close();}
    await page.bringToFront();await closeFind();
  });
  await openPath('few-unicode.txt');
  await check('Few-line Unicode files search the whole document beyond the bounded native input',async()=>{
    await select(0);assert.equal(await page.evaluate(()=>window.nimloEditor.large),true);
    const first=lowline.indexOf(lowNeedle),last=lowline.lastIndexOf(lowNeedle);assert(first>8192 && last>first+8192);
    await openFind();await query('日本😀target');await selectionIs(first,first+lowNeedle.length);await countIs(1,2);
    await page.keyboard.press('Enter');await selectionIs(last,last+lowNeedle.length);await countIs(2,2);
    const state=await page.evaluate(()=>({nativeLength:document.getElementById('code-input').value.length,windowStart:window.nimloEditor.start,windowEnd:window.nimloEditor.end,scrollLeft:window.nimloEditor.scrollLeft,scrollTop:window.nimloEditor.scrollTop,large:window.nimloEditor.large}));
    assert(state.nativeLength<=8192,JSON.stringify(state));assert(state.windowStart<=last && state.windowEnd>=last+lowNeedle.length,JSON.stringify(state));assert(state.scrollLeft>0,JSON.stringify(state));measurements.push({case:'few-line-unicode-search',...state,globalMatch:last});
    await closeFind();await textIs(lowline);await shot('find-few-line-unicode');
    await page.keyboard.insertText('REPLACED');const changed=lowline.slice(0,last)+'REPLACED'+lowline.slice(last+lowNeedle.length);await textIs(changed);
    await page.waitForFunction(({file,text})=>window.__findReview.documents[file]?.content===text,{file:'few-unicode.txt',text:changed});
    await page.keyboard.press(shortcut+'+z');await textIs(lowline);
  });
  await openPath('many-lines.txt');
  await check('An offscreen match after eleven thousand lines is revealed at its global offset',async()=>{
    await select(0);await openFind();await query('offscreen-needle');const at=tall.indexOf('offscreen-needle');await selectionIs(at,at+16);await countIs(1,1);
    const geometry=await page.evaluate(()=>{const editor=window.nimloEditor,input=document.getElementById('code-input'),surface=editor.scroller,r=surface.getBoundingClientRect(),style=getComputedStyle(input),height=parseFloat(style.lineHeight),line=editor.lineAtOffset(editor.selectionStart),top=r.top+parseFloat(style.paddingTop)+line*height-editor.scrollTop;return{caretTop:top,caretBottom:top+height,viewportTop:r.top,viewportBottom:r.bottom,nativeLength:input.value.length,scrollTop:editor.scrollTop};});
    assert(geometry.caretTop>=geometry.viewportTop-1 && geometry.caretBottom<=geometry.viewportBottom+1,JSON.stringify(geometry));assert(geometry.nativeLength<=8192);assert(geometry.scrollTop>0);measurements.push({case:'many-line-search-reveal',...geometry});await closeFind();
  });
  await openPath('dense.txt');
  await check('Dense matches keep the native input and search rendering bounded',async()=>{
    await select(0);const nodesBefore=await page.locator('*').count();await openFind();await query('a');await selectionIs(0,1);
    await page.waitForFunction(()=>document.getElementById('file-find-count').textContent.trim().length>0);
    const state=await page.evaluate(()=>({countText:document.getElementById('file-find-count').textContent,nativeLength:document.getElementById('code-input').value.length,searchNodes:document.getElementById('file-find').querySelectorAll('*').length,allNodes:document.querySelectorAll('*').length,highlightNodes:document.querySelectorAll('.find-match').length,largestTextControl:Math.max(...[...document.querySelectorAll('textarea,input')].map(input=>input.value.length))}));
    assert(state.nativeLength<=8192);assert(state.largestTextControl<=8192);assert(state.searchNodes<=32);assert(state.highlightNodes<=300);assert(state.allNodes-nodesBefore<=400);assert(/10,?000\+/.test(state.countText),state.countText);
    await page.keyboard.press('Enter');await selectionIs(1,2);await page.keyboard.press('Shift+Enter');await selectionIs(0,1);await page.keyboard.press('Shift+Enter');await selectionIs(999999,1000000);await page.keyboard.press('Enter');await selectionIs(0,1);await textIs(dense);measurements.push({case:'dense-search-bounds',...state});await closeFind();
  });
  await check('Selecting a large document range never copies it into the search input',async()=>{
    await select(0,20000,'forward');await openFind();assert.equal(await page.inputValue('#file-find-input'),'a');
    assert((await page.inputValue('#code-input')).length<=8192);await textIs(dense);await closeFind();
  });
  await openPath('normal.txt');
  await check('Read-only paired devices can search without requesting any file mutations',async()=>{
    await rpc('session_access_set',{settings:{allowDevices:true,permissions:{editFiles:false,terminal:false,ai:false}},password:null});
    const invitation=await rpc('pair_create',{origin:new URL(url).origin});assert.equal(invitation.type,'pairing');
    const peerContext=await newContext(),response=await peerContext.request.post(new URL('/api/pair',url).href,{headers:{Origin:new URL(url).origin},data:{invite:invitation.invite,code:invitation.code}});assert.equal(response.status(),200);
    const peer=await newPage(peerContext,new URL('/',url).href);await peer.waitForFunction(()=>document.getElementById('code-input').readOnly);await textIs(normal,peer);
    assert.equal(await peer.evaluate(()=>window.__findReview.bootstrap.isHost),false);await select(0,5,'forward',peer);const before=await noMutations(peer);
    await openFind(peer);assert.equal(await peer.inputValue('#file-find-input'),'Alpha');await countIs(1,4,peer);await peer.keyboard.press('Enter');await selectionIs(6,11,peer);await closeFind(peer);await textIs(normal,peer);assert.deepEqual(await noMutations(peer),before);
    assert.equal(await peer.evaluate(()=>window.nimloDesktop.undo()),true);
    assert.equal(await peer.evaluate(()=>window.nimloDesktop.redo()),true);
    assert.equal(await peer.evaluate(()=>window.nimloDesktop.save()),false);
    await peer.waitForTimeout(50);assert.deepEqual(await noMutations(peer),before);
    assert.equal(fs.readFileSync(path.join(workspace,'normal.txt'),'utf8'),normal);await peerContext.close();
  });
  await check('Search causes no rendering errors, inference, shell starts or disk changes',async()=>{
    assert.deepEqual(errors,[]);
    for(const [file,source] of Object.entries(sources))assert.equal(fs.readFileSync(path.join(workspace,file),'utf8'),source,file);
    const messages=await page.evaluate(()=>window.__findReview.sent);assert(messages.every(message=>!['ai_start','terminal_start','terminal_input'].includes(message.type)));
    const probes=fs.existsSync(providerLog) ? fs.readFileSync(providerLog,'utf8').trim().split('\n').filter(Boolean) : [];assert(probes.every(argumentsText=>/(?:auth|login|status|--version)/.test(argumentsText)),'Unexpected provider command: '+probes.join(', '));
  });
  console.log('FIND IN FILE PASS '+engine+' '+checks.length);
})().catch(async error=>{
  errors.push(sanitized(error.stack || error));if(page)await page.evaluate(()=>({count:document.getElementById('file-find-count').textContent,query:document.getElementById('file-find-input').value,barHidden:document.getElementById('file-find').hidden,selection:window.nimloEditor?.getSelection(),nativeLength:document.getElementById('code-input').value.length,windowStart:window.nimloEditor?.start,windowEnd:window.nimloEditor?.end,view:document.getElementById('app').dataset.view,activeElement:document.activeElement?.id})).then(state=>measurements.push({case:'failure-state',...state})).catch(()=>{});console.error('FIND IN FILE FAIL '+sanitized(error.stack || error));if(page)await shot('failure').catch(()=>{});process.exitCode=1;
}).finally(async()=>{
  try{if(browser)await browser.close();}finally{await stopHost();fs.rmSync(fixture,{recursive:true,force:true});}
  const report={status:errors.length ? 'fail' : 'pass',date:new Date().toISOString(),browserEngine:engine,stage,checks,errors,screenshots,measurements,binarySha256:fs.existsSync(binary) ? hash(fs.readFileSync(binary)) : null,harnessSha256:hash(fs.readFileSync(__filename)),sourceSha256:Object.fromEntries(['web/app.js','web/editor.js','web/style.css','web/index.html'].map(file=>[file,hash(fs.readFileSync(path.join(repo,file)))])),sourceOverrides:false,isolatedTemporaryWorkspace:true,fixtureHostExited:!host || host.exitCode!==null || host.signalCode!==null,realInferenceRequests:0,limits:['Trusted browser keyboard events qualify the embedded browser UI; native macOS menu routing is tested separately.','Input-size and DOM bounds are checked; these checks do not measure whole-app memory use or physical display latency.']};
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
});
