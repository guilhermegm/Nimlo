#!/usr/bin/env node
'use strict';

// Invoke the real AppKit Find menu against the real WKWebView in a disposable
// app. Only a private Metrics.swift copy receives the fixture commands; the
// shipping bridge, installed application and user's projects stay untouched.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const crypto=require('node:crypto'),assert=require('node:assert/strict'),net=require('node:net');
const cp=require('node:child_process'),{promisify}=require('node:util');
const execFile=promisify(cp.execFile);
const repo=path.resolve(__dirname,'..');
const sourceApp=path.resolve(process.env.NIMLO_APP || path.join(repo,'target/desktop/Nimlo.app'));
const output=path.resolve(process.env.NATIVE_FIND_OUTPUT || path.join(repo,'target/find-in-file-review/native.json'));
const work=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-native-find-')));
fs.chmodSync(work,0o700);
const bundle=path.join(work,'Nimlo.app'),report=path.join(work,'native.json'),project=path.join(work,'project');
const checks=[],menus=[];let child,hostPid,sequence=0,stderr='';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const result={status:'running',startedAt:new Date().toISOString(),method:{realAppKitMenu:true,realWKWebView:true,privateCopiedMetricsOnly:true,systemAutomation:false,realInferenceRequests:0,disposableWorkspace:true},checks,menus};
async function run(file,args){return(await execFile(file,args,{cwd:repo,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})).stdout;}
async function until(test,label){const end=Date.now()+30000;while(Date.now()<end){const value=await test();if(value)return value;await pause(60);}throw Error('Timeout: '+label);}
function json(file,value){fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});fs.chmodSync(file,0o600);}
async function command(value){
  const name=String(++sequence).padStart(6,'0')+'.json',destination=path.join(report+'.commands',name);
  json(destination+'.tmp',value);fs.renameSync(destination+'.tmp',destination);
  const response=await until(()=>read(path.join(report+'.responses',name)),'private '+value.kind+' response');
  assert.equal(response.ok,true,response.error);return response;
}
async function javascript(body){return(await command({kind:'javascript',javascript:body})).value;}
async function openNative(file,text){
  await javascript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',metaKey:true,shiftKey:true,bubbles:true,cancelable:true}));return true;");
  await until(()=>javascript("return document.getElementById('command-dialog').open;"),'native file picker');
  await javascript(`const input=document.getElementById('command-input');input.value=${JSON.stringify(':e ')}+${JSON.stringify(file)};input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('command-form').requestSubmit();return true;`);
  await until(()=>javascript(`return !document.getElementById('command-dialog').open&&document.getElementById('file-label').textContent===${JSON.stringify(file)}&&window.nimloEditor.value===${JSON.stringify(text)};`),'native open '+file);
}
async function menu(action,expectedKey,expectedShift=false,shortcut=false){
  const value=await command({kind:'find-menu',action,shortcut});menus.push(value);
  assert.equal(value.key,expectedKey);assert.equal(value.command,true);assert.equal(value.shift,expectedShift);assert.equal(value.otherModifiers,false);assert.equal(value.enabled,true);
  assert.equal(value.windowVisible,true,'Editor window remains open');
  return value;
}
async function check(name,action){await action();checks.push(name);console.log('PASS '+name);}
function alive(pid){if(!Number.isInteger(pid)||pid<2)return false;try{process.kill(pid,0);return true;}catch{return false;}}
async function terminateOwned(pid,signal){
  if(!alive(pid))return;assert(pid!==62074&&pid!==62115,'Refusing user session PID');
  const commandLine=(await run('/bin/ps',['-p',String(pid),'-o','command='])).replaceAll('/private/var/','/var/');
  assert(commandLine.includes(bundle.replaceAll('/private/var/','/var/')),'Refusing unrelated process');process.kill(pid,signal);
}

