import Foundation

final class NativeHost {
  var process: Process?
  var onReady: ((URL) -> Void)?, onExit: ((String) -> Void)?
  var errors = ""
  private var parent: Pipe?, stdout: Pipe?, stderr: Pipe?, buffer = Data(), stopped = false
  func start(resources: URL, workspace: String?, state: String) {
    let p = Process()
    let pin = Pipe()
    let pout = Pipe()
    let perr = Pipe()
    p.executableURL = resources.appendingPathComponent("nimlo-host")
    p.arguments = [
      "--desktop", "--resume-project", "--state-dir", state, "--listen", "127.0.0.1:0",
    ]
    if let workspace {
      p.arguments! += ["--workspace", workspace]
      p.currentDirectoryURL = URL(fileURLWithPath: workspace)
    }
    var environment = ProcessInfo.processInfo.environment
    var paths = (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").components(
      separatedBy: ":")
    for path in [
      "/opt/homebrew/bin", "/usr/local/bin",
      FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path,
    ] where !paths.contains(path) { paths.append(path) }
    environment["PATH"] = paths.joined(separator: ":")
    p.environment = environment
    p.standardInput = pin
    p.standardOutput = pout
    p.standardError = perr
    process = p
    parent = pin
    stdout = pout
    stderr = perr
    pout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      DispatchQueue.main.async { self?.receive(data) }
    }
    perr.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      DispatchQueue.main.async {
        guard let self else { return }
        self.errors = String((self.errors + String(decoding: data, as: UTF8.self)).suffix(4000))
      }
    }
    p.terminationHandler = { [weak self] p in
      DispatchQueue.main.async {
        guard let self else { return }
        self.stdout?.fileHandleForReading.readabilityHandler = nil
        self.stderr?.fileHandleForReading.readabilityHandler = nil
        if !self.stopped {
          self.onExit?("The workspace stopped (\(p.terminationStatus)). \(self.errors)")
        }
      }
    }
    do {
      try p.run()
      try? pin.fileHandleForReading.close()
    } catch { onExit?(error.localizedDescription) }
  }
  private func receive(_ data: Data) {
    guard !data.isEmpty else { return }
    buffer.append(data)
    guard buffer.count <= 16384 else {
      onExit?("Invalid host startup response")
      stop()
      return
    }
    while let newline = buffer.firstIndex(of: 10) {
      let line = buffer.prefix(upTo: newline)
      buffer = Data(buffer.dropFirst(newline + 1))
      guard let value = (try? JSONSerialization.jsonObject(with: line)) as? [String: String],
        value["type"] == "ready", let text = value["url"], let c = URLComponents(string: text),
        c.scheme == "http", c.host == "127.0.0.1", let port = c.port, port > 0, c.path == "/",
        c.user == nil, c.password == nil, c.query == nil, let fragment = c.fragment,
        fragment.hasPrefix("token="), fragment.count == 70,
        fragment.dropFirst(6).allSatisfy({ "0123456789abcdef".contains($0) }), let url = c.url
      else { continue }
      onReady?(url)
    }
  }
  func stop() {
    stopped = true
    try? parent?.fileHandleForWriting.close()
    parent = nil
    if let p = process, p.isRunning {
      DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if p.isRunning { p.terminate() } }
    }
  }
  deinit {
    try? parent?.fileHandleForWriting.close()
    if process?.isRunning == true { process?.terminate() }
  }
}
