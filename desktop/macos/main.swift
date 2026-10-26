import AppKit
import WebKit
import Darwin

final class NimloWelcomeButton: NSButton {
    private var hovering = false
    private var hoverArea: NSTrackingArea?

    override var isFlipped: Bool { true }
    override var isHighlighted: Bool { didSet { needsDisplay = true } }
    override var isEnabled: Bool { didSet { needsDisplay = true } }
    override func updateTrackingAreas() {
        if let hoverArea { removeTrackingArea(hoverArea) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        addTrackingArea(area); hoverArea = area
        super.updateTrackingAreas()
    }
    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder(); needsDisplay = true; return accepted
    }
    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder(); needsDisplay = true; return accepted
    }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
    }
    override func draw(_ dirtyRect: NSRect) {
        let fill = isHighlighted ? NSColor(calibratedRed: 0.13, green: 0.16, blue: 0.20, alpha: 1)
            : hovering && isEnabled ? NSColor(calibratedRed: 0.18, green: 0.21, blue: 0.26, alpha: 1)
            : NSColor(calibratedRed: 0.14, green: 0.17, blue: 0.21, alpha: 1)
        let outline = NSColor(calibratedRed: 0.25, green: 0.29, blue: 0.35, alpha: isEnabled ? 1 : 0.45)
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
        fill.setFill(); shape.fill(); outline.setStroke(); shape.lineWidth = 1; shape.stroke()

        let ink = NSColor(calibratedRed: 0.87, green: 0.90, blue: 0.94, alpha: isEnabled ? 1 : 0.45)
        let caption = NSAttributedString(string: title, attributes: [.font: font ?? NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: ink])
        let size = caption.size(), iconSize: CGFloat = 16, gap: CGFloat = 8
        let left = ((bounds.width - iconSize - gap - size.width) / 2).rounded()
        let top = ((bounds.height - iconSize) / 2).rounded()
        let folder = NSBezierPath()
        folder.move(to: NSPoint(x: left + 1.5, y: top + 4))
        folder.line(to: NSPoint(x: left + 6, y: top + 4))
        folder.line(to: NSPoint(x: left + 8, y: top + 6))
        folder.line(to: NSPoint(x: left + 14.5, y: top + 6))
        folder.line(to: NSPoint(x: left + 14.5, y: top + 12.5))
        folder.line(to: NSPoint(x: left + 1.5, y: top + 12.5))
        folder.close(); folder.lineWidth = 1.25; folder.lineJoinStyle = .round
        ink.withAlphaComponent(isEnabled ? 0.75 : 0.35).setStroke(); folder.stroke()
        caption.draw(at: NSPoint(x: left + iconSize + gap, y: ((bounds.height - size.height) / 2).rounded()))
    }
}

