import AppKit
import WebKit

// Created only on request and released after a successful pending-edit flush.
// SessionStorage is kept in a small native record so unsent prompts survive a
// closed tools view while the host keeps running shells and AI conversations.
final class NativeCompanion: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
  weak var window: NSWindow!
  weak var host: EditorWorkspace?
  var web: WorkspaceWebView?
  var fileDownload: NimloFileDownload?
  var report: String?
  var port: Int
  var launch: URL, project = "", section = "ai", selectedPath = ""
  var storage: [String: String] = [:]
  var aiOpen = false, terminalOpen = false, modal = false
  var onError: ((String) -> Void)?, onClosed: (() -> Void)?, onLayout: (() -> Void)?
  var onOpenFile: ((String, String, Int) -> Void)?
  private var pendingPanels = Set<String>()
  var aiSelected: Bool { web != nil && (freshOpen ? pendingPanels.contains("ai") : aiOpen) }
  var terminalSelected: Bool {
    web != nil && (freshOpen ? pendingPanels.contains("terminal") : terminalOpen)
  }
  private var closing = false, freshOpen = true, loadEpoch = 0, requestEpoch = 0
  init(launch: URL) {
    self.launch = launch
    port = launch.port!
    super.init()
  }
  func show(
    _ section: String, project: String, path: String?, in window: NSWindow, host: EditorWorkspace
  ) {
    if web == nil { pendingPanels.removeAll() }
    if web == nil || freshOpen, ["ai", "terminal"].contains(section) {
      if pendingPanels.contains(section) {
        pendingPanels.remove(section)
      } else {
        pendingPanels.insert(section)
      }
    }
    self.section = section
    self.project = project
    self.selectedPath = path ?? ""
    self.window = window
    self.host = host
    requestEpoch += 1
    if web != nil {
      openAction()
      return
    }
    loadEpoch += 1
    freshOpen = true
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(WorkspaceMessageHandler(self), name: "nimloWorkspace")
    var script =
      "window.nimloNativeWorkspace=true;document.documentElement.dataset.nativeWorkspace='yes';"
    if let data = try? JSONSerialization.data(withJSONObject: storage),
      let json = String(data: data, encoding: .utf8)
    {
      script +=
        "try { for (const [key,value] of Object.entries(\(json))) sessionStorage.setItem(key,value); } catch {}"
    }
    config.userContentController.addUserScript(
      WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let view = WorkspaceWebView(frame: host.bounds, configuration: config)
    view.autoresizingMask = [.width, .height]
    view.underPageBackgroundColor = .clear
    view.editorRect = host.bounds
    view.blocksEditor = false
    view.navigationDelegate = self
    view.uiDelegate = self
    web = view
    host.addSubview(view)
    view.load(URLRequest(url: launch))
  }
  private func openAction(retry: Int = 0, request: Int? = nil) {
    guard let web else { return }
    let epoch = loadEpoch
    let requested = request ?? requestEpoch
    guard requested == requestEpoch else { return }
    web.callAsyncJavaScript(
      "return await window.nimloNeovimCompanion?.open(view,project,fresh,path,panels) ?? false;",
      arguments: [
        "view": section, "project": project, "fresh": freshOpen, "path": selectedPath,
        "panels": pendingPanels.sorted(),
      ],
      in: nil, in: .page
    ) { [weak self] result in
      guard let self, self.loadEpoch == epoch, self.requestEpoch == requested else { return }
      if case .success(let value) = result, value as? Bool == true {
        self.freshOpen = false
        self.pendingPanels.removeAll()
        self.onLayout?()
        return
      }
      if retry < 50 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
          self?.openAction(retry: retry + 1, request: requested)
        }
      }
    }
  }
  func selectFile(project: String, path: String?) {
    self.project = project
    self.selectedPath = path ?? ""
    guard let web else { return }
    web.callAsyncJavaScript(
      "return await window.nimloNeovimCompanion?.select(project,path) ?? false;",
      arguments: ["project": project, "path": selectedPath], in: nil, in: .page
    ) { _ in }
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { openAction() }
  func receive(_ message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
      NimloPolicy.localPage(url, port: port), message.webView === web,
      let body = message.body as? [String: Any], let type = body["type"] as? String
    else { return }
    if type == "layout" && freshOpen && body["active"] as? Bool != true { return }
    if type == "openFile", let project = body["projectId"] as? String, project.count <= 80,
      let path = body["path"] as? String, !path.isEmpty, path.utf8.count <= 4096,
      !path.contains("\0")
    {
      onOpenFile?(project, path, max(1, min(10_000_000, body["line"] as? Int ?? 1)))
      return
    }
    guard type == "layout", let host, let web,
      let x = body["x"] as? Double, let y = body["y"] as? Double,
      let width = body["width"] as? Double, let height = body["height"] as? Double,
      [x, y, width, height].allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 100_000 })
    else { return }
    let rect = NSRect(x: x, y: y, width: width, height: height).intersection(host.bounds)
    host.sourceRect = rect
    host.layoutSubtreeIfNeeded()
    web.editorRect = rect
    let wasModal = modal
    modal = body["modal"] as? Bool == true
    if modal && !wasModal { window?.makeFirstResponder(web) }
    host.modal = modal
    web.overlays = (body["overlays"] as? [[String: Any]] ?? []).prefix(16).compactMap { value in
      guard let x = value["x"] as? Double, let y = value["y"] as? Double,
        let w = value["width"] as? Double, let h = value["height"] as? Double,
        [x, y, w, h].allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 100_000 })
      else { return nil }
      return NSRect(x: x, y: y, width: w, height: h).intersection(host.bounds)
    }
    web.blocksEditor = modal || body["popover"] as? Bool == true
    aiOpen = body["ai"] as? Bool == true
    terminalOpen = body["terminal"] as? Bool == true
    onLayout?()
    if body["active"] as? Bool == true && !aiOpen && !terminalOpen && !modal && !web.blocksEditor
      && web.overlays.isEmpty
    {
      close(onlyIfEmpty: true)
    }
  }
  func close(onlyIfEmpty: Bool = false, retry: Int = 0) {
    guard !closing, fileDownload == nil, let web else { return }
    if onlyIfEmpty && (aiOpen || terminalOpen || modal || !web.overlays.isEmpty) { return }
    closing = true
    let epoch = loadEpoch
    let requested = requestEpoch
    web.callAsyncJavaScript(
      "const ready=await window.nimloDesktop?.prepareReload(false);return {ready:ready===true,storage:ready ? Object.fromEntries(Object.entries(sessionStorage)) : {}};",
      arguments: [:], in: nil, in: .page
    ) { [weak self] result in
      guard let self, self.loadEpoch == epoch else { return }
      self.closing = false
      guard self.requestEpoch == requested else { return }
      if onlyIfEmpty
        && (self.aiOpen || self.terminalOpen || self.modal || !(self.web?.overlays.isEmpty ?? true))
      {
        return
      }
      if case .success(let value) = result, let snapshot = value as? [String: Any],
        snapshot["ready"] as? Bool == true, let store = snapshot["storage"] as? [String: String]
      {
        self.storage = store
        self.release()
      } else if !self.aiOpen && !self.terminalOpen && !self.modal && retry < 30 {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
          guard let self, self.loadEpoch == epoch, self.requestEpoch == requested else { return }
          self.close(onlyIfEmpty: onlyIfEmpty, retry: retry + 1)
        }
      } else {
        self.onError?("Finish the dialog or resolve pending edits before closing these tools.")
      }
    }
  }
  private func release() {
    cancelFileDownload()
    loadEpoch += 1
    requestEpoch += 1
    web?.configuration.userContentController.removeScriptMessageHandler(forName: "nimloWorkspace")
    web?.stopLoading()
    web?.navigationDelegate = nil
    web?.uiDelegate = nil
    web?.removeFromSuperview()
    web = nil
    host?.sourceRect = nil
    host?.modal = false
    host?.layoutSubtreeIfNeeded()
    aiOpen = false
    terminalOpen = false
    modal = false
    closing = false
    onClosed?()
  }
  func closePrepared() { release() }
  func ownsResponder() -> Bool {
    guard let web, let view = window?.firstResponder as? NSView else { return false }
    return view === web || view.isDescendant(of: web)
  }
  func invokeEditor(_ action: String) {
    guard let web else { return }
    web.callAsyncJavaScript(
      "if(!['undo','redo'].includes(action))return false;const el=document.activeElement;if(!el||(!['INPUT','TEXTAREA'].includes(el.tagName)&&!el.isContentEditable))return false;return document.execCommand(action);",
      arguments: ["action": action], in: nil, in: .page
    ) { _ in }
  }
  func prepareQuit(_ done: @escaping (Bool) -> Void) {
    guard fileDownload == nil else {
      done(false)
      return
    }
    guard let web else {
      done(true)
      return
    }
    web.callAsyncJavaScript(
      "return await window.nimloDesktop?.prepareReload(false) === true;", arguments: [:], in: nil,
      in: .page
    ) { result in
      if case .success(let value) = result { done(value as? Bool == true) } else { done(false) }
    }
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url else {
      decisionHandler(.cancel)
      return
    }
    if action.shouldPerformDownload, action.sourceFrame.isMainFrame,
      NimloPolicy.localPage(action.sourceFrame.request.url ?? url, port: port),
      NimloPolicy.localBlob(url, port: port)
    {
      decisionHandler(fileDownload == nil ? .download : .cancel)
      return
    }
    if NimloPolicy.localPage(url, port: port), action.targetFrame?.isMainFrame == true {
      decisionHandler(.allow)
      return
    }
    if action.navigationType == .linkActivated, NimloPolicy.externalLink(url) {
      NSWorkspace.shared.open(url)
    }
    decisionHandler(.cancel)
  }
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? { nil }
  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
  ) {
    let a = NSAlert()
    a.messageText = "Nimlo"
    a.informativeText = String(message.prefix(4000))
    a.addButton(withTitle: "Continue")
    a.addButton(withTitle: "Cancel")
    a.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }
  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
  ) {
    let a = NSAlert()
    a.messageText = "Nimlo"
    a.informativeText = String(message.prefix(4000))
    a.beginSheetModal(for: window) { _ in completionHandler() }
  }
  func recordNative(_ name: String, fields: [String: Any]) {}
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    onError?(
      "The workspace view stopped. Close and reopen the tools to reconnect. Native editing and host recovery are still available."
    )
  }
}

private final class WorkspaceMessageHandler: NSObject, WKScriptMessageHandler {
  weak var owner: NativeCompanion?
  init(_ owner: NativeCompanion) { self.owner = owner }
  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) { owner?.receive(message) }
}
