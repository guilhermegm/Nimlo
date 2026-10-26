#!/usr/bin/env node
'use strict';

// Independent protocol/recovery critic fixture. Only disposable project text,
// local fake account probes and ephemeral authenticated peers are used.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),vm=require('node:vm');
const assert=require('node:assert/strict'),{spawn}=require('node:child_process');
const WebSocket=require(process.env.NIMLO_WS_MODULE||path.resolve(__dirname,'../../mini_gym/node_modules/ws'));
const repo=path.resolve(__dirname,'..'),binary=path.resolve(repo,process.env.NIMLO_BINARY||'target/release/nimlo-editor');
const output=path.resolve(process.env.PATCH_OUTPUT||path.join(repo,'tests/patch-check.json'));
const checks=[],peers=new Set(),secrets=new Set(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let fixture,host,origin,token;
function redacted(error){let value=String(error.stack||error);for(const secret of secrets)value=value.split(secret).join('[private]');return value;}
async function until(fn,label,timeout=10000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await fn();if(value)return value;await pause(15);}throw Error('Timeout: '+label);}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
async function drain(){for(let n=0;n<12;n++)await Promise.resolve();}

async function frontendProofs(){
  const source=fs.readFileSync(path.join(repo,'web/app.js'),'utf8');
  const begin=source.indexOf('  function fileState('),end=source.indexOf('  function fileClosed(');
  const lifecycleBegin=source.indexOf('  function rememberFilePath('),lifecycleEnd=source.indexOf('  function trimClosedDrafts(');
  assert(begin>=0&&end>begin,'Actual embedded frontend functions not found');
  assert(lifecycleBegin>=0&&lifecycleEnd>lifecycleBegin,'Actual embedded file lifecycle functions not found');
  function fixtureContext(){
    const doc={path:'note.txt',content:'A😀Z',revision:1,dirty:false,closed:false,localText:null,draftBase:null,workspacePath:'/fixture',sessionId:'fixture-session'};
    const state={projectId:'project-a',generation:7,clientId:'own-client',sessionId:'fixture-session',workspacePath:'/fixture',path:null,docs:new Map([[doc.path,doc]]),recentFiles:[doc.path],fileShortcutsEnabled:true,fileViews:new Map(),projectViews:new Map(),conflict:null,proposal:null};
    const requests=[],errors=[];
    const context={state,TextEncoder,typing:{doc:null,pairs:[],pending:null,syntax:null},codeRender:{doc:null},fileFind:{doc:null},clearCodeCache:()=>{},paintFindCount:()=>{},dismissConflict:()=>{state.conflict=null;},dismissReview:()=>{state.proposal=null;},rememberCodeView:()=>{},selectLocal:path=>{state.path=path;},notice:()=>{},composition:null,writable:()=>true,readDraft:()=>null,saveDraft:()=>true,renderEditor:()=>{},renderOpenFiles:()=>{},updateControls:()=>{},showConflict:()=>{},report:error=>errors.push(error),$:()=>({close(){}}),
      fileClosed:name=>{const current=state.docs.get(name);if(current)current.closed=true;},
      command:(type,fields,mutate)=>new Promise((resolve,reject)=>requests.push({type,fields,mutate,resolve,reject}))};
    vm.createContext(context);vm.runInContext(source.slice(lifecycleBegin,lifecycleEnd)+'\n'+source.slice(begin,end),context);
    return{context,state,doc,requests,errors};
  }
  function compositionContext(){
    const f=fixtureContext(),c=f.context,modals=[],saved=[],timers=[];f.state.path=f.doc.path;
    const input={readOnly:false,isComposing:false},editor={value:f.doc.content,selectionStart:1,selectionEnd:1,scrollTop:0,scrollLeft:0,selectionWrites:0,setSelectionRange(start,end){this.selectionWrites++;this.selectionStart=start;this.selectionEnd=end;}};
    Object.assign(c,{input,editor,app:{dataset:{composing:'false'}},TextEncoder,editTimer:0,
      current:()=>f.state.docs.get(f.state.path),textOf:doc=>doc.localText??doc.content,allowDraftEdit:()=>true,
      saveDraft:doc=>{saved.push({path:doc.path,workspacePath:doc.workspacePath,text:doc.localText,base:doc.draftBase});return true;},
      showConflict:(doc,kind)=>modals.push({doc,kind}),paintCode:()=>{},notice:()=>{},trimClosedDrafts:()=>{},rememberCodeView:()=>{},restoreCodeView:()=>{},renderFiles:()=>{},
      clearTimeout:()=>{},setTimeout:callback=>{timers.push(callback);return timers.length;},$:()=>({close(){},setAttribute(){}})});
    const range=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a);assert(a>=0&&b>a,'Actual composition fixture source not found');return source.slice(a,b);};
    vm.runInContext(range('  function fileClosed(','  function rememberCodeView(')+'\n'+range('  function renderEditor(','  const escapeHtml')+'\n'+range('  function trackTypedPairs(','  function insertText(')+'\n'+range('  function beginComposition()',"  input.addEventListener('input',edited);")+'\n'+range('  async function flush(doc=current())','  function resumeDrafts()'),c);
    return{...f,input,editor,modals,saved,timers};
  }
  const mismatch={type:'file_patch',baseRevision:2,patch:{start:0,deleteCount:1,insert:'M'},file:{path:'note.txt',revision:3,dirty:true,conflict:null}};
  await check('Actual frontend applies explicit FileSync replies after a missed patch and resumes incremental updates',async()=>{
    const f=fixtureContext();f.context.filePatch(mismatch);assert.equal(f.requests.length,1);assert.equal(f.requests[0].type,'file_sync');assert.equal(f.requests[0].mutate,true);
    f.requests[0].resolve({file:{path:'note.txt',content:'latest😀Z',revision:3,dirty:true,conflict:null}});await drain();assert.equal(f.doc.content,'latest😀Z');assert.equal(f.doc.revision,3);
    f.context.filePatch({baseRevision:3,sourceClientId:'peer',patch:{start:0,deleteCount:6,insert:'next'},file:{path:'note.txt',revision:4,dirty:true,conflict:null}});assert.equal(f.doc.content,'next😀Z');assert.equal(f.doc.revision,4);assert.deepEqual(f.errors,[]);
  });
  await check('FileSync recovery cannot resurrect closed documents, overwrite a switched project or replace a newer document identity',async()=>{
    for(const mutate of[f=>f.doc.closed=true,f=>f.state.projectId='project-b',f=>f.state.generation++,f=>f.state.docs.set('note.txt',{...f.doc,content:'new identity',revision:9})]){
      const f=fixtureContext();f.context.filePatch(mismatch);mutate(f);f.requests[0].resolve({file:{path:'note.txt',content:'WRONG',revision:3,dirty:true}});await drain();assert.equal(f.doc.content,'A😀Z');assert(![...f.state.docs.values()].some(doc=>doc.content==='WRONG'));
    }
    const f=fixtureContext();f.context.filePatch(mismatch);f.state.projectId='project-b';f.requests[0].reject(Object.assign(Error('Closed in old project'),{code:'file_closed'}));await drain();assert.equal(f.doc.closed,false);
  });
  await check('Missed-patch snapshots preserve pending text for conflict review and ignore duplicate or older revisions',async()=>{
    const f=fixtureContext();f.context.filePatch(mismatch);f.doc.localText='device-only pending';f.doc.draftBase=1;f.requests[0].resolve({file:{path:'note.txt',content:'host version',revision:3,dirty:true}});await drain();assert.equal(f.doc.localText,'device-only pending');assert.equal(f.doc.needsReview,true);
    const count=f.requests.length;f.context.filePatch(mismatch);assert.equal(f.requests.length,count);f.context.fileState({path:'note.txt',content:'older',revision:2});assert.equal(f.doc.content,'host version');
  });
  await check('Own patch acknowledgements and late legacy snapshots retain newer local typing without false own attribution',async()=>{
    const f=fixtureContext();f.doc.localText='edit2😀Z';f.doc.draftBase=1;f.doc.sentEdit={text:'edit1😀Z',baseRevision:1};
    f.context.filePatch({baseRevision:1,sourceClientId:'own-client',patch:{start:0,deleteCount:1,insert:'edit1'},file:{path:'note.txt',revision:2,dirty:true,conflict:null}});
    assert.equal(f.doc.content,'edit1😀Z');assert.equal(f.doc.localText,'edit2😀Z');assert.equal(f.doc.draftBase,2);assert(!f.doc.needsReview);
    f.context.fileState({path:'note.txt',content:'remote😀Z',revision:3,dirty:true,conflict:null},false,'own-client');assert.equal(f.doc.localText,'edit2😀Z');assert.equal(f.doc.needsReview,true);assert.equal(f.doc.content,'remote😀Z');
  });
  await check('Actual frontend patch generation preserves Unicode scalar boundaries for astral replacements',async()=>{
    for(const [before,after]of[['A😀Z','A😃Z'],['𐀀tail','𐐀tail'],['😀','x😀'],['x😀','😀'],['😀tail','tail'],['same','same']]){
      const f=fixtureContext(),patch=f.context.textPatch(before,after);assert(f.context.scalarBoundary(before,patch.start));assert(f.context.scalarBoundary(before,patch.start+patch.deleteCount));assert.equal(before.slice(0,patch.start)+patch.insert+before.slice(patch.start+patch.deleteCount),after);
    }
  });
  await check('A newly recovered host snapshot frees a known equal acknowledged device draft without deleting unknown storage',async()=>{
    for(const known of[true,false]){
      const f=fixtureContext(),cleared=[];f.state.docs.clear();f.context.readDraft=()=>known?{path:'note.txt',workspacePath:'/fixture',sessionId:'fixture-session',baseRevision:1,text:'A😀Z'}:null;f.context.saveDraft=doc=>{cleared.push(doc.localText);return true;};
      f.context.fileState({path:'note.txt',content:'A😀Z',revision:1,dirty:false,conflict:null});assert.equal(cleared.length,known?1:0,'Equal acknowledged storage must be released only after a successful read');if(known)assert.equal(cleared[0],null);
    }
  });
  await check('Peer snapshots and patches before the first IME input retain the original base and defer marked selection and conflict focus',async()=>{
    for(const eventType of['snapshot','patch']){
      const f=compositionContext(),c=f.context;c.beginComposition();
      if(eventType==='snapshot')c.fileState({path:'note.txt',content:'PEER A😀Z',revision:2,dirty:true},false,'peer');
      else c.filePatch({baseRevision:1,sourceClientId:'peer',patch:{start:0,deleteCount:0,insert:'PEER '},file:{path:'note.txt',revision:2,dirty:true}});
      assert.equal(f.editor.value,'A😀Z');assert.equal(f.editor.selectionWrites,0);assert.equal(f.modals.length,0);
      f.editor.value='A日本😀Z';c.edited();assert.equal(f.doc.draftBase,1);assert.equal(f.doc.localText,'A日本😀Z');assert.equal(f.doc.content,'PEER A😀Z');assert.equal(f.doc.needsReview,true);
      await assert.rejects(c.flush(f.doc),/composition/);assert.equal(f.requests.length,0);assert.equal(f.modals.length,0);
      c.endComposition();assert.equal(c.composition,null);assert.equal(f.doc.draftBase,1);assert.equal(f.modals.length,1);assert.equal(f.modals[0].kind,'draft');
    }
  });
  await check('Canceled or no-change IME does not fabricate an old-source draft over a newer peer snapshot',async()=>{
    for(const hadInput of[false,true]){
      const f=compositionContext(),c=f.context;c.beginComposition();
      if(hadInput){f.editor.value='A文😀Z';c.edited();}
      c.fileState({path:'note.txt',content:'PEER A😀Z',revision:2,dirty:true},false,'peer');
      f.editor.value='A😀Z';c.endComposition();assert.equal(f.doc.localText,null);assert.equal(f.doc.draftBase,null);assert(!f.doc.needsReview);assert.equal(f.doc.content,'PEER A😀Z');assert.equal(f.editor.value,'PEER A😀Z');assert.equal(f.modals.length,0);assert.equal(f.requests.length,0);
    }
  });
  await check('A verified own acknowledgement safely rebases a composing pending source without treating a foreign snapshot as its acknowledgement',async()=>{
    const f=compositionContext(),c=f.context;f.doc.localText='OWN A😀Z';f.doc.draftBase=1;f.doc.sentEdit={text:f.doc.localText,baseRevision:1};f.editor.value=f.doc.localText;c.beginComposition();
    c.fileState({path:'note.txt',content:'OWN A😀Z',revision:2,dirty:true},false,'own-client');assert.equal(c.composition.base,2);
    f.editor.value='OWN A日本😀Z';c.endComposition();assert.equal(f.doc.draftBase,2);assert.equal(f.doc.localText,'OWN A日本😀Z');assert(!f.doc.needsReview);assert.equal(f.modals.length,0);
    const foreign=compositionContext();foreign.doc.localText='OWN A😀Z';foreign.doc.draftBase=1;foreign.doc.sentEdit={text:'OWN A😀Z',baseRevision:1};foreign.editor.value=foreign.doc.localText;foreign.context.beginComposition();
    foreign.context.fileState({path:'note.txt',content:'OTHER A😀Z',revision:2,dirty:true},false,'own-client');foreign.editor.value='OWN A日本😀Z';foreign.context.endComposition();assert.equal(foreign.doc.draftBase,1);assert.equal(foreign.doc.needsReview,true);assert.equal(foreign.doc.content,'OTHER A😀Z');
  });
  await check('IME commits stay with their captured document across disconnects, remote close, deferred selection and a new project identity',async()=>{
    for(const kind of['disconnect','close','selection','project']){
      const f=compositionContext(),c=f.context;c.beginComposition();
      const other={...f.doc,path:'other.txt',content:'OTHER',localText:null,draftBase:null};f.state.docs.set(other.path,other);
      if(kind==='disconnect')c.writable=()=>false;
      if(kind==='close')c.fileClosed(f.doc.path);
      if(kind==='selection'){c.selectLocal(other.path);assert.equal(f.state.path,f.doc.path);}
      if(kind==='project'){f.state.projectId='project-b';f.state.generation++;f.state.workspacePath='/other';f.state.docs=new Map([['note.txt',{...other,path:'note.txt',workspacePath:'/other'}]]);}
      f.editor.value='A日本😀Z';c.endComposition();assert.equal(f.doc.localText,'A日本😀Z');assert.equal(f.doc.draftBase,1);assert(f.saved.some(row=>row.workspacePath==='/fixture'&&row.text==='A日本😀Z'));assert.equal(f.requests.length,0);
      if(kind==='close'){assert.equal(f.doc.closed,true);assert.equal(f.doc.needsReview,true);assert.equal(f.state.path,null);}
      if(kind==='selection'){assert.equal(f.state.path,other.path);assert.equal(other.content,'OTHER');assert.equal(other.localText,null);}
      if(kind==='project'){assert.equal(f.doc.needsReview,true);assert.equal(f.state.docs.get('note.txt').content,'OTHER');assert.equal(f.state.docs.get('note.txt').localText,null);}
    }
  });
  await check('A flush already awaiting acknowledgement cannot send marked text when composition starts during its wait',async()=>{
    const f=compositionContext(),c=f.context;let release;
    f.doc.inflight=new Promise(resolve=>release=resolve);
    const waiting=c.flush(f.doc).then(()=>({ok:true}),error=>({error}));
    c.beginComposition();f.editor.value='A文😀Z';c.edited();f.doc.inflight=null;release();await drain();
    if(f.requests.length){f.requests[0].reject(Error('Fixture stops the unsafe composing send'));await waiting;}
    assert.equal(f.requests.length,0,'The pre-await guard admitted composition that began during acknowledgement wait');
    const result=await waiting;assert.match(result.error?.message||'',/composition/);assert.equal(f.doc.localText,'A文😀Z');assert.equal(f.doc.draftBase,1);
  });
  await check('A disk conflict arriving during a canceled composition is shown only after marked input finishes',async()=>{
    const f=compositionContext(),c=f.context;c.beginComposition();c.fileState({path:'note.txt',content:'A😀Z',revision:1,dirty:true,conflict:{diskContent:'CHANGED ON DISK',diskRevision:2}},false,'peer');
    assert.equal(f.modals.length,0);assert.equal(f.editor.selectionWrites,0);c.endComposition();assert.equal(f.doc.localText,null);assert.equal(f.modals.length,1);assert.equal(f.modals[0].kind,'disk');assert.equal(f.doc.conflict.diskContent,'CHANGED ON DISK');
  });
}

