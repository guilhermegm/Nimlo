#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');

// Compile the actual app delegate into a disposable executable. Only external
// installer operations, termination replies and modal alert effects are
// intercepted; its update state machine and real WKWebView promise handling run.
const root = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nimlo-handoff-check-'));
fs.chmodSync(work, 0o700);
const destination = path.join(root, 'target/updater-review/handoff.json');
fs.mkdirSync(path.dirname(destination), { recursive: true });
function run(executable, args, timeout = 120000) {
  const result = cp.spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stdout || '') + (result.stderr || '') + (result.error?.message || ''));
  return result.stdout;
}
try {
  const source = fs.readFileSync(path.join(root, 'desktop/macos/main.swift'), 'utf8');
  const entry = '\nlet app = NSApplication.shared\n';
  if (source.split(entry).length !== 2) throw new Error('Native entry point changed; update fixture explicitly.');
  let delegate = source.slice(0, source.indexOf(entry));
  delegate = delegate.replaceAll('NimloUpdateInstaller', 'HandoffInstallerFixture')
    .replaceAll('NSApp.terminate(nil)', 'HandoffEffects.terminate()')
    .replaceAll('NSApp.reply(toApplicationShouldTerminate: true)', 'HandoffEffects.reply(true)')
    .replaceAll('NSApp.reply(toApplicationShouldTerminate: false)', 'HandoffEffects.reply(false)')
    .replaceAll('alert.runModal()', 'HandoffEffects.alert(alert)');
  fs.writeFileSync(path.join(work, 'AppDelegate.swift'), delegate);
  fs.writeFileSync(path.join(work, 'HandoffCheck.swift'), String.raw`
import AppKit
import WebKit
import Foundation

enum HandoffEffects {
    static var terminations = 0, replies = 0, alerts = 0
    static func terminate() { terminations += 1 }
    static func reply(_ value: Bool) { replies += 1 }
    static func alert(_ alert: NSAlert) -> NSApplication.ModalResponse { alerts += 1; return .alertFirstButtonReturn }
    static func reset() { terminations = 0; replies = 0; alerts = 0 }
}

enum HandoffInstallerFixture {
    static let lock = NSLock()
    static var ready = false
    static var cancelFailure = false
    static var cancels = [URL]()
    static var launched = [Process]()
    static var preparePlan: URL?
    static var prepareGate: DispatchSemaphore?
    static var prepareEntered = DispatchSemaphore(value: 0)
    static var launchCalls = 0
    static var receipts = 0
    static func prepare(appURL: URL, archiveURL: URL, envelopeURL: URL, parentPID: Int32, hostPID: Int32, relaunchArguments: [String]) throws -> URL {
        lock.lock(); let plan = preparePlan!, gate = prepareGate; lock.unlock()
        prepareEntered.signal()
        if let gate { _ = gate.wait(timeout: .now() + 5) }
        return plan
    }
    static func launch(planURL: URL) throws -> Process { launchCalls += 1; return try sleeper() }
    static func installationReady(planURL: URL) throws -> Bool { ready }
    static func cancel(planURL: URL) throws {
        cancels.append(planURL)
        if cancelFailure { throw NSError(domain: "HandoffFixture", code: 28, userInfo: [NSLocalizedDescriptionKey: "Injected disk-full cancellation failure"]) }
    }
    static func acknowledgeStartup(arguments: [String] = CommandLine.arguments) -> Bool { receipts += 1; return true }
    static func sleeper() throws -> Process {
        let child = Process(); child.executableURL = URL(fileURLWithPath: "/bin/sleep"); child.arguments = ["60"]
        child.standardInput = FileHandle.nullDevice; child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        try child.run(); launched.append(child); return child
    }
    static func stopOwnedChildren() {
        for child in launched where child.isRunning { child.terminate(); child.waitUntilExit() }
        launched.removeAll()
    }
}

@main struct HandoffCheck {
    static var checks = [String](), failures = [String]()
    static let fm = FileManager.default
    static func check(_ name: String, _ accepted: @autoclosure () -> Bool) {
        if accepted() { checks.append(name) } else { failures.append(name); print("FAIL " + name) }
    }
    static func spin(_ condition: () -> Bool, timeout: TimeInterval = 5) {
        let end = Date().addingTimeInterval(timeout)
        while !condition() && Date() < end { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
        if !condition() { failures.append("asynchronous fixture timed out") }
    }
    static func drain() { let end = Date().addingTimeInterval(0.1); while Date() < end { _ = RunLoop.current.run(mode: .default, before: end) } }
    static func instance(_ root: URL) -> NimloApp {
        let app = NimloApp(); app.state = root.path
        app.window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        app.window.isReleasedWhenClosed = false
        return app
    }
    static func armed(_ root: URL, name: String) throws -> NimloApp {
        let app = instance(root)
        app.installingUpdate = true; app.updatePreparationID = UUID()
        app.updateInstallPlan = root.appendingPathComponent(name + ".json")
        app.updateInstallProcess = try HandoffInstallerFixture.sleeper()
        return app
    }
    static func attachWeb(_ app: NimloApp, expression: String) {
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        app.web = WKWebView(frame: app.window.contentView!.bounds, configuration: configuration)
        app.window.contentView = app.web
        app.web.loadHTMLString("<html><body><div id='app' data-controller='yes'></div><script>window.flushCalls=0;window.nimloDesktop={prepareReload:async()=>{window.flushCalls++;" + expression + "},canUpdate:()=>true};</script></body></html>", baseURL: nil)
        var loaded = false
        spin({
            if !loaded { app.web.evaluateJavaScript("!!window.nimloDesktop") { value, _ in loaded = value as? Bool == true } }
            return loaded
        })
    }
    static func value(_ web: WKWebView, _ script: String) -> Any? {
        var completed = false, result: Any?
        web.evaluateJavaScript(script) { object, _ in result = object; completed = true }
        spin { completed }; return result
    }
    static func main() throws {
        let native = NSApplication.shared; native.setActivationPolicy(.accessory)
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        defer { HandoffInstallerFixture.stopOwnedChildren() }

        let waiting = try armed(root, name: "waiting")
        var waitingCompletion: Bool?
        waiting.updatePreparationCompletion = { waitingCompletion = $0 }
        HandoffInstallerFixture.ready = false
        waiting.pollUpdatePreparation(deadline: Date().addingTimeInterval(10))
        check("unverified helper never ends current session", waiting.installingUpdate && !waiting.quitting && HandoffEffects.terminations == 0 && waitingCompletion == nil)
        waiting.cancelUpdatePreparation()
        check("Cancel signals helper and preserves current session", HandoffInstallerFixture.cancels.contains(root.appendingPathComponent("waiting.json")) && !waiting.installingUpdate && !waiting.quitting && waitingCompletion == false && HandoffEffects.terminations == 0)
        check("Cancel invalidates timer, UUID and old helper references", waiting.updateInstallTimer == nil && waiting.updatePreparationID == nil && waiting.updateInstallPlan == nil && waiting.updateInstallProcess == nil)

        HandoffEffects.reset()
        let failedCancellation = try armed(root, name: "failed-cancellation")
        let cancellationHelper = failedCancellation.updateInstallProcess!
        var failedCancellationCompletion: Bool?
        failedCancellation.updatePreparationCompletion = { failedCancellationCompletion = $0 }
        attachWeb(failedCancellation, expression: "return await new Promise(resolve=>window.finishCancelledFlush=resolve);")
        HandoffInstallerFixture.ready = true
        failedCancellation.pollUpdatePreparation(deadline: Date().addingTimeInterval(10))
        spin { value(failedCancellation.web, "typeof window.finishCancelledFlush") as? String == "function" }
        HandoffInstallerFixture.cancelFailure = true
        failedCancellation.cancelUpdatePreparation()
        _ = value(failedCancellation.web, "window.finishCancelledFlush(true); true")
        spin { !failedCancellation.installingUpdate }
        check("failed cancellation record cannot leave a helper able to swap after normal quit", !cancellationHelper.isRunning && !failedCancellation.quitting && failedCancellationCompletion == false && HandoffEffects.terminations == 0)
        check("late final flush cannot commit during cancellation fallback", failedCancellation.updatePreparationID == nil && !failedCancellation.quitting && HandoffEffects.terminations == 0)
        HandoffInstallerFixture.cancelFailure = false

        HandoffEffects.reset(); HandoffInstallerFixture.ready = true
        let success = try armed(root, name: "success")
        attachWeb(success, expression: "return true;")
        var successCompletion: Bool?
        success.updatePreparationCompletion = { successCompletion = $0 }
        success.pollUpdatePreparation(deadline: Date().addingTimeInterval(10))
        spin { successCompletion != nil }
        check("verified helper still requires final native WebKit draft flush", value(success.web, "window.flushCalls") as? Int == 1)
        check("successful final flush authorizes one orderly restart", successCompletion == true && success.quitting && HandoffEffects.terminations == 1 && HandoffEffects.replies == 0)
        check("successful handoff clears preparation state", !success.installingUpdate && success.updatePreparationID == nil && success.updatePreparationCompletion == nil)

        HandoffEffects.reset()
        let failed = try armed(root, name: "failed-flush")
        attachWeb(failed, expression: "return false;")
        var failureCompletion: Bool?
        failed.updatePreparationCompletion = { failureCompletion = $0 }
        failed.pollUpdatePreparation(deadline: Date().addingTimeInterval(10))
        spin { failureCompletion != nil }
        check("failed final flush keeps current session alive", failureCompletion == false && !failed.quitting && HandoffEffects.terminations == 0 && HandoffEffects.alerts == 1)
        check("failed flush cooperatively cancels validated helper", HandoffInstallerFixture.cancels.contains(root.appendingPathComponent("failed-flush.json")))

        HandoffEffects.reset()
        let stale = try armed(root, name: "stale-flush")
        attachWeb(stale, expression: "return await new Promise(resolve=>window.finishOldFlush=resolve);")
        var oldCompletion: Bool?, newCompletion: Bool?
        stale.updatePreparationCompletion = { oldCompletion = $0 }
        stale.pollUpdatePreparation(deadline: Date().addingTimeInterval(10))
        spin { value(stale.web, "typeof window.finishOldFlush") as? String == "function" }
        stale.cancelUpdatePreparation()
        stale.installingUpdate = true; stale.updatePreparationID = UUID()
        let newID = stale.updatePreparationID
        stale.updateInstallPlan = root.appendingPathComponent("new-generation.json")
        stale.updateInstallProcess = try HandoffInstallerFixture.sleeper()
        stale.updatePreparationCompletion = { newCompletion = $0 }
        _ = value(stale.web, "window.finishOldFlush(true); true")
        drain()
        check("stale WebKit completion cannot quit a newer update attempt", oldCompletion == false && newCompletion == nil && stale.installingUpdate && stale.updatePreparationID == newID && !stale.quitting && HandoffEffects.terminations == 0)
        stale.cancelUpdatePreparation()

        HandoffEffects.reset()
        let dead = try armed(root, name: "dead-helper")
        dead.updateInstallProcess?.terminate(); dead.updateInstallProcess?.waitUntilExit()
        var deadCompletion: Bool?
        dead.updatePreparationCompletion = { deadCompletion = $0 }
        dead.pollUpdatePreparation(deadline: Date().addingTimeInterval(10))
        check("dead helper cannot trigger restart even with ready status", deadCompletion == false && !dead.quitting && HandoffEffects.terminations == 0)

        HandoffEffects.reset()
        let delayed = instance(root)
        let copy = root.appendingPathComponent("late-copy", isDirectory: true)
        try fm.createDirectory(at: copy, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let plan = copy.appendingPathComponent("plan.json")
        try Data("fixture".utf8).write(to: plan)
        let gate = DispatchSemaphore(value: 0)
        HandoffInstallerFixture.lock.lock(); HandoffInstallerFixture.preparePlan = plan; HandoffInstallerFixture.prepareGate = gate; HandoffInstallerFixture.lock.unlock()
        var delayedCompletion: Bool?
        let initialLaunches = HandoffInstallerFixture.launchCalls
        delayed.beginUpdatePreparation(archive: root.appendingPathComponent("unused.zip"), envelope: root.appendingPathComponent("unused.json")) { delayedCompletion = $0 }
        check("background preparation entered without quitting session", HandoffInstallerFixture.prepareEntered.wait(timeout: .now()+3) == .success && !delayed.quitting && HandoffEffects.terminations == 0)
        delayed.cancelUpdatePreparation(); gate.signal()
        spin { !fm.fileExists(atPath: copy.path) }
        check("cancel during archive preparation never launches late helper", delayedCompletion == false && HandoffInstallerFixture.launchCalls == initialLaunches && !delayed.quitting && HandoffEffects.terminations == 0)
        check("cancelled late preparation removes only its private copy", !fm.fileExists(atPath: copy.path))

        let report: [String: Any] = ["status": failures.isEmpty ? "passed" : "failed", "count": checks.count, "checks": checks, "failures": failures,
            "scope": "Actual NimloApp update handoff methods, real WKWebView async promise flush, injected external installer/termination/modal effects",
            "limitations": ["Installer internals exercised separately", "No real installed application replaced", "Only owned fixture sleep processes terminated"]]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        print("\(failures.isEmpty ? "PASS" : "FAIL") \(checks.count) native handoff checks; \(failures.count) failures")
        HandoffInstallerFixture.stopOwnedChildren()
        if !failures.isEmpty { exit(1) }
    }
}
`);
  const binary = path.join(work, 'handoff-check');
  process.stdout.write(run('/usr/bin/xcrun', ['swiftc', '-O', '-target', `${os.arch() === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.3`,
    path.join(root, 'desktop/macos/Policy.swift'), path.join(root, 'desktop/macos/UpdateManifest.swift'),
    path.join(root, 'desktop/macos/Updater.swift'), path.join(root, 'desktop/macos/Downloads.swift'),
    path.join(root, 'desktop/macos/Metrics.swift'), path.join(work, 'AppDelegate.swift'), path.join(work, 'HandoffCheck.swift'),
    '-o', binary, '-framework', 'AppKit', '-framework', 'WebKit']));
  process.stdout.write(run(binary, [work, destination], 60000));
  const report = JSON.parse(fs.readFileSync(destination, 'utf8'));
  report.sourceSHA256 = crypto.createHash('sha256').update(source).digest('hex');
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
} finally { fs.rmSync(work, { recursive: true, force: true }); }
