import Darwin
import Foundation

struct NimloVersion: Comparable, Equatable {
  let parts: [Int]
  init?(_ value: String) {
    let fields = value.split(separator: ".", omittingEmptySubsequences: false)
    guard fields.count == 3,
      fields.allSatisfy({ !$0.isEmpty && $0.count <= 8 && ($0.count == 1 || !$0.hasPrefix("0")) && $0.utf8.allSatisfy({ (48...57).contains($0) }) })
    else { return nil }
    parts = fields.map { Int($0)! }
  }
  var text: String { parts.map(String.init).joined(separator: ".") }
  static func < (lhs: Self, rhs: Self) -> Bool { lhs.parts.lexicographicallyPrecedes(rhs.parts) }
}

enum NimloUpdateSource {
  static let repository = "guilhermegm/Nimlo"
  static let api = URL(string: "https://api.github.com/repos/\(repository)/releases/latest")!
  static let releases = URL(string: "https://github.com/\(repository)/releases")!
  static let maximumBytes = 1024 * 1024
  #if arch(arm64)
    static let platform = "macos-arm64"
  #else
    static let platform = "macos-x64"
  #endif
}

struct NimloUpdateOffer: Equatable {
  let version: NimloVersion
  var tag: String { "v" + version.text }
  var page: URL { URL(string: "https://github.com/\(NimloUpdateSource.repository)/releases/tag/\(tag)")! }
  init?(tag: String) {
    guard tag.hasPrefix("v"), let version = NimloVersion(String(tag.dropFirst())) else { return nil }
    self.version = version
  }
}

enum NimloUpdateDecision { case available(NimloUpdateOffer), current, unavailable }
enum NimloUpdateFailure: Error { case network, invalidResponse, invalidMetadata, rateLimited(Date?) }

func nimloUpdateDecision(_ data: Data, current: NimloVersion) throws -> NimloUpdateDecision {
  struct Asset: Decodable { let name: String; let state: String; let size: Int; let browser_download_url: String }
  struct Release: Decodable {
    let tag_name: String; let html_url: String; let draft: Bool; let prerelease: Bool; let assets: [Asset]
  }
  guard data.count <= NimloUpdateSource.maximumBytes,
    let release = try? JSONDecoder().decode(Release.self, from: data),
    let offer = NimloUpdateOffer(tag: release.tag_name), release.html_url == offer.page.absoluteString
  else { throw NimloUpdateFailure.invalidMetadata }
  guard !release.draft && !release.prerelease else { return .unavailable }
  guard offer.version > current else { return .current }
  let name = "Nimlo-\(offer.version.text)-\(NimloUpdateSource.platform).zip"
  let download = "https://github.com/\(NimloUpdateSource.repository)/releases/download/\(offer.tag)/\(name)"
  guard release.assets.contains(where: { $0.name == name && $0.state == "uploaded" && $0.size > 0 && $0.size <= 256 * 1024 * 1024 && $0.browser_download_url == download }) else { return .unavailable }
  return .available(offer)
}