async function start(workspace,state,bin){
  origin=null;token=null;
  host=spawn(binary,['--workspace',workspace,'--state-dir',state,'--listen','127.0.0.1:0'],{cwd:repo,env:{...process.env,PATH:bin+':/usr/bin:/bin:/usr/sbin:/sbin',SHELL:'/bin/sh'},stdio:['ignore','pipe','pipe']});
  let text='';host.stdout.on('data',chunk=>{text=(text+chunk).slice(-12000);const match=text.match(/(http:\/\/[^\s]+)\/#token=([a-f0-9]{64})/);if(match){origin=match[1];token=match[2];secrets.add(token);text='';}});host.stderr.on('data',()=>{});
  await until(()=>{if(host.exitCode!==null)throw Error('Host exited during startup');return origin;},'host launch');assert(![8765,8767].includes(+new URL(origin).port));
  const response=await fetch(origin+'/api/bootstrap',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});assert.equal(response.status,200);const cookie=response.headers.get('set-cookie')?.split(';')[0];assert(cookie);secrets.add(cookie);return cookie;
}
class Peer{
  constructor(socket){this.socket=socket;this.events=[];this.pending=new Map();this.docs=new Map();this.sequence=0;this.snapshot=null;peers.add(this);
    socket.on('error',()=>{});socket.on('message',raw=>{const value=JSON.parse(raw);this.events.push(value);if(this.events.length>128)this.events.shift();
      if(value.type==='bootstrap'){this.snapshot=value;this.docs=new Map((value.openFiles||[]).map(file=>[file.path,file]));}
      if(value.type==='file_state'){const old=this.docs.get(value.file.path);if(!old||value.file.revision>=old.revision)this.docs.set(value.file.path,value.file);}
      if(value.type==='file_patch'){const old=this.docs.get(value.file.path);if(old&&old.revision===value.baseRevision&&value.file.revision>old.revision)this.docs.set(value.file.path,{...value.file,content:old.content.slice(0,value.patch.start)+value.patch.insert+old.content.slice(value.patch.start+value.patch.deleteCount)});}
      if(value.type==='file_closed')this.docs.delete(value.path);if(value.type==='control'&&this.snapshot)this.snapshot.generation=value.generation;
      const waiting=this.pending.get(value.requestId);if(waiting){clearTimeout(waiting.timer);this.pending.delete(value.requestId);waiting.resolve(value);}});
    socket.on('close',()=>{for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(Error('Fixture peer closed'));}this.pending.clear();});
  }
  request(type,fields={}){const requestId='patch-'+(++this.sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(requestId);reject(Error('Timeout '+type));},10000);this.pending.set(requestId,{resolve,reject,timer});this.socket.send(JSON.stringify({type,requestId,projectId:this.snapshot.projectId,generation:this.snapshot.generation,...fields}));});}
}
async function connect(id,cookie,modern=true){const socket=new WebSocket(origin.replace(/^http/,'ws')+'/ws?clientId='+id+(modern?'&patches=1':''),{headers:{Origin:origin,Cookie:cookie}}),peer=new Peer(socket);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});await until(()=>peer.snapshot,'peer bootstrap');return peer;}
async function success(peer,type,fields={}){const value=await peer.request(type,fields);assert.notEqual(value.type,'error',value.message);return value;}
async function deniedUpgrade(headers){return new Promise((resolve,reject)=>{const socket=new WebSocket(origin.replace(/^http/,'ws')+'/ws?clientId=untrusted&patches=1',{headers});const timer=setTimeout(()=>{socket.terminate();reject(Error('Unauthenticated upgrade did not settle'));},8000);socket.on('error',()=>{});socket.on('open',()=>{clearTimeout(timer);socket.close();reject(Error('Unauthenticated patch peer connected'));});socket.on('unexpected-response',(_,response)=>{clearTimeout(timer);response.resume();socket.terminate();resolve(response.statusCode);});});}
async function stop(signal='SIGINT'){for(const peer of peers){peer.socket.close();}peers.clear();if(!host)return;const current=host;host=null;if(current.exitCode!==null||current.signalCode!==null)return;current.kill(signal);await until(()=>current.exitCode!==null||current.signalCode!==null,'owned fixture host shutdown');}

