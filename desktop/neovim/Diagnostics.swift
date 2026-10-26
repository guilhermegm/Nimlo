import AppKit
import WebKit

// A local, explicitly enabled fixture driver. The directory must already be
// owner-only. There is no web-facing command bridge and no normal-app timer.
final class NativeDiagnostics {
  weak var app: NativeApp?
  let directory: URL
  var timer: Timer?, seen = Set<String>(), errors: [String] = [], lastText = "", reading = false
  var lastUpdateURL = ""
  init?(app: NativeApp, directory: String) {
    let url = URL(fileURLWithPath: directory)
    guard let a = try? FileManager.default.attributesOfItem(atPath: url.path),
      a[.type] as? FileAttributeType == .typeDirectory,
      (a[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
      (a[.posixPermissions] as? NSNumber)?.intValue == 0o700
    else { return nil }
    self.app = app
    self.directory = url
    // Explicit private fixtures never contact GitHub or open a real browser.
    app.updateMonitor?.manualInterval = 0
    app.updateMonitor?.fetch = { callback in
      DispatchQueue.main.async { callback(.failure(.network)) }; return {}
    }
    app.updatePageOpener = { [weak self] page in self?.lastUpdateURL = page.absoluteString; return true }
    try? FileManager.default.createDirectory(
      at: url.appendingPathComponent("responses"), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
  }
  func start() {
    timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
      self?.poll()
    }
    record()
  }
  func stop() {
    timer?.invalidate()
    timer = nil
  }
  func record(error: String? = nil) {
    if let error { errors.append(error) }
    guard let app else { return }
    if app.engine.ready && !reading {
      reading = true
      app.engine.contents { [weak self] result in
        guard let self else { return }
        self.reading = false
        if case .success(let text) = result { self.lastText = text }
        self.writeStatus()
      }
    } else {
      writeStatus()
    }
  }
  private func writeStatus() {
    guard let app else { return }
    let value: [String: Any] = [
      "ready": app.client.connected && app.engine.ready, "welcome": !app.started, "pid": getpid(),
      "hostPid": app.host.process?.processIdentifier ?? 0,
      "neovimPid": app.engine.process?.processIdentifier ?? 0, "engineVersion": app.engine.version,
      "projectId": app.client.projectId, "workspace": app.workspace,
      "active": app.active as Any? ?? NSNull(), "text": lastText,
      "dirty": app.active.flatMap { app.documents[$0]?.dirty } ?? false,
      "pending": app.localDirty || app.commitInFlight, "busy": app.busy, "quitPhase": app.quitPhase,
      "capturing": app.capturing, "flushWaiters": app.flushWaiters.count,
      "nativePendingFile": FileManager.default.fileExists(atPath: app.draftURL.path),
      "status": app.status.stringValue, "sheet": app.window?.attachedSheet != nil,
      "companion": app.companion?.web != nil,
      "toolsWindowNumber": app.companion?.web?.window?.windowNumber ?? 0,
      "aiOpen": app.companion?.aiOpen ?? false,
      "terminalOpen": app.companion?.terminalOpen ?? false,
      "toolsModal": app.companion?.modal ?? false,
      "toolOverlays": app.companion?.web?.overlays.count ?? 0,
      "editorWidth": app.editor.bounds.width, "editorHeight": app.editor.bounds.height,
      "toolbarCompact": app.toolbarButtons.first?.compact ?? false,
      "mainWindowCount": NSApp.windows.filter {
        $0.isVisible && $0.sheetParent == nil && !($0 is NSPanel)
      }.count, "palette": app.palette?.rows ?? [], "errors": errors,
      "windowNumber": app.window?.windowNumber ?? 0, "nativeRows": app.browser.outline.numberOfRows,
      "gridRows": app.editor.rows, "gridColumns": app.editor.columns,
      "mode": app.editor.modeName, "vim": app.mode.selectedSegment == 1,
      "appActive": NSApp.isActive,
      "keyWindow": NSApp.keyWindow?.title ?? "",
      "mainWindow": NSApp.mainWindow?.title ?? "",
      "responder": app.window?.firstResponder.map { String(describing: type(of: $0)) } ?? "",
      "selectAllTarget": NSApp.target(forAction: NSSelectorFromString("selectAll:")).map {
        String(describing: type(of: $0))
      } ?? "",
      "updateVisible": !app.updateNotice.isHidden,
      "updateVersion": app.updateMonitor?.available?.version.text ?? "",
      "updateMessage": app.updateNotice.message.stringValue,
      "updateChecking": app.updateMonitor?.checking ?? false,
      "updateHeight": app.updateNotice.frame.height,
      "updateButtonFits": app.window.contentView.map {
        $0.bounds.contains(app.updateNotice.button.convert(app.updateNotice.button.bounds, to: $0))
      } ?? false,
      "openedUpdateURL": lastUpdateURL,
    ]
    write(value, to: directory.appendingPathComponent("status.json"))
  }
  private func write(_ value: [String: Any], to url: URL) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    else { return }
    try? data.write(to: url, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
  private func poll() {
    guard
      let files = try? FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil)
    else { return }
    for url in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
    where url.pathExtension == "json"
      && url.deletingPathExtension().lastPathComponent.allSatisfy({ $0.isNumber })
      && !seen.contains(url.lastPathComponent)
    {
      guard let data = try? Data(contentsOf: url), data.count <= 8 * 1024 * 1024,
        let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      else { continue }
      seen.insert(url.lastPathComponent)
      run(value) { [weak self] reply in
        guard let self else { return }
        self.write(
          reply,
          to: self.directory.appendingPathComponent("responses").appendingPathComponent(
            url.lastPathComponent))
        self.record()
      }
    }
    record()
  }
  private func run(_ command: [String: Any], done: @escaping ([String: Any]) -> Void) {
    guard let app, let kind = command["kind"] as? String else {
      done(["ok": false])
      return
    }
    func result(_ result: Result<Any, Error>) {
      switch result {
      case .success(let value): done(["ok": true, "value": value])
      case .failure(let error): done(["ok": false, "error": error.localizedDescription])
      }
    }
    switch kind {
    case "updateFixture":
      guard let monitor = app.updateMonitor else { done(["ok": false]); return }
      let response: Result<Data, NimloUpdateFailure>
      if command["offline"] as? Bool == true { response = .failure(.network) }
      else if let release = command["release"] as? [String: Any],
        let data = try? JSONSerialization.data(withJSONObject: release) { response = .success(data) }
      else { done(["ok": false]); return }
      monitor.fetch = { callback in DispatchQueue.main.async { callback(response) }; return {} }
      done(["ok": true])
    case "clickUpdate":
      guard !app.updateNotice.isHidden else { done(["ok": false]); return }
      app.updateNotice.button.performClick(nil); done(["ok": true])
    case "input":
      app.markChanged()
      app.engine.keys(command["keys"] as? String ?? "")
      done(["ok": true])
    case "type":
      app.editor.insertText(
        command["text"] as? String ?? "", replacementRange: NSRange(location: NSNotFound, length: 0)
      )
      done(["ok": true])
    case "paste":
      app.markChanged()
      app.engine.text(command["text"] as? String ?? "")
      done(["ok": true])
    case "engine":
      app.engine.lua(
        command["lua"] as? String ?? "return true", command["args"] as? [Any] ?? [], result)
    case "file":
      app.openFile(command["path"] as? String ?? "")
      done(["ok": true])
    case "focusEditor":
      app.window.makeKeyAndOrderFront(nil)
      app.window.makeFirstResponder(app.editor)
      done(["ok": true])
    case "focusTools":
      guard let web = app.companion?.web else {
        done(["ok": false, "error": "No tools view"])
        return
      }
      app.window.makeKeyAndOrderFront(nil)
      done(["ok": app.window.makeFirstResponder(web)])
    case "closeFind":
      app.closeFind(nil)
      done(["ok": true])
    case "clipboard":
      done(["ok": true, "value": NSPasteboard.general.string(forType: .string) ?? ""])
    case "setClipboard":
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(command["text"] as? String ?? "", forType: .string)
      done(["ok": true])
    case "sheetText":
      func field(_ view: NSView) -> NSTextField? {
        if let field = view as? NSTextField, field.isEditable { return field }
        for child in view.subviews { if let result = field(child) { return result } }
        return nil
      }
      guard let view = app.window.attachedSheet?.contentView, let input = field(view) else {
        done(["ok": false, "error": "No input field"])
        return
      }
      input.stringValue = command["text"] as? String ?? ""
      input.currentEditor()?.string = input.stringValue
      done(["ok": true])
    case "flush": app.flush { ok in done(["ok": ok]) }
    case "rpc":
      app.client.command(
        command["type"] as? String ?? "ping", command["fields"] as? [String: Any] ?? [:]
      ) { reply in result(reply.map { $0 as Any }) }
    case "menu":
      let wanted = command["action"] as? String ?? ""
      func locate(_ menu: NSMenu) -> NSMenuItem? {
        for item in menu.items {
          if item.action.map(NSStringFromSelector) == wanted { return item }
          if let sub = item.submenu, let match = locate(sub) { return match }
        }
        return nil
      }
      guard let root = NSApp.mainMenu, let item = locate(root), let menu = item.menu else {
        done(["ok": false, "error": "No menu action " + wanted])
        return
      }
      // The fixture can run while the person keeps using another app. AppKit
      // has no global action target while inactive; address this fixture's
      // first responder for the same menu action in that case.
      let target = item.target
      if target == nil && !NSApp.isActive, let action = item.action,
        let responder = (NSApp.keyWindow ?? app.companion?.window ?? app.window)?.firstResponder,
        responder.responds(to: action)
      {
        item.target = responder
      }
      defer { item.target = target }
      menu.update()
      guard item.isEnabled else {
        done(["ok": false, "error": "Menu is disabled"])
        return
      }
      menu.performActionForItem(at: menu.index(of: item))
      done(["ok": true])
    case "key":
      app.window.makeKeyAndOrderFront(nil)
      if command["target"] as? String == "tools", let web = app.companion?.web {
        app.window.makeFirstResponder(web)
      } else {
        app.window.makeFirstResponder(app.editor)
      }
      let flags = NSEvent.ModifierFlags(rawValue: UInt(command["modifiers"] as? Int ?? 0))
      let text = command["characters"] as? String ?? ""
      let code = UInt16(command["keyCode"] as? Int ?? 0)
      guard
        let event = NSEvent.keyEvent(
          with: .keyDown, location: .zero, modifierFlags: flags,
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: app.window.windowNumber,
          context: nil, characters: text,
          charactersIgnoringModifiers: command["unmodified"] as? String ?? text, isARepeat: false,
          keyCode: code)
      else {
        done(["ok": false])
        return
      }
      NSApp.sendEvent(event)
      done(["ok": true])
    case "vim":
      app.mode.selectedSegment = command["enabled"] as? Bool == true ? 1 : 0
      app.modeChanged(nil)
      done(["ok": true])
    case "palette":
      app.findFile(nil)
      app.palette?.field.stringValue = command["query"] as? String ?? ""
      app.palette?.search()
      done(["ok": true])
    case "paletteOpen":
      app.palette?.openSelected()
      done(["ok": true])
    case "paletteClose":
      app.palette?.close()
      done(["ok": true])
    case "find":
      app.findInFile(nil)
      app.findField.stringValue = command["query"] as? String ?? ""
      app.find(command["backward"] as? Bool ?? false)
      done(["ok": true])
    case "companion":
      app.showTool(command["view"] as? String ?? "ai")
      done(["ok": true])
    case "companionJS":
      guard let web = app.companion?.web else {
        done(["ok": false, "error": "No companion"])
        return
      }
      web.callAsyncJavaScript(
        command["javascript"] as? String ?? "return true;", arguments: [:], in: nil, in: .page
      ) { reply in result(reply) }
    case "closeCompanion":
      app.companion?.close()
      done(["ok": true])
    case "sheet":
      func button(_ view: NSView) -> NSButton? {
        if let b = view as? NSButton, b.title == command["title"] as? String { return b }
        for child in view.subviews { if let b = button(child) { return b } }
        return nil
      }
      guard let view = app.window.attachedSheet?.contentView, let b = button(view) else {
        done(["ok": false, "error": "Sheet button not found"])
        return
      }
      b.performClick(nil)
      done(["ok": true])
    case "capture":
      guard let view = app.window.contentView,
        let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds)
      else {
        done(["ok": false])
        return
      }
      view.cacheDisplay(in: view.bounds, to: bitmap)
      let name = (command["name"] as? String ?? "native") + ".png"
      guard !name.contains("/") else {
        done(["ok": false])
        return
      }
      try? bitmap.representation(using: .png, properties: [:])?.write(
        to: directory.appendingPathComponent(name))
      done(["ok": true])
    case "hitEditor":
      let point = app.editor.convert(NSPoint(x: 80, y: 80), to: app.window.contentView)
      let hit = app.window.contentView?.hitTest(point)
      done(["ok": true, "value": hit === app.editor])
    case "toolbar":
      let title = command["title"] as? String ?? ""
      let buttons = app.toolbarButtons + app.mode.subviews.compactMap { $0 as? ToolbarButton }
      if let button = buttons.first(where: { $0.label == title }) {
        guard button.isEnabled else {
          done(["ok": false, "error": "Disabled toolbar action"])
          return
        }
        button.performClick(nil)
        done(["ok": true])
      } else {
        done(["ok": false, "error": "Unknown toolbar action"])
      }
    case "resize":
      app.window.setContentSize(
        NSSize(width: command["width"] as? Int ?? 1280, height: command["height"] as? Int ?? 820))
      done(["ok": true])
    case "privateLaunch": done(["ok": true, "url": app.hostURL?.absoluteString ?? ""])
    case "quit":
      done(["ok": true])
      DispatchQueue.main.async { NSApp.terminate(nil) }
    default: done(["ok": false, "error": "Unknown fixture command"])
    }
  }
}
