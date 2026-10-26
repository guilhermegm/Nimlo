#!/usr/bin/env node
'use strict';

// Real Nimlo editor/host/helper lifecycle in disposable, locally signed bundles.
// The copied native source adds private fixture commands and explicit consent;
// production sources, signing keys, installed apps and user state stay untouched.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),assert=require('node:assert/strict'),net=require('node:net');
const cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const sourceApp=path.resolve(process.env.NIMLO_APP||path.join(root,'target/desktop/Nimlo.app'));
const output=path.join(root,'target/updater-review/installed-lifecycle.json');
const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-installed-update-')));
fs.chmodSync(work,0o700);
const checks=[],owned=new Map(),helperDirectories=new Set(),fixtures=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const run=(file,args,options={})=>cp.execFileSync(file,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:120000,maxBuffer:4*1024*1024,...options});
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
function json(file,value){fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});fs.chmodSync(file,0o600);}
function alive(pid){if(!Number.isInteger(pid)||pid<2)return false;try{process.kill(pid,0);return true;}catch{return false;}}
async function until(test,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const result=await test();if(result)return result;await delay(70);}throw Error('Timeout: '+label);}
function replaceOnce(source,needle,replacement){assert.equal(source.split(needle).length,2,'Fixture source boundary changed: '+needle);return source.replace(needle,replacement);}
function commandLine(pid){try{return run('/bin/ps',['-p',String(pid),'-o','command=']).trim();}catch{return '';}}
const systemAlias=value=>value.replaceAll('/private/var/','/var/').replaceAll('/private/tmp/','/tmp/');
function remember(pid,marker){assert(pid!==62074&&pid!==62115,'Refusing real user PID');assert(Number.isInteger(pid)&&pid>1);owned.set(pid,marker);}
function terminateOwned(pid,signal='SIGTERM'){const marker=owned.get(pid);if(!marker||!alive(pid))return;const command=commandLine(pid);if(systemAlias(command).includes(systemAlias(marker))&&pid!==62074&&pid!==62115)process.kill(pid,signal);}
async function port(){return new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});}
function signing(app){for(const relative of ['Contents/Resources/nimlo-editor','Contents/Helpers/nimlo-update-helper','Contents/MacOS/Nimlo',''])run('/usr/bin/codesign',['--force','--sign','-',path.join(app,relative)]);run('/usr/bin/codesign',['--verify','--deep','--strict',app]);}
function setInfo(app,key,value){run('/usr/bin/plutil',['-replace',key,'-string',String(value),path.join(app,'Contents/Info.plist')]);}
async function check(name,action){const start=Date.now();await action();checks.push({name,passed:true,milliseconds:Date.now()-start});console.log('PASS '+name);}

// No production key is read: Node creates an ephemeral fixture key in memory.
const keys=crypto.generateKeyPairSync('ed25519');
const publicKey=keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64');
let delegate=fs.readFileSync(path.join(root,'desktop/macos/main.swift'),'utf8');
const sourceHash=crypto.createHash('sha256').update(delegate).digest('hex');
delegate=replaceOnce(delegate,'let arguments = ["--state-dir", state!, "--port", String(port)]',
  'let arguments = ["--state-dir", state!, "--port", String(port), "--test-report", report!]');
delegate=replaceOnce(delegate,'self.updateInstallProcess = try NimloUpdateInstaller.launch(planURL: plan)',
  'self.updateInstallProcess = try NimloUpdateInstaller.launch(planURL: plan)\n                    self.recordNative("fixture-update-plan", fields: ["plan": plan.path, "helperPID": self.updateInstallProcess!.processIdentifier])');
delegate=delegate.replaceAll('alert.runModal()','InstalledUpdateConsent.respond(alert)');
delegate=delegate.replaceAll('NSApp.terminate(nil)','self.recordNative("fixture-terminate-request", fields: ["quitting": self.quitting]); NSApp.terminate(nil)');
delegate=replaceOnce(delegate,'func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {',
  'func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {\n        recordNative("fixture-terminate-delegate", fields: ["quitting": quitting, "hostRunning": host?.isRunning ?? false])');
