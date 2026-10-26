import AppKit
import WebKit

// One user-requested Blob export at a time. WebKit streams into a private
// staging file; a successful export moves it to a new, user-chosen filename.
// No file contents or native filesystem API are exposed to the page.
final class NimloFileDownload {
  let download: WKDownload
  var staging: URL?
  var destination: URL?
  init(_ download: WKDownload) { self.download = download }
  deinit { if let staging { try? FileManager.default.removeItem(at: staging) } }
}

extension NativeCompanion {
  func webView(
    _ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload
  ) {
    guard fileDownload == nil else {
      download.cancel { _ in }
      return
    }
    fileDownload = NimloFileDownload(download)
    download.delegate = self
  }

  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
    completionHandler: @escaping (URL?) -> Void
  ) {
    guard let transfer = fileDownload, transfer.download === download else {
      completionHandler(nil)
      return
    }
    let name = NimloPolicy.downloadName(suggestedFilename)
    func choose(_ destination: URL?) {
      guard let destination, destination.isFileURL,
        !FileManager.default.fileExists(atPath: destination.path)
      else {
        completionHandler(nil)
        self.fileDownload = nil
        return
      }
      do {
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent(
          "nimlo-export-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(
          at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        transfer.staging = staging
        transfer.destination = destination
        completionHandler(staging.appendingPathComponent("draft"))
      } catch {
        completionHandler(nil)
        self.fileDownload = nil
        self.downloadFailed("Could not prepare the export.")
      }
    }
    // Only an explicit local test launch plus a precreated, owner-only
    // directory can bypass the Save panel. Normal launches never do so.
    if let fixture = privateDownloadFixture() {
      choose(fixture.appendingPathComponent(name))
      return
    }
    let panel = NSSavePanel()
    panel.title = "Save a recovery copy"
    panel.nameFieldStringValue = name
    panel.message = "Choose a new filename. Your recovery draft stays in Nimlo."
    panel.canCreateDirectories = true
    panel.beginSheetModal(for: window) { result in
      guard result == .OK else {
        choose(nil)
        return
      }
      guard let url = panel.url, !FileManager.default.fileExists(atPath: url.path) else {
        choose(nil)
        self.downloadFailed("That file already exists. Download again and choose a new filename.")
        return
      }
      choose(url)
    }
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let transfer = fileDownload, transfer.download === download,
      let staging = transfer.staging, let destination = transfer.destination
    else { return }
    defer { fileDownload = nil }
    do {
      // moveItem refuses an existing destination, including one created
      // while the download was running. Never replace a user's file.
      try FileManager.default.moveItem(at: staging.appendingPathComponent("draft"), to: destination)
      recordNative("download-finished", fields: ["name": destination.lastPathComponent])
    } catch { downloadFailed("Could not save the recovery copy. Your draft is still in Nimlo.") }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    guard fileDownload?.download === download else { return }
    fileDownload = nil
    if (error as NSError).code != NSURLErrorCancelled {
      downloadFailed("The export failed. Your draft is still in Nimlo.")
    }
  }

  func download(
    _ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void
  ) { decisionHandler(.cancel) }

  func cancelFileDownload() {
    fileDownload?.download.cancel { _ in }
    fileDownload = nil
  }

  func downloadFailed(_ message: String) {
    if report != nil {
      recordNative("download-failed", fields: ["message": message])
      return
    }
    let alert = NSAlert()
    alert.messageText = "Recovery copy"
    alert.informativeText = message
    alert.beginSheetModal(for: window) { _ in }
  }

  private func privateDownloadFixture() -> URL? {
    guard let report else { return nil }
    let directory = URL(fileURLWithPath: report + ".downloads", isDirectory: true)
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: directory.path),
      attrs[.type] as? FileAttributeType == .typeDirectory,
      (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
      (attrs[.posixPermissions] as? NSNumber)?.intValue == 0o700
    else { return nil }
    return directory
  }
}
