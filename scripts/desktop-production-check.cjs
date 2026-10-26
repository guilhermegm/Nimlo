#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict'),{spawn,execFileSync}=require('node:child_process');
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-installed-app-'))),repo=path.resolve(__dirname,'..');let app,duplicate,host;
const pause=ms=>new Promise(r=>setTimeout(r,ms));const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function until(test,label){for(let i=0;i<150;i++){const v=await test();if(v)return v;await pause(100);}throw Error('Timeout: '+label);}
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return [];}}
(async()=>{
 const bundle=path.join(tmp,'Applications/Nimlo.app'),project=path.join(tmp,'project'),bin=path.join(tmp,'bin'),report=path.join(tmp,'report.json'),secondReport=path.join(tmp,'duplicate.json');
 fs.mkdirSync(project);fs.mkdirSync(bin);fs.cpSync(path.join(repo,'target/desktop/Nimlo.app'),bundle,{recursive:true});
 for(const name of ['codex','claude']){fs.writeFileSync(path.join(bin,name),'#!/bin/sh\necho "Logged in using subscription"\n');fs.chmodSync(path.join(bin,name),0o700);}
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});
 const executable=path.join(bundle,'Contents/MacOS/Nimlo'),args=['--workspace',project,'--state-dir',path.join(tmp,'state'),'--port',String(port)];
 const options={env:{...process.env,PATH:bin+':/usr/bin:/bin:/usr/sbin:/sbin'},stdio:'ignore'};
 const plist=path.join(bundle,'Contents/Info.plist');
 const metadata=key=>execFileSync('/usr/libexec/PlistBuddy',['-c','Print :'+key,plist],{encoding:'utf8'}).trim();
 assert.equal(metadata('CFBundleName'),'Nimlo');assert.equal(metadata('CFBundleDisplayName'),'Nimlo');assert.equal(metadata('CFBundleIdentifier'),'dev.nimlo.editor');assert.equal(metadata('CFBundleExecutable'),'Nimlo');assert.equal(metadata('CFBundleIconFile'),'Nimlo');
 assert.deepEqual(fs.readFileSync(path.join(bundle,'Contents/Resources/Nimlo.icns')),fs.readFileSync(path.join(repo,'desktop/macos/Nimlo.icns')));
 app=spawn(executable,[...args,'--test-report',report],options);
 const loaded=await until(()=>read(report).find(x=>x.event==='loaded'&&x.snapshot.connected&&x.snapshot.authenticated),'copied production bundle');host=loaded.hostPid;assert(alive(host));
 assert.equal((await fetch('http://127.0.0.1:'+port+'/api/bootstrap')).status,401);
 for(const file of ['index.html','editor.js','app.js','style.css']){const body=await(await fetch('http://127.0.0.1:'+port+(file==='index.html'?'/':'/'+file))).text();assert.equal(body,fs.readFileSync(path.join(repo,'web',file),'utf8'));}
 for(const file of ['favicon.png','apple-touch-icon.png','logo.png']){const response=await fetch('http://127.0.0.1:'+port+'/'+file);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),fs.readFileSync(path.join(repo,'web',file)));}
 duplicate=spawn(executable,[...args,'--test-report',secondReport],options);
 const error=await until(()=>read(secondReport).find(x=>x.event==='error'),'duplicate ownership rejected');assert(error.message.includes('already running'));assert(alive(host));
 await until(()=>duplicate.exitCode!==null,'duplicate app exits');
 const stats={status:'pass',copiedBundleOutsideCheckout:true,authenticatedNativeWindow:true,embeddedAssetsMatchSource:true,nimloIdentity:true,desktopIconMatchesSource:true,embeddedBrandImagesMatchSource:true,unauthenticatedBootstrap:401,duplicateOwnerRejected:true,nativeExecutableBytes:fs.statSync(executable).size,hostExecutableBytes:fs.statSync(path.join(bundle,'Contents/Resources/nimlo-editor')).size,disposableWorkspace:true,realInferenceRequests:0};
 app.kill('SIGTERM');await until(()=>!alive(host),'owned production host stops');stats.ownedHostShutdown=true;
 fs.writeFileSync(path.join(repo,'tests/desktop/production-bundle.json'),JSON.stringify(stats,null,2)+'\n');console.log('PASS copied production app, private login, embedded assets, single ownership and host cleanup');
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(app&&alive(app.pid))app.kill('SIGKILL');if(duplicate&&alive(duplicate.pid))duplicate.kill('SIGKILL');if(host&&alive(host))process.kill(host,'SIGTERM');await pause(300);fs.rmSync(tmp,{recursive:true,force:true});});