async function hostProofs(){
  fixture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-patch-critic-')));
  const workspace=path.join(fixture,'project-a'),other=path.join(fixture,'project-b'),state=path.join(fixture,'state'),bin=path.join(fixture,'bin');for(const dir of[workspace,other,state,bin])fs.mkdirSync(dir,{mode:0o700});
  const disk='A😀Z\nsecond line\n';fs.writeFileSync(path.join(workspace,'note.txt'),disk);fs.writeFileSync(path.join(other,'note.txt'),'OTHER PROJECT\n');
  for(const name of['codex','claude'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nprintf "Logged in using subscription\\n"\n',{mode:0o700});
  const cookie=await start(workspace,state,bin);let modern=await connect('patch-modern',cookie);
  await check('The tested release serves all four exact current embedded assets',async()=>{for(const name of['index.html','app.js','editor.js','style.css']){const served=await(await fetch(origin+(name==='index.html'?'/':'/'+name))).text();assert.equal(served,fs.readFileSync(path.join(repo,'web',name),'utf8'),'Release asset differs: '+name);}});
  const invitation=await success(modern,'pair_create',{origin});secrets.add(invitation.code);secrets.add(invitation.invite);
  const paired=await fetch(origin+'/api/pair',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:invitation.code,invite:invitation.invite}),signal:AbortSignal.timeout(8000)});assert.equal(paired.status,200);
  const phoneCookie=paired.headers.get('set-cookie')?.split(';')[0];assert(phoneCookie);secrets.add(phoneCookie);
  let legacy=await connect('patch-legacy',phoneCookie,false),second=await connect('patch-second',phoneCookie);
  await check('Patch peers require authenticated credentials and an accepted origin',async()=>{assert([401,403].includes(await deniedUpgrade({Origin:origin})));assert([401,403].includes(await deniedUpgrade({Origin:'https://untrusted.fixture.invalid',Cookie:cookie})));assert.equal(modern.snapshot.textPatchVersion,1);assert.equal(legacy.snapshot.textPatchVersion,0);});
  let file=(await success(modern,'open_file',{path:'note.txt'})).file;
  await check('Modern patches and legacy full snapshots converge on the exact Unicode text',async()=>{
    const patch=await success(modern,'patch_file',{path:'note.txt',baseRevision:file.revision,start:1,deleteCount:2,insert:'日本😀'});assert.equal(patch.type,'file_patch');assert.equal(patch.file.content,undefined);assert.deepEqual(patch.patch,{start:1,deleteCount:2,insert:'日本😀'});
    await until(()=>legacy.docs.get('note.txt')?.revision===patch.file.revision&&second.docs.get('note.txt')?.revision===patch.file.revision,'mixed peers converge');assert.equal(legacy.docs.get('note.txt').content,'A日本😀Z\nsecond line\n');assert.equal(second.docs.get('note.txt').content,legacy.docs.get('note.txt').content);assert(!legacy.events.some(event=>event.type==='file_patch'));file=legacy.docs.get('note.txt');
  });
  await check('Stale revisions, half-surrogates, range overflow, NUL and oversize inserts cannot change acknowledged text or history',async()=>{
    const before=(await success(modern,'file_sync',{path:'note.txt'})).file;
    for(const fields of[{baseRevision:before.revision-1,start:0,deleteCount:0,insert:'stale'},{start:4,deleteCount:0,insert:'half'},{start:3,deleteCount:1,insert:''},{start:999999,deleteCount:0,insert:'range'},{start:0,deleteCount:0,insert:'\0'},{start:0,deleteCount:0,insert:'x'.repeat(1048577)}]){
      const result=await modern.request('patch_file',{path:'note.txt',baseRevision:before.revision,start:0,deleteCount:0,insert:'',...fields});assert.equal(result.type,'error');const after=(await success(modern,'file_sync',{path:'note.txt'})).file;assert.equal(after.revision,before.revision);assert.equal(after.content,before.content);
    }
    const undone=(await success(modern,'undo_file',{path:'note.txt',revision:before.revision})).file;assert.equal(undone.content,disk,'Failed patches changed acknowledged undo history');
    const redone=(await success(modern,'redo_file',{path:'note.txt',revision:undone.revision})).file;assert.equal(redone.content,before.content);file=redone;
  });
  await check('Concurrent same-base patches acknowledge exactly one sender and preserve both peers revision fences',async()=>{
    const base=file.revision;const replies=await Promise.all([modern.request('patch_file',{path:'note.txt',baseRevision:base,start:0,deleteCount:1,insert:'M'}),second.request('patch_file',{path:'note.txt',baseRevision:base,start:0,deleteCount:1,insert:'S'})]);assert.equal(replies.filter(value=>value.type==='file_patch').length,1);assert.equal(replies.filter(value=>value.type==='error'&&value.code==='stale_revision').length,1);file=(await success(modern,'file_sync',{path:'note.txt'})).file;await until(()=>legacy.docs.get('note.txt')?.revision===file.revision,'legacy converges after concurrent patches');assert.equal(legacy.docs.get('note.txt').content,file.content);
  });
  await check('Patch generation and selected-project fences reject foreign writes while legacy edits remain supported',async()=>{
    const oldProject=modern.snapshot.projectId,oldGeneration=modern.snapshot.generation;
    assert.equal((await modern.request('patch_file',{path:'note.txt',baseRevision:file.revision,start:0,deleteCount:0,insert:'WRONG',generation:oldGeneration+100})).code,'stale_generation');
    await success(modern,'add_project',{path:other});await until(()=>modern.snapshot.projectId!==oldProject,'selected project changes');assert.equal((await modern.request('patch_file',{path:'note.txt',baseRevision:file.revision,start:0,deleteCount:0,insert:'WRONG',projectId:oldProject,generation:oldGeneration})).type,'error');assert.equal(fs.readFileSync(path.join(other,'note.txt'),'utf8'),'OTHER PROJECT\n');
    await success(modern,'select_project',{targetProjectId:oldProject});await until(()=>modern.snapshot.projectId===oldProject,'restore selected project');
    const result=await success(legacy,'edit_file',{path:'note.txt',baseRevision:file.revision,content:'legacy acknowledged 😀 draft\n'});assert.equal(result.type,'file_state');file=(await success(modern,'file_sync',{path:'note.txt'})).file;assert.equal(file.content,'legacy acknowledged 😀 draft\n');
  });
  await check('FileSync reads existing buffers without selecting files and cannot reopen a closed document',async()=>{
    const active=modern.snapshot.activePath;await success(modern,'file_sync',{path:'note.txt'});assert.equal(modern.snapshot.activePath,active);await success(modern,'close_file',{path:'note.txt',revision:file.revision,discard:true});assert.equal((await modern.request('file_sync',{path:'note.txt'})).code,'file_closed');assert(!second.docs.has('note.txt'));file=(await success(modern,'open_file',{path:'note.txt'})).file;
  });
  let expected;
  await check('Every acknowledged patch survives an abrupt host exit and reconnect without modifying disk',async()=>{
    const reply=await success(modern,'patch_file',{path:'note.txt',baseRevision:file.revision,start:0,deleteCount:0,insert:'ACKNOWLEDGED\n'});expected='ACKNOWLEDGED\n'+disk;assert.equal(reply.type,'file_patch');await stop('SIGKILL');const nextCookie=await start(workspace,state,bin);modern=await connect('patch-after-crash',nextCookie);const restored=(await success(modern,'file_sync',{path:'note.txt'})).file;assert.equal(restored.content,expected);assert.equal(restored.revision,reply.file.revision);assert.equal(restored.dirty,true);assert.equal(fs.readFileSync(path.join(workspace,'note.txt'),'utf8'),disk);
  });
  return{workspace,other};
}