delegate=replaceOnce(delegate,'let app = NSApplication.shared',String.raw`
enum InstalledUpdateConsent {
    @discardableResult static func respond(_ alert: NSAlert) -> NSApplication.ModalResponse {
        let value = ProcessInfo.processInfo.environment["NIMLO_INSTALLED_UPDATE_CONSENT"] ?? ""
        let url = URL(fileURLWithPath: value)
        let consent = (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }
        // Only the exact restart prompt may receive explicit fixture approval.
        // All unexpected native alerts are recorded and refused.
        let approved = alert.messageText == "Restart Nimlo to install the update?" && consent?["decision"] == "restart"
        let event: [String: Any] = ["message": alert.messageText, "approved": approved, "pid": getpid()]
        if let data = try? JSONSerialization.data(withJSONObject: event) {
            try? data.write(to: URL(fileURLWithPath: value + ".observed"), options: .atomic)
        }
        return approved ? .alertSecondButtonReturn : .alertFirstButtonReturn
    }
}

let app = NSApplication.shared`);
let metrics=fs.readFileSync(path.join(root,'desktop/macos/Metrics.swift'),'utf8');
metrics=replaceOnce(metrics,'case "front":',String.raw`
case "fixture-state":
            done(["ok": true, "pid": getpid(), "hostPID": app.host?.processIdentifier ?? 0,
                  "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
                  "installing": app.installingUpdate, "quitting": app.quitting])
        case "fixture-update":
            guard let archive = command["archive"] as? String, let envelope = command["envelope"] as? String else {
                done(["ok": false, "error": "Missing private fixture archive"]); return
            }
            app.installUpdate(archive: URL(fileURLWithPath: archive), envelope: URL(fileURLWithPath: envelope)) { installed in
                done(["ok": true, "installed": installed])
            }
        case "fixture-quit":
            done(["ok": true]); app.quitting = true; app.stopHost(); NSApp.terminate(nil)
        case "front":`);
