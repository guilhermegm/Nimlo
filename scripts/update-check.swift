import Foundation

private var checks = 0
private func expect(_ value: @autoclosure () -> Bool, _ message: String) {
  precondition(value(), message); checks += 1
}
private func wait(_ predicate: () -> Bool) {
  let end = Date().addingTimeInterval(5)
  while !predicate() && Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
  precondition(predicate(), "Asynchronous check timed out")
}
private func release(_ tag: String = "v0.3.2", _ change: (inout [String: Any]) -> Void = { _ in }) -> Data {
  let version = String(tag.dropFirst()), name = "Nimlo-\(version)-\(NimloUpdateSource.platform).zip"
  var value: [String: Any] = [
    "tag_name": tag, "html_url": "https://github.com/guilhermegm/Nimlo/releases/tag/\(tag)",
    "draft": false, "prerelease": false,
    "assets": [["name": name, "state": "uploaded", "size": 100,
      "browser_download_url": "https://github.com/guilhermegm/Nimlo/releases/download/\(tag)/\(name)"]],
  ]
  change(&value)
  return try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}
private func decision(_ data: Data, current: String = "0.3.1") -> String {
  do {
    switch try nimloUpdateDecision(data, current: NimloVersion(current)!) {
    case .available(let offer): return offer.version.text
    case .current: return "current"
    case .unavailable: return "unavailable"
    }
  } catch { return "invalid" }
}

