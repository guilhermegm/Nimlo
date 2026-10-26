#!/usr/bin/env node
'use strict';
// Real WKDownload transport from the embedded Device drafts UI. The fixture
// supplies a private destination instead of interacting with the Save panel.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-native-download-')));
const report=path.join(tmp,'native.json'),commands=report+'.commands',responses=report+'.responses',downloads=report+'.downloads',workspace=path.join(tmp,'project'),bin=path.join(tmp,'bin');
const source='Pending recovery: 日本語 😀 e\u0301\n'+('exact recovery copy\n').repeat(1500),drafts=['deleted.txt','another.txt'];
let app,host,sequence=0;const checks=[],pause=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
async function until(fn,label){for(let i=0;i<200;i++){const result=await fn();if(result)return result;await pause(100);}throw Error('Timeout: '+label);}
async function command(javascript){const name=String(++sequence).padStart(6,'0')+'.json';fs.writeFileSync(path.join(commands,name),JSON.stringify({kind:'javascript',javascript}),{mode:0o600});const result=await until(()=>read(path.join(responses,name)),'private fixture response');assert.equal(result.ok,true,result.error);return result.value;}
(async()=>{
 for(const directory of [workspace,bin,commands,downloads])fs.mkdirSync(directory,{mode:0o700});
 for(const provider of ['codex','claude']){fs.writeFileSync(path.join(bin,provider),'#!/bin/sh\necho "Logged in using subscription"\n',{mode:0o700});}
 const entries=drafts.map((file,index)=>['relay-draft:'+workspace+':'+file,JSON.stringify({workspacePath:workspace,path:file,text:source+index+'\n',baseRevision:1,sessionId:'fixture-old-session'})]);
 fs.writeFileSync(path.join(commands,'000000.json'),JSON.stringify({kind:'install',javascript:'for(const [key,value] of '+JSON.stringify(entries)+')sessionStorage.setItem(key,value);'}),{mode:0o600});
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 const executable=path.join(repo,'target/desktop/Nimlo.app/Contents/MacOS/Nimlo');
 app=spawn(executable,['--workspace',workspace,'--state-dir',path.join(tmp,'state'),'--port',String(port),'--test-report',report],{env:{...process.env,PATH:bin+':/usr/bin:/bin:/usr/sbin:/sbin'},stdio:'ignore'});
 const loaded=await until(()=>(read(report)||[]).find(e=>e.event==='loaded'&&e.snapshot.connected&&e.snapshot.authenticated),'native authenticated page');host=loaded.hostPid;
 for(const file of ['index.html','editor.js','app.js','style.css'])assert.equal(await(await fetch('http://127.0.0.1:'+port+(file==='index.html'?'/':'/'+file))).text(),fs.readFileSync(path.join(repo,'web',file),'utf8'));
 checks.push('Actual release native window authenticated and all four embedded assets match source');
 assert.equal(await command("document.getElementById('device-drafts').click(); return document.querySelectorAll('.draft-row').length;"),2);
 async function download(file){return command("const row=[...document.querySelectorAll('.draft-row')].find(row=>row.querySelector('strong').textContent==="+JSON.stringify(file)+"); row.querySelector('button').click(); return true;");}
 await download(drafts[0]);await until(()=>fs.existsSync(path.join(downloads,drafts[0])),'first WKDownload');
 assert.equal(fs.readFileSync(path.join(downloads,drafts[0]),'utf8'),source+'0\n');
 assert.equal(await command('return sessionStorage.getItem('+JSON.stringify(entries[0][0])+')!==null;'),true);
 assert.deepEqual(fs.readdirSync(workspace),[]);checks.push('Device drafts saves exact Unicode bytes through WKDownload, retains its pending copy and leaves host files untouched');
 await download(drafts[0]);await pause(750);assert.equal(fs.readFileSync(path.join(downloads,drafts[0]),'utf8'),source+'0\n');
 await download(drafts[1]);await until(()=>fs.existsSync(path.join(downloads,drafts[1])),'export after cancelled existing destination');
 assert.equal(fs.readFileSync(path.join(downloads,drafts[1]),'utf8'),source+'1\n');checks.push('Existing destination is preserved and a cancelled export releases its single transfer slot');
 app.kill('SIGTERM');await until(()=>!alive(host),'owned host cleanup');await until(()=>app.exitCode!==null||app.signalCode!==null,'owned window cleanup');checks.push('Only the owned fixture window and host stop after testing');
 const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 fs.writeFileSync(path.join(repo,'tests/desktop/native-download.json'),JSON.stringify({status:'pass',checks,binarySha256:sha(path.join(repo,'target/release/nimlo-editor')),nativeExecutableSha256:sha(executable),fixtureOnly:true,realInferenceRequests:0,limits:['Save-panel interaction requires an unlocked Mac and was replaced with a private fixture destination. The actual WebKit Blob transfer and application download policy were exercised.']},null,2)+'\n');
 console.log('PASS native download: '+checks.length+' checks');
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{if(app&&alive(app.pid))app.kill('SIGKILL');if(host&&alive(host))process.kill(host,'SIGTERM');await pause(300);fs.rmSync(tmp,{recursive:true,force:true});});
