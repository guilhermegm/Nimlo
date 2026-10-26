#!/usr/bin/env node
'use strict';
const {appBundle}=require('./app-bundle.cjs');
// Small diagnostic for a suspended real WKWebView. No performance conclusion.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process'),repo=path.resolve(__dirname,'..');
const sha=filename=>crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const preparation=process.env.NATIVE_DIAGNOSTIC_PREPARATION||path.join(repo,'target/native-performance-prepared-baseline.json');
const descriptor=fs.existsSync(preparation)?JSON.parse(fs.readFileSync(preparation)):null;
const sourceApp=descriptor?.app||path.join(repo,'target/performance-baseline-a811aaf/Relay.app');
const bundleIdentity=appBundle(sourceApp);
const wrapper=process.env.NATIVE_DIAGNOSTIC_WRAPPER||descriptor?.diagnosticWrapper||path.join(repo,'target/performance-baseline-a811aaf/RelayDiagnostic-visible');
const diagnosticManifest=descriptor?.diagnosticManifest||path.join(repo,'target/performance-baseline-a811aaf/diagnostic-visible-build-manifest.json');
let helperAssociation=null;
if(!process.env.NATIVE_DIAGNOSTIC_WRAPPER){helperAssociation=JSON.parse(fs.readFileSync(diagnosticManifest));assert.equal(sha(wrapper),helperAssociation.nativePreResignSha256,'Frozen native diagnostic helper does not match manifest');assert.equal(sha(path.join(repo,'desktop/macos/Metrics.swift')),helperAssociation.metricsSourceSha256,'Prepare a helper from current Metrics.swift before debugging');}
if(process.argv.includes('--plan')&&process.argv[process.argv.indexOf('--plan')+1]==='1'){console.log(JSON.stringify({sourceApp,wrapper,diagnosticManifest:helperAssociation?diagnosticManifest:null,helperValidated:!!helperAssociation,explicitOverride:!!process.env.NATIVE_DIAGNOSTIC_WRAPPER,willLaunchApps:false,willModifyFiles:false},null,2));process.exit(0);}
const {processes}=require('./native-performance-check.cjs');
const base=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-native-window-debug-'))),appPath=path.join(base,'Nimlo.app'),project=path.join(base,'workspace'),bin=path.join(base,'bin'),report=path.join(base,'native.json');
const pause=ms=>new Promise(r=>setTimeout(r,ms));let app,host,appIdentity,hostIdentity,sequence=0;
const output=path.join(repo,'tests/native-performance-window-debug.json'),result={scope:'Disposable copied native window diagnostics only, not a performance trial',sourceApp,wrapper,helperAssociation,explicitOverride:!!process.env.NATIVE_DIAGNOSTIC_WRAPPER,snapshots:[]};
function read(){try{return JSON.parse(fs.readFileSync(report,'utf8'));}catch{return [];}}
async function until(fn){for(let i=0;i<300;i++){const value=await fn();if(value)return value;await pause(50);}throw Error('Diagnostic deadline');}
async function command(payload){const name=String(sequence++).padStart(6,'0')+'.json';fs.writeFileSync(path.join(report+'.commands',name),JSON.stringify(payload),{mode:0o600});const value=await until(()=>{try{return JSON.parse(fs.readFileSync(path.join(report+'.responses',name),'utf8'));}catch{return null;}});if(!value.ok)throw Error(value.error);return value.value??value;}
const snapshot="return {visibility:document.visibilityState,hidden:document.hidden,focus:document.hasFocus(),width:innerWidth,height:innerHeight,screenX,screenY,screenWidth:screen.width,screenHeight:screen.height,controller:document.getElementById('app')?.dataset.controller,appHidden:document.getElementById('app')?.hidden,codeRect:document.getElementById('code-input')?.getBoundingClientRect().toJSON(),codeDisplay:getComputedStyle(document.getElementById('code-input')).display,joinOpen:document.getElementById('join-dialog')?.open};";
(async()=>{try{
  for(const dir of[project,bin,report+'.commands',report+'.responses'])fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(path.join(project,'ordinary.txt'),'ordinary fixture\n');
  for(const name of['codex','claude'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\necho "Logged in using subscription"\n',{mode:0o700});
  fs.cpSync(sourceApp,appPath,{recursive:true});fs.copyFileSync(wrapper,path.join(appPath,bundleIdentity.native));
  execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier dev.nimlo.windowdebug.'+crypto.randomUUID().replaceAll('-',''),path.join(appPath,'Contents/Info.plist')]);execFileSync('/usr/bin/codesign',['--force','--sign','-',appPath],{stdio:'ignore'});
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});if([8765,8767].includes(port))throw Error('Excluded port');
  app=spawn(path.join(appPath,bundleIdentity.native),['--workspace',project,'--state-dir',path.join(base,'state'),'--port',String(port),'--test-report',report],{env:{...process.env,PATH:bin+':/usr/bin:/bin:/usr/sbin:/sbin'},stdio:'ignore'});
  appIdentity=processes().find(p=>p.pid===app.pid&&p.ppid===process.pid)?.startIdentity;assert(appIdentity,'Owned native wrapper identity must be observed');
  const loaded=await until(()=>read().find(e=>e.event==='loaded'&&e.snapshot.connected));host=loaded.hostPid;hostIdentity=processes().find(p=>p.pid===host&&p.ppid===app.pid)?.startIdentity;assert(hostIdentity,'Owned Rust host parent/start identity must be observed');
  result.snapshots.push({label:'loaded',value:await command({kind:'javascript',javascript:snapshot})});
  result.nativeFront=await command({kind:'front'});await pause(300);result.snapshots.push({label:'front',value:await command({kind:'javascript',javascript:snapshot})});
  result.frameObservation=await command({kind:'javascript',javascript:"return await Promise.race([new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r({frames:true})))),new Promise(r=>setTimeout(()=>r({frames:false,visibility:document.visibilityState,focus:document.hasFocus()}),1500))]);"});
  result.status='pass';
}catch(error){result.status='fail';result.error=error.message;process.exitCode=1;}finally{
  const alive=(pid,identity)=>!!identity&&processes().some(p=>p.pid===pid&&p.startIdentity===identity);
  if(app&&app.exitCode===null&&alive(app.pid,appIdentity))app.kill('SIGTERM');await pause(300);if(host&&alive(host,hostIdentity)){try{process.kill(host,'SIGTERM');}catch{}}
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));fs.rmSync(base,{recursive:true,force:true});
}})();