final class UpdateProtocol: URLProtocol, @unchecked Sendable {
  static var status = 200, mime = "application/json", length: Int?, chunks: [Data] = []
  static var headers: [String: String] = [:], requests: [URLRequest] = []
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.requests.append(request)
    var headers = Self.headers; headers["Content-Type"] = Self.mime
    if let length = Self.length { headers["Content-Length"] = String(length) }
    let response = HTTPURLResponse(url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1", headerFields: headers)!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    for chunk in Self.chunks { client?.urlProtocol(self, didLoad: chunk) }
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}

@main struct UpdateChecks {
  static func main() throws {
    expect(NimloVersion("0.3.10")! > NimloVersion("0.3.9")!, "numeric comparison")
    expect(NimloVersion("1.0.0")! > NimloVersion("0.99.99")!, "major comparison")
    for value in ["", "v0.3.1", "0.3", "0.3.1-rc1", "0.03.1", "0.-3.1", "0.3.1\n", "0.3.999999999999999999"] {
      expect(NimloVersion(value) == nil, "invalid version \(value)")
    }
    expect(decision(release()) == "0.3.2", "compatible newer release")
    expect(decision(release("v0.3.10"), current: "0.3.9") == "0.3.10", "multi-digit patch")
    expect(decision(release("v0.3.1")) == "current", "installed release")
    expect(decision(release("v0.2.9")) == "current", "older release")
    expect(decision(release { $0["draft"] = true }) == "unavailable", "draft ignored")
    expect(decision(release { $0["prerelease"] = true }) == "unavailable", "prerelease ignored")
    expect(decision(release { $0["assets"] = [] }) == "unavailable", "incomplete upload ignored")
    for url in ["http://github.com/guilhermegm/Nimlo/releases/tag/v0.3.2", "https://evil.test/releases/tag/v0.3.2", "https://github.com/other/Nimlo/releases/tag/v0.3.2", "https://user:pass@github.com/guilhermegm/Nimlo/releases/tag/v0.3.2", "https://github.com/guilhermegm/Nimlo/releases/tag/v0.3.2?next=evil"] {
      expect(decision(release { $0["html_url"] = url }) == "invalid", "untrusted page refused")
    }
    expect(decision(release("v0.3.2-rc1")) == "invalid", "unstable tag refused")
    expect(decision(Data("<html>error</html>".utf8)) == "invalid", "invalid body")
    expect(decision(Data(repeating: 32, count: NimloUpdateSource.maximumBytes + 1)) == "invalid", "oversized metadata")
    for field in ["name", "state", "size", "browser_download_url"] {
      expect(decision(release { value in
        var asset = (value["assets"] as! [[String: Any]])[0]
        asset[field] = field == "size" ? 0 : "invalid"
        value["assets"] = [asset]
      }) == "unavailable", "invalid compatible asset \(field)")
    }

    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("nimlo-update-check-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = NimloUpdateCache(url: directory.appendingPathComponent("updates.json"))
    var clock = Date(timeIntervalSince1970: 100000), requests = 0
    var pending: NimloUpdateRequest.Completion?
    let monitor = NimloUpdateMonitor(current: "0.3.1", cache: cache, fetch: { callback in requests += 1; pending = callback; return {} }, now: { clock })!
    var feedback: [NimloManualUpdateResult] = []
    monitor.onManualResult = { feedback.append($0) }
    monitor.check(); monitor.check(manual: true)
    expect(requests == 1 && monitor.checking, "single flight and manual coalescing")
    pending?(.success(release())); wait { !monitor.checking }
    expect(monitor.available?.version.text == "0.3.2" && feedback.count == 1, "new offer and manual response")
    expect(cache.read()?.tag == "v0.3.2", "offer persisted")
    let attributes = try FileManager.default.attributesOfItem(atPath: cache.url.path)
    expect((attributes[.posixPermissions] as! NSNumber).intValue == 0o600, "cache is private")
    let restored = NimloUpdateMonitor(current: "0.3.1", cache: cache, now: { clock })!
    expect(restored.available?.version.text == "0.3.2", "offer survives restart")
    expect(NimloUpdateMonitor(current: "0.3.2", cache: cache, now: { clock })!.available == nil, "notice disappears after installation")
    expect(NimloUpdateMonitor(current: "1.0.0", cache: cache, now: { clock })!.available == nil, "newer installed app ignores cached offer")
    monitor.check(); expect(requests == 1, "hourly automatic throttle")
    monitor.check(manual: true); expect(requests == 1, "manual anti-spam throttle")
    clock.addTimeInterval(31); monitor.check(manual: true); expect(requests == 2, "manual refresh before next hour")
    pending?(.failure(.network)); wait { !monitor.checking }
    expect(monitor.available?.version.text == "0.3.2" && cache.read()?.tag == "v0.3.2", "offline error retains persistent notice")
    clock.addTimeInterval(3601); monitor.check(); pending?(.success(Data("bad json".utf8))); wait { !monitor.checking }
    expect(monitor.available != nil, "bad metadata does not dismiss notice")
    clock.addTimeInterval(3601); monitor.check(); pending?(.success(release { $0["assets"] = [] })); wait { !monitor.checking }
    expect(monitor.available != nil, "partial upload does not dismiss known offer")
    clock.addTimeInterval(3601); monitor.check(); pending?(.failure(.rateLimited(clock.addingTimeInterval(7200)))); wait { !monitor.checking }
    expect(monitor.nextCheck == clock.addingTimeInterval(7200), "server rate-limit backoff")
    clock.addTimeInterval(31); let limitedCount = requests; monitor.check(manual: true)
    expect(requests == limitedCount, "manual requests respect server rate limits")
    var restartedRequests = 0
    let limited = NimloUpdateMonitor(current: "0.3.1", cache: cache, fetch: { _ in restartedRequests += 1; return {} }, now: { clock })!
    limited.check(manual: true)
    expect(restartedRequests == 0, "rate-limit backoff survives restart")
    clock.addTimeInterval(7201); monitor.check(manual: true); pending?(.success(release("v0.3.1"))); wait { !monitor.checking }
    expect(monitor.available == nil && cache.read()?.tag == nil, "withdrawn newer release clears notice")
    clock.addTimeInterval(3601); monitor.check(); let late = pending; monitor.stop(); late?(.success(release()))
    RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    expect(monitor.available == nil, "stopped monitor ignores late responses")
    try FileManager.default.removeItem(at: cache.url)
    let original = directory.appendingPathComponent("original.txt"); try Data("untouched".utf8).write(to: original)
    try FileManager.default.createSymbolicLink(at: cache.url, withDestinationURL: original)
    expect(cache.read() == nil, "cache symlink not read")
    cache.write(NimloUpdateRecord(tag: "v9.0.0", lastAttempt: 0, nextCheck: 0))
    let preserved = try String(contentsOf: original, encoding: .utf8)
    expect(preserved == "untouched", "cache symlink target not overwritten")
    try FileManager.default.removeItem(at: cache.url)
    try Data(repeating: 32, count: 16385).write(to: cache.url); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: cache.url.path)
    expect(cache.read() == nil, "oversized cache refused")

    func network(status: Int = 200, mime: String = "application/json", length: Int? = nil, headers: [String: String] = [:], chunks: [Data]) -> Result<Data, NimloUpdateFailure> {
      UpdateProtocol.status = status; UpdateProtocol.mime = mime; UpdateProtocol.length = length; UpdateProtocol.headers = headers; UpdateProtocol.chunks = chunks
      let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [UpdateProtocol.self]
      var result: Result<Data, NimloUpdateFailure>?
      let request = NimloUpdateRequest(configuration: config) { result = $0 }; request.start()
      wait { result != nil }; return result!
    }
    if case .success(let data) = network(chunks: [release().prefix(40), release().dropFirst(40)]) {
      expect(data == release(), "bounded streaming metadata")
    } else { preconditionFailure("Valid metadata request failed") }
    let request = UpdateProtocol.requests.last!
    expect(request.url == NimloUpdateSource.api && request.httpMethod == "GET", "fixed metadata endpoint")
    expect(request.value(forHTTPHeaderField: "Authorization") == nil && request.value(forHTTPHeaderField: "Cookie") == nil && request.httpBody == nil, "no credentials or project data")
    for result in [network(status: 302, chunks: []), network(status: 500, chunks: []), network(mime: "text/html", chunks: [release()]), network(length: NimloUpdateSource.maximumBytes + 1, chunks: []), network(chunks: [Data(repeating: 32, count: NimloUpdateSource.maximumBytes), Data([32])])] {
      if case .failure = result { checks += 1 } else { preconditionFailure("Unsafe response accepted") }
    }
    if case .failure(.rateLimited) = network(status: 429, headers: ["Retry-After": "120"], chunks: []) { checks += 1 } else { preconditionFailure("Rate limit ignored") }
    let redirect = NimloUpdateRequest { _ in }
    let session = URLSession(configuration: .ephemeral)
    let task = session.dataTask(with: NimloUpdateSource.api)
    var redirected = true
    redirect.urlSession(session, task: task, willPerformHTTPRedirection: HTTPURLResponse(url: NimloUpdateSource.api, statusCode: 302, httpVersion: nil, headerFields: nil)!, newRequest: URLRequest(url: URL(string: "https://evil.test/")!)) { redirected = $0 != nil }
    expect(!redirected, "redirect refused")
    redirect.cancel(); task.cancel(); session.invalidateAndCancel()
    print("PASS \(checks) update version, metadata, persistence, scheduling, transport and cache checks")
    if CommandLine.arguments.contains("--live") {
      var live: Result<Data, NimloUpdateFailure>?
      _ = NimloUpdateRequest.fetch { live = $0 }
      wait { live != nil }
      let data = try live!.get()
      let value = try nimloUpdateDecision(data, current: NimloVersion("0.0.0")!)
      if case .available(let offer) = value { print("PASS live GitHub release check: \(offer.tag)") }
      else { preconditionFailure("Expected a published compatible release") }
    }
  }
}
