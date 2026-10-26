import AppKit
import Darwin
import WebKit

struct NativeDocument {
  var path: String, text: String, revision: Int, dirty: Bool, conflict: [String: Any]?
  init?(_ value: [String: Any]) {
    guard let path = value["path"] as? String, let text = value["content"] as? String,
      let revision = value["revision"] as? Int
    else { return nil }
    self.path = path
    self.text = text
    self.revision = revision
    dirty = value["dirty"] as? Bool ?? false
    conflict = value["conflict"] as? [String: Any]
  }
}
final class NativeApp: NSObject, NSApplicationDelegate, NSWindowDelegate, NSMenuItemValidation,
  NSSearchFieldDelegate
{
  var window: NSWindow!, editor = EditorView(), browser = FileBrowser(), client = WorkspaceClient(),
    engine = Neovim(), host = NativeHost()
  var companion: NativeCompanion?, palette: FilePalette?
  var state = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
    ".nimlo-neovim/desktop"
  ).path
  var workspaceArgument: String?, openArgument: String?, testDirectory: String?
  var workspace = "", projectName = "", active: String?, documents: [String: NativeDocument] = [:],
    projects: [[String: Any]] = [], rootFiles: [[String: Any]] = [], recent: [String] = []
  var hostURL: URL?, started = false, quitting = false, busy = false, recoveryChecked = false,
    conflictOpen = false
  var checkingQuit = false
  var engineActionInProgress = false
  var quitPhase = ""
  var boundProject = ""
  var queuedFile: String?
  var mutation = 0, localDirty = false, baseRevision: Int?, baseText: String?, pendingText: String?,
    commitInFlight = false, capturing = false
  var flushWaiters: [(Bool) -> Void] = [], commitWork: DispatchWorkItem?
  var lockFD: Int32 = -1
  var projectButton = NSPopUpButton(), fileLabel = NSTextField(labelWithString: ""),
    status = NSTextField(labelWithString: ""), engineLabel = NSTextField(labelWithString: ""),
    mode = EditorModeControl()
  var findBar = NSView(), findField = NSSearchField(), split = NSSplitView(),
    center = EditorWorkspace()
  var centerMinimum: NSLayoutConstraint!
  var findHeight: NSLayoutConstraint!, testController: NativeDiagnostics?
  var toolbarButtons: [ToolbarButton] = []
  var aiButton: ToolbarButton?, terminalButton: ToolbarButton?
  var recentMenu: NSMenu!
  var updateMonitor: NimloUpdateMonitor?
  let updateNotice = UpdateNotice()
  var updateNoticeHeight: NSLayoutConstraint?
  var updatePageOpener: (URL) -> Bool = { NSWorkspace.shared.open($0) }
  var currentSnapshot: [String: Any] = [:]
  var draftURL: URL { URL(fileURLWithPath: state).appendingPathComponent("native-pending.json") }
  var resources: URL { Bundle.main.resourceURL! }

  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      try configure()
      try FileManager.default.createDirectory(
        atPath: state, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      lockFD = Darwin.open(
        (state as NSString).appendingPathComponent("desktop.lock"), O_CREAT | O_RDWR | O_NOFOLLOW,
        0o600)
      guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
        throw NimloFailure(
          "This Nimlo session is already open. Use its window or a different --state-dir.")
      }
    } catch {
      showFailure(error.localizedDescription)
      return
    }
    configureUpdates()
    setupWindow()
    setupMenus()
    if let directory = testDirectory {
      testController = NativeDiagnostics(app: self, directory: directory)
      testController?.start()
    }
    if workspaceArgument != nil || NimloPolicy.hasSavedProject(state: state) {
      startWorkspace()
    } else {
      welcome()
    }
    if testDirectory == nil { updateMonitor?.startAutomaticChecks() }
  }
  func configureUpdates() {
    updateMonitor = NimloUpdateMonitor(
      current: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
      cache: NimloUpdateCache(url: URL(fileURLWithPath: state).appendingPathComponent("update-state.json")))
    updateMonitor?.onChange = { [weak self] offer in self?.displayUpdate(offer) }
    updateMonitor?.onManualResult = { [weak self] result in
      guard let self else { return }
      switch result {
      case .available: self.displayUpdate(self.updateMonitor?.available)
      case .current: self.updateMessage("You're up to date", "This Mac is running the latest available Nimlo release.")
      case .unavailable: self.updateMessage("No update available for this Mac", "The latest release does not have a compatible download yet. Please check again later.")
      case .failed: self.updateMessage("Could not check for updates", "Check your internet connection and try again later. You can also visit Nimlo's GitHub Releases page.")
      case .throttled: self.updateMessage("Check again shortly", "Please wait a moment before checking for updates again.")
      }
    }
    updateNotice.onOpen = { [weak self] in
      guard let self, let offer = self.updateMonitor?.available else { return }
      if !self.updatePageOpener(offer.page) { self.updateMessage("Could not open the release page", "Open github.com/guilhermegm/Nimlo/releases in your browser to download the update.") }
    }
  }
  func mountContent(_ content: NSView) {
    updateNoticeHeight?.isActive = false
    updateNotice.removeFromSuperview()
    let root = NSView()
    content.translatesAutoresizingMaskIntoConstraints = false
    updateNotice.translatesAutoresizingMaskIntoConstraints = false
    root.addSubview(updateNotice); root.addSubview(content)
    updateNotice.display(updateMonitor?.available)
    updateNoticeHeight = updateNotice.heightAnchor.constraint(equalToConstant: updateNotice.isHidden ? 0 : 44)
    NSLayoutConstraint.activate([
      updateNotice.topAnchor.constraint(equalTo: root.topAnchor),
      updateNotice.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      updateNotice.trailingAnchor.constraint(equalTo: root.trailingAnchor), updateNoticeHeight!,
      content.topAnchor.constraint(equalTo: updateNotice.bottomAnchor),
      content.leadingAnchor.constraint(equalTo: root.leadingAnchor),
      content.trailingAnchor.constraint(equalTo: root.trailingAnchor),
      content.bottomAnchor.constraint(equalTo: root.bottomAnchor),
    ])
    window.contentView = root
  }
  func displayUpdate(_ offer: NimloUpdateOffer?) {
    updateNotice.display(offer)
    updateNoticeHeight?.constant = offer == nil ? 0 : 44
    window?.contentView?.layoutSubtreeIfNeeded()
  }
  func updateMessage(_ title: String, _ message: String) {
    guard !quitting, window?.attachedSheet == nil, companion?.modal != true else { return }
    let alert = NSAlert(); alert.messageText = title; alert.informativeText = message
    alert.addButton(withTitle: "OK"); alert.beginSheetModal(for: window) { _ in }
  }
  @objc func checkForUpdates(_ sender: Any?) { updateMonitor?.check(manual: true) }
  func applicationDidBecomeActive(_ notification: Notification) {
    if testDirectory == nil { updateMonitor?.check() }
  }
  func configure() throws {
    let args = Array(CommandLine.arguments.dropFirst())
    var i = 0
    while i < args.count {
      guard i + 1 < args.count else { throw NimloFailure("Missing value for \(args[i])") }
      let value = args[i + 1]
      switch args[i] {
      case "--workspace": workspaceArgument = URL(fileURLWithPath: value).standardizedFileURL.path
      case "--state-dir": state = URL(fileURLWithPath: value).standardizedFileURL.path
      case "--open-file": openArgument = value
      case "--test-control": testDirectory = value
      default: throw NimloFailure("Unknown argument: \(args[i])")
      }
      i += 2
    }
  }
  func setupWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
    )
    window.title = "Nimlo"
    window.minSize = NSSize(width: 800, height: 480)
    window.backgroundColor = NSColor(rgb: 0x15191f)
    window.appearance = NSAppearance(named: .darkAqua)
    window.isReleasedWhenClosed = false
    window.delegate = self
    if testDirectory == nil { window.setFrameAutosaveName("NimloDesktop") }
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
  func welcome() {
    let view = NSView()
    mountContent(view)
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 18
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    let logo = NSImageView()
    logo.image = NSImage(contentsOf: resources.appendingPathComponent("welcome-logo.png"))
    logo.imageScaling = .scaleProportionallyUpOrDown
    logo.widthAnchor.constraint(equalToConstant: 56).isActive = true
    logo.heightAnchor.constraint(equalToConstant: 56).isActive = true
    let title = NSTextField(labelWithString: "Nimlo")
    title.font = NSFont.systemFont(ofSize: 27, weight: .medium)
    let copy = NSTextField(
      labelWithString: "Your files, terminal, and AI.\nOne quiet place to work.")
    copy.alignment = .center
    copy.textColor = NSColor(rgb: 0x8491a2)
    copy.font = NSFont.systemFont(ofSize: 13)
    let open = NSButton(title: "Open folder…", target: self, action: #selector(chooseFolder))
    open.bezelStyle = .rounded
    open.controlSize = .large
    for item in [logo, title, copy, open] { stack.addArrangedSubview(item) }
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
  }
  func setupWorkspaceUI() {
    let view = NSView()
    view.wantsLayer = true
    view.layer?.backgroundColor = NSColor(rgb: 0x15191f).cgColor
    mountContent(view)
    let header = NSView()
    let footer = NSView()
    for v in [header, footer, split] {
      v.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(v)
    }
    header.wantsLayer = true
    header.layer?.backgroundColor = NSColor(rgb: 0x1b2129).cgColor
    footer.wantsLayer = true
    footer.layer?.backgroundColor = NSColor(rgb: 0x1b2129).cgColor
    let logo = NSImageView(
      image: NSImage(contentsOf: resources.appendingPathComponent("welcome-logo.png")) ?? NSImage())
    logo.imageScaling = .scaleProportionallyUpOrDown
    projectButton.target = self
    projectButton.action = #selector(projectChanged)
    projectButton.font = NSFont.systemFont(ofSize: 12)
    projectButton.isBordered = false
    fileLabel.font = NSFont.systemFont(ofSize: 12, weight: .medium)
    fileLabel.lineBreakMode = .byTruncatingMiddle
    fileLabel.textColor = NSColor(rgb: 0xdde4ed)
    let files = tool("Find file", "doc.text.magnifyingglass", #selector(findFile))
    let ai = tool("AI", "sparkles", #selector(showAI))
    let terminal = tool("Terminal", "terminal", #selector(showTerminal))
    let share = tool("Share", "personalhotspot", #selector(showSharing))
    mode.selectedSegment = 0
    mode.target = self
    mode.action = #selector(modeChanged)
    toolbarButtons = [files, ai, terminal, share]
    aiButton = ai
    terminalButton = terminal
    let divider = NSView()
    divider.wantsLayer = true
    divider.layer?.backgroundColor = NSColor(rgb: 0x343e4b).cgColor
    divider.widthAnchor.constraint(equalToConstant: 1).isActive = true
    divider.heightAnchor.constraint(equalToConstant: 16).isActive = true
    let tools = NSStackView(views: [
      logo, projectButton, files, fileLabel, NSView(), mode, divider, ai, terminal, share,
    ])
    tools.spacing = 6
    tools.alignment = .centerY
    tools.translatesAutoresizingMaskIntoConstraints = false
    header.addSubview(tools)
    logo.widthAnchor.constraint(equalToConstant: 25).isActive = true
    logo.heightAnchor.constraint(equalToConstant: 25).isActive = true
    projectButton.widthAnchor.constraint(lessThanOrEqualToConstant: 210).isActive = true
    fileLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    split.isVertical = true
    split.dividerStyle = .thin
    split.addArrangedSubview(browser)
    split.addArrangedSubview(center)
    browser.widthAnchor.constraint(greaterThanOrEqualToConstant: 180).isActive = true
    centerMinimum = center.widthAnchor.constraint(greaterThanOrEqualToConstant: 400)
    centerMinimum.isActive = true
    browser.client = client
    browser.onOpen = { [weak self] in self?.openFile($0) }
    browser.onNew = { [weak self] in self?.newFile(nil) }
    browser.onNotice = { [weak self] in self?.status.stringValue = $0 }
    editor.engine = engine
    editor.sourceText = { [weak self] in
      self?.pendingText ?? self?.active.flatMap { self?.documents[$0]?.text } ?? ""
    }
    findBar.translatesAutoresizingMaskIntoConstraints = false
    editor.translatesAutoresizingMaskIntoConstraints = false
    let source = center.source
    source.addSubview(findBar)
    source.addSubview(editor)
    findField.placeholderString = "Find in current file"
    findField.delegate = self
    findField.target = self
    findField.action = #selector(findNext)
    let previous = NSButton(
      image: NSImage(systemSymbolName: "chevron.up", accessibilityDescription: "Previous match")!,
      target: self, action: #selector(findPrevious))
    let next = NSButton(
      image: NSImage(systemSymbolName: "chevron.down", accessibilityDescription: "Next match")!,
      target: self, action: #selector(findNext))
    let close = NSButton(
      image: NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close find")!,
      target: self, action: #selector(closeFind))
    let findTools = NSStackView(views: [findField, previous, next, close])
    findTools.spacing = 6
    findTools.translatesAutoresizingMaskIntoConstraints = false
    findBar.addSubview(findTools)
    findHeight = findBar.heightAnchor.constraint(equalToConstant: 0)
    findBar.isHidden = true
    status.font = NSFont.systemFont(ofSize: 10.5)
    status.textColor = NSColor(rgb: 0x8491a2)
    status.lineBreakMode = .byTruncatingMiddle
    engineLabel.font = NSFont.systemFont(ofSize: 10.5)
    engineLabel.textColor = NSColor(rgb: 0x8491a2)
    status.translatesAutoresizingMaskIntoConstraints = false
    engineLabel.translatesAutoresizingMaskIntoConstraints = false
    footer.addSubview(status)
    footer.addSubview(engineLabel)
    NSLayoutConstraint.activate([
      header.topAnchor.constraint(equalTo: view.topAnchor),
      header.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      header.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      header.heightAnchor.constraint(equalToConstant: 50),
      tools.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 14),
      tools.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -12),
      tools.centerYAnchor.constraint(equalTo: header.centerYAnchor),
      footer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      footer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      footer.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      footer.heightAnchor.constraint(equalToConstant: 25),
      status.leadingAnchor.constraint(equalTo: footer.leadingAnchor, constant: 14),
      status.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
      engineLabel.trailingAnchor.constraint(equalTo: footer.trailingAnchor, constant: -14),
      engineLabel.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
      status.trailingAnchor.constraint(lessThanOrEqualTo: engineLabel.leadingAnchor, constant: -16),
      split.topAnchor.constraint(equalTo: header.bottomAnchor),
      split.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      split.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      split.bottomAnchor.constraint(equalTo: footer.topAnchor),
      findBar.topAnchor.constraint(equalTo: source.topAnchor),
      findBar.leadingAnchor.constraint(equalTo: source.leadingAnchor),
      findBar.trailingAnchor.constraint(equalTo: source.trailingAnchor), findHeight,
      findTools.leadingAnchor.constraint(equalTo: findBar.leadingAnchor, constant: 12),
      findTools.trailingAnchor.constraint(equalTo: findBar.trailingAnchor, constant: -12),
      findTools.centerYAnchor.constraint(equalTo: findBar.centerYAnchor),
      findField.heightAnchor.constraint(equalToConstant: 26),
      editor.topAnchor.constraint(equalTo: findBar.bottomAnchor),
      editor.leadingAnchor.constraint(equalTo: source.leadingAnchor),
      editor.trailingAnchor.constraint(equalTo: source.trailingAnchor),
      editor.bottomAnchor.constraint(equalTo: source.bottomAnchor),
    ])
    DispatchQueue.main.async { [weak self] in self?.split.setPosition(280, ofDividerAt: 0) }
  }
  func tool(_ title: String, _ symbol: String, _ action: Selector) -> ToolbarButton {
    ToolbarButton(title, symbol: symbol, target: self, action: action)
  }
  func refreshToolbar() {
    let modal = companion?.modal == true
    centerMinimum?.constant = companion?.aiOpen == true ? 600 : 400
    let enabled = client.connected && !busy && !modal
    for button in toolbarButtons {
      button.isEnabled = enabled
      button.compact = window.frame.width < 1000
    }
    aiButton?.state = companion?.aiSelected == true ? .on : .off
    terminalButton?.state = companion?.terminalSelected == true ? .on : .off
    mode.isEnabled = enabled
    projectButton.isEnabled = enabled
    editor.interactive = !busy && !modal
    browser.outline.isEnabled = !modal
    browser.filter.isEnabled = !modal
  }
  func windowDidResize(_ notification: Notification) { if started { refreshToolbar() } }
  func startWorkspace() {
    guard !started else { return }
    started = true
    setupWorkspaceUI()
    status.stringValue = "Connecting…"
    engine.onRedraw = { [weak self] in self?.editor.redraw($0) }
    engine.onChange = { [weak self] in self?.markChanged() }
    editor.onActivity = { [weak self] in self?.markChanged() }
    engine.onAction = { [weak self] action, args in self?.engineAction(action, args) }
    engine.onExit = { [weak self] message in self?.showFailure(message) }
    client.onEvent = { [weak self] in self?.receive($0) }
    client.onStatus = { [weak self] connected, message in
      guard let self else { return }
      self.refreshStatus()
      if !connected {
        self.engine.lua("vim.bo.modifiable=false")
        self.status.stringValue = "Disconnected · Your pending text is kept locally"
      }
    }
    host.onReady = { [weak self] url in
      self?.hostURL = url
      self?.client.connect(url)
    }
    host.onExit = { [weak self] message in self?.showFailure(message) }
    engine.start(resources: resources, state: URL(fileURLWithPath: state)) { [weak self] result in
      guard let self else { return }
      switch result {
      case .success:
        self.engineLabel.stringValue = "Native · Neovim \(self.engine.version)"
        self.bindCurrent(reset: true)
        self.editor.scheduleResize()
        self.recoverPending()
      case .failure(let error): self.showFailure(error.localizedDescription)
      }
    }
    host.start(resources: resources, workspace: workspaceArgument, state: state)
  }
  func receive(_ event: [String: Any]) {
    guard let type = event["type"] as? String else { return }
    if event["requestId"] != nil
      && ["file_state", "active_file", "file_closed", "control"].contains(type)
    {
      return
    }
    if type != "bootstrap", let scope = event["projectId"] as? String, scope != client.projectId {
      return
    }
    switch type {
    case "bootstrap":
      currentSnapshot = event
      workspace = event["workspacePath"] as? String ?? ""
      projectName = event["workspace"] as? String ?? ""
      projects = event["projects"] as? [[String: Any]] ?? []
      rootFiles = event["files"] as? [[String: Any]] ?? []
      recent = event["recentFiles"] as? [String] ?? []
      let incoming = event["openFiles"] as? [[String: Any]] ?? []
      documents = Dictionary(
        uniqueKeysWithValues: incoming.compactMap { value in
          NativeDocument(value).map { ($0.path, $0) }
        })
      browser.update(project: client.projectId, name: projectName, files: rootFiles)
      updateProjects()
      updateRecent()
      let nextPath = event["activePath"] as? String
      let changesSelection = nextPath != active || boundProject != client.projectId
      setActive(nextPath)
      if !changesSelection && !localDirty { bindCurrent(reset: false) }
      if let first = openArgument, engine.ready {
        openArgument = nil
        openFile(first)
      }
      recoverPending()
      if localDirty { commit(force: true) }
    case "file_state":
      if let value = event["file"] as? [String: Any], let doc = NativeDocument(value) {
        if let old = documents[doc.path], old.revision > doc.revision { break }
        let textChanged = documents[doc.path]?.text != doc.text
        let ownEdit = event["sourceClientId"] as? String == client.clientId
        documents[doc.path] = doc
        if doc.path == active {
          if !ownEdit && !localDirty && !commitInFlight && !editor.hasMarkedText() {
            if textChanged {
              bindCurrent(reset: false)
            } else {
              engine.lua("vim.bo[_G.nimlo.buf].modified=(...)", [doc.dirty])
            }
          }
          refreshStatus()
        }
      }
    case "active_file": setActive(event["path"] as? String)
    case "file_unloaded", "file_closed":
      if let path = event["path"] as? String {
        if path != active || !localDirty { documents.removeValue(forKey: path) }
        if path == active && type == "file_closed" { setActive(nil) }
      }
    case "file_shortcuts":
      recent = event["paths"] as? [String] ?? recent
      updateRecent()
    case "projects_changed":
      projects = event["projects"] as? [[String: Any]] ?? projects
      updateProjects()
    case "terminal_state": currentSnapshot["terminal"] = event["terminal"]
    case "ai_state": currentSnapshot["ai"] = event["ai"]
    case "internet_state": currentSnapshot["internet"] = event["internet"]
    case "control", "session_access": refreshStatus()
    case "error": status.stringValue = event["message"] as? String ?? "Workspace command failed"
    default: break
    }
    testController?.record()
  }
  func setActive(_ path: String?) {
    if path == active && boundProject == client.projectId {
      refreshStatus()
      return
    }
    if localDirty || commitInFlight {
      flush { [weak self] ok in if ok { self?.setActive(path) } }
      return
    }
    active = path
    baseRevision = nil
    baseText = nil
    pendingText = nil
    bindCurrent(reset: true)
    refreshStatus()
    if let path { browser.select(path) }
  }
  func bindCurrent(reset: Bool) {
    guard engine.ready else { return }
    boundProject = client.projectId
    let doc = active.flatMap { documents[$0] }
    engine.bind(
      name: doc.map { workspace + "/" + $0.path } ?? "", text: doc?.text ?? "",
      dirty: doc?.dirty ?? false, editable: doc != nil && client.connected && !conflictOpen,
      reset: reset
    ) { [weak self] result in
      if case .failure(let error) = result { self?.status.stringValue = error.localizedDescription }
    }
    if reset { companion?.selectFile(project: client.projectId, path: active) }
    if reset && window.attachedSheet == nil && findBar.isHidden {
      window.makeFirstResponder(editor)
    }
    if let first = openArgument, client.connected {
      openArgument = nil
      openFile(first)
    }
  }
  func markChanged() {
    guard let active, let doc = documents[active], !quitting else { return }
    if !localDirty {
      baseRevision = doc.revision
      baseText = doc.text
    }
    localDirty = true
    mutation += 1
    commitWork?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.commit() }
    commitWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: work)
    refreshStatus()
  }
  func flush(_ done: @escaping (Bool) -> Void) {
    guard !editor.hasMarkedText() else {
      status.stringValue = "Finish composing text before switching or closing."
      done(false)
      return
    }
    guard started, engine.ready, active != nil else {
      done(true)
      return
    }
    flushWaiters.append(done)
    commitWork?.cancel()
    commit(force: true)
  }
  private func settle(_ ok: Bool) {
    let callbacks = flushWaiters
    flushWaiters = []
    for callback in callbacks { callback(ok) }
  }
  func commit(force: Bool = false) {
    guard !capturing, !commitInFlight else { return }
    guard let path = active, let doc = documents[path], engine.ready else {
      settle(true)
      return
    }
    guard !editor.hasMarkedText() else { return }
    if !localDirty && !force {
      settle(true)
      return
    }
    capturing = true
    let scope = client.projectId
    let revision = baseRevision ?? doc.revision
    let original = baseText ?? doc.text
    let serial = mutation
    engine.contents { [weak self] result in
      guard let self else { return }
      self.capturing = false
      guard self.active == path, self.client.projectId == scope else {
        self.settle(false)
        return
      }
      switch result {
      case .failure(let error):
        self.status.stringValue = error.localizedDescription
        self.settle(false)
      case .success(let text):
        if text == original {
          if self.mutation != serial {
            self.commit(force: true)
            return
          }
          self.localDirty = false
          self.baseText = nil
          self.baseRevision = nil
          self.pendingText = nil
          if self.documents[path]?.text != text {
            self.bindCurrent(reset: false)
          } else {
            try? FileManager.default.removeItem(at: self.draftURL)
          }
          self.settle(true)
          self.refreshStatus()
          return
        }
        self.localDirty = true
        self.pendingText = text
        do { try self.writePending(path: path, text: text, revision: revision) } catch {
          self.status.stringValue = "Cannot protect the pending copy: " + error.localizedDescription
          self.settle(false)
          return
        }
        guard text.utf8.count <= 1024 * 1024, !text.contains("\0") else {
          self.status.stringValue = "File limit reached · Export a copy before trimming this text"
          self.settle(false)
          return
        }
        guard self.client.connected else {
          self.status.stringValue = "Pending copy protected · Reconnect to continue"
          self.settle(false)
          return
        }
        self.commitInFlight = true
        self.client.command("edit_file", ["path": path, "baseRevision": revision, "content": text])
        { [weak self] reply in
          guard let self else { return }
          self.commitInFlight = false
          guard self.active == path, self.client.projectId == scope else {
            self.settle(false)
            return
          }
          switch reply {
          case .success(let value):
            if let raw = value["file"] as? [String: Any], let saved = NativeDocument(raw) {
              self.documents[path] = saved
              self.baseRevision = saved.revision
              self.baseText = saved.text
            }
            if self.mutation == serial {
              self.localDirty = false
              self.pendingText = nil
              self.baseText = nil
              self.baseRevision = nil
              try? FileManager.default.removeItem(at: self.draftURL)
              // Neovim already owns these edits. Reapplying an acknowledgement
              // can overwrite input whose on_lines notification is still queued.
              self.refreshStatus()
              self.settle(true)
            } else {
              self.commit(force: true)
            }
          case .failure(let error):
            self.status.stringValue = error.localizedDescription
            self.settle(false)
            if self.client.connected { self.reviewPending(error.localizedDescription) }
          }
        }
      }
    }
  }
  func writePending(path: String, text: String, revision: Int) throws {
    let record: [String: Any] = [
      "version": 1, "workspace": workspace, "projectId": client.projectId, "path": path,
      "content": text, "baseRevision": revision,
    ]
    let data = try JSONSerialization.data(withJSONObject: record)
    try data.write(to: draftURL, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: draftURL.path)
  }
  func reviewPending(_ message: String) {
    guard !conflictOpen, let path = active, let text = pendingText else { return }
    conflictOpen = true
    let alert = NSAlert()
    alert.messageText = "Your pending text is protected"
    alert.informativeText =
      message
      + "\nKeep your version, use the current workspace version, or export a copy before deciding."
    for title in ["Keep my changes", "Use workspace version", "Export copy…", "Cancel"] {
      alert.addButton(withTitle: title)
    }
    alert.beginSheetModal(for: window) { [weak self] answer in
      guard let self else { return }
      self.conflictOpen = false
      if answer == .alertFirstButtonReturn {
        self.client.command("open_file", ["path": path]) { result in
          if case .success(let reply) = result, let value = reply["file"] as? [String: Any],
            let doc = NativeDocument(value)
          {
            self.documents[path] = doc
            self.baseRevision = doc.revision
            self.baseText = doc.text
            self.localDirty = true
            self.commit(force: true)
          }
        }
      } else if answer == .alertSecondButtonReturn {
        self.localDirty = false
        self.pendingText = nil
        self.baseText = nil
        self.baseRevision = nil
        try? FileManager.default.removeItem(at: self.draftURL)
        self.bindCurrent(reset: false)
        self.refreshStatus()
      } else if answer.rawValue == NSApplication.ModalResponse.alertThirdButtonReturn.rawValue {
        self.export(text, name: (path as NSString).lastPathComponent)
      }
    }
  }
  func recoverPending() {
    guard !recoveryChecked, client.connected, engine.ready else { return }
    recoveryChecked = true
    guard let data = try? Data(contentsOf: draftURL), data.count < 8 * 1024 * 1024,
      let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let path = value["path"] as? String, let content = value["content"] as? String,
      let root = value["workspace"] as? String
    else { return }
    let alert = NSAlert()
    alert.messageText = "Recover pending native text?"
    alert.informativeText =
      "An unacknowledged copy of \(path) was kept by Nimlo. The workspace recovery remains available separately."
    for title in ["Recover", "Export copy…", "Discard pending copy"] {
      alert.addButton(withTitle: title)
    }
    alert.beginSheetModal(for: window) { [weak self] answer in
      guard let self else { return }
      if answer == .alertSecondButtonReturn {
        self.export(content, name: (path as NSString).lastPathComponent) { _ in
          self.recoveryChecked = false
          DispatchQueue.main.async { self.recoverPending() }
        }
        return
      }
      if answer == .alertThirdButtonReturn {
        try? FileManager.default.removeItem(at: self.draftURL)
        return
      }
      let restore = {
        self.client.command("open_file", ["path": path]) { result in
          guard case .success(let reply) = result, let value = reply["file"] as? [String: Any],
            let doc = NativeDocument(value)
          else {
            self.showFailure("Cannot reopen the pending file. Its copy remains protected.")
            return
          }
          self.active = path
          self.documents[path] = doc
          self.baseRevision = doc.revision
          self.baseText = doc.text
          self.localDirty = true
          self.pendingText = content
          self.mutation += 1
          self.engine.bind(
            name: self.workspace + "/" + path, text: content, dirty: true, editable: true,
            reset: true
          ) { _ in self.commit(force: true) }
        }
      }
      if root == self.workspace {
        restore()
      } else if let project = self.projects.first(where: { $0["path"] as? String == root }),
        let id = project["id"] as? String
      {
        self.client.command("select_project", ["targetProjectId": id]) { result in
          if case .success = result { restore() }
        }
      } else {
        self.showFailure("Attach the project folder before recovering this copy: " + root)
      }
    }
  }
  func refreshStatus() {
    refreshToolbar()
    let doc = active.flatMap { documents[$0] }
    fileLabel.stringValue = active.map { ($0 as NSString).lastPathComponent } ?? "Choose a file"
    fileLabel.toolTip = active
    window.title =
      (active.map { ($0 as NSString).lastPathComponent + " — " } ?? "") + "Nimlo"
    window.isDocumentEdited = (doc?.dirty ?? false) || localDirty
    status.stringValue =
      (!client.connected
        ? "Connecting…"
        : localDirty
          ? "Pending changes…"
          : doc?.conflict != nil
            ? "Disk conflict · Save to review"
            : doc?.dirty == true ? "Unsaved · Recovery protected" : active ?? projectName)
  }
  func operation(_ action: @escaping (@escaping () -> Void) -> Void) {
    guard !busy, !conflictOpen, companion?.modal != true, window.attachedSheet == nil else {
      return
    }
    let scope = client.projectId
    let generation = client.generation
    busy = true
    refreshToolbar()
    editor.interactive = false
    flush { [weak self] ok in
      guard let self else { return }
      if ok && self.client.projectId == scope && self.client.generation == generation {
        action { self.finishOperation() }
      } else {
        self.busy = false
        self.queuedFile = nil
        self.projectButton.isEnabled = true
        self.refreshToolbar()
      }
    }
  }
  func finishOperation() {
    busy = false
    projectButton.isEnabled = true
    refreshToolbar()
    if let path = queuedFile {
      queuedFile = nil
      DispatchQueue.main.async { [weak self] in self?.openFile(path) }
    }
  }
  func openFile(_ path: String) {
    guard started, client.connected else { return }
    if busy {
      queuedFile = path
      return
    }
    operation { [weak self] done in
      guard let self else {
        done()
        return
      }
      self.client.command("open_file", ["path": path]) { result in
        if case .failure(let error) = result { self.showFailure(error.localizedDescription) }
        done()
      }
    }
  }
  @objc func saveFile(_ sender: Any?) {
    if routeEditor("save") { return }
    operation { [weak self] done in
      guard let self, let path = self.active, let doc = self.documents[path] else {
        done()
        return
      }
      if doc.conflict != nil {
        self.resolveDisk(doc, done: done)
        return
      }
      self.client.command("save_file", ["path": path, "revision": doc.revision]) { result in
        if case .failure(let error) = result { self.showFailure(error.localizedDescription) }
        done()
      }
    }
  }
  func resolveDisk(_ doc: NativeDocument, done: @escaping () -> Void) {
    let scope = client.projectId
    let generation = client.generation
    let alert = NSAlert()
    alert.messageText = "The file changed on disk"
    alert.informativeText =
      "Save the editor version, or use the current disk version? Both versions stay protected until you choose."
    for title in ["Save editor version", "Use disk version", "Cancel"] {
      alert.addButton(withTitle: title)
    }
    alert.beginSheetModal(for: window) { [weak self] choice in
      guard let self, choice != .alertThirdButtonReturn else {
        done()
        return
      }
      guard self.client.projectId == scope, self.client.generation == generation else {
        done()
        return
      }
      self.client.command(
        "resolve_conflict",
        [
          "path": doc.path, "revision": doc.revision,
          "diskRevision": doc.conflict?["diskRevision"] ?? "",
          "resolution": choice == .alertFirstButtonReturn ? "buffer" : "disk",
        ]
      ) { result in
        guard self.client.projectId == scope else {
          done()
          return
        }
        guard case .success(let reply) = result else {
          if case .failure(let error) = result { self.showFailure(error.localizedDescription) }
          done()
          return
        }
        if choice == .alertFirstButtonReturn, let file = reply["file"] as? [String: Any],
          let revision = file["revision"] as? Int
        {
          self.client.command("save_file", ["path": doc.path, "revision": revision]) { result in
            if case .failure(let error) = result { self.showFailure(error.localizedDescription) }
            done()
          }
        } else {
          done()
        }
      }
    }
  }
  @objc func undo(_ sender: Any?) { if !routeEditor("undo") { history(false) } }
  @objc func redo(_ sender: Any?) { if !routeEditor("redo") { history(true) } }
  func history(_ redo: Bool) {
    operation { [weak self] done in
      guard let self, let path = self.active, let doc = self.documents[path] else {
        done()
        return
      }
      self.client.command(
        redo ? "redo_file" : "undo_file", ["path": path, "revision": doc.revision]
      ) { result in
        if case .failure(let error) = result {
          self.status.stringValue = error.localizedDescription
        }
        done()
      }
    }
  }
  @objc func closeFile(_ sender: Any?) {
    if routeEditor("closeFile") { return }
    operation { [weak self] done in
      guard let self, let path = self.active, let doc = self.documents[path] else {
        done()
        return
      }
      let scope = self.client.projectId
      let generation = self.client.generation
      let close: (Bool) -> Void = { discard in
        guard self.client.projectId == scope, self.client.generation == generation else {
          done()
          return
        }
        self.client.command(
          "close_file",
          [
            "path": path, "revision": self.documents[path]?.revision ?? doc.revision,
            "discard": discard,
          ]
        ) { result in
          if case .failure(let error) = result { self.showFailure(error.localizedDescription) }
          done()
        }
      }
      if !doc.dirty && doc.conflict == nil {
        close(false)
        return
      }
      let alert = NSAlert()
      alert.messageText = "Save changes before closing?"
      alert.informativeText = path
      for title in ["Save", "Don’t Save", "Cancel"] { alert.addButton(withTitle: title) }
      alert.beginSheetModal(for: self.window) { answer in
        guard self.client.projectId == scope, self.client.generation == generation,
          let current = self.documents[path], current.revision == doc.revision
        else {
          self.showFailure(
            "This file changed while the close dialog was open. Review it before closing.")
          done()
          return
        }
        if answer == .alertThirdButtonReturn {
          done()
        } else if answer == .alertSecondButtonReturn {
          close(true)
        } else {
          self.client.command("save_file", ["path": path, "revision": doc.revision]) { result in
            if case .success = result {
              close(false)
            } else if case .failure(let error) = result {
              self.showFailure(error.localizedDescription)
              done()
            }
          }
        }
      }
    }
  }
  func saveAndClose() {
    operation { [weak self] done in
      guard let self, let path = self.active, let doc = self.documents[path] else {
        done()
        return
      }
      let scope = self.client.projectId
      self.client.command("save_file", ["path": path, "revision": doc.revision]) { result in
        guard self.client.projectId == scope else {
          done()
          return
        }
        guard case .success(let reply) = result, let value = reply["file"] as? [String: Any],
          let revision = value["revision"] as? Int
        else {
          if case .failure(let error) = result { self.showFailure(error.localizedDescription) }
          done()
          return
        }
        self.client.command("close_file", ["path": path, "revision": revision, "discard": false]) {
          result in
          if case .failure(let error) = result { self.showFailure(error.localizedDescription) }
          done()
        }
      }
    }
  }
  @objc func newFile(_ sender: Any?) {
    if routeEditor("newFile") { return }
    guard client.connected, window.attachedSheet == nil else { return }
    let scope = client.projectId
    let generation = client.generation
    let a = NSAlert()
    a.messageText = "New file · " + projectName
    a.informativeText = "Enter a path relative to this project."
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 26))
    field.placeholderString = "src/new-file.txt"
    a.accessoryView = field
    a.addButton(withTitle: "Create")
    a.addButton(withTitle: "Cancel")
    a.window.initialFirstResponder = field
    a.beginSheetModal(for: window) { [weak self] choice in
      guard let self, choice == .alertFirstButtonReturn else { return }
      guard self.client.projectId == scope, self.client.generation == generation else { return }
      let path = field.stringValue.trimmingCharacters(in: .whitespaces)
      // AppKit removes attachedSheet after this completion returns.
      DispatchQueue.main.async {
        guard self.client.projectId == scope, self.client.generation == generation else { return }
        self.operation { done in
          self.client.command("create_file", ["path": path]) { result in
            if case .failure(let error) = result { self.showFailure(error.localizedDescription) }
            done()
          }
        }
      }
    }
    a.window.makeFirstResponder(field)
  }
  @objc func chooseFolder(_ sender: Any?) {
    guard window?.attachedSheet == nil else { return }
    let p = NSOpenPanel()
    p.canChooseDirectories = true
    p.canChooseFiles = false
    p.allowsMultipleSelection = false
    p.prompt = "Open folder"
    p.beginSheetModal(for: window) { [weak self] choice in
      guard let self, choice == .OK, let url = p.url else { return }
      DispatchQueue.main.async {
        if self.started {
          self.operation { done in
            self.client.command("add_project", ["path": url.path]) { result in
              if case .failure(let error) = result { self.showFailure(error.localizedDescription) }
              done()
            }
          }
        } else {
          self.workspaceArgument = url.path
          self.startWorkspace()
        }
      }
    }
  }
  func updateProjects() {
    projectButton.removeAllItems()
    for project in projects {
      projectButton.addItem(withTitle: project["name"] as? String ?? "Project")
      projectButton.lastItem?.representedObject = project["id"]
      projectButton.lastItem?.toolTip = project["path"] as? String
    }
    if let i = projects.firstIndex(where: { $0["id"] as? String == client.projectId }) {
      projectButton.selectItem(at: i)
    }
  }
  @objc func projectChanged(_ sender: Any?) {
    guard let id = projectButton.selectedItem?.representedObject as? String, id != client.projectId
    else { return }
    operation { [weak self] done in
      self?.client.command("select_project", ["targetProjectId": id]) { [weak self] result in
        if case .failure(let error) = result {
          self?.showFailure(error.localizedDescription)
          self?.updateProjects()
        }
        done()
      }
    }
  }
  @objc func removeProject(_ sender: Any?) {
    guard projects.count > 1 else { return }
    let a = NSAlert()
    let scope = client.projectId
    let generation = client.generation
    a.messageText = "Remove this project from the session?"
    a.informativeText = "Files on disk are kept."
    a.addButton(withTitle: "Remove")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { [weak self] choice in
      guard let self, choice == .alertFirstButtonReturn else { return }
      DispatchQueue.main.async {
        guard self.client.projectId == scope, self.client.generation == generation else { return }
        self.operation { done in
          self.client.command("remove_project", ["targetProjectId": scope]) { result in
            if case .failure(let error) = result { self.showFailure(error.localizedDescription) }
            done()
          }
        }
      }
    }
  }
  func updateRecent() {
    guard recentMenu != nil else { return }
    recentMenu.removeAllItems()
    for path in recent {
      let item = recentMenu.addItem(
        withTitle: path, action: #selector(openRecent), keyEquivalent: "")
      item.target = self
      item.representedObject = path
    }
  }
  @objc func openRecent(_ sender: NSMenuItem) {
    if let path = sender.representedObject as? String { openFile(path) }
  }
  @objc func findFile(_ sender: Any?) {
    if routeEditor("findFile") { return }
    guard client.connected, !busy, palette == nil, window.attachedSheet == nil else { return }
    let picker = FilePalette(client: client, name: projectName, files: rootFiles)
    palette = picker
    picker.onOpen = { [weak self] in self?.openFile($0) }
    picker.onClose = { [weak self] in
      self?.palette = nil
      self?.window.makeFirstResponder(self?.editor)
    }
    picker.show(window)
  }
  @objc func findInFile(_ sender: Any?) {
    if routeEditor("findInFile") { return }
    guard active != nil else { return }
    findBar.isHidden = false
    findHeight.constant = 40
    window.makeFirstResponder(findField)
  }
  func controlTextDidChange(_ notification: Notification) {
    if notification.object as AnyObject? === findField { find(false) }
  }
  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    if NSStringFromSelector(selector) == "cancelOperation:" {
      closeFind(nil)
      return true
    }
    return false
  }
  func find(_ backwards: Bool) {
    guard !findField.stringValue.isEmpty else { return }
    engine.lua("return _G.nimlo.find(...)", [findField.stringValue, backwards])
  }
  @objc func findNext(_ sender: Any?) {
    if routeEditor("findNext") { return }
    find(false)
  }
  @objc func findPrevious(_ sender: Any?) {
    if routeEditor("findPrevious") { return }
    find(true)
  }
  @objc func closeFind(_ sender: Any?) {
    findHeight.constant = 0
    findBar.isHidden = true
    window.makeFirstResponder(editor)
    if mode.selectedSegment == 0 { engine.mode(false) }
    editor.scheduleResize()
  }
  @objc func modeChanged(_ sender: Any?) {
    editor.vimEnabled = mode.selectedSegment == 1
    engine.mode(mode.selectedSegment == 1)
    window.makeFirstResponder(editor)
  }
  func engineAction(_ action: String, _ args: [Any]) {
    engineActionInProgress = true
    defer { engineActionInProgress = false }
    switch action {
    case "save": saveFile(nil)
    case "close": closeFile(nil)
    case "undo": undo(nil)
    case "redo": redo(nil)
    case "saveClose": saveAndClose()
    case "open":
      if let path = args.first as? String {
        if path.hasPrefix(workspace + "/") {
          openFile(String(path.dropFirst(workspace.count + 1)))
        } else {
          openFile(path)
        }
      }
    default: break
    }
  }
  func routeEditor(_ action: String) -> Bool {
    if engineActionInProgress { return false }
    if ["undo", "redo"].contains(action), let companion, companion.ownsResponder() {
      companion.invokeEditor(action)
      return true
    }
    if ["undo", "redo"].contains(action), let responder = window?.firstResponder,
      responder !== editor
    {
      if action == "undo" { responder.undoManager?.undo() } else { responder.undoManager?.redo() }
      return true
    }
    return false
  }
  func showTool(_ section: String) {
    operation { [weak self] done in
      guard let self, let url = self.hostURL else {
        done()
        return
      }
      if self.companion == nil {
        let c = NativeCompanion(launch: url)
        c.onError = { [weak self] in self?.showFailure($0) }
        c.onLayout = { [weak self] in self?.refreshToolbar() }
        c.onClosed = { [weak self] in
          self?.refreshToolbar()
          self?.window.makeFirstResponder(self?.editor)
        }
        c.onOpenFile = { [weak self] project, path, line in
          self?.openToolFile(project: project, path: path, line: line)
        }
        self.companion = c
      }
      self.companion?.show(
        section, project: self.client.projectId, path: self.active, in: self.window,
        host: self.center)
      done()
    }
  }
  func openToolFile(project: String, path: String, line: Int) {
    guard projects.contains(where: { $0["id"] as? String == project }) else { return }
    operation { [weak self] done in
      guard let self else {
        done()
        return
      }
      let open = {
        self.client.command("open_file", ["path": path]) { result in
          if case .success = result {
            self.engine.lua("_G.nimlo.goto_line(...)", [line])
            self.window.makeFirstResponder(self.editor)
          } else if case .failure(let error) = result {
            self.showFailure(error.localizedDescription)
          }
          done()
        }
      }
      if project == self.client.projectId {
        open()
      } else {
        self.client.command("select_project", ["targetProjectId": project]) { result in
          if case .success = result { open() } else { done() }
        }
      }
    }
  }
  @objc func showAI(_ sender: Any?) { showTool("ai") }
  @objc func showTerminal(_ sender: Any?) { showTool("terminal") }
  @objc func showSharing(_ sender: Any?) { showTool("sharing") }
  @objc func showSettings(_ sender: Any?) { showTool("settings") }
  @objc func showPermissions(_ sender: Any?) { showTool("permissions") }
  @objc func showDrafts(_ sender: Any?) { showTool("drafts") }
  @objc func openBrowser(_ sender: Any?) { if let url = hostURL { NSWorkspace.shared.open(url) } }
  func export(_ text: String, name: String, completion: @escaping (Bool) -> Void = { _ in }) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = (name as NSString).lastPathComponent + ".recovery.txt"
    panel.title = "Export pending copy"
    panel.beginSheetModal(for: window) { [weak self] choice in
      guard choice == .OK, let url = panel.url else {
        completion(false)
        return
      }
      do {
        try Data(text.utf8).write(to: url, options: [.withoutOverwriting])
        completion(true)
      } catch {
        self?.showFailure(error.localizedDescription)
        completion(false)
      }
    }
  }
  @objc func exportPending(_ sender: Any?) {
    engine.contents { [weak self] result in
      if case .success(let text) = result {
        self?.export(text, name: self?.active ?? "native-draft")
      }
    }
  }
  func showFailure(_ message: String) {
    if testDirectory != nil {
      status.stringValue = message
      testController?.record(error: message)
      return
    }
    let alert = NSAlert()
    alert.messageText = "Nimlo"
    alert.informativeText = message
    if let window, window.attachedSheet == nil {
      alert.beginSheetModal(for: window) { _ in }
    } else if window == nil {
      alert.runModal()
      NSApp.terminate(nil)
    }
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    NSApp.terminate(nil)
    return false
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if quitting || !started { return .terminateNow }
    guard !checkingQuit, window.attachedSheet == nil else { return .terminateCancel }
    checkingQuit = true
    quitPhase = "flush"
    testController?.record()
    // Continue the ordinary AppKit event loop while pipe/network callbacks
    // flush. A second terminate request commits the already-prepared quit.
    DispatchQueue.main.async { [weak self] in
      self?.flush { [weak self] ok in
        guard let self else { return }
        self.quitPhase = "flushed-\(ok)"
        self.testController?.record()
        guard ok else {
          self.checkingQuit = false
          return
        }
        let finish = { (ready: Bool) in
          guard ready else {
            self.checkingQuit = false
            self.showFailure("Finish pending browser edits before quitting.")
            return
          }
          self.confirmQuit()
        }
        if let companion = self.companion { companion.prepareQuit(finish) } else { finish(true) }
      }
    }
    return .terminateCancel
  }
  func sessionWork(_ done: @escaping (Bool, Bool) -> Void) {
    let ids = projects.compactMap { $0["id"] as? String }
    let ownViews = companion?.web == nil ? 1 : 2
    func inspect(_ index: Int, _ running: Bool) {
      if index >= ids.count {
        done(running, true)
        return
      }
      client.snapshot(project: ids[index]) { result in
        guard case .success(let value) = result else {
          done(running, false)
          return
        }
        let terminal = value["terminal"] as? [String: Any]
        let ai = value["ai"] as? [String: Any]
        let internet = value["internet"] as? [String: Any]
        let peers =
          (value["clients"] as? [[String: Any]] ?? []).filter { $0["connected"] as? Bool == true }
          .count > ownViews
        let active =
          terminal?["running"] as? Bool == true
          || ["starting", "running", "awaiting_approval", "cancelling"].contains(
            ai?["status"] as? String ?? "")
          || internet?["status"] as? String == "ready" || peers
        inspect(index + 1, running || active)
      }
    }
    inspect(0, false)
  }
  func confirmQuit() {
    quitPhase = "confirm"
    testController?.record()
    sessionWork { [weak self] running, verified in
      guard let self else { return }
      guard verified else {
        self.checkingQuit = false
        self.showFailure(
          "Reconnect to the workspace before quitting. Pending copies remain protected.")
        return
      }
      if running && self.testDirectory == nil {
        let alert = NSAlert()
        alert.messageText = "Stop the session and quit?"
        alert.informativeText =
          "Recovery remains available. Running shells, AI jobs and paired connections end when the host stops."
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: self.window) { [weak self] choice in
          if choice == .alertFirstButtonReturn {
            self?.finishQuit()
          } else {
            self?.checkingQuit = false
          }
        }
      } else {
        self.finishQuit()
      }
    }
  }
  @objc func closeProject(_ sender: Any?) {
    operation { [weak self] done in
      guard let self else {
        done()
        return
      }
      let prepare = { (ready: Bool) in
        guard ready else {
          self.showFailure("Finish pending companion edits before closing this project.")
          done()
          return
        }
        self.sessionWork { running, verified in
          guard verified else {
            self.showFailure("Reconnect to the host before closing the project.")
            done()
            return
          }
          let close = { self.finishClosingProject(done) }
          if running && self.testDirectory == nil {
            let alert = NSAlert()
            alert.messageText = "Close the project session?"
            alert.informativeText =
              "Recovery remains available. Running shells, AI jobs and paired connections will stop."
            alert.addButton(withTitle: "Close Project")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: self.window) { choice in
              if choice == .alertFirstButtonReturn { close() } else { done() }
            }
          } else {
            close()
          }
        }
      }
      if let companion = self.companion { companion.prepareQuit(prepare) } else { prepare(true) }
    }
  }
  func finishClosingProject(_ done: @escaping () -> Void) {
    do {
      let preference = URL(fileURLWithPath: state).appendingPathComponent("last-project.json")
      if FileManager.default.fileExists(atPath: preference.path) {
        try FileManager.default.removeItem(at: preference)
      }
    } catch {
      showFailure(error.localizedDescription)
      done()
      return
    }
    companion?.closePrepared()
    companion = nil
    client.stop()
    engine.stop()
    host.stop()
    status.stringValue = "Closing project…"
    let until = Date().addingTimeInterval(8)
    func wait() {
      if host.process?.isRunning == true || engine.process?.isRunning == true {
        if Date() > until {
          showFailure("The previous session is still stopping. Try closing the project again.")
          done()
          return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { wait() }
        return
      }
      done()
      started = false
      busy = false
      workspaceArgument = nil
      openArgument = nil
      workspace = ""
      projectName = ""
      active = nil
      documents = [:]
      projects = []
      recent = []
      rootFiles = []
      boundProject = ""
      recoveryChecked = false
      currentSnapshot = [:]
      client = WorkspaceClient()
      engine = Neovim()
      host = NativeHost()
      editor = EditorView()
      browser = FileBrowser()
      projectButton = NSPopUpButton()
      fileLabel = NSTextField(labelWithString: "")
      status = NSTextField(labelWithString: "")
      engineLabel = NSTextField(labelWithString: "")
      mode = EditorModeControl()
      toolbarButtons = []
      aiButton = nil
      terminalButton = nil
      centerMinimum = nil
      findBar = NSView()
      findField = NSSearchField()
      split = NSSplitView()
      center = EditorWorkspace()
      findHeight = nil
      window.title = "Nimlo"
      window.isDocumentEdited = false
      updateRecent()
      welcome()
      testController?.record()
    }
    wait()
  }
  func finishQuit() {
    quitPhase = "stop"
    testController?.record()
    quitting = true
    companion?.closePrepared()
    client.stop()
    engine.stop()
    host.stop()
    NSApp.terminate(nil)
  }
  func applicationWillTerminate(_ notification: Notification) {
    updateMonitor?.stop()
    testController?.stop()
    client.stop()
    engine.stop()
    host.stop()
    if lockFD >= 0 {
      flock(lockFD, LOCK_UN)
      Darwin.close(lockFD)
    }
  }
  func setupMenus() {
    let menu = NSMenu()
    NSApp.mainMenu = menu
    func group(_ title: String) -> NSMenu {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let sub = NSMenu(title: title)
      item.submenu = sub
      menu.addItem(item)
      return sub
    }
    func add(
      _ group: NSMenu, _ title: String, _ action: Selector, _ key: String = "",
      _ flags: NSEvent.ModifierFlags = [.command]
    ) {
      let item = group.addItem(withTitle: title, action: action, keyEquivalent: key)
      item.target = self
      item.keyEquivalentModifierMask = flags
    }
    let app = group("Nimlo")
    let about = app.addItem(
      withTitle: "About Nimlo",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    about.target = NSApp
    add(app, "Check for Updates…", #selector(checkForUpdates))
    app.addItem(.separator())
    let hide = app.addItem(
      withTitle: "Hide Nimlo", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    hide.target = NSApp
    let quit = app.addItem(
      withTitle: "Quit Nimlo", action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q")
    quit.target = NSApp
    let file = group("File")
    add(file, "Open Folder…", #selector(chooseFolder), "o")
    add(file, "New File…", #selector(newFile), "n")
    add(file, "Find File…", #selector(findFile), "p")
    let recentItem = NSMenuItem(title: "Recent Files", action: nil, keyEquivalent: "")
    recentMenu = NSMenu()
    recentItem.submenu = recentMenu
    file.addItem(recentItem)
    file.addItem(.separator())
    add(file, "Save", #selector(saveFile), "s")
    add(file, "Close File", #selector(closeFile), "w")
    add(file, "Close Project", #selector(closeProject), "w", [.command, .shift])
    add(file, "Export Pending Copy…", #selector(exportPending))
    file.addItem(.separator())
    add(file, "Remove Project from Session…", #selector(removeProject))
    let edit = group("Edit")
    add(edit, "Undo", #selector(undo), "z")
    add(edit, "Redo", #selector(redo), "z", [.command, .shift])
    edit.addItem(.separator())
    for (title, action, key) in [
      ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"),
      ("Select All", "selectAll:", "a"),
    ] { edit.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key) }
    edit.addItem(.separator())
    add(edit, "Find in File…", #selector(findInFile), "f")
    add(edit, "Find Next", #selector(findNext), "g")
    add(edit, "Find Previous", #selector(findPrevious), "g", [.command, .shift])
    let workspace = group("Workspace")
    add(workspace, "AI", #selector(showAI), "1", [.command, .option])
    add(workspace, "Terminal", #selector(showTerminal), "`", [.control])
    add(workspace, "Pair a Device…", #selector(showSharing))
    add(workspace, "Session Permissions…", #selector(showPermissions))
    add(workspace, "AI Settings…", #selector(showSettings), ",")
    add(workspace, "Device Drafts…", #selector(showDrafts))
    add(workspace, "Open Browser Workspace", #selector(openBrowser))
  }
  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    if item.action == #selector(checkForUpdates) {
      return !quitting && updateMonitor != nil && updateMonitor?.checking == false && window?.attachedSheet == nil && companion?.modal != true
    }
    if companion?.modal == true {
      return [#selector(undo), #selector(redo)].contains(item.action)
        && companion?.ownsResponder() == true
    }
    if [#selector(chooseFolder)].contains(item.action) { return !busy }
    if [
      #selector(saveFile), #selector(closeFile), #selector(undo), #selector(redo),
      #selector(findInFile), #selector(findNext), #selector(findPrevious), #selector(exportPending),
    ].contains(item.action) {
      return client.connected && active != nil && !busy
    }
    if item.action == #selector(closeProject) { return started && client.connected && !busy }
    if item.action == #selector(removeProject) { return projects.count > 1 && !busy }
    return !started || client.connected
  }
}
