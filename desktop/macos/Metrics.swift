import AppKit
import WebKit
import ObjectiveC

// Explicit local fixture diagnostics only. This is not a JavaScript bridge or
// network listener. A normal launch creates no timer and reads no command file.
private var nimloMetricsAssociation: UInt8 = 0

extension NimloApp {
    func stopPerformanceDiagnostics() {
        objc_setAssociatedObject(self, &nimloMetricsAssociation, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }
    func startPerformanceDiagnostics() {
        guard let report, let controller = NimloMetricsController(app: self, report: report) else { return }
        objc_setAssociatedObject(self, &nimloMetricsAssociation, controller, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        controller.start()
    }
}

private final class NimloMetricsController {
    weak var app: NimloApp?
    let commands: URL
    let responses: URL
    var timer: Timer?
    var busy = false

    init?(app: NimloApp, report: String) {
        self.app = app
        commands = URL(fileURLWithPath: report + ".commands", isDirectory: true)
        responses = URL(fileURLWithPath: report + ".responses", isDirectory: true)
        guard Self.privatePath(commands, directory: true) else { return nil }
        try? FileManager.default.createDirectory(at: responses, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        guard Self.privatePath(responses, directory: true) else { return nil }
    }

    static func privatePath(_ url: URL, directory: Bool) -> Bool {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              attrs[.type] as? FileAttributeType == (directory ? .typeDirectory : .typeRegular),
              (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let mode = attrs[.posixPermissions] as? NSNumber,
              mode.intValue == (directory ? 0o700 : 0o600) else { return false }
        return true
    }

    func start() {
        poll() // A prewritten install command runs before the host loads a page.
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in self?.poll() }
    }

    static func errorMessage(_ error: Error) -> String {
        let detail = (error as NSError).userInfo["WKJavaScriptExceptionMessage"] as? String
        return String((detail ?? error.localizedDescription).prefix(2000))
    }

    func frontWindow() {
        guard let app else { return }
        // A terminal-launched fixture may be refused foreground activation.
        // Its direct window key events still reach WebKit, but an occluded
        // view can suspend frame callbacks. Float only this explicitly opted-in
        // diagnostic window so both benchmark sides remain visibly rendered.
        app.window.level = .floating
        // Test copies use unique bundle IDs, but AppKit can still center a
        // newly launched window on an inactive secondary display. Keep the
        // fixture visible on the primary display without changing its size.
        if let screen = NSScreen.screens.first {
            let visible = screen.visibleFrame, size = app.window.frame.size
            app.window.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2))
        }
        app.window.collectionBehavior.insert(.moveToActiveSpace)
        app.window.orderFrontRegardless(); app.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func poll() {
        guard !busy, let app, !app.quitting, Self.privatePath(commands, directory: true), Self.privatePath(responses, directory: true),
              let files = try? FileManager.default.contentsOfDirectory(at: commands, includingPropertiesForKeys: nil),
              let file = files.filter({ $0.lastPathComponent.range(of: "^[0-9]{6}\\.json$", options: .regularExpression) != nil }).sorted(by: { $0.lastPathComponent < $1.lastPathComponent }).first else { return }
        let name = file.lastPathComponent
        guard Self.privatePath(file, directory: false),
              let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
              ((attrs[.size] as? NSNumber)?.intValue ?? Int.max) <= 262144,
              let bytes = try? Data(contentsOf: file),
              let command = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            try? FileManager.default.removeItem(at: file)
            reply(name, ["ok": false, "error": "Invalid private command file"]); return
        }
        try? FileManager.default.removeItem(at: file)
        busy = true
        let done: ([String: Any]) -> Void = { [weak self] value in self?.reply(name, value); self?.busy = false }
        let body = command["javascript"] as? String ?? ""
        switch command["kind"] as? String {
        case "front":
            frontWindow()
            done(["ok": true, "front": true, "nativeWindow": ["visible": app.window.isVisible, "key": app.window.isKeyWindow,
                "occluded": !app.window.occlusionState.contains(.visible), "frameX": app.window.frame.minX,
                "frameY": app.window.frame.minY, "width": app.window.frame.width, "height": app.window.frame.height,
                "appActive": NSApp.isActive, "appHidden": NSApp.isHidden, "onActiveSpace": app.window.isOnActiveSpace,
                "webWindowAttached": app.web.window != nil, "webHidden": app.web.isHiddenOrHasHiddenAncestor,
                "screens": NSScreen.screens.map { ["x": $0.frame.minX, "y": $0.frame.minY, "width": $0.frame.width, "height": $0.frame.height] }]])
        case "install":
            guard !body.isEmpty else { done(["ok": false, "error": "Missing fixture script"]); return }
            app.web.configuration.userContentController.addUserScript(WKUserScript(source: body, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            done(["ok": true, "installed": true])
        case "javascript":
            app.web.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value): done(["ok": true, "value": value])
                case .failure(let error): done(["ok": false, "error": Self.errorMessage(error)])
                }
            }
        case "key":
            guard let characters = command["characters"] as? String, characters.count == 1,
                  let keyCode = command["keyCode"] as? Int, (0...127).contains(keyCode) else { done(["ok": false, "error": "Invalid fixture key"]); return }
            if !app.window.isKeyWindow { frontWindow() }
            app.web.callAsyncJavaScript("return window.__nativePerformance.armKey();", arguments: [:], in: nil, in: .page) { [weak self] armed in
                guard let self, let app = self.app else { done(["ok": false, "error": "Window closed"]); return }
                guard (try? armed.get()) as? Bool == true else { done(["ok": false, "error": "Native input fixture unavailable"]); return }
                let start = ProcessInfo.processInfo.systemUptime
                for type in [NSEvent.EventType.keyDown, NSEvent.EventType.keyUp] {
                    if let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [], timestamp: start,
                                                  windowNumber: app.window.windowNumber, context: nil, characters: characters,
                                                  charactersIgnoringModifiers: characters, isARepeat: false, keyCode: UInt16(keyCode)) {
                        app.window.sendEvent(event)
                    }
                }
                app.web.callAsyncJavaScript("return await window.__nativePerformance.awaitKey();", arguments: [:], in: nil, in: .page) { result in
                    switch result {
                    case .success(let value): done(["ok": true, "value": value, "nativeDispatchToFrameCallbackMilliseconds": (ProcessInfo.processInfo.systemUptime - start) * 1000])
                    case .failure(let error): done(["ok": false, "error": Self.errorMessage(error)])
                    }
                }
            }
        default: done(["ok": false, "error": "Unknown fixture command"])
        }
    }

    // Reject source-shaped responses. The harness retains only bounded scalar
    // observations, never document/protocol contents or an unbounded event log.
    func reply(_ name: String, _ response: [String: Any]) {
        func bounded(_ value: Any, depth: Int = 0) -> Bool {
            guard depth < 10 else { return false }
            if let text = value as? String { return text.utf8.count <= 4096 }
            if let array = value as? [Any] { return array.count <= 512 && array.allSatisfy { bounded($0, depth: depth + 1) } }
            if let object = value as? [String: Any] { return object.count <= 128 && object.allSatisfy { $0.key.utf8.count <= 128 && bounded($0.value, depth: depth + 1) } }
            return value is NSNumber || value is NSNull
        }
        var result = response
        if !bounded(result) { result = ["ok": false, "error": "Fixture response exceeds scalar limits"] }
        guard let bytes = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), bytes.count <= 65536 else { return }
        let file = responses.appendingPathComponent(name)
        try? bytes.write(to: file, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    deinit { timer?.invalidate() }
}