// The window owns one loopback Rust host. No native command or filesystem
// bridge is exposed to JavaScript; editing continues through authenticated WS.
final class NimloApp: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var host: Process?
    var parentPipe: Pipe?
    var launch: URL?
    var output = Data()
    var errors = ""
    var quitting = false
    var checkingQuit = false
    var lockFD: Int32 = -1
    var port = 8741
    var workspace: String?
    var state: String!
    var devRoot: String?
    var report: String?
    var events: [[String: Any]] = []
    var watchTimer: Timer?
    var stamps: [String: String] = [:]
    var pendingReload = false
    var pendingCSS = false
    var pendingRestart = false
    var restartingHost = false
    var checkingReload = false
    var reloadRetry: Timer?
    var building: Process?
    var buildAgain = false
    var hostSequence = 0
    var fileDownload: NimloFileDownload?
    var selectingProject = false
    var closingProject = false
    var updater: NimloUpdater?
    var updateStartupTimer: Timer?
    var updateStartupDeadline: Date?
    var installingUpdate = false
    var updateInstallPlan: URL?
    var updateInstallProcess: Process?
    var updateInstallTimer: Timer?
    var updatePreparationPanel: NSPanel?
    var updatePreparationCompletion: ((Bool) -> Void)?
    var updatePreparationID: UUID?
    var updateFlushing = false
    var updateCancellationPending = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        do { try configure() } catch { fail(error.localizedDescription); return }
        let fm = FileManager.default
        do { try fm.createDirectory(atPath: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        catch { fail("Cannot open the desktop recovery folder: \(error.localizedDescription)"); return }
        let lockPath = (state as NSString).appendingPathComponent("desktop.lock")
        lockFD = Darwin.open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            if let id = Bundle.main.bundleIdentifier {
                NSRunningApplication.runningApplications(withBundleIdentifier: id).first(where: { $0.processIdentifier != getpid() })?.activate(options: [])
            }
            fail("This desktop session is already running. Return to its Nimlo window, or use a different --state-dir and --port."); return
        }
        // The saved project resumes through the host's existing recovery path.
        // A fresh or explicitly closed session stays native until selection.
        if workspace == nil, let root = devRoot, !NimloPolicy.hasSavedProject(state: state) { workspace = root }
        setupWindow()
        setupUpdater()
        if workspace != nil || devRoot != nil || NimloPolicy.hasSavedProject(state: state) { startEditor() }
        else { showWelcome() }
        acknowledgeUpdateStartup()
    }

    func configure() throws {
        let args = Array(CommandLine.arguments.dropFirst()); var i = 0
        while i < args.count {
            guard i + 1 < args.count else { throw NSError(domain: "Nimlo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing value for \(args[i])"]) }
            let value = args[i + 1]
            switch args[i] {
            case "--workspace": workspace = URL(fileURLWithPath: value).standardizedFileURL.path
            case "--state-dir": state = URL(fileURLWithPath: value).standardizedFileURL.path
            case "--dev-root": devRoot = URL(fileURLWithPath: value).standardizedFileURL.path; port = 8742
            case "--port":
                guard let p = Int(value), (1024...65535).contains(p) else { throw NSError(domain: "Nimlo", code: 1, userInfo: [NSLocalizedDescriptionKey: "--port needs a number from 1024 to 65535"]) }
                port = p
            case "--test-report": report = value // Explicit local fixture diagnostics only; never a web API.
            case "--update-receipt", "--update-token": break // Validated by the private installer receipt writer.
            default: throw NSError(domain: "Nimlo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown desktop argument: \(args[i])"])
            }
            i += 2
        }
        if state == nil {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let current = home.appendingPathComponent(".nimlo", isDirectory: true)
            let legacy = home.appendingPathComponent(".relay-editor", isDirectory: true)
            var legacyIsDirectory: ObjCBool = false
            let hasLegacy = FileManager.default.fileExists(atPath: legacy.path, isDirectory: &legacyIsDirectory) && legacyIsDirectory.boolValue
            let root = !FileManager.default.fileExists(atPath: current.path) && hasLegacy ? legacy : current
            state = root.appendingPathComponent(devRoot == nil ? "desktop" : "desktop-dev").path
        }
    }

    func setupWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Nimlo"; window.minSize = NSSize(width: 800, height: 480)
        window.backgroundColor = NSColor(calibratedRed: 0.082, green: 0.098, blue: 0.122, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.delegate = self; window.isReleasedWhenClosed = false
        window.setFrameAutosaveName(devRoot == nil ? "NimloDesktop" : "NimloDev")
        window.center(); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem); let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: "About Nimlo", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let updates = appMenu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdates), keyEquivalent: "")
        updates.target = self
        appMenu.addItem(.separator()); appMenu.addItem(withTitle: "Hide Nimlo", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator()); appMenu.addItem(withTitle: "Quit Nimlo", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); editItem.title = "Edit"; menu.addItem(editItem); let edit = NSMenu(title: "Edit"); editItem.submenu = edit
        let undoItem = edit.addItem(withTitle: "Undo", action: #selector(undoEdit), keyEquivalent: "z")
        undoItem.target = self
        let redoItem = edit.addItem(withTitle: "Redo", action: #selector(redoEdit), keyEquivalent: "z")
        redoItem.keyEquivalentModifierMask = [.command, .shift]; redoItem.target = self
        edit.addItem(.separator())
        for (title, selector, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(selector), keyEquivalent: key)
        }
        edit.addItem(.separator())
        let findInFileItem = edit.addItem(withTitle: "Find in File…", action: #selector(findInFile), keyEquivalent: "f")
        findInFileItem.target = self
        let findNextItem = edit.addItem(withTitle: "Find Next", action: #selector(findNext), keyEquivalent: "g")
        findNextItem.target = self
        let findPreviousItem = edit.addItem(withTitle: "Find Previous", action: #selector(findPrevious), keyEquivalent: "g")
        findPreviousItem.keyEquivalentModifierMask = [.command, .shift]; findPreviousItem.target = self
        let fileItem = NSMenuItem(); fileItem.title = "File"; menu.insertItem(fileItem, at: 1)
        let fileMenu = NSMenu(title: "File"); fileItem.submenu = fileMenu
        let newFileItem = fileMenu.addItem(withTitle: "New File…", action: #selector(newFile), keyEquivalent: "n")
        newFileItem.target = self
        let findFileItem = fileMenu.addItem(withTitle: "Find File…", action: #selector(findFile), keyEquivalent: "p")
        findFileItem.target = self
        fileMenu.addItem(.separator())
        let saveItem = fileMenu.addItem(withTitle: "Save", action: #selector(saveFile), keyEquivalent: "s")
        saveItem.target = self
        fileMenu.addItem(.separator())
        let closeFileItem = fileMenu.addItem(withTitle: "Close File", action: #selector(closeCurrentFile), keyEquivalent: "w")
        closeFileItem.target = self
        let closeProjectItem = fileMenu.addItem(withTitle: "Close Project", action: #selector(closeProject), keyEquivalent: "w")
        closeProjectItem.keyEquivalentModifierMask = [.command, .shift]; closeProjectItem.target = self
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "")
        let viewItem = NSMenuItem(); viewItem.title = "View"; menu.addItem(viewItem); let view = NSMenu(title: "View"); viewItem.submenu = view
        let reload = view.addItem(withTitle: "Reload Editor", action: #selector(requestReload), keyEquivalent: "r"); reload.target = self
        NSApp.mainMenu = menu
    }

    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        if item.action == #selector(checkForUpdates) { return updater?.enabled == true && updater?.busy == false && !closingProject && !quitting && !checkingQuit && !installingUpdate }
        if item.action == #selector(newFile) || item.action == #selector(findFile)
            || item.action == #selector(findInFile) || item.action == #selector(findNext)
            || item.action == #selector(findPrevious) || item.action == #selector(saveFile)
            || item.action == #selector(closeCurrentFile)
            || item.action == #selector(undoEdit) || item.action == #selector(redoEdit) { return fileActionsEnabled }
        if item.action == #selector(closeProject) {
            return web != nil && launch != nil && window.attachedSheet == nil && !closingProject && !checkingQuit && !quitting && !installingUpdate
        }
        if item.action == #selector(requestReload) { return web != nil && !closingProject && !quitting && !installingUpdate }
        return true
    }

    private var fileActionsEnabled: Bool {
        web != nil && launch != nil && window.attachedSheet == nil && !closingProject && !checkingQuit && !quitting && !installingUpdate
    }

    @objc func newFile() { invokeFileAction("files-new-file") }
    @objc func findFile() { invokeFileAction("find-file") }
    @objc func findInFile() { invokeEditorFind("findInFile") }
    @objc func findNext() { invokeEditorFind("findNext") }
    @objc func findPrevious() { invokeEditorFind("findPrevious") }
    @objc func saveFile() { invokeEditorCommand("save") }
    @objc func closeCurrentFile() { invokeEditorCommand("closeFile") }
    @objc func undoEdit() { invokeEditorCommand("undo", fallback: "undo:") }
    @objc func redoEdit() { invokeEditorCommand("redo", fallback: "redo:") }

    private func invokeEditorCommand(_ action: String, fallback: String? = nil) {
        guard fileActionsEnabled else { return }
        let responder = window.firstResponder
        web.evaluateJavaScript("window.nimloDesktop?.\(action)?.() ?? false;") { [weak self] handled, error in
            guard let self, let fallback, error == nil, handled as? Bool == false,
                  self.fileActionsEnabled, self.window.firstResponder === responder else { return }
            // Text fields (search, AI drafts, dialogs) keep WebKit's own history.
            // Code edits use the shared document history through the web hook.
            NSApp.sendAction(NSSelectorFromString(fallback), to: nil, from: nil)
        }
    }

    private func invokeEditorFind(_ action: String) {
        guard fileActionsEnabled else { return }
        // The web editor owns file selection, dialog and composition guards.
        web.evaluateJavaScript("window.nimloDesktop?.\(action)?.();", completionHandler: nil)
    }

    private func invokeFileAction(_ id: String) {
        guard fileActionsEnabled else { return }
        // Use the existing UI handlers and their permission, composition and
        // dialog guards. Native menus add no filesystem or command bridge.
        web.evaluateJavaScript("document.getElementById('\(id)')?.click();", completionHandler: nil)
    }

    func setupUpdater() {
        guard devRoot == nil, report == nil else { return }
        let updates = NimloUpdater(); updater = updates
        updates.canPresent = { [weak self] in
            guard let self else { return false }
            return !self.quitting && !self.closingProject && !self.checkingQuit && !self.installingUpdate && self.window.attachedSheet == nil
        }
        updates.presentationGate = { [weak self] complete in self?.allowUpdatePresentation(complete) }
        updates.readyToInstall = { [weak self] archive, envelope, complete in
            guard let self else { complete(false); return }
            self.installUpdate(archive: archive, envelope: envelope, completion: complete)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            self?.allowUpdatePresentation { allowed in if allowed { self?.updater?.checkAutomatically() } }
        }
    }

    @objc func checkForUpdates() {
        allowUpdatePresentation { [weak self] allowed in if allowed { self?.updater?.check() } }
    }

    func allowUpdatePresentation(_ complete: @escaping (Bool) -> Void) {
        guard !quitting, !closingProject, !checkingQuit, !installingUpdate, window.attachedSheet == nil else { complete(false); return }
        guard let web else { complete(true); return }
        web.callAsyncJavaScript("return window.nimloDesktop?.canUpdate() === true;", arguments: [:], in: nil, in: .page) { result in
            complete(!self.quitting && !self.closingProject && !self.checkingQuit && !self.installingUpdate && self.window.attachedSheet == nil && (try? result.get()) as? Bool == true)
        }
    }

    func installUpdate(archive: URL, envelope: URL, completion: @escaping (Bool) -> Void) {
        guard !quitting, !closingProject, !checkingQuit, !installingUpdate else { completion(false); return }
        let proceed = { [weak self] in
            guard let self, !self.quitting, !self.closingProject, !self.installingUpdate else { completion(false); return }
            self.confirmEditorExit(projectClose: false, updating: true) { [weak self] approved in
                guard let self, approved else { completion(false); return }
                self.beginUpdatePreparation(archive: archive, envelope: envelope, completion: completion)
            }
        }
        // Persist the same bounded cursor/view record used by normal reloads,
        // and flush acknowledged drafts before asking to restart.
        guard let web else { proceed(); return }
        web.callAsyncJavaScript("return await window.nimloDesktop?.prepareReload(false);", arguments: [:], in: nil, in: .page) { result in
            guard (try? result.get()) as? Bool == true else {
                completion(false)
                let alert = NSAlert(); alert.messageText = "Finish pending edits before updating"
                alert.informativeText = "Nimlo will keep running. Resolve pending drafts or finish the current input, then check for updates again."
                alert.runModal(); return
            }
            proceed()
        }
    }

    func beginUpdatePreparation(archive: URL, envelope: URL, completion: @escaping (Bool) -> Void) {
        installingUpdate = true; updateFlushing = false; updateCancellationPending = false; updatePreparationCompletion = completion
        let preparationID = UUID(); updatePreparationID = preparationID
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 112), styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "Updating Nimlo"; panel.isReleasedWhenClosed = false
        let label = NSTextField(labelWithString: "Preparing and verifying update…")
        label.frame = NSRect(x: 20, y: 65, width: 340, height: 20)
        let spinner = NSProgressIndicator(frame: NSRect(x: 20, y: 27, width: 22, height: 22))
        spinner.style = .spinning; spinner.startAnimation(nil)
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelUpdatePreparation))
        cancel.frame = NSRect(x: 280, y: 20, width: 80, height: 30); cancel.bezelStyle = .rounded
        cancel.keyEquivalent = "\u{1b}"
        panel.contentView?.addSubview(label); panel.contentView?.addSubview(spinner); panel.contentView?.addSubview(cancel)
        updatePreparationPanel = panel; window.beginSheet(panel)
        // Copying and hashing the archive must not block Cancel or the main loop.
        // Keep the original state directory; the host restores its saved project.
        let arguments = ["--state-dir", state!, "--port", String(port)]
        let appURL = Bundle.main.bundleURL.resolvingSymlinksInPath()
        let hostPID = host?.processIdentifier ?? 0
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let prepared = Result { try NimloUpdateInstaller.prepare(appURL: appURL,
                archiveURL: archive.resolvingSymlinksInPath(), envelopeURL: envelope.resolvingSymlinksInPath(),
                parentPID: getpid(), hostPID: hostPID, relaunchArguments: arguments) }
            DispatchQueue.main.async {
                guard let self else { if let plan = try? prepared.get() { try? FileManager.default.removeItem(at: plan.deletingLastPathComponent()) }; return }
                guard self.installingUpdate, self.updatePreparationID == preparationID else { if let plan = try? prepared.get() { try? FileManager.default.removeItem(at: plan.deletingLastPathComponent()) }; return }
                do {
                    let plan = try prepared.get(); self.updateInstallPlan = plan
                    self.updateInstallProcess = try NimloUpdateInstaller.launch(planURL: plan)
                    let deadline = Date().addingTimeInterval(150)
                    self.updateInstallTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                        self?.pollUpdatePreparation(deadline: deadline)
                    }
                } catch { self.endUpdatePreparation(error: error) }
            }
        }
    }

    func pollUpdatePreparation(deadline: Date) {
        guard installingUpdate, let plan = updateInstallPlan, let preparationID = updatePreparationID else { return }
        do {
            guard Date() < deadline else { throw NimloUpdateError.invalid("Update verification took too long. Nimlo will keep running.") }
            let ready = try NimloUpdateInstaller.installationReady(planURL: plan)
            guard updateInstallProcess?.isRunning == true else { throw NimloUpdateError.invalid("The update helper stopped. Nimlo will keep running.") }
            guard ready, !updateFlushing else { return }
            updateFlushing = true
            // The helper has finished ZIP, code-signature and Gatekeeper checks.
            // The sheet blocks new local input while the last drafts are flushed.
            let finish: (Bool) -> Void = { [weak self] flushed in
                guard let self, self.installingUpdate, self.updatePreparationID == preparationID else { return }
                do {
                    guard flushed, self.updateInstallProcess?.isRunning == true,
                          try NimloUpdateInstaller.installationReady(planURL: plan) else {
                        throw NimloUpdateError.invalid("Finish pending edits, then try updating again. Nimlo will keep running.")
                    }
                    self.quitting = true
                    self.updateInstallTimer?.invalidate(); self.updateInstallTimer = nil
                    if let panel = self.updatePreparationPanel { self.window.endSheet(panel); panel.close() }
                    self.updatePreparationPanel = nil; self.installingUpdate = false; self.updatePreparationID = nil
                    let complete = self.updatePreparationCompletion; self.updatePreparationCompletion = nil
                    complete?(true)
                    self.watchTimer?.invalidate(); self.reloadRetry?.invalidate(); self.updater?.shutdown()
                    if self.building?.isRunning == true { self.building?.terminate() }
                    // AppKit may wait inside terminate() for our asynchronous
                    // reply. Start the owned host shutdown before entering it.
                    if self.host?.isRunning == true { self.stopHost() }
                    NSApp.terminate(nil)
                } catch { self.endUpdatePreparation(error: error) }
            }
            guard let web else { finish(true); return }
            web.callAsyncJavaScript("return await window.nimloDesktop?.prepareReload(false);", arguments: [:], in: nil, in: .page) { result in
                finish((try? result.get()) as? Bool == true)
            }
        } catch { endUpdatePreparation(error: error) }
    }

    @objc func cancelUpdatePreparation() { endUpdatePreparation(error: nil) }

    func endUpdatePreparation(error: Error?) {
        guard installingUpdate, !updateCancellationPending else { return }
        updateInstallTimer?.invalidate(); updateInstallTimer = nil
        // Invalidate pending WebKit/background callbacks before cancellation.
        updatePreparationID = nil
        if let plan = updateInstallPlan {
            if let process = updateInstallProcess {
                do { try NimloUpdateInstaller.cancel(planURL: plan) }
                catch let cancellationError {
                    if process.isRunning {
                        // If private state cannot be written, retain the quit
                        // guard until our helper exits. The current app stays
                        // alive, so that helper cannot reach its swap step.
                        updateCancellationPending = true
                        process.terminate()
                        updateInstallTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] timer in
                            guard let self else { timer.invalidate(); return }
                            guard !process.isRunning else { return }
                            timer.invalidate(); self.finishUpdateCancellation(error: error ?? cancellationError)
                        }
                        return
                    }
                }
            } else { try? FileManager.default.removeItem(at: plan.deletingLastPathComponent()) }
        }
        finishUpdateCancellation(error: error)
    }

    func finishUpdateCancellation(error: Error?) {
        updateInstallTimer?.invalidate(); updateInstallTimer = nil
        updateInstallPlan = nil; updateInstallProcess = nil; updateFlushing = false; updateCancellationPending = false; installingUpdate = false; updatePreparationID = nil
        if let panel = updatePreparationPanel { window.endSheet(panel); panel.close() }; updatePreparationPanel = nil
        let complete = updatePreparationCompletion; updatePreparationCompletion = nil; complete?(false)
        if let error {
            let alert = NSAlert(); alert.messageText = "Couldn’t prepare the update"
            alert.informativeText = error.localizedDescription; alert.runModal()
        }
    }

    func acknowledgeUpdateStartup() {
        guard CommandLine.arguments.contains("--update-receipt") else { return }
        if web == nil { _ = NimloUpdateInstaller.acknowledgeStartup(); return }
        guard updateStartupTimer == nil else { return }
        updateStartupDeadline = Date().addingTimeInterval(55)
        updateStartupTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            guard !self.quitting, Date() < (self.updateStartupDeadline ?? .distantPast) else {
                timer.invalidate(); self.updateStartupTimer = nil; return
            }
            self.web?.callAsyncJavaScript("return !!window.nimloDesktop && document.getElementById('app')?.dataset.controller === 'yes';", arguments: [:], in: nil, in: .page) { result in
                if (try? result.get()) as? Bool == true, NimloUpdateInstaller.acknowledgeStartup() {
                    timer.invalidate(); self.updateStartupTimer = nil
                }
            }
        }
    }

    func showWelcome() {
        window.title = devRoot == nil ? "Nimlo" : "Nimlo — Development"
        let view = NSView(); view.identifier = NSUserInterfaceItemIdentifier("nimlo-welcome")
        let logo = NSImageView()
        logo.image = Bundle.main.url(forResource: "welcome-logo", withExtension: "png").flatMap { NSImage(contentsOf: $0) }
        logo.imageScaling = .scaleProportionallyUpOrDown
        logo.setAccessibilityLabel("Nimlo logo")
        let title = NSTextField(labelWithString: "Welcome to Nimlo")
        title.font = .systemFont(ofSize: 21, weight: .medium)
        title.textColor = NSColor(calibratedRed: 0.929, green: 0.945, blue: 0.969, alpha: 1)
        title.alignment = .center
        let button = NimloWelcomeButton(title: "Open folder…", target: self, action: #selector(chooseProjectFolder))
        button.identifier = NSUserInterfaceItemIdentifier("select-project-folder")
        button.setButtonType(.momentaryPushIn); button.isBordered = false
        button.font = .systemFont(ofSize: 13, weight: .medium)
        button.setAccessibilityLabel("Open project folder")
        button.focusRingType = .exterior
        button.keyEquivalent = "\r"
        let content = NSStackView(views: [logo, title, button])
        content.orientation = .vertical; content.alignment = .centerX; content.spacing = 20
        content.setCustomSpacing(24, after: title)
        content.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content)
        NSLayoutConstraint.activate([
            logo.widthAnchor.constraint(equalToConstant: 104), logo.heightAnchor.constraint(equalToConstant: 104),
            button.widthAnchor.constraint(equalToConstant: 196), button.heightAnchor.constraint(equalToConstant: 36),
            content.centerXAnchor.constraint(equalTo: view.centerXAnchor), content.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 12),
            content.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            content.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24)
        ])
        window.contentView = view; window.makeFirstResponder(button)
        recordNative("welcome")
    }

    @objc func chooseProjectFolder() {
        guard web == nil, !selectingProject, !closingProject, !quitting else { return }
        selectingProject = true
        let panel = NSOpenPanel(); panel.title = "Select a project folder"; panel.prompt = "Open project"
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }; self.selectingProject = false
            // Cancel keeps the welcome screen and starts no background host.
            guard response == .OK, let folder = panel.url, !self.quitting else { return }
            self.openProjectFolder(folder)
        }
    }

    func openProjectFolder(_ folder: URL) {
        guard web == nil, !closingProject, !quitting else { return }
        guard folder.isFileURL, let values = try? folder.resourceValues(forKeys: [.isDirectoryKey]), values.isDirectory == true else {
            let alert = NSAlert(); alert.messageText = "Select a project folder"
            alert.informativeText = "Choose an existing folder to open in Nimlo."
            alert.beginSheetModal(for: window) { _ in }; return
        }
        // Explicit workspace takes precedence over the last-project pointer.
        // Existing per-project recovery and browser drafts are left untouched.
        workspace = folder.standardizedFileURL.path
        startEditor()
    }

    func startEditor() {
        guard web == nil, !closingProject, !quitting else { return }
        let config = WKWebViewConfiguration()
        // A private, ephemeral profile is reauthenticated by the owned host.
        config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self; web.uiDelegate = self
        if #available(macOS 13.3, *), devRoot != nil { web.isInspectable = true }
        window.contentView = web
        startPerformanceDiagnostics(); startHost()
        if devRoot != nil {
            stamps = fileStamps()
            watchTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in self?.watchChanges() }
        }
    }

    var binary: String {
        if let root = devRoot { return (root as NSString).appendingPathComponent("target/release/nimlo-editor") }
        return Bundle.main.resourceURL!.appendingPathComponent("nimlo-editor").path
    }
    func startHost() {
        guard web != nil, !closingProject, !quitting else { return }
        launch = nil; errors = ""; output.removeAll(keepingCapacity: true); hostSequence += 1
        let sequence = hostSequence
        let p = Process(); p.executableURL = URL(fileURLWithPath: binary)
        p.currentDirectoryURL = URL(fileURLWithPath: workspace ?? FileManager.default.homeDirectoryForCurrentUser.path)
        var args = ["--desktop", "--resume-project", "--state-dir", state!, "--listen", "127.0.0.1:\(port)"]
        if let folder = workspace { args += ["--workspace", folder] }
        if let root = devRoot { args += ["--dev-assets", (root as NSString).appendingPathComponent("web")] }
        p.arguments = args
        var environment = ProcessInfo.processInfo.environment
        var paths = (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").components(separatedBy: ":")
        for path in ["/opt/homebrew/bin", "/usr/local/bin", FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path] where !paths.contains(path) { paths.append(path) }
        environment["PATH"] = paths.joined(separator: ":"); p.environment = environment
        let input = Pipe(), stdout = Pipe(), stderr = Pipe(); p.standardInput = input; p.standardOutput = stdout; p.standardError = stderr
        parentPipe = input; host = p
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { guard let self, sequence == self.hostSequence else { return }; self.receive(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async { guard let self, sequence == self.hostSequence else { return }; self.errors = String((self.errors + String(decoding: data, as: UTF8.self)).suffix(6000)) }
        }
        p.terminationHandler = { [weak self] process in
            stdout.fileHandleForReading.readabilityHandler = nil; stderr.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self, sequence == self.hostSequence else { return }
                self.recordNative("host-exit", fields:["pid":process.processIdentifier,"status":process.terminationStatus])
                if self.quitting { NSApp.reply(toApplicationShouldTerminate: true) }
                else if self.closingProject { self.finishClosingProject() }
                else if self.restartingHost { self.restartingHost = false; self.pendingRestart = false; self.startHost() }
                else { self.fail("Nimlo's host stopped (\(process.terminationStatus)). \(self.errors)") }
            }
        }
        do { try p.run() } catch { fail("Cannot start the bundled host: \(error.localizedDescription)"); return }
        recordNative("host-start", fields:["pid":p.processIdentifier])
        // Close the parent's duplicate read end, so a killed window closes the
        // only writer and the host observes EOF even if it is orphaned.
        try? input.fileHandleForReading.close()
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.hostSequence == sequence, self.launch == nil, !self.closingProject, !self.quitting else { return }
            self.fail("The local host did not become ready. \(self.errors)")
        }
    }

    func receive(_ data: Data) {
        guard !data.isEmpty, !closingProject else { return }
        output.append(data)
        guard output.count <= 16384 else { fail("Invalid host startup response"); return }
        while let newline = output.firstIndex(of: 10) {
            let line = output.prefix(upTo: newline); output.removeSubrange(...newline)
            guard let json = try? JSONSerialization.jsonObject(with: line) as? [String: String], json["type"] == "ready",
                  let text = json["url"], let url = NimloPolicy.launchURL(text, port: port), launch == nil else { continue }
            launch = url
            // A new hash alone is a same-document navigation in WKWebView.
            // Change the benign query too so each owned host gets a full load,
            // restoring the prepared view and exchanging its new capability.
            var page = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            page.query = "desktop=\(hostSequence)"
            web.load(URLRequest(url: page.url!)); window.title = devRoot == nil ? "Nimlo" : "Nimlo — Development"
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload, action.sourceFrame.isMainFrame,
           NimloPolicy.localPage(action.sourceFrame.request.url ?? url, port: port), NimloPolicy.localBlob(url, port: port) {
            decisionHandler(fileDownload == nil ? .download : .cancel); return
        }
        if NimloPolicy.localPage(url, port: port), action.targetFrame?.isMainFrame == true { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated, NimloPolicy.externalLink(url), !NimloPolicy.localPage(url, port: port) { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = "Nimlo"; alert.informativeText = String(message.prefix(4000)); alert.addButton(withTitle: "Continue"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = "Nimlo"; alert.informativeText = String(message.prefix(4000)); alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { record("loaded", retry: 30); acknowledgeUpdateStartup() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        window.title = "Nimlo — Editor recovered"
        if let launch { webView.load(URLRequest(url: launch)) }
    }
    func record(_ name: String, retry: Int = 0) {
        guard let report, let web else { return }
        web.callAsyncJavaScript("return {connected:document.getElementById('app')?.dataset.controller === 'yes',authenticated:!document.getElementById('join-dialog')?.open,hook:!!window.nimloDesktop,css:getComputedStyle(document.documentElement).getPropertyValue('--nimlo-desktop-test').trim(),value:document.getElementById('code-input')?.value,prompt:document.getElementById('prompt')?.value,terminalDraft:document.getElementById('terminal-command')?.value,selection:document.getElementById('code-input')?.selectionStart,marker:window.__nimloDesktopTest||null};", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            let snapshot = (try? result.get()) as? [String: Any] ?? [:]
            if snapshot["connected"] as? Bool != true && retry > 0 { DispatchQueue.main.asyncAfter(deadline: .now()+0.1) { self.record(name, retry: retry-1) }; return }
            self.events.append(["event":name,"hostPid":self.host?.processIdentifier ?? 0,"snapshot":snapshot]); self.events = Array(self.events.suffix(64))
            if let data = try? JSONSerialization.data(withJSONObject: self.events, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: URL(fileURLWithPath: report), options: .atomic) }
        }
    }
    func recordNative(_ name: String, fields: [String: Any] = [:]) {
        guard let report else { return }
        var event = fields; event["event"] = name; events.append(event); events = Array(events.suffix(64))
        if let data = try? JSONSerialization.data(withJSONObject: events, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: URL(fileURLWithPath: report), options: .atomic) }
    }

    func fileStamps() -> [String: String] {
        guard let root = devRoot else { return [:] }
        let fm = FileManager.default
        var paths = ["web/index.html", "web/app.js", "web/editor.js", "web/style.css", "Cargo.toml", "Cargo.lock"]
        paths += ((try? fm.contentsOfDirectory(atPath: root+"/src")) ?? []).filter { $0.hasSuffix(".rs") }.map { "src/"+$0 }
        return Dictionary(uniqueKeysWithValues: paths.map { path in
            let a = try? fm.attributesOfItem(atPath: root+"/"+path)
            return (path, "\((a?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0): \(a?[.size] ?? 0)")
        })
    }
    func watchChanges() {
        guard !quitting, !closingProject, web != nil else { return }
        let next = fileStamps(); let changed = Set(stamps.keys).union(next.keys).filter { stamps[$0] != next[$0] }; stamps = next
        if changed.contains(where: { !$0.hasPrefix("web/") }) { buildHost() }
        if changed.contains("web/style.css") { pendingCSS = true }
        if changed.contains("web/app.js") || changed.contains("web/editor.js") || changed.contains("web/index.html") { pendingReload = true }
        applyChanges()
    }
    func buildHost() {
        guard let root = devRoot, !closingProject, !quitting else { return }
        if building != nil { buildAgain = true; return }
        window.title = "Nimlo — Building host…"
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/env"); p.arguments = ["cargo", "build", "--release", "--manifest-path", root+"/Cargo.toml"]
        // Cargo diagnostics go to the dev terminal; no startup credential does.
        p.standardOutput = FileHandle.standardError; p.standardError = FileHandle.standardError; building = p
        let sequence = hostSequence
        p.terminationHandler = { [weak self] p in DispatchQueue.main.async {
            guard let self, self.hostSequence == sequence, !self.closingProject, !self.quitting else { return }; self.building = nil
            if self.buildAgain { self.buildAgain = false; self.buildHost(); return }
            if p.terminationStatus == 0 { self.pendingRestart = true; self.applyChanges() }
            else { self.window.title = "Nimlo — Build failed; see dev terminal" }
        } }
        do { try p.run() } catch { building = nil; window.title = "Nimlo — Cannot run Cargo" }
    }
    @objc func requestReload() { guard web != nil, !closingProject, !quitting, !installingUpdate else { return }; pendingReload = true; applyChanges() }
    func applyChanges() {
        guard let web, launch != nil, !checkingReload, !restartingHost, !closingProject, !quitting, !installingUpdate else { return }
        if pendingCSS && !pendingReload {
            pendingCSS = false
            web.evaluateJavaScript("document.querySelectorAll('link[rel=stylesheet]').forEach(link => {const next=new URL(link.href); next.searchParams.set('dev',Date.now()); link.href=next.href;});") { [weak self] _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now()+0.2) { self?.record("css") }
            }; return
        }
        guard pendingReload || pendingRestart else { return }
        checkingReload = true
        // Keep UI hot reload available while an active shell defers a rebuilt
        // host. This also lets the user end that shell through updated controls.
        let restarting = pendingRestart && !pendingReload
        if restarting && building != nil { checkingReload = false; return }
        let sequence = hostSequence
        web.callAsyncJavaScript("if (!window.nimloDesktop) { const field=document.getElementById('code-input'); return !restart && (!field || field.readOnly || !field.value) && ![...document.querySelectorAll('textarea:not([readonly]),input:not([readonly])')].some(input => !['hidden','checkbox','radio','button','submit','reset','image','range','color','file'].includes(input.type) && input.value); } return await window.nimloDesktop.prepareReload(restart);", arguments: ["restart":restarting], in: nil, in: .page) { [weak self] result in
            guard let self, self.web === web, self.hostSequence == sequence, !self.closingProject, !self.quitting else { return }; self.checkingReload = false
            guard (try? result.get()) as? Bool == true else {
                self.window.title = "Nimlo — Reload waiting for drafts, dialogs or active work"
                if self.devRoot == nil && self.reloadRetry == nil { self.reloadRetry = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: false) { [weak self] _ in self?.reloadRetry = nil; self?.applyChanges() } }
                return
            }
            self.pendingCSS = false; self.pendingReload = false
            if restarting {
                self.restartingHost = true; self.record("restart"); self.stopHost()
            } else {
                self.window.title = self.devRoot == nil ? "Nimlo" : "Nimlo — Development"; self.web.reload()
            }
        }
    }
    func stopHost() {
        try? parentPipe?.fileHandleForWriting.close(); parentPipe = nil
        guard let p = host, p.isRunning else {
            if quitting { NSApp.reply(toApplicationShouldTerminate: true) }
            else if closingProject { finishClosingProject() }
            return
        }
        p.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now()+8) { if p.isRunning { Darwin.kill(p.processIdentifier, SIGKILL) } }
    }

    @objc func closeProject() {
        guard web != nil, launch != nil, window.attachedSheet == nil, !closingProject, !checkingQuit, !quitting, !installingUpdate else { return }
        confirmEditorExit(projectClose: true) { [weak self] approved in
            guard let self, approved else { return }
            self.closingProject = true
            self.watchTimer?.invalidate(); self.watchTimer = nil
            self.reloadRetry?.invalidate(); self.reloadRetry = nil
            self.pendingReload = false; self.pendingCSS = false; self.pendingRestart = false; self.restartingHost = false
            self.buildAgain = false
            if self.building?.isRunning == true { self.building?.terminate() }
            self.building = nil
            self.stopPerformanceDiagnostics()
            self.cancelFileDownload()
            self.stopHost()
        }
    }

    func finishClosingProject() {
        guard closingProject, host?.isRunning != true else { return }
        // Wait for shutdown before clearing the pointer: paired clients may
        // otherwise save a new selection while the old host is still alive.
        let saved = (state as NSString).appendingPathComponent("last-project.json")
        var preferenceError: Error?
        do {
            if FileManager.default.fileExists(atPath: saved) { try FileManager.default.removeItem(atPath: saved) }
        } catch { preferenceError = error }
        hostSequence += 1
        web?.stopLoading(); web?.navigationDelegate = nil; web?.uiDelegate = nil
        web = nil; host = nil; launch = nil; workspace = nil
        output.removeAll(); errors = ""; checkingReload = false
        closingProject = false
        showWelcome()
        recordNative("project-closed")
        if let preferenceError {
            let alert = NSAlert(); alert.messageText = "Could not clear the remembered project"
            alert.informativeText = "This folder may reopen next time Nimlo starts. \(preferenceError.localizedDescription)"
            alert.beginSheetModal(for: window) { _ in }
        }
    }

    func confirmEditorExit(projectClose: Bool, updating: Bool = false, completion: @escaping (Bool) -> Void) {
        guard let web else {
            if updating {
                let alert = NSAlert(); alert.messageText = "Restart Nimlo to install the update?"
                alert.addButton(withTitle: "Later"); alert.addButton(withTitle: "Restart and Update")
                completion(alert.runModal() == .alertSecondButtonReturn)
            } else { completion(true) }
            return
        }
        checkingQuit = true
        let sequence = hostSequence
        web.callAsyncJavaScript("return await window.nimloDesktop?.quitState();", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            defer { self.checkingQuit = false }
            guard self.web === web, self.hostSequence == sequence, !self.quitting, !self.closingProject else { completion(false); return }
            let status = (try? result.get()) as? [String: Bool] ?? ["pending":true,"work":true,"dirty":true]
            if status["pending"] == true {
                let alert = NSAlert(); alert.messageText = "Edits are still reaching the host"
                alert.informativeText = projectClose
                    ? "Wait for the connection or resolve the draft before closing the project."
                    : "Wait for the connection or resolve the draft before quitting. Closing the window keeps Nimlo running."
                alert.runModal(); completion(false); return
            }
            if updating || status["work"] == true || status["dirty"] == true {
                let alert = NSAlert(); alert.messageText = updating ? "Restart Nimlo to install the update?" : projectClose ? "Close this project?" : "Quit this Nimlo session?"
                alert.informativeText = updating
                    ? "Project files and acknowledged unsaved work remain in recovery. Restarting ends terminals, AI jobs and paired-device access. Choose Later to keep this session running."
                    : projectClose
                    ? "Closing the project ends this desktop session, including terminals, AI and paired-device access. Acknowledged unsaved files remain in recovery for the next time you open this folder."
                    : "Quitting stops host terminals, AI and phone access. Acknowledged unsaved files remain in recovery for next launch. Close the window instead to keep the session running."
                alert.addButton(withTitle: updating ? "Later" : projectClose ? "Keep open" : "Keep running")
                alert.addButton(withTitle: updating ? "Restart and Update" : projectClose ? "Close Project" : "Quit Nimlo")
                guard alert.runModal() == .alertSecondButtonReturn else { completion(false); return }
            }
            completion(true)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting { return host?.isRunning == true ? .terminateLater : .terminateNow }
        if checkingQuit || closingProject || installingUpdate { return .terminateCancel }
        guard web != nil, launch != nil else { quitting = true; stopHost(); return host?.isRunning == true ? .terminateLater : .terminateNow }
        confirmEditorExit(projectClose: false) { [weak self] approved in
            guard let self else { return }
            guard approved else { NSApp.reply(toApplicationShouldTerminate: false); return }
            self.quitting = true; self.watchTimer?.invalidate(); if self.building?.isRunning == true { self.building?.terminate() }; self.stopHost()
        }
        return .terminateLater
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { if !installingUpdate { sender.orderOut(nil) }; return false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window?.makeKeyAndOrderFront(nil); return true }
    func applicationWillTerminate(_ notification: Notification) { updater?.shutdown(); updateStartupTimer?.invalidate(); cancelFileDownload(); try? parentPipe?.fileHandleForWriting.close(); if lockFD >= 0 { Darwin.close(lockFD) } }
    func fail(_ message: String) {
        if report != nil { recordNative("error", fields:["message":message]); quitting = true; stopHost(); NSApp.terminate(nil); return }
        let alert = NSAlert(); alert.messageText = "Nimlo could not start"; alert.informativeText = message
        alert.runModal(); quitting = true; stopHost(); NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = NimloApp()
app.setActivationPolicy(.regular); app.delegate = delegate
app.run()