fs.writeFileSync(path.join(work,'main.swift'),delegate);
fs.writeFileSync(path.join(work,'Metrics.swift'),metrics);
const native=path.join(work,'Nimlo');
const helper=path.join(work,'nimlo-update-helper');
let sequence=0;
async function command(fixture,value,timeout=30000){
  const name=String(++sequence).padStart(6,'0')+'.json',file=path.join(fixture.report+'.commands',name);
  const staged=file+'.tmp';json(staged,value);fs.renameSync(staged,file);
  const reply=await until(()=>read(path.join(fixture.report+'.responses',name)),'private fixture command '+value.kind,timeout);
  assert.equal(reply.ok,true,reply.error);return reply;
}
async function javascript(fixture,body){return (await command(fixture,{kind:'javascript',javascript:body})).value;}
async function ready(fixture){
  let status;
  await until(async()=>{
    status=await command(fixture,{kind:'fixture-state'});
    remember(status.pid,fixture.installed);
    if(status.hostPID>1)remember(status.hostPID,fixture.installed);
    // Metrics deliberately consumes prewritten fixture commands before the
    // host starts. Never mistake an old report or hostPID zero for readiness.
    return status.hostPID>1&&read(fixture.report)?.some(event=>event.event==='loaded'&&event.hostPid===status.hostPID&&event.snapshot?.connected&&event.snapshot?.hook);
  },'native editor startup');
  return status;
}
function envelope(fixture){
  const bytes=fs.readFileSync(fixture.archive),payload=Buffer.from(JSON.stringify({schema:1,bundleIdentifier:'dev.nimlo.editor',version:'0.2.0',build:2,publishedAt:new Date().toISOString(),minimumSystemVersion:'13.3',architecture:os.arch()==='arm64'?'arm64':'x86_64',url:'https://fixture.example.invalid/Nimlo.zip',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),releaseNotes:'Private installed Nimlo lifecycle fixture.'}));
  json(fixture.envelope,{payload:payload.toString('base64'),signature:crypto.sign(null,payload,keys.privateKey).toString('base64')});
}
async function setup(name,crash=false){
  const directory=path.join(work,name);fs.mkdirSync(directory,{mode:0o700});
  const fixture={directory,installed:path.join(directory,'installed/Nimlo.app'),incoming:path.join(directory,'incoming/Nimlo.app'),project:path.join(directory,'project'),state:path.join(directory,'state'),report:path.join(directory,'native.json'),consent:path.join(directory,'consent.json'),archive:path.join(directory,'release.zip'),envelope:path.join(directory,'release.json'),port:await port()};
  fixtures.push(fixture);
  for(const directory of [fixture.project,fixture.state,fixture.report+'.commands',fixture.report+'.responses'])fs.mkdirSync(directory,{mode:0o700});
  fs.writeFileSync(path.join(fixture.project,'fixture.md'),'Original file on disk.\n');
  for(const [app,build] of [[fixture.installed,1],[fixture.incoming,2]]){
    run('/usr/bin/ditto',[sourceApp,app]);
    fs.copyFileSync(native,path.join(app,'Contents/MacOS/Nimlo'));
    fs.copyFileSync(helper,path.join(app,'Contents/Helpers/nimlo-update-helper'));
    setInfo(app,'CFBundleVersion',build);setInfo(app,'CFBundleShortVersionString',build===1?'0.1.0':'0.2.0');setInfo(app,'NimloUpdatePublicKey',publicKey);setInfo(app,'NimloUpdateFeedURL','');
    if(crash&&build===2)fs.copyFileSync(path.join(work,'crash-native'),path.join(app,'Contents/MacOS/Nimlo'));
    signing(app);
  }
  // These archives originate in this private local build fixture. We never
  // remove quarantine or change assessment policy for an actual download.
  run('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',fixture.incoming,fixture.archive]);envelope(fixture);
  json(fixture.consent,{decision:'later'});
  const child=cp.spawn(path.join(fixture.installed,'Contents/MacOS/Nimlo'),['--workspace',fixture.project,'--state-dir',fixture.state,'--port',String(fixture.port),'--test-report',fixture.report],{env:{...process.env,NIMLO_INSTALLED_UPDATE_CONSENT:fixture.consent},stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',bytes=>stderr=(stderr+bytes).slice(-6000));child.on('error',error=>{stderr+=error.message;});fixture.stderr=()=>stderr;fixture.child=child;remember(child.pid,fixture.installed);
  fixture.before=await ready(fixture);
  await javascript(fixture,String.raw`
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',metaKey:true,shiftKey:true,bubbles:true,cancelable:true}));
    const wait=async predicate=>{for(let count=0;count<150;count++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Fixture editor wait');};
    await wait(()=>document.getElementById('command-dialog').open);
    const input=document.getElementById('command-input');input.value=':e fixture.md';input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('command-form').requestSubmit();
    await wait(()=>!document.getElementById('command-dialog').open&&document.getElementById('code-input').value==='Original file on disk.\n');
    const editor=document.getElementById('code-input');editor.value='Acknowledged unsaved lifecycle draft.\n';editor.dispatchEvent(new Event('input',{bubbles:true}));editor.setSelectionRange(8,8);
    for(let count=0;count<150;count++) {
      if(await window.nimloDesktop.prepareReload(false)) return true;
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    throw Error('Fixture draft was not durably acknowledged');
  `);
  assert.equal(await javascript(fixture,'return (await window.nimloDesktop.quitState()).pending;'),false);
  assert.equal(fs.readFileSync(path.join(fixture.project,'fixture.md'),'utf8'),'Original file on disk.\n');
  return fixture;
}
async function install(fixture){
  json(fixture.consent,{decision:'restart'});
  const pending=command(fixture,{kind:'fixture-update',archive:fixture.archive,envelope:fixture.envelope},120000);
  const event=await until(()=>read(fixture.report)?.find(event=>event.event==='fixture-update-plan'),'helper prepared',60000);
  fixture.plan=event.plan;fixture.helperPID=event.helperPID;helperDirectories.add(path.dirname(fixture.plan));remember(event.helperPID,path.dirname(fixture.plan));
  const result=await pending;assert.equal(result.installed,true,'Native app refused the authorized update');
  const observed=read(fixture.consent+'.observed');assert.equal(observed?.approved,true);assert.equal(observed?.pid,fixture.before.pid);
  await until(()=>!alive(fixture.before.pid)&&!alive(fixture.before.hostPID),'old app and host normal shutdown');
  return until(()=>{const status=read(path.join(path.dirname(fixture.plan),'status.json'));return ['complete','failed','unconfirmed'].includes(status?.state)?status:null;},'installer completion',60000);
}
async function verifyRestoredEditor(fixture,build){
  const after=await ready(fixture);assert.notEqual(after.pid,fixture.before.pid);assert.notEqual(after.hostPID,fixture.before.hostPID);assert.equal(after.build,String(build));
  const state=await javascript(fixture,"return {text:document.getElementById('code-input').value,dirty:!document.getElementById('save-button').hidden,project:document.getElementById('project-label').textContent,selection:document.getElementById('code-input').selectionStart};");
  assert.equal(state.text,'Acknowledged unsaved lifecycle draft.\n');assert.equal(state.dirty,true);assert.equal(state.project,'project');
  assert.equal(fs.readFileSync(path.join(fixture.project,'fixture.md'),'utf8'),'Original file on disk.\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.state,'last-project.json'),'utf8')).workspace,fixture.project);
  await command(fixture,{kind:'fixture-quit'});await until(()=>!alive(after.pid)&&!alive(after.hostPID),'fixture normal quit');return after;
}
(async()=>{
  assert.equal(process.platform,'darwin','Installed update lifecycle requires macOS');
  assert(fs.existsSync(sourceApp),'Build the final Nimlo.app before this fixture');
  run('/usr/bin/swiftc',['-O','-target',`${os.arch()==='arm64'?'arm64':'x86_64'}-apple-macosx13.3`,path.join(root,'desktop/macos/Policy.swift'),path.join(work,'main.swift'),path.join(work,'Metrics.swift'),path.join(root,'desktop/macos/Downloads.swift'),path.join(root,'desktop/macos/UpdateManifest.swift'),path.join(root,'desktop/macos/UpdateInstaller.swift'),path.join(root,'desktop/macos/Updater.swift'),'-o',native,'-framework','AppKit','-framework','WebKit']);
  run('/usr/bin/swiftc',['-O','-target',`${os.arch()==='arm64'?'arm64':'x86_64'}-apple-macosx13.3`,path.join(root,'desktop/macos/UpdateInstaller.swift'),path.join(root,'desktop/macos/update-helper/main.swift'),'-o',helper]);
  fs.writeFileSync(path.join(work,'crash.c'),'int main(void) { return 23; }\n');run('/usr/bin/clang',[path.join(work,'crash.c'),'-o',path.join(work,'crash-native')]);
  let success;
  await check('Later preserves the running Nimlo editor, host and acknowledged unsaved draft',async()=>{
    success=await setup('success');const result=await command(success,{kind:'fixture-update',archive:success.archive,envelope:success.envelope});assert.equal(result.installed,false);
    const status=await command(success,{kind:'fixture-state'});assert.equal(status.pid,success.before.pid);assert.equal(status.hostPID,success.before.hostPID);assert.equal(status.build,'1');assert.equal(status.installing,false);assert.equal(await javascript(success,"return document.getElementById('code-input').value;"),'Acknowledged unsaved lifecycle draft.\n');assert.equal(read(success.consent+'.observed')?.approved,false);
  });
  await check('Approved update replaces real Nimlo, confirms startup and restores its project and unsaved recovery',async()=>{
    const status=await install(success);assert.equal(status.state,'complete',JSON.stringify(status));const receipt=read(path.join(path.dirname(success.plan),'startup.json'));assert.equal(receipt?.build,2);const after=await verifyRestoredEditor(success,2);assert.equal(receipt.pid,after.pid);assert.equal(fs.existsSync(path.join(path.dirname(success.plan),'release.zip')),false);
  });
  await check('Crashing replacement rolls back and relaunches real Nimlo with the same project and unsaved recovery',async()=>{
    const fixture=await setup('crash',true);const status=await install(fixture);assert.equal(status.state,'failed');assert.match(status.message,/previous version was restored/i);await verifyRestoredEditor(fixture,1);
  });
})().then(()=>{
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({status:'passed',date:new Date().toISOString(),checks,count:checks.length,nativeSourceSHA256:sourceHash,embeddedHostSHA256:crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceApp,'Contents/Resources/nimlo-editor'))).digest('hex'),fixtureOnly:true,realNimloEditor:true,realNimloHost:true,realAtomicInstaller:true,productionKeysRead:false,productionSourceModified:false,limits:['Temporary native source copies add private Metrics update/state/quit commands, deterministic consent and report-only relaunch arguments.','Bundles are locally ad-hoc signed with a temporary manifest key; this is not a notarized downloaded-app qualification.','Crash candidate intentionally replaces only its fixture native executable with an immediate-exit program.','Old/new fixtures use the current editor/host with build numbers 1 and 2; this does not qualify historical data-format migrations.']},null,2)+'\n');
}).catch(error=>{
  const diagnostics=fixtures.map(fixture=>({before:fixture.before,oldChildExitCode:fixture.child?.exitCode,events:read(fixture.report),consent:read(fixture.consent+'.observed'),stderr:fixture.stderr?.(),processes:[...owned].map(([pid,marker])=>({pid,alive:alive(pid),command:commandLine(pid),marker})),installerStatus:fixture.plan?read(path.join(path.dirname(fixture.plan),'status.json')):null,helperLog:fixture.plan&&fs.existsSync(path.join(path.dirname(fixture.plan),'helper.log'))?fs.readFileSync(path.join(path.dirname(fixture.plan),'helper.log'),'utf8'):null}));
  console.error(error.stack);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({status:'failed',date:new Date().toISOString(),checks,error:error.stack,nativeSourceSHA256:sourceHash,diagnostics},null,2)+'\n');process.exitCode=1;
}).finally(async()=>{
  // A replacement or rollback may have launched before a failing assertion
  // could query its PID. Recover only processes whose command names this
  // uniquely created private fixture directory.
  for(const line of run('/bin/ps',['-axo','pid=,command=']).split('\n')) {
    const match=line.match(/^\s*(\d+)\s+(.+)$/);
    if(match&&systemAlias(match[2]).includes(systemAlias(work+'/')))remember(Number(match[1]),work+'/');
  }
  for(const pid of owned.keys())terminateOwned(pid);
  await delay(500);for(const pid of owned.keys())terminateOwned(pid,'SIGKILL');
  for(const directory of helperDirectories)if(![...owned.keys()].some(pid=>alive(pid)&&commandLine(pid).includes(directory)))fs.rmSync(directory,{recursive:true,force:true});
  fs.rmSync(work,{recursive:true,force:true});
});