async function browserDraftProofs({workspace,other}){
  const playwright=require(process.env.PLAYWRIGHT_PATH||path.resolve(__dirname,'../../mini_gym/node_modules/playwright'));
  const engine=process.env.NIMLO_BROWSER||'chromium',browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true}),text='Deleted file pending text: 日本 😀 e\u0301\n'+('recover exactly\n').repeat(200),errors=[];
    await context.addInitScript(({workspace,other,text})=>{
      if(sessionStorage.getItem('critic-drafts-initialized'))return;
      for(let index=0;index<40;index++){
        const workspacePath=index<20?workspace:other,path='deleted-fixture-'+index+'.txt';
        sessionStorage.setItem('relay-draft:'+workspacePath+':'+path,JSON.stringify({workspacePath,path,text:text+index+'\n',baseRevision:1,sessionId:'critic-old-session'}));
      }
      sessionStorage.setItem('critic-drafts-initialized','1');
    },{workspace,other,text});
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/#token='+token);
    await page.waitForFunction(()=>document.getElementById('app').dataset.controller==='yes');
    const key=index=>'relay-draft:'+(index<20?workspace:other)+':deleted-fixture-'+index+'.txt';
    async function draftRow(index){
      const row=page.locator('.draft-row').filter({has:page.getByText('deleted-fixture-'+index+'.txt',{exact:true})});
      for(let attempt=0;attempt<2;attempt++){
        if(await row.count())return row;
        await page.click(await page.locator('#draft-previous').isVisible()?'#draft-previous':'#draft-next');
      }
      assert.equal(await row.count(),1,'The selected saved draft was not discoverable on either metadata page');return row;
    }
    await check('Embedded Device drafts reaches inactive and deleted paths with at most thirty-two visible metadata rows',async()=>{
      await page.click('#connection-state');await page.click('#device-drafts');await page.locator('#draft-dialog').waitFor({state:'visible'});
      assert.equal(await page.locator('.draft-row').count(),32);const first=await page.locator('.draft-row strong').allTextContents();
      assert.equal(fs.existsSync(path.join(workspace,'deleted-fixture-0.txt')),false);assert(!(await page.locator('#draft-list').textContent()).includes('Deleted file pending text'));
      await page.click('#draft-next');assert.equal(await page.locator('.draft-row').count(),8);const second=await page.locator('.draft-row strong').allTextContents(),seen=new Set([...first,...second]);assert.equal(seen.size,40);for(let index=0;index<40;index++)assert(seen.has('deleted-fixture-'+index+'.txt'));
      await page.click('#draft-previous');assert.deepEqual(await page.locator('.draft-row strong').allTextContents(),first);
      const bounds=await page.locator('#draft-dialog').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=391&&bounds.y>=0&&bounds.y+bounds.height<=845);
    });
    await check('Downloading a deleted draft returns exact Unicode text without discarding its only saved copy or writing host files',async()=>{
      const row=await draftRow(0),downloaded=page.waitForEvent('download');await row.getByRole('button',{name:'Download',exact:true}).click();const download=await downloaded;
      assert.equal(download.suggestedFilename(),'deleted-fixture-0.txt');assert.equal(fs.readFileSync(await download.path(),'utf8'),text+'0\n');
      assert.equal(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).text,key(0)),text+'0\n');assert.equal(fs.existsSync(path.join(workspace,'deleted-fixture-0.txt')),false);
    });
    await check('Device draft discard requires explicit confirmation and frees only the chosen saved draft',async()=>{
      const row=await draftRow(0);page.once('dialog',dialog=>dialog.dismiss());await row.getByRole('button',{name:'Discard',exact:true}).click();assert(await page.evaluate(key=>!!sessionStorage.getItem(key),key(0)));
      page.once('dialog',dialog=>dialog.accept());await row.getByRole('button',{name:'Discard',exact:true}).click();assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),key(0)),null);assert.equal(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).text,key(1)),text+'1\n');
      assert.equal(await page.locator('#draft-list').getByText('deleted-fixture-0.txt',{exact:true}).count(),0);
    });
    await check('A browser storage removal failure keeps a deleted draft recoverable through the same download action',async()=>{
      await page.evaluate(()=>{window.__criticRemoveItem=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(key.startsWith('relay-draft:'))throw Error('Fixture storage unavailable');return window.__criticRemoveItem.call(this,key);};});
      const row=await draftRow(1);page.once('dialog',dialog=>dialog.accept());await row.getByRole('button',{name:'Discard',exact:true}).click();
      assert.equal(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).text,key(1)),text+'1\n');assert((await page.locator('#notice').textContent()).includes('saved copy was kept'));
      const downloaded=page.waitForEvent('download');await row.getByRole('button',{name:'Download',exact:true}).click();assert.equal(fs.readFileSync(await(await downloaded).path(),'utf8'),text+'1\n');await page.evaluate(()=>Storage.prototype.removeItem=window.__criticRemoveItem);
    });
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
}

(async()=>{let error;try{await frontendProofs();if(process.env.PATCH_FRONTEND_ONLY!=='1'){const fixtures=await hostProofs();await browserDraftProofs(fixtures);}}catch(value){error=redacted(value);console.error(error);process.exitCode=1;}finally{await stop().catch(value=>{error??=redacted(value);process.exitCode=1;});if(fixture)fs.rmSync(fixture,{recursive:true,force:true});fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({status:error?'fail':'pass',date:new Date().toISOString(),checks,error:error||null,frontendSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(repo,'web/app.js'))).digest('hex'),binarySha256:process.env.PATCH_FRONTEND_ONLY==='1'?null:crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),browserEngine:process.env.PATCH_FRONTEND_ONLY==='1'?null:(process.env.NIMLO_BROWSER||'chromium'),fixtureOnly:true,realInferenceRequests:0,frontendOnly:process.env.PATCH_FRONTEND_ONLY==='1',limits:['Frontend recovery proofs execute the actual function source in a controlled deferred-reply VM; Device drafts exercise exact embedded assets and real browser downloads.','This correctness fixture is not a latency or memory benchmark.']},null,2)+'\n');console.log((error?'FAIL':'PASS')+' patch critic fixture: '+checks.length+' checks');}})();
