#!/usr/bin/env node
'use strict';
// Exercises the actual AppKit/WKWebView shell in disposable folders. The test
// script is appended only to a copied dev asset; no production test bridge.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),app=path.join(repo,'target/desktop/Nimlo Dev.app/Contents/MacOS/Nimlo');
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-desktop-'))),project=path.join(tmp,'project'),fixture=path.join(tmp,'source'),bin=path.join(tmp,'bin'),report=path.join(tmp,'native.json');
let desktop,hostPid;const checks=[];
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
async function until(test,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await test();if(value)return value;await new Promise(r=>setTimeout(r,100));}throw Error('Timeout: '+label);}
function read(){try{return JSON.parse(fs.readFileSync(report,'utf8'));}catch{return [];}}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});}
const driver=`
(() => {
  async function wait(test){for(let i=0;i<100;i++){if(test())return;await new Promise(r=>setTimeout(r,60));}throw Error('fixture wait');}
  async function command(value){document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',metaKey:true,shiftKey:true,bubbles:true,cancelable:true}));await wait(()=>document.getElementById('command-dialog').open);const f=document.getElementById('command-input');f.value=value;f.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('command-form').requestSubmit();await wait(()=>!document.getElementById('command-dialog').open);}
  window.__desktopCommand=command;
  (async()=>{await wait(()=>document.getElementById('app').dataset.controller==='yes');
    if(!sessionStorage.getItem('native-fixture')){await command(':e test.md');await wait(()=>document.getElementById('code-input').value==='native fixture\\n');const f=document.getElementById('code-input');f.value='native edited\\n';f.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,400));document.getElementById('prompt').value='keep prompt';document.getElementById('terminal-command').value='keep shell text';f.setSelectionRange(3,3);sessionStorage.setItem('native-fixture','1');}
    window.__nimloDesktopTest='first';
  })().catch(e=>window.__nimloDesktopTest='ERROR '+e.message);
})();`;
(async()=>{
 fs.mkdirSync(path.join(repo,'tests/desktop'),{recursive:true});
 fs.writeFileSync(path.join(repo,'tests/desktop/validation.json'),JSON.stringify({status:'running',started:new Date().toISOString()})+'\n');
 for(const dir of [project,bin,path.join(fixture,'web'),path.join(fixture,'src'),path.join(fixture,'target/release')])fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(project,'test.md'),'native fixture\n');
 for(const name of ['index.html','editor.js','app.js','style.css','favicon.png','apple-touch-icon.png','logo.png'])fs.copyFileSync(path.join(repo,'web',name),path.join(fixture,'web',name));
 fs.copyFileSync(path.join(repo,'target/release/nimlo-editor'),path.join(fixture,'target/release/nimlo-editor'));
 for(const provider of ['codex','claude']){fs.writeFileSync(path.join(bin,provider),'#!/bin/sh\necho "Logged in using subscription"\n');fs.chmodSync(path.join(bin,provider),0o700);}
 // Build success/failure is simulated here; the real Rust build is checked by
 // cargo separately. This makes ownership/restart tests fast and deterministic.
 fs.writeFileSync(path.join(bin,'cargo'),'#!/bin/sh\nif [ -f "'+path.join(tmp,'build-fails')+'" ]; then exit 1; fi\nexit 0\n');fs.chmodSync(path.join(bin,'cargo'),0o700);
 fs.writeFileSync(path.join(fixture,'src/main.rs'),'// native restart fixture\n');
 const original=fs.readFileSync(path.join(fixture,'web/app.js'),'utf8')+driver;
 fs.writeFileSync(path.join(fixture,'web/app.js'),original);
 const port=await freePort();
 desktop=spawn(app,['--dev-root',fixture,'--workspace',project,'--state-dir',path.join(tmp,'state'),'--port',String(port),'--test-report',report],{env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
 let diagnostics='';desktop.stderr.on('data',d=>diagnostics=(diagnostics+d).slice(-6000));
 await check('Native window automatically authenticates to its own Rust host',async()=>{const loaded=await until(()=>read().find(e=>e.event==='loaded'&&e.snapshot.connected&&e.snapshot.authenticated&&e.snapshot.hook),'native WKWebView startup');hostPid=loaded.hostPid;assert(alive(hostPid));assert.equal((await fetch('http://127.0.0.1:'+port+'/api/bootstrap')).status,401);});
 await new Promise(r=>setTimeout(r,1200));
 await check('CSS hot reload keeps acknowledged edits, prompt, terminal draft and caret',async()=>{fs.appendFileSync(path.join(fixture,'web/style.css'),'\n:root { --nimlo-desktop-test: after; }\n');const e=await until(()=>read().find(e=>e.event==='css'&&e.snapshot.css==='after'),'live CSS');assert.equal(e.hostPid,hostPid);assert.equal(e.snapshot.value,'native edited\n');assert.equal(e.snapshot.prompt,'keep prompt');assert.equal(e.snapshot.terminalDraft,'keep shell text');assert.equal(e.snapshot.selection,3);});
 await check('JavaScript hot reload restores the shared file and local UI drafts',async()=>{fs.writeFileSync(path.join(fixture,'web/app.js'),original+"\nsetTimeout(()=>window.__nimloDesktopTest='second',300);\n");const e=await until(()=>read().find(e=>e.event==='loaded'&&e.snapshot.value==='native edited\n'&&e.snapshot.prompt==='keep prompt'),'JS reload');assert.equal(e.hostPid,hostPid);assert.equal(e.snapshot.terminalDraft,'keep shell text');assert.equal(e.snapshot.selection,3);});
 await check('Fixing a JavaScript syntax error resumes hot reload and restores drafts',async()=>{fs.writeFileSync(path.join(fixture,'web/app.js'),original+'\n}\n');await until(()=>read().find(e=>e.event==='loaded'&&!e.snapshot.hook),'syntax error displayed');const count=read().length;fs.writeFileSync(path.join(fixture,'web/app.js'),original);const e=await until(()=>read().slice(count).find(e=>e.event==='loaded'&&e.snapshot.connected),'syntax error repaired');assert.equal(e.snapshot.value,'native edited\n');assert.equal(e.snapshot.prompt,'keep prompt');});
 await check('Missing-hook reload waits for actual editable text and ignores checkbox submission values',async()=>{const before=read().length;fs.writeFileSync(path.join(fixture,'web/app.js'),"document.getElementById('prompt').value='unacknowledged fallback text'; setTimeout(()=>document.getElementById('prompt').value='',4000);\n");await until(()=>read().slice(before).find(e=>e.event==='loaded'&&!e.snapshot.hook&&e.snapshot.prompt==='unacknowledged fallback text'),'fallback text displayed');const count=read().length;fs.writeFileSync(path.join(fixture,'web/app.js'),original);await new Promise(r=>setTimeout(r,1000));assert.equal(read().slice(count).filter(e=>e.event==='loaded').length,0,'Reload discarded editable fallback text');assert(alive(hostPid));const e=await until(()=>read().slice(count).find(e=>e.event==='loaded'&&e.snapshot.connected&&e.snapshot.hook),'reload after fallback text cleared');assert.equal(e.snapshot.value,'native edited\n');assert.equal(e.snapshot.prompt,'keep prompt');});
 await check('Restoring an empty HTML file resumes the editor without losing its view',async()=>{const count=read().length;fs.writeFileSync(path.join(fixture,'web/index.html'),'');await until(()=>read().slice(count).find(e=>e.event==='loaded'&&!e.snapshot.hook),'empty HTML displayed');const after=read().length;fs.copyFileSync(path.join(repo,'web/index.html'),path.join(fixture,'web/index.html'));const e=await until(()=>read().slice(after).find(e=>e.event==='loaded'&&e.snapshot.connected),'HTML restored');assert.equal(e.snapshot.value,'native edited\n');assert.equal(e.snapshot.prompt,'keep prompt');assert.equal(e.snapshot.selection,3);});
 await check('A failed Rust build leaves the working session alive',async()=>{fs.writeFileSync(path.join(tmp,'build-fails'),'1');fs.appendFileSync(path.join(fixture,'src/main.rs'),'// fails\n');await new Promise(r=>setTimeout(r,1500));assert(alive(hostPid));assert.equal(read().filter(e=>e.event==='restart').length,0);fs.unlinkSync(path.join(tmp,'build-fails'));});
 await check('A successful Rust build restarts only the owned host and reauthenticates',async()=>{fs.appendFileSync(path.join(fixture,'src/main.rs'),'// success\n');const e=await until(()=>read().find(e=>e.event==='loaded'&&e.hostPid!==hostPid&&e.snapshot.connected),'host restart');assert.equal(e.snapshot.value,'native edited\n');assert.equal(e.snapshot.prompt,'keep prompt');const old=hostPid;hostPid=e.hostPid;await until(()=>!alive(old),'old host reaped');});
 await check('An active terminal defers Rust restart without ending its shell',async()=>{fs.writeFileSync(path.join(fixture,'web/app.js'),original+"\nsetTimeout(()=>window.__desktopCommand(':terminal'),500);\n");await new Promise(r=>setTimeout(r,2200));const count=read().filter(e=>e.event==='restart').length;fs.appendFileSync(path.join(fixture,'src/main.rs'),'// deferred\n');await new Promise(r=>setTimeout(r,1600));assert(alive(hostPid));assert.equal(read().filter(e=>e.event==='restart').length,count);});
 await check('Ending the terminal applies the deferred build',async()=>{fs.writeFileSync(path.join(fixture,'web/app.js'),original+"\nsetTimeout(()=>{window.confirm=()=>true;document.getElementById('terminal-end').click();},500);\n");const old=hostPid;const e=await until(()=>read().findLast(e=>e.event==='loaded'&&e.hostPid!==old&&e.snapshot.connected&&alive(e.hostPid)),'deferred restart');hostPid=e.hostPid;await until(()=>!alive(old),'deferred old host reaped');});
 await check('Killing the window process closes its pipe and stops its owned host',async()=>{desktop.kill('SIGKILL');await until(()=>!alive(hostPid),'host stops on parent EOF');});
 const output={status:'pass',checks,platform:process.platform,architecture:process.arch,actualNativeWKWebView:true,disposableWorkspace:true,realInferenceRequests:0,rustBuildInWatcher:'simulated; real cargo checks run separately'};
 fs.mkdirSync(path.join(repo,'tests/desktop'),{recursive:true});fs.writeFileSync(path.join(repo,'tests/desktop/validation.json'),JSON.stringify(output,null,2)+'\n');console.log('DESKTOP PASS '+checks.length);
 fs.rmSync(path.join(repo,'tests/desktop/failure.json'),{force:true});
})().catch(e=>{console.error(e.stack);fs.mkdirSync(path.join(repo,'tests/desktop'),{recursive:true});const failure={status:'fail',error:e.message,events:read()};fs.writeFileSync(path.join(repo,'tests/desktop/failure.json'),JSON.stringify(failure,null,2)+'\n');fs.writeFileSync(path.join(repo,'tests/desktop/validation.json'),JSON.stringify(failure,null,2)+'\n');process.exitCode=1;}).finally(async()=>{if(desktop&&alive(desktop.pid))desktop.kill('SIGKILL');if(hostPid&&alive(hostPid))process.kill(hostPid,'SIGTERM');await new Promise(r=>setTimeout(r,400));fs.rmSync(tmp,{recursive:true,force:true});});
