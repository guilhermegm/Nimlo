#!/usr/bin/env node
'use strict';
// Exercise actual AppKit welcome, remembered startup and explicit project close.
// Only main.swift's entry is replaced; production lifecycle guards stay intact.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const repo=path.resolve(__dirname,'..'),artifacts=path.resolve(process.env.NIMLO_WELCOME_ARTIFACTS||path.join(repo,'target/project-reopen-review'));
const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nimlo-welcome-check-'))),checks=[];
let child;const ownedHosts=new Set(),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const nativeSource=path.join(repo,'desktop/macos/main.swift');
const driver=String.raw`
final class WelcomeCheck {
    let delegate: NimloApp
    let scenario = ProcessInfo.processInfo.environment["NIMLO_WELCOME_SCENARIO"]!
    let resultPath = ProcessInfo.processInfo.environment["NIMLO_WELCOME_RESULT"]!
    let project = URL(fileURLWithPath: ProcessInfo.processInfo.environment["NIMLO_WELCOME_PROJECT"]!)
    let screenshot = ProcessInfo.processInfo.environment["NIMLO_WELCOME_PREVIEW"]!
    let savedPath = ProcessInfo.processInfo.environment["NIMLO_WELCOME_SAVED"]!
    let recoveryPath = ProcessInfo.processInfo.environment["NIMLO_WELCOME_RECOVERY"]!
    var checks = [String](), observations = [String: Any]()
    var savedBefore: Data?
    var recoveryBefore: Data?
    var previousHost: pid_t = 0
    var hostPids = [pid_t]()
    weak var closedWeb: WKWebView?
    var stage = 0, waiting = false
    var timer: Timer?
    let began = Date()
    init(_ delegate: NimloApp) {
        self.delegate = delegate
        savedBefore = try? Data(contentsOf: URL(fileURLWithPath: savedPath))
        recoveryBefore = try? Data(contentsOf: URL(fileURLWithPath: recoveryPath))
    }
    func require(_ condition: Bool, _ message: String) -> Bool {
        if !condition { finish(false, message); return false }
        checks.append(message); return true
    }
    func views(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap { views($0) } }
    func button() -> NSButton? {
        guard let content = delegate.window?.contentView else { return nil }
        return views(content).compactMap { $0 as? NSButton }.first {
            $0.identifier?.rawValue == "select-project-folder" || $0.title.lowercased().contains("select project")
        }
    }
    func unchanged() -> Bool { savedBefore == (try? Data(contentsOf: URL(fileURLWithPath: savedPath))) }
    func welcome() -> Bool {
        delegate.host == nil && delegate.web == nil && delegate.launch == nil && delegate.workspace == nil && !delegate.closingProject
    }
    func recoveryUnchanged() -> Bool { recoveryBefore != nil && recoveryBefore == (try? Data(contentsOf: URL(fileURLWithPath: recoveryPath))) }
    func savedProject() -> URL? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: savedPath)),
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: String], let path = record["workspace"] else { return nil }
        return URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL
    }
    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [self] _ in tick() }
    }
    func tick() {
        if Date().timeIntervalSince(began) > 65 { finish(false, "Timed out at native stage \(stage)"); return }
        if waiting { return }
        guard delegate.window != nil else { return }
        if scenario == "saved" || scenario == "explicit" || scenario == "dev" {
            if stage == 0 {
                guard delegate.host != nil, delegate.web != nil else { return }
                guard require(button() == nil, "Remembered or explicit project starts the editor without welcome") else { return }
                if scenario == "saved" {
                    guard require(delegate.workspace == nil, "Ordinary saved launch delegates workspace restoration to the host") else { return }
                    guard require(delegate.host?.arguments?.contains("--resume-project") == true && delegate.host?.arguments?.contains("--workspace") == false, "Saved launch resumes without overriding its recorded workspace") else { return }
                }
                stage = 5
            }
        }
        switch stage {
        case 0:
            guard let content = delegate.window.contentView, let select = button() else { return }
            guard require(welcome(), "Welcome creates no WebKit view, host process, launch capability or workspace") else { return }
            let all = views(content)
            guard require(all.compactMap { $0 as? NSImageView }.contains { $0.image != nil }, "Welcome contains a loaded logo") else { return }
            guard require(all.compactMap { $0 as? NSTextField }.contains { $0.stringValue.lowercased().contains("welcome") }, "Welcome contains its greeting") else { return }
            guard require(all.compactMap { $0 as? NSButton }.count == 1 && select.isEnabled, "Welcome has one enabled project-folder action") else { return }
            guard require(unchanged(), "Opening welcome preserves saved-project metadata") else { return }
            if scenario == "fresh", let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) {
                content.cacheDisplay(in: content.bounds, to: bitmap)
                let image = NSImage(size: content.bounds.size)
                image.lockFocus(); self.delegate.window.backgroundColor.setFill()
                NSBezierPath(rect: NSRect(origin: .zero, size: content.bounds.size)).fill()
                bitmap.draw(in: NSRect(origin: .zero, size: content.bounds.size)); image.unlockFocus()
                if let tiff = image.tiffRepresentation, let composed = NSBitmapImageRep(data: tiff), let bytes = composed.representation(using: .png, properties: [:]) {
                    try? bytes.write(to: URL(fileURLWithPath: screenshot), options: .atomic)
                }
            }
            observations["welcomeHostAbsent"] = true; observations["welcomeWebKitAbsent"] = true
            stage = 1; waiting = true
            DispatchQueue.main.asyncAfter(deadline: .now()+0.6) { self.waiting = false }
        case 1:
            guard require(welcome() && unchanged(), "Settled welcome remains idle and preserves saved-project metadata") else { return }
            if scenario == "closed" || scenario == "missing" {
                guard require(recoveryUnchanged(), "Welcome preserves unrelated recovery data") else { return }
                guard require(delegate.applicationShouldTerminate(NSApp) == .terminateNow, "Quit from welcome completes immediately without an editor guard") else { return }
                finish(true); return
            }
            button()?.performClick(nil); stage = 2
        case 2:
            guard let panel = delegate.window.attachedSheet as? NSOpenPanel else { return }
            guard require(panel.canChooseDirectories && !panel.canChooseFiles && !panel.allowsMultipleSelection, "Folder action opens a directory-only single-selection sheet") else { return }
            guard require(welcome() && unchanged(), "Opening folder picker does not start the host or alter saved projects") else { return }
            panel.cancel(nil); stage = 3
        case 3:
            guard delegate.window.attachedSheet == nil, let select = button(), select.isEnabled else { return }
            guard require(welcome() && unchanged(), "Cancelling folder selection returns to unchanged welcome") else { return }
            select.performClick(nil); stage = 4
        case 4:
            guard let panel = delegate.window.attachedSheet as? NSOpenPanel else { return }
            panel.directoryURL = project; waiting = true; stage = 6
            DispatchQueue.main.asyncAfter(deadline: .now()+0.8) {
                self.observations["pickerDirectory"] = panel.directoryURL?.path ?? ""
                panel.cancel(nil)
                self.waiting = false
            }
        case 6:
            guard delegate.window.attachedSheet == nil else { return }
            // Modern AppKit hosts the affirmative picker button in a remote
            // service. Exercise the production selected-folder path directly;
            // the actual attached picker and cancel path are verified above.
            checks.append("Production folder-selection handler receives the temporary fixture directory")
            observations["affirmativePickerAutomated"] = false
            delegate.openProjectFolder(project); stage = 5
        case 5, 13:
            guard delegate.window.attachedSheet == nil, delegate.host?.isRunning == true, delegate.web != nil, delegate.launch != nil else { return }
            waiting = true
            delegate.web.callAsyncJavaScript("return {authenticated:!document.getElementById('join-dialog')?.open,connected:document.getElementById('app')?.dataset.controller==='yes',workspacePath:document.getElementById('workspace-name')?.title||null};", arguments: [:], in: nil, in: .page) { [self] result in
                self.waiting = false
                guard let value = (try? result.get()) as? [String: Any], value["connected"] as? Bool == true, value["authenticated"] as? Bool == true else { return }
                self.observations["workspace"] = self.delegate.workspace ?? ""
                self.observations["expectedWorkspace"] = self.project.path
                let actual = (value["workspacePath"] as? String).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().standardizedFileURL }
                let expected = self.project.resolvingSymlinksInPath().standardizedFileURL
                guard self.require(actual == expected, "Chosen or explicit project resolves to the exact temporary fixture folder") else { return }
                guard self.require(self.delegate.window.contentView === self.delegate.web && self.button() == nil, "Authenticated editor replaces welcome in the same native window") else { return }
                guard self.require(self.savedProject() == expected, "Chosen project is persisted for the next ordinary launch") else { return }
                guard self.require(self.recoveryUnchanged(), "Opening a project preserves unrelated recovery data") else { return }
                self.checks.append("Owned Rust host and embedded WebKit editor complete local authentication")
                self.hostPids.append(self.delegate.host!.processIdentifier)
                self.observations["hostPid"] = self.delegate.host!.processIdentifier
                self.observations["hostArguments"] = self.delegate.host?.arguments ?? []
                self.observations["authenticated"] = true
                if self.stage == 13 { self.beginCleanClose(next: 14); return }
                if self.scenario != "saved" { self.finish(true); return }
                guard self.require(self.unchanged(), "Ordinary saved launch preserves the recorded project") else { return }
                let menu = NSApp.mainMenu?.items.first(where: { $0.title == "File" })?.submenu
                guard self.require(menu?.items.contains(where: { $0.action == #selector(NimloApp.closeProject) && $0.title == "Close Project" }) == true, "File menu exposes an explicit Close Project action") else { return }
                let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 240, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
                self.delegate.window.beginSheet(sheet)
                self.delegate.closeProject()
                guard self.require(self.delegate.window.attachedSheet === sheet && self.delegate.web != nil && self.delegate.host?.isRunning == true && !self.delegate.closingProject && self.unchanged(), "An attached native sheet defers project close and preserves its editor and pointer") else { return }
                self.delegate.window.endSheet(sheet); sheet.orderOut(nil)
                let pid = self.delegate.host!.processIdentifier
                guard self.require(self.delegate.windowShouldClose(self.delegate.window) == false && !self.delegate.window.isVisible && self.delegate.host?.processIdentifier == pid && self.delegate.host?.isRunning == true, "Closing the window hides it while preserving the host and project") else { return }
                _ = self.delegate.applicationShouldHandleReopen(NSApp, hasVisibleWindows: false)
                guard self.require(self.delegate.window.isVisible && self.delegate.web != nil && self.unchanged(), "Reopening a hidden window retains its editor and remembered project") else { return }
                self.stage = 7
            }
        case 7: guardClose(pending: true, work: false, dirty: false, label: "Pending edits", next: 8)
        case 8: guardClose(pending: false, work: true, dirty: false, label: "Active work", next: 9)
        case 9: guardClose(pending: false, work: false, dirty: true, label: "Unsaved files", next: 10)
        case 10:
            waiting = true
            delegate.web.callAsyncJavaScript("window.nimloDesktop=window.__nimloWelcomeOriginalDesktop;delete window.__nimloWelcomeOriginalDesktop;return await window.nimloDesktop.quitState();", arguments: [:], in: nil, in: .page) { [self] result in
                waiting = false
                guard let status = (try? result.get()) as? [String: Bool], require(status["pending"] == false && status["work"] == false && status["dirty"] == false, "Actual pristine fixture is safe to close after restoring its real lifecycle hook") else { return }
                beginCleanClose(next: 11)
            }
        case 11, 14:
            guard welcome(), Darwin.kill(previousHost, 0) != 0, closedWeb == nil else { return }
            guard require(button()?.isEnabled == true && !delegate.quitting, "Explicit Close Project returns to enabled welcome in the same app") else { return }
            guard require(!FileManager.default.fileExists(atPath: savedPath), "Explicit project close removes the next-launch project pointer") else { return }
            guard require(recoveryUnchanged(), "Explicit project close preserves unrelated recovery data") else { return }
            guard require(delegate.parentPipe == nil && delegate.watchTimer == nil && delegate.reloadRetry == nil, "Explicit project close releases host pipes, editor view and lifecycle timers") else { return }
            if stage == 14 { finish(true); return }
            delegate.openProjectFolder(project); stage = 13
        default: break
        }
    }
    func beginCleanClose(next: Int) {
        previousHost = delegate.host!.processIdentifier; closedWeb = delegate.web
        stage = next; delegate.closeProject()
    }
    func guardClose(pending: Bool, work: Bool, dirty: Bool, label: String, next: Int) {
        waiting = true
        let webID = ObjectIdentifier(delegate.web!), pid = delegate.host!.processIdentifier, pointer = try? Data(contentsOf: URL(fileURLWithPath: savedPath))
        delegate.web.callAsyncJavaScript("window.__nimloWelcomeOriginalDesktop ||= window.nimloDesktop;window.nimloDesktop={...window.__nimloWelcomeOriginalDesktop,quitState:async()=>({pending,work,dirty})};return true;", arguments: ["pending":pending,"work":work,"dirty":dirty], in: nil, in: .page) { [self] result in
            guard (try? result.get()) as? Bool == true else { finish(false, "Could not arrange isolated native close guard"); return }
            let deadline = Date().addingTimeInterval(5)
            func dismiss() {
                guard let modal = NSApp.modalWindow else {
                    if Date() < deadline { DispatchQueue.main.asyncAfter(deadline: .now()+0.05) { dismiss() } }
                    else { self.finish(false, "\(label) close guard did not show its warning") }
                    return
                }
                self.observations["guard-\(label)"] = self.views(modal.contentView!).compactMap { ($0 as? NSTextField)?.stringValue }.filter { !$0.isEmpty }
                NSApp.abortModal()
                DispatchQueue.main.asyncAfter(deadline: .now()+0.25) {
                    guard self.require(self.delegate.web.map { ObjectIdentifier($0) } == webID && self.delegate.host?.processIdentifier == pid && self.delegate.host?.isRunning == true && !self.delegate.closingProject, "\(label) warning cancellation preserves the editor and host") else { return }
                    guard self.require(pointer == (try? Data(contentsOf: URL(fileURLWithPath: self.savedPath))), "\(label) warning cancellation preserves the remembered project") else { return }
                    self.stage = next; self.waiting = false
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now()+0.05) { dismiss() }
            delegate.closeProject()
        }
    }
    func finish(_ success: Bool, _ error: String? = nil) {
        timer?.invalidate(); timer = nil
        if let host = delegate.host { hostPids.append(host.processIdentifier) }
        observations["hostPids"] = Array(Set(hostPids)); observations["hostPid"] = delegate.host?.processIdentifier ?? 0
        var result: [String: Any] = ["status":success ? "pass" : "fail", "scenario":scenario,"checks":checks,"observations":observations]
        if let error { result["error"] = error }
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: resultPath), options: .atomic)
        }
        delegate.quitting = true; delegate.watchTimer?.invalidate()
        try? delegate.parentPipe?.fileHandleForWriting.close(); delegate.parentPipe = nil
        if delegate.host?.isRunning == true { delegate.host?.terminate() }
        let deadline = Date().addingTimeInterval(6)
        while delegate.host?.isRunning == true && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        if let host = delegate.host, host.isRunning { Darwin.kill(host.processIdentifier, SIGKILL) }
        if let domain = Bundle.main.bundleIdentifier { UserDefaults.standard.removePersistentDomain(forName: domain); UserDefaults.standard.synchronize() }
        Darwin.exit(success ? 0 : 1)
    }
}
let app = NSApplication.shared
let delegate = NimloApp()
app.setActivationPolicy(.regular); app.delegate = delegate
let welcomeCheck = WelcomeCheck(delegate)
welcomeCheck.start()
app.run()
`;
async function port(){return new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});}
async function run(){
 assert.equal(process.platform,'darwin','AppKit welcome check requires macOS');
 fs.mkdirSync(artifacts,{recursive:true});
 const source=fs.readFileSync(nativeSource,'utf8'),entry='let app = NSApplication.shared\nlet delegate = NimloApp()';
 const offset=source.lastIndexOf(entry);assert(offset>=0&&source.indexOf(entry)===offset,'Unique production main entry is required');
 const transformed=source.slice(0,offset)+driver;
 const build=path.join(tmp,'build'),bundle=path.join(tmp,'Nimlo Welcome Check.app'),resources=path.join(bundle,'Contents/Resources'),executable=path.join(bundle,'Contents/MacOS/Nimlo');
 fs.mkdirSync(build);fs.mkdirSync(path.dirname(executable),{recursive:true});
 fs.cpSync(path.join(repo,'target/desktop/Nimlo.app/Contents/Resources'),resources,{recursive:true});
 const plist=path.join(bundle,'Contents/Info.plist');fs.copyFileSync(path.join(repo,'desktop/macos/Info.plist'),plist);
 execFileSync('/usr/libexec/PlistBuddy',['-c','Set :CFBundleIdentifier dev.nimlo.welcome-fixture.'+crypto.randomBytes(6).toString('hex'),plist]);
 fs.writeFileSync(path.join(build,'main.swift'),transformed);
 const compiler=execFileSync('/usr/bin/xcrun',['--find','swiftc'],{encoding:'utf8'}).trim(),architecture=execFileSync('/usr/bin/uname',['-m'],{encoding:'utf8'}).trim(),sdk=execFileSync('/usr/bin/xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim();
 const args=['-O','-sdk',sdk,'-target',architecture+'-apple-macosx13.3',path.join(repo,'desktop/macos/Policy.swift'),path.join(build,'main.swift'),path.join(repo,'desktop/macos/Metrics.swift'),path.join(repo,'desktop/macos/Downloads.swift'),path.join(repo,'desktop/macos/UpdateManifest.swift'),path.join(repo,'desktop/macos/UpdateInstaller.swift'),path.join(repo,'desktop/macos/Updater.swift'),'-o',executable,'-framework','AppKit','-framework','WebKit'];
 execFileSync(compiler,args,{stdio:'pipe',timeout:120000});execFileSync('/usr/bin/codesign',['--force','--sign','-',bundle],{stdio:'pipe'});
 const metadata={sourceSha256:hash(nativeSource),transformedMainSha256:hash(path.join(build,'main.swift')),nativeDriverSha256:hash(executable),hostSha256:hash(path.join(resources,'nimlo-editor')),entryOnlyReplacement:true,compilerArguments:args.map(arg=>arg.replaceAll(tmp,'<fixture>'))};
 for(const scenario of ['fresh','saved','closed','missing','explicit','dev']){
  const fixture=path.join(tmp,['fresh','saved','closed'].includes(scenario)?'remembered-lifecycle':scenario),home=path.join(fixture,'home'),project=path.join(fixture,'project'),state=path.join(fixture,'state'),bin=path.join(fixture,'bin'),result=path.join(artifacts,scenario+'.json');
  for(const directory of [home,project,state,bin])fs.mkdirSync(directory,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(project,'welcome.txt'),'Nimlo welcome test fixture\n');
  for(const provider of ['codex','claude'])fs.writeFileSync(path.join(bin,provider),'#!/bin/sh\nprintf "%s\\n" "Logged in using subscription"\n',{mode:0o700});
  const saved=path.join(state,'last-project.json'),recovery=path.join(state,'preserved-recovery-fixture.txt');
  if(!fs.existsSync(recovery))fs.writeFileSync(recovery,'Recovery data must survive explicit project close\n',{mode:0o600});
  if(scenario==='missing')fs.writeFileSync(saved,JSON.stringify({workspace:path.join(fixture,'missing-project')}),{mode:0o600});
  if(scenario==='saved')assert(fs.existsSync(saved),'Initial real folder selection produced next-launch metadata');
  if(scenario==='closed')assert(!fs.existsSync(saved),'Explicit close removed the next-launch project pointer');
  let expectedProject=project;
  const argv=['--state-dir',state];
  if(scenario==='explicit')argv.push('--workspace',project);
  if(scenario==='dev'){
   expectedProject=path.join(fixture,'dev-root');fs.mkdirSync(path.join(expectedProject,'target/release'),{recursive:true});
   fs.copyFileSync(path.join(resources,'nimlo-editor'),path.join(expectedProject,'target/release/nimlo-editor'));
   fs.cpSync(path.join(repo,'web'),path.join(expectedProject,'web'),{recursive:true});argv.push('--dev-root',expectedProject);
  }
  argv.push('--port',String(await port()));
  fs.rmSync(result,{force:true});
  child=spawn(executable,argv,{env:{...process.env,HOME:home,CFFIXED_USER_HOME:home,PATH:bin+':/usr/bin:/bin:/usr/sbin:/sbin',NIMLO_WELCOME_SCENARIO:scenario,NIMLO_WELCOME_RESULT:result,NIMLO_WELCOME_PROJECT:expectedProject,NIMLO_WELCOME_PREVIEW:path.join(artifacts,'welcome.png'),NIMLO_WELCOME_SAVED:saved,NIMLO_WELCOME_RECOVERY:recovery},stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',bytes=>stderr=(stderr+bytes).slice(-12000));child.stdout.resume();
  const exit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('Native fixture timeout: '+scenario));},80000);child.on('error',reject);child.on('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});});
  const record=fs.existsSync(result)?JSON.parse(fs.readFileSync(result,'utf8')):null;
  const hosts=record?.observations?.hostPids||[];for(const pid of hosts)ownedHosts.add(pid);
  assert.equal(exit.code,0,scenario+': '+(record?.error||stderr||JSON.stringify(exit)));assert.equal(record?.status,'pass');
  for(const pid of hosts){for(let i=0;i<80&&alive(pid);i++)await pause(100);assert(!alive(pid),'Owned host exited: '+scenario);}
  checks.push(...record.checks.map(check=>scenario+': '+check));console.log('PASS project lifecycle '+scenario+' ('+record.checks.length+' checks)');child=null;
 }
 assert.equal(hash(nativeSource),metadata.sourceSha256,'Production main.swift remained unchanged during fixtures');
 assert(fs.statSync(path.join(artifacts,'welcome.png')).size>1000,'Own AppKit welcome view preview exists');
 fs.writeFileSync(path.join(artifacts,'validation.json'),JSON.stringify({status:'pass',at:new Date().toISOString(),checks,metadata,fixtureOnly:true,realInferenceRequests:0,productionTestHooksAdded:false,limits:['An in-process driver replaces only the native entry point; it exercises production AppKit views, host ownership, authentication, startup and close guards without screen or accessibility permissions.','The actual directory sheet, cancellation and reopening are exercised. Its affirmative button is hosted remotely by macOS, so fixture selection calls production openProjectFolder and then authenticates its real host.','Pending/work/dirty close states are arranged by replacing the private fixture page lifecycle object, then dismissing actual native guard alerts. Production guard code stays unchanged; actual pristine close restores the real hook.','Unrelated state preservation is checked with a fixture recovery sentinel; this does not independently prove restoration of every editor draft.','The owned bundle, state, HOME, provider stubs and project directories are isolated fixtures.']},null,2)+'\n');
}
run().catch(error=>{fs.mkdirSync(artifacts,{recursive:true});fs.writeFileSync(path.join(artifacts,'failure-'+Date.now()+'.json'),JSON.stringify({status:'fail',error:error.stack},null,2)+'\n');console.error(error.stack);process.exitCode=1;}).finally(async()=>{if(child&&child.exitCode===null)child.kill('SIGKILL');for(const pid of ownedHosts)if(alive(pid))process.kill(pid,'SIGTERM');await pause(300);fs.rmSync(tmp,{recursive:true,force:true});});