// Only public release metadata is fetched. No cookies, account credentials,
// workspace data, executable downloads, or redirects are used by this client.
final class NimloUpdateRequest: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
  typealias Completion = (Result<Data, NimloUpdateFailure>) -> Void
  private var session: URLSession?, task: URLSessionDataTask?, completion: Completion?
  private var body = Data(), failure: NimloUpdateFailure?
  private var finished = false
  init(configuration: URLSessionConfiguration = .ephemeral, completion: @escaping Completion) {
    self.completion = completion
    super.init()
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.urlCredentialStorage = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 12
    configuration.timeoutIntervalForResource = 15
    let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1; queue.qualityOfService = .utility
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    var request = URLRequest(url: NimloUpdateSource.api)
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    request.setValue("2026-03-10", forHTTPHeaderField: "X-GitHub-Api-Version")
    request.setValue("Nimlo-Update-Checker", forHTTPHeaderField: "User-Agent")
    task = session?.dataTask(with: request)
  }
  func start() { task?.resume() }
  func cancel() { task?.cancel() }
  static func fetch(_ completion: @escaping Completion) -> () -> Void {
    let request = NimloUpdateRequest(completion: completion); request.start()
    return { request.cancel() }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    failure = .invalidResponse; completionHandler(nil)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let http = response as? HTTPURLResponse, http.url == NimloUpdateSource.api else {
      failure = .invalidResponse; completionHandler(.cancel); return
    }
    if http.statusCode == 403 || http.statusCode == 429 {
      let retry = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init).map { Date().addingTimeInterval(min(86400, max(0, $0))) }
      let reset = http.value(forHTTPHeaderField: "X-RateLimit-Reset").flatMap(Double.init).map(Date.init(timeIntervalSince1970:))
      failure = .rateLimited(retry ?? reset); completionHandler(.cancel); return
    }
    guard http.statusCode == 200, response.expectedContentLength <= NimloUpdateSource.maximumBytes,
      ["application/json", "application/vnd.github+json"].contains(response.mimeType ?? "") else {
      failure = .invalidResponse; completionHandler(.cancel); return
    }
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard data.count <= NimloUpdateSource.maximumBytes - body.count else {
      failure = .invalidResponse; dataTask.cancel(); return
    }
    body.append(data)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard !finished else { return }; finished = true
    let result: Result<Data, NimloUpdateFailure> = failure.map(Result.failure) ?? (error == nil ? .success(body) : .failure(.network))
    let callback = completion; completion = nil
    self.session?.finishTasksAndInvalidate(); self.session = nil
    DispatchQueue.main.async { callback?(result) }
  }
}

struct NimloUpdateRecord: Codable {
  var schema = 1
  var platform = NimloUpdateSource.platform
  var tag: String?
  var lastAttempt: Double
  var nextCheck: Double
  var retryAfter: Double?
}

struct NimloUpdateCache {
  let url: URL
  private func safeParent() -> Bool {
    var info = stat()
    return lstat(url.deletingLastPathComponent().path, &info) == 0 && info.st_uid == getuid()
      && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) && info.st_mode & 0o077 == 0
  }
  func read() -> NimloUpdateRecord? {
    guard safeParent() else { return nil }
    let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard fd >= 0 else { return nil }; defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o077 == 0, info.st_size <= 16384 else { return nil }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    guard let data = try? handle.read(upToCount: 16385), data.count <= 16384,
      let record = try? JSONDecoder().decode(NimloUpdateRecord.self, from: data), record.schema == 1,
      record.platform == NimloUpdateSource.platform, record.lastAttempt.isFinite, record.nextCheck.isFinite else { return nil }
    return record
  }
  func write(_ record: NimloUpdateRecord) {
    guard safeParent(), let data = try? JSONEncoder().encode(record), data.count <= 16384 else { return }
    var existing = stat()
    if lstat(url.path, &existing) == 0 && (existing.st_uid != getuid() || existing.st_mode & mode_t(S_IFMT) != mode_t(S_IFREG) || existing.st_mode & 0o077 != 0) { return }
    let temporary = url.deletingLastPathComponent().appendingPathComponent(".update-\(UUID().uuidString).tmp")
    let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return }; defer { Darwin.close(fd); unlink(temporary.path) }
    do {
      try FileHandle(fileDescriptor: fd, closeOnDealloc: false).write(contentsOf: data)
      guard fsync(fd) == 0 else { return }
      _ = Darwin.rename(temporary.path, url.path)
    } catch { return }
  }
}

enum NimloManualUpdateResult { case available, current, unavailable, failed, throttled }