(async()=>{
  assert.equal(process.platform,'darwin','Native Find requires macOS');
  assert(fs.existsSync(sourceApp),'Build Nimlo.app before running native Find checks');
  for(const directory of [project,path.join(work,'state'),path.join(work,'bin'),report+'.commands',report+'.responses'])fs.mkdirSync(directory,{mode:0o700});
  const source='Alpha alpha ALPHA\nliteral .* [x]\nlast alpha\n';
  fs.writeFileSync(path.join(project,'find.txt'),source);
  fs.writeFileSync(path.join(project,'other.txt'),'Another file\n');
  for(const provider of ['codex','claude'])fs.writeFileSync(path.join(work,'bin',provider),'#!/bin/sh\nprintf "Logged in using subscription\\n"\n',{mode:0o700});
  const main=fs.readFileSync(path.join(repo,'desktop/macos/main.swift'),'utf8');
  let metrics=fs.readFileSync(path.join(repo,'desktop/macos/Metrics.swift'),'utf8');
  result.mainSourceSha256=hash(main);result.metricsSourceSha256=hash(metrics);
  const boundary='case "front":';assert.equal(metrics.split(boundary).length,2,'Private Metrics fixture boundary changed');
  metrics=metrics.replace(boundary,String.raw`
        case "fixture-quit":
            done(["ok": true]); app.quitting = true; app.stopHost(); NSApp.terminate(nil)
        case "find-menu":
            guard let action = command["action"] as? String,
                  ["findInFile", "findNext", "findPrevious", "saveFile", "undoEdit", "redoEdit", "closeCurrentFile"].contains(action), let mainMenu = NSApp.mainMenu else {
                done(["ok": false, "error": "Missing native Find menu action"]); return
            }
            func locate(_ menu: NSMenu) -> NSMenuItem? {
                for item in menu.items {
                    if item.action == NSSelectorFromString(action), item.target === app { return item }
                    if let submenu = item.submenu, let result = locate(submenu) { return result }
                }
                return nil
            }
            guard let item = locate(mainMenu), let parent = item.menu else {
                done(["ok": false, "error": "Native Find menu item not found"]); return
            }
            // Opening an AppKit menu refreshes auto-enabled items. Match that
            // behavior before invoking an item from this private file command.
            parent.update()
            let enabled = item.isEnabled && app.validateMenuItem(item)
            guard enabled else { done(["ok": false, "error": "Native Find menu disabled"]); return }
            let modifiers = item.keyEquivalentModifierMask
            if command["shortcut"] as? Bool == true {
                frontWindow()
                let codes: [String: UInt16] = ["f": 3, "g": 5, "s": 1, "z": 6, "w": 13]
                let characters = modifiers.contains(.shift) ? item.keyEquivalent.uppercased() : item.keyEquivalent
                guard let code = codes[item.keyEquivalent], let event = NSEvent.keyEvent(with: .keyDown, location: .zero,
                    modifierFlags: modifiers, timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: app.window.windowNumber, context: nil, characters: characters,
                    charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code) else {
                    done(["ok": false, "error": "Cannot create native shortcut"]); return
                }
                NSApp.sendEvent(event)
            } else {
                parent.performActionForItem(at: parent.index(of: item))
            }
            done(["ok": true, "title": item.title, "key": item.keyEquivalent,
                  "command": modifiers.contains(.command), "shift": modifiers.contains(.shift),
                  "otherModifiers": !modifiers.intersection([.control, .option]).isEmpty, "enabled": enabled,
                  "windowVisible": app.window.isVisible,
                  "shortcut": command["shortcut"] as? Bool == true])
        case "front":`);
  fs.writeFileSync(path.join(work,'main.swift'),main);fs.writeFileSync(path.join(work,'Metrics.swift'),metrics);
  const native=path.join(work,'Nimlo');
  await run('/usr/bin/swiftc',['-O','-target',`${os.arch()==='arm64'?'arm64':'x86_64'}-apple-macosx13.3`,path.join(repo,'desktop/macos/Policy.swift'),path.join(work,'main.swift'),path.join(work,'Metrics.swift'),path.join(repo,'desktop/macos/Downloads.swift'),path.join(repo,'desktop/macos/UpdateManifest.swift'),path.join(repo,'desktop/macos/UpdateInstaller.swift'),path.join(repo,'desktop/macos/Updater.swift'),'-o',native,'-framework','AppKit','-framework','WebKit']);
  fs.cpSync(sourceApp,bundle,{recursive:true});fs.copyFileSync(native,path.join(bundle,'Contents/MacOS/Nimlo'));
  result.hostSha256=hash(fs.readFileSync(path.join(bundle,'Contents/Resources/nimlo-editor')));
  const plist=path.join(bundle,'Contents/Info.plist');
  await run('/usr/bin/plutil',['-replace','CFBundleIdentifier','-string','dev.nimlo.findfixture.'+crypto.randomUUID().replaceAll('-',''),plist]);
  await run('/usr/bin/plutil',['-replace','NimloUpdateFeedURL','-string','',plist]);
  await run('/usr/bin/codesign',['--force','--sign','-',bundle]);await run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
  const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
  const env={...process.env,PATH:path.join(work,'bin')+':/usr/bin:/bin:/usr/sbin:/sbin'};delete env.ENV;delete env.BASH_ENV;
  child=cp.spawn(path.join(bundle,'Contents/MacOS/Nimlo'),['--workspace',project,'--state-dir',path.join(work,'state'),'--port',String(port),'--test-report',report],{env,stdio:['ignore','ignore','pipe']});
  child.stderr.on('data',bytes=>{stderr=(stderr+bytes).slice(-4000);});
  child.on('error',error=>{stderr+=error.message;});
  const loaded=await until(()=>read(report)?.find(event=>event.event==='loaded'&&event.snapshot?.connected&&event.snapshot?.hook),'private native editor startup');
  hostPid=loaded.hostPid;assert(alive(hostPid));
  result.ownedPids={app:child.pid,host:hostPid};
  await javascript(String.raw`
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'P',metaKey:true,shiftKey:true,bubbles:true,cancelable:true}));
    const wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Native Find fixture editor wait');};
    await wait(()=>document.getElementById('command-dialog').open);
    const query=document.getElementById('command-input');query.value=':e find.txt';query.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('command-form').requestSubmit();
    await wait(()=>!document.getElementById('command-dialog').open&&window.nimloEditor.value==='Alpha alpha ALPHA\nliteral .* [x]\nlast alpha\n');
    window.nimloEditor.setSelectionRange(0,5);document.getElementById('code-input').focus({preventScroll:true});return true;
  `);
  await check('AppKit Edit → Find in File has Command F and opens real WebKit search',async()=>{
    await menu('findInFile','f');
    await until(()=>javascript("return !document.getElementById('file-find').hidden&&document.activeElement.id==='file-find-input'&&document.getElementById('file-find-input').value==='Alpha'&&document.getElementById('file-find-count').textContent==='1 of 4';"),'native Find opens');
  });
  await check('AppKit Find Next has Command G and advances the editor selection',async()=>{
    await menu('findNext','g');await until(()=>javascript('return window.nimloEditor.selectionStart===6&&window.nimloEditor.selectionEnd===11;'),'native next selection');
  });
  await check('AppKit Find Previous has Shift Command G and reverses the editor selection',async()=>{
    await menu('findPrevious','g',true);await until(()=>javascript('return window.nimloEditor.selectionStart===0&&window.nimloEditor.selectionEnd===5;'),'native previous selection');
  });
  await check('Native Find leaves disk bytes unchanged and Escape restores code focus',async()=>{
    assert.equal(await javascript("document.getElementById('file-find-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));return document.getElementById('file-find').hidden&&document.activeElement.id==='code-input'&&window.nimloEditor.selectionStart===0&&window.nimloEditor.selectionEnd===5;"),true);
    assert.equal(fs.readFileSync(path.join(project,'find.txt'),'utf8'),source);
  });
  await check('A native Command F key event opens Find and Command G shortcuts navigate once',async()=>{
    await menu('findInFile','f',false,true);
    await until(()=>javascript("return !document.getElementById('file-find').hidden&&document.activeElement.id==='file-find-input';"),'keyboard Find opens');
    await menu('findNext','g',false,true);
    await until(()=>javascript('return window.nimloEditor.selectionStart===6&&window.nimloEditor.selectionEnd===11;'),'keyboard next match');
    await menu('findPrevious','g',true,true);
    await until(()=>javascript('return window.nimloEditor.selectionStart===0&&window.nimloEditor.selectionEnd===5;'),'keyboard previous match');
    await javascript("document.getElementById('file-find-close').click();return true;");
  });
  await javascript(String.raw`
    window.__nativeEditorCommands=[];
    const send=WebSocket.prototype.send;
    WebSocket.prototype.send=function(data){window.__nativeEditorCommands.push(JSON.parse(data).type);return send.call(this,data);};
    window.nimloEditor.setSelectionRange(0,0);document.getElementById('code-input').focus();
    document.execCommand('insertText',false,'changed ');return true;
  `);
  await check('Native Undo and Redo menus use shared file history exactly once',async()=>{
    await until(()=>javascript("return window.nimloEditor.value.startsWith('changed ');"),'edited buffer');
    await menu('undoEdit','z');
    await until(()=>javascript(`return window.nimloEditor.value===${JSON.stringify(source)};`),'menu Undo');
    await menu('redoEdit','z',true);
    await until(()=>javascript(`return window.nimloEditor.value===${JSON.stringify('changed '+source)};`),'menu Redo');
    assert.equal(await javascript("return window.__nativeEditorCommands.filter(type=>type==='undo_file').length;"),1);
    assert.equal(await javascript("return window.__nativeEditorCommands.filter(type=>type==='redo_file').length;"),1);
  });
  await check('Native Command Z and Shift Command Z each change shared history once',async()=>{
    await menu('undoEdit','z',false,true);
    await until(()=>javascript(`return window.nimloEditor.value===${JSON.stringify(source)};`),'keyboard Undo');
    await menu('redoEdit','z',true,true);
    await until(()=>javascript(`return window.nimloEditor.value===${JSON.stringify('changed '+source)};`),'keyboard Redo');
    assert.equal(await javascript("return window.__nativeEditorCommands.filter(type=>type==='undo_file').length;"),2);
    assert.equal(await javascript("return window.__nativeEditorCommands.filter(type=>type==='redo_file').length;"),2);
  });
  await check('Native Save menu and Command S save the current buffer to disk',async()=>{
    await menu('saveFile','s');await until(()=>fs.readFileSync(path.join(project,'find.txt'),'utf8')==='changed '+source,'menu Save');
    await menu('undoEdit','z',false,true);await until(()=>javascript(`return window.nimloEditor.value===${JSON.stringify(source)};`),'undo before saving');
    await menu('saveFile','s',false,true);await until(()=>fs.readFileSync(path.join(project,'find.txt'),'utf8')===source,'keyboard Save');
    assert.equal(await javascript("return window.__nativeEditorCommands.filter(type=>type==='save_file').length;"),2);
  });
  await check('Native Undo in the search field preserves code and uses field history',async()=>{
    await javascript('window.nimloEditor.setSelectionRange(0,5);return true;');
    await menu('findInFile','f');
    await until(()=>javascript("return document.activeElement.id==='file-find-input';"),'search field focus');
    const before=await javascript('return window.__nativeEditorCommands.length;');
    await javascript("document.execCommand('insertText',false,'needle');return true;");
    await until(()=>javascript("return document.getElementById('file-find-input').value==='needle';"),'edited search field');
    await menu('undoEdit','z',false,true);
    await until(()=>javascript("return document.getElementById('file-find-input').value==='Alpha';"),'search field Undo');
    assert.equal(await javascript('return window.__nativeEditorCommands.length;'),before);
    assert.equal(await javascript(`return window.nimloEditor.value===${JSON.stringify(source)};`),true);
  });
  await check('Native Undo and Redo survive switching away from a saved file',async()=>{
    await javascript("document.getElementById('file-find-close').click();window.nimloEditor.setSelectionRange(0,0);document.getElementById('code-input').focus();document.execCommand('insertText',false,'retained ');return true;");
    await menu('saveFile','s',false,true);
    await until(()=>fs.readFileSync(path.join(project,'find.txt'),'utf8')==='retained '+source,'saved history fixture');
    await openNative('other.txt','Another file\n');await openNative('find.txt','retained '+source);
    await menu('undoEdit','z',false,true);await until(()=>javascript(`return window.nimloEditor.value===${JSON.stringify(source)};`),'retained native Undo');
    await menu('redoEdit','z',true,true);await until(()=>javascript(`return window.nimloEditor.value===${JSON.stringify('retained '+source)};`),'retained native Redo');
    await openNative('other.txt','Another file\n');await openNative('find.txt','retained '+source);
  });
  await check('Command W closes the saved file while keeping the native window open',async()=>{
    await menu('closeCurrentFile','w',false,true);
    await until(()=>javascript("return document.getElementById('file-label').textContent!=='find.txt'&&!document.querySelector('.open-file[data-path=\"find.txt\"]');"),'saved file closed');
    assert(alive(child.pid));assert(alive(hostPid));
    await menu('closeCurrentFile','w',false,true);
  });
  await check('Command W offers Cancel, Save and Don’t Save for unsaved files',async()=>{
    await openNative('find.txt','retained '+source);
    await javascript("window.nimloEditor.setSelectionRange(0,0);document.getElementById('code-input').focus();document.execCommand('insertText',false,'unsaved ');return true;");
    await menu('closeCurrentFile','w',false,true);
    await until(()=>javascript("return document.getElementById('close-file-dialog').open;"),'close confirmation');
    await javascript("document.querySelector('#close-file-dialog button[value=cancel]').click();return true;");
    await until(()=>javascript("return !document.getElementById('close-file-dialog').open&&document.getElementById('file-label').textContent==='find.txt'&&document.activeElement.id==='code-input';"),'cancel close');
    assert.equal(fs.readFileSync(path.join(project,'find.txt'),'utf8'),'retained '+source);
    await menu('closeCurrentFile','w',false,true);
    await until(()=>javascript("return document.getElementById('close-file-dialog').open;"),'save confirmation');
    await javascript("document.getElementById('close-file-save').click();return true;");
    await until(()=>javascript("return document.getElementById('file-label').textContent!=='find.txt';"),'save then close');
    assert.equal(fs.readFileSync(path.join(project,'find.txt'),'utf8'),'unsaved retained '+source);
    await openNative('find.txt','unsaved retained '+source);
    await javascript("window.nimloEditor.setSelectionRange(0,0);document.getElementById('code-input').focus();document.execCommand('insertText',false,'discard ');return true;");
    await menu('closeCurrentFile','w',false,true);
    await until(()=>javascript("return document.getElementById('close-file-dialog').open;"),'discard confirmation');
    await javascript("document.querySelector('#close-file-dialog button[value=discard]').click();return true;");
    await until(()=>javascript("return document.getElementById('file-label').textContent!=='find.txt';"),'discard then close');
    assert.equal(fs.readFileSync(path.join(project,'find.txt'),'utf8'),'unsaved retained '+source);
    assert(alive(child.pid));assert(alive(hostPid));
  });
  await command({kind:'fixture-quit'});await until(()=>!alive(child.pid)&&!alive(hostPid),'private native app and host shutdown');
  result.status='pass';
})().catch(async error=>{
  result.status='fail';result.error=error.stack;result.stderr=stderr;
  if(child&&alive(child.pid))try{result.failureView=await javascript("return {active:document.activeElement?.id,barHidden:document.getElementById('file-find')?.hidden,query:document.getElementById('file-find-input')?.value,count:document.getElementById('file-find-count')?.textContent,findHook:typeof window.nimloDesktop?.findInFile,controller:document.getElementById('app')?.dataset.controller,path:document.getElementById('file-label')?.textContent,selection:window.nimloEditor?.getSelection()};");}catch{}
  console.error(error.stack);process.exitCode=1;
}).finally(async()=>{
  try{
    if(child&&alive(child.pid)){await terminateOwned(child.pid,'SIGTERM');await pause(500);if(alive(child.pid))await terminateOwned(child.pid,'SIGKILL');}
    if(alive(hostPid)){await terminateOwned(hostPid,'SIGTERM');await pause(300);}
    result.ownedProcessesExited=(!child||!alive(child.pid))&&!alive(hostPid);
    if(!result.ownedProcessesExited){result.status='fail';result.cleanupError='Owned fixture process remains';process.exitCode=1;}
  }catch(error){result.status='fail';result.cleanupError=error.message;process.exitCode=1;}
  result.completedAt=new Date().toISOString();fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');fs.rmSync(work,{recursive:true,force:true});console.log(result.status.toUpperCase()+' '+output);
});
