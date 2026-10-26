import AppKit
import Foundation

final class Neovim {
  var process: Process?
  var onRedraw: (([[Any]]) -> Void)?
  var onChange: (() -> Void)?
  var onAction: ((String, [Any]) -> Void)?
  var onExit: ((String) -> Void)?
  var ready = false
  var version = ""
  private var channel = 0, next = 0
  private var pending: [Int: (Result<Any, Error>) -> Void] = [:]
  private var input: FileHandle?
  private let reader = DispatchQueue(label: "dev.nimlo.neovim.reader")
  private let writer = DispatchQueue(label: "dev.nimlo.neovim.writer")
  private var buffer = Data(), stderr = "", stopping = false
  private var stdout: Pipe?, errors: Pipe?

  func start(resources: URL, state: URL, completion: @escaping (Result<Any, Error>) -> Void) {
    let p = Process()
    let pin = Pipe()
    let pout = Pipe()
    let perr = Pipe()
    p.executableURL = resources.appendingPathComponent("neovim/bin/nvim")
    p.arguments = ["--embed", "-u", "NONE", "-i", "NONE", "--noplugin"]
    var env = ProcessInfo.processInfo.environment
    env["VIMRUNTIME"] = resources.appendingPathComponent("neovim/share/nvim/runtime").path
    env["NVIM_APPNAME"] = "nimlo-neovim"
    env["XDG_CONFIG_HOME"] = state.appendingPathComponent("config").path
    env["XDG_STATE_HOME"] = state.appendingPathComponent("engine-state").path
    env["XDG_DATA_HOME"] = state.appendingPathComponent("engine-data").path
    env["XDG_CACHE_HOME"] = state.appendingPathComponent("engine-cache").path
    p.environment = env
    p.standardInput = pin
    p.standardOutput = pout
    p.standardError = perr
    process = p
    input = pin.fileHandleForWriting
    stdout = pout
    errors = perr
    pout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      self?.reader.async { self?.consume(data) }
    }
    perr.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      DispatchQueue.main.async {
        self?.stderr = String(
          ((self?.stderr ?? "") + String(decoding: data, as: UTF8.self)).suffix(3000))
      }
    }
    p.terminationHandler = { [weak self] p in
      DispatchQueue.main.async {
        guard let self else { return }
        self.ready = false
        self.stdout?.fileHandleForReading.readabilityHandler = nil
        self.errors?.fileHandleForReading.readabilityHandler = nil
        let callbacks = self.pending.values
        self.pending.removeAll()
        for callback in callbacks { callback(.failure(NimloFailure("Neovim stopped"))) }
        if !self.stopping {
          self.onExit?("Neovim stopped (\(p.terminationStatus)). \(self.stderr)")
        }
      }
    }
    do {
      try p.run()
      try? pin.fileHandleForReading.close()
    } catch {
      completion(.failure(error))
      return
    }
    call("nvim_get_api_info", []) { [weak self] result in
      guard let self else { return }
      do {
        let info = try result.get() as? [Any] ?? []
        self.channel = info.first as? Int ?? 1
        let meta = info.count > 1 ? info[1] as? [String: Any] : nil
        let version = meta?["version"] as? [String: Any] ?? [:]
        self.version = "\(version["major"] ?? 0).\(version["minor"] ?? 0).\(version["patch"] ?? 0)"
        self.call(
          "nvim_ui_attach", [100, 35, ["rgb": true, "ext_linegrid": true, "ext_multigrid": false]]
        ) { result in
          do {
            _ = try result.get()
            let script = try String(
              contentsOf: resources.appendingPathComponent("nimlo.lua"), encoding: .utf8)
            self.call("nvim_exec_lua", [script, [self.channel]]) { result in
              if case .success = result { self.ready = true }
              completion(result)
            }
          } catch { completion(.failure(error)) }
        }
      } catch { completion(.failure(error)) }
    }
  }
  private func consume(_ data: Data) {
    guard !data.isEmpty else { return }
    buffer.append(data)
    guard buffer.count <= MP.limit else {
      DispatchQueue.main.async {
        self.onExit?("Neovim sent an oversized RPC frame")
        self.stop()
      }
      return
    }
    var consumed = 0
    while consumed < buffer.count {
      var offset = consumed
      do {
        let message = try MP.decode(buffer, offset: &offset) as? [Any] ?? []
        consumed = offset
        DispatchQueue.main.async { [weak self] in self?.receive(message) }
      } catch MP.Failure.incomplete { break } catch {
        buffer.removeAll()
        DispatchQueue.main.async {
          self.onExit?("Invalid Neovim RPC response")
          self.stop()
        }
        return
      }
    }
    if consumed > 0 { buffer = Data(buffer.dropFirst(consumed)) }
  }
  private func receive(_ message: [Any]) {
    guard let type = message.first as? Int else { return }
    if type == 1, message.count == 4, let id = message[1] as? Int,
      let done = pending.removeValue(forKey: id)
    {
      if message[2] is NSNull {
        done(.success(message[3]))
      } else {
        done(.failure(NimloFailure(String(describing: message[2]))))
      }
    } else if type == 2, message.count == 3, let method = message[1] as? String,
      let args = message[2] as? [Any]
    {
      if method == "redraw" {
        onRedraw?(args.compactMap { $0 as? [Any] })
      } else if method == "nimlo_changed" {
        onChange?()
      } else if method == "nimlo_action", let action = args.first as? String {
        onAction?(action, Array(args.dropFirst()))
      } else if method == "nimlo_clipboard", let lines = args.first as? [String] {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lines.joined(separator: "\n"), forType: .string)
      }
    } else if type == 0, message.count == 4, let id = message[1] as? Int {
      let result: Any =
        (message[2] as? String) == "nimlo_clipboard_get"
        ? [
          (NSPasteboard.general.string(forType: .string) ?? "").components(separatedBy: "\n"), "v",
        ] as [Any] : NSNull()
      send([1, id, NSNull(), result])
    }
  }
  private func send(_ value: Any) {
    let data = MP.encode(value)
    guard let input else { return }
    writer.async { try? input.write(contentsOf: data) }
  }
  func call(
    _ method: String, _ args: [Any], _ completion: @escaping (Result<Any, Error>) -> Void = { _ in }
  ) {
    guard process?.isRunning == true, pending.count < 256 else {
      completion(.failure(NimloFailure("Neovim is unavailable or busy")))
      return
    }
    next += 1
    let id = next
    pending[id] = completion
    send([0, id, method, args])
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
      self?.pending.removeValue(forKey: id)?(.failure(NimloFailure("Neovim did not respond")))
    }
  }
  func lua(
    _ code: String, _ args: [Any] = [], _ done: @escaping (Result<Any, Error>) -> Void = { _ in }
  ) { call("nvim_exec_lua", [code, args], done) }
  func keys(_ keys: String) { lua("return _G.nimlo.key(...)", [keys]) }
  func text(_ text: String) { lua("return _G.nimlo.paste(...)", [text]) }
  func contents(_ done: @escaping (Result<String, Error>) -> Void) {
    lua("return _G.nimlo.text()") { result in
      done(
        result.flatMap { value in
          guard let string = value as? String else {
            return .failure(NimloFailure("Invalid editor text"))
          }
          return .success(string)
        })
    }
  }
  func bind(
    name: String, text: String, dirty: Bool, editable: Bool, reset: Bool,
    completion: @escaping (Result<Any, Error>) -> Void = { _ in }
  ) { lua("return _G.nimlo.bind(...)", [name, text, dirty, editable, reset], completion) }
  func mode(_ vim: Bool) { lua("_G.nimlo.mode(...)", [vim]) }
  func stop() {
    stopping = true
    ready = false
    try? input?.close()
    input = nil
    if let p = process, p.isRunning {
      p.terminate()
      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
      }
    }
  }
  deinit { if process?.isRunning == true { process?.terminate() } }
}