// All monitor state and UI callbacks belong to the main thread. The network
// delegate accumulates a bounded response on its own serial background queue.
final class NimloUpdateMonitor {
  typealias Fetch = (@escaping NimloUpdateRequest.Completion) -> (() -> Void)
  let current: NimloVersion
  let cache: NimloUpdateCache
  var fetch: Fetch
  var now: () -> Date
  var manualInterval: TimeInterval = 30
  var onChange: ((NimloUpdateOffer?) -> Void)?
  var onManualResult: ((NimloManualUpdateResult) -> Void)?
  private(set) var available: NimloUpdateOffer?
  private(set) var checking = false
  private(set) var nextCheck = Date(timeIntervalSince1970: 0)
  private var lastAttempt = Date(timeIntervalSince1970: 0)
  private var serverRetryAfter: Date?
  private var timer: Timer?, cancelFetch: (() -> Void)?
  private var generation = 0, manualPending = false, stopped = false
  init?(current: String, cache: NimloUpdateCache, fetch: @escaping Fetch = NimloUpdateRequest.fetch, now: @escaping () -> Date = Date.init) {
    guard let version = NimloVersion(current) else { return nil }
    self.current = version; self.cache = cache; self.fetch = fetch; self.now = now
    if let saved = cache.read() {
      if let tag = saved.tag, let offer = NimloUpdateOffer(tag: tag), offer.version > version { available = offer }
      lastAttempt = Date(timeIntervalSince1970: min(saved.lastAttempt, now().timeIntervalSince1970))
      if saved.nextCheck >= 0 && saved.nextCheck <= now().timeIntervalSince1970 + 86400 { nextCheck = Date(timeIntervalSince1970: saved.nextCheck) }
      if let retry = saved.retryAfter, retry.isFinite, retry > now().timeIntervalSince1970, retry <= now().timeIntervalSince1970 + 86400 { serverRetryAfter = Date(timeIntervalSince1970: retry) }
    }
  }
  func startAutomaticChecks() {
    guard timer == nil, !stopped else { return }
    check()
    timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.check() }
  }
  func check(manual: Bool = false) {
    guard !stopped else { return }
    if checking { manualPending = manualPending || manual; return }
    let time = now()
    if let retry = serverRetryAfter, time < retry {
      if manual { onManualResult?(available == nil ? .throttled : .available) }; return
    }
    if manual && time.timeIntervalSince(lastAttempt) < manualInterval {
      onManualResult?(available == nil ? .throttled : .available); return
    }
    guard manual || time >= nextCheck else { return }
    checking = true; manualPending = manual; lastAttempt = time
    nextCheck = time.addingTimeInterval(15 * 60); persist()
    generation += 1; let id = generation
    cancelFetch = fetch { [weak self] result in
      DispatchQueue.main.async {
        guard let self, self.generation == id, !self.stopped else { return }
        self.complete(result)
      }
    }
  }
  private func complete(_ result: Result<Data, NimloUpdateFailure>) {
    checking = false; cancelFetch = nil
    var feedback = NimloManualUpdateResult.failed
    switch result {
    case .success(let data):
      do {
        let decision = try nimloUpdateDecision(data, current: current)
        serverRetryAfter = nil
        nextCheck = now().addingTimeInterval(3600)
        switch decision {
        case .available(let offer): setAvailable(offer); feedback = .available
        case .current: setAvailable(nil); feedback = .current
        case .unavailable: feedback = available == nil ? .unavailable : .available
        }
      } catch { nextCheck = now().addingTimeInterval(15 * 60) }
    case .failure(let error):
      nextCheck = now().addingTimeInterval(15 * 60)
      if case .rateLimited(let reset) = error {
        if let reset, reset.timeIntervalSince1970.isFinite { nextCheck = max(nextCheck, min(reset, now().addingTimeInterval(86400))) }
        serverRetryAfter = nextCheck
      }
    }
    persist()
    let manual = manualPending; manualPending = false
    if manual { onManualResult?(feedback) }
  }
  private func setAvailable(_ offer: NimloUpdateOffer?) {
    if available != offer { available = offer; onChange?(offer) }
  }
  private func persist() {
    cache.write(NimloUpdateRecord(tag: available?.tag, lastAttempt: lastAttempt.timeIntervalSince1970, nextCheck: nextCheck.timeIntervalSince1970, retryAfter: serverRetryAfter?.timeIntervalSince1970))
  }
  func stop() {
    stopped = true; generation += 1; timer?.invalidate(); timer = nil
    cancelFetch?(); cancelFetch = nil; checking = false; manualPending = false
  }
}
