import Foundation
import CryptoKit
import Darwin

// Compile together with desktop/macos/UpdateManifest.swift. HTTPS is intercepted
// by URLProtocol; no production feed, signing key, project, or network is used.
private struct FixtureReply {
    let status: Int
    let headers: [String: String]
    let body: Data
    var stall = false
}

private final class UpdateFixtureProtocol: URLProtocol, @unchecked Sendable {
    static var replies: [String: FixtureReply] = [:]
    static var starts = 0

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.starts += 1
        guard let url = request.url, let reply = Self.replies[url.path] else {
            client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)); return
        }
        precondition(request.value(forHTTPHeaderField: "Accept-Encoding") == "identity")
        precondition(request.value(forHTTPHeaderField: "Authorization") == nil)
        guard !reply.stall else { return }
        let response = HTTPURLResponse(url: url, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        var offset = 0
        while offset < reply.body.count {
            let end = min(reply.body.count, offset + 8192)
            client?.urlProtocol(self, didLoad: reply.body.subdata(in: offset..<end))
            offset = end
        }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main
struct NimloUpdateManifestCheck {
    static var checks = [String]()
    static let key = Curve25519.Signing.PrivateKey()
    static let bundle = "dev.nimlo.editor"
    static let archive = Data((0..<100_000).map { UInt8($0 % 251) })

    static func check(_ name: String, _ condition: @autoclosure () throws -> Bool) {
        do { let accepted = try condition(); precondition(accepted, "FAIL: " + name) }
        catch { preconditionFailure("FAIL: " + name + ": " + error.localizedDescription) }
        checks.append(name)
    }

    static func payload(_ changes: [String: Any] = [:]) -> [String: Any] {
        var value: [String: Any] = [
            "schema": 1, "bundleIdentifier": bundle, "version": "1.2.3", "build": 12,
            "publishedAt": "2026-10-15T12:30:00Z", "minimumSystemVersion": "13.3", "architecture": "arm64",
            "url": "https://updates.example.test/download", "size": archive.count,
            "sha256": SHA256.hash(data: archive).map { String(format: "%02x", $0) }.joined(),
            "releaseNotes": "A smoother editor.\nYour projects stay in place."
        ]
        value.merge(changes) { _, new in new }
        return value
    }

    static func signed(_ object: [String: Any]) throws -> Data {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return try envelope(data, signature: key.signature(for: data))
    }

    static func envelope(_ data: Data, signature: Data) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["payload": data.base64EncodedString(), "signature": signature.base64EncodedString()])
    }

    static func verify(_ data: Data, publicKey: Data = key.publicKey.rawRepresentation,
                       currentBuild: Int = 11, architecture: String = "arm64", system: String = "13.3") throws -> NimloUpdateManifest {
        try NimloUpdateManifest.verify(envelope: data, publicKey: publicKey, bundleIdentifier: bundle,
                                       currentBuild: currentBuild, architecture: architecture, systemVersion: system)
    }

    static func rejects(_ name: String, _ operation: () throws -> Void) {
        do { try operation(); preconditionFailure("FAIL: accepted " + name) }
        catch { checks.append(name) }
    }

    static func configuration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [UpdateFixtureProtocol.self]
        return config
    }

    static func transfer<T>(_ start: (@escaping (Result<T, Error>) -> Void) -> NimloUpdateRequest,
                            cancel: Bool = false) -> Result<T, Error> {
        var result: Result<T, Error>?
        let request = start { value in
            precondition(Thread.isMainThread, "Completion must run on main thread")
            precondition(result == nil, "Completion must run exactly once")
            result = value
        }
        if cancel { request.cancel() }
        let deadline = Date().addingTimeInterval(10)
        withExtendedLifetime(request) {
            while result == nil && Date() < deadline {
                _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
            }
        }
        guard let result else { preconditionFailure("Transfer timed out") }
        return result
    }

    static func fetch(_ path: String, cancel: Bool = false) -> Result<Data, Error> {
        transfer({ done in NimloUpdateTransport.fetchManifest(from: URL(string: "https://updates.example.test" + path)!,
                                                              configuration: configuration(), completion: done) }, cancel: cancel)
    }

    static func failed<T>(_ result: Result<T, Error>) -> Bool {
        if case .failure = result { return true }; return false
    }

    static func main() throws {
        let fm = FileManager.default
        let temporary = fm.temporaryDirectory.appendingPathComponent("nimlo-update-manifest-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: temporary) }
        let valid = try signed(payload())
        let manifest = try verify(valid)
        check("valid Ed25519-signed release", manifest.build == 12 && manifest.releaseNotes.contains("smoother"))
        check("legacy release retains automatic install policy", !manifest.requiresManualInstallation)
        check("signed unnotarized release requests manual installation", try verify(signed(payload(["distribution": "unnotarized"]))).requiresManualInstallation)
        rejects("unknown release distribution") { _ = try verify(signed(payload(["distribution": "unknown"]))) }
        check("numeric OS comparison", try verify(valid, system: "13.10").build == 12)
        check("universal architecture", try verify(signed(payload(["architecture": "universal"])), architecture: "x86_64").build == 12)
        check("fractional ISO8601 timestamp", try verify(signed(payload(["publishedAt": "2026-10-15T12:30:00.123Z"]))).build == 12)
        rejects("wrong signing key") { _ = try verify(valid, publicKey: Curve25519.Signing.PrivateKey().publicKey.rawRepresentation) }
        rejects("truncated public key") { _ = try verify(valid, publicKey: Data(repeating: 0, count: 31)) }
        let original = try JSONSerialization.data(withJSONObject: payload())
        let tampered = try JSONSerialization.data(withJSONObject: payload(["version": "9.9.9"]))
        rejects("tampered payload") { _ = try verify(envelope(tampered, signature: key.signature(for: original))) }
        rejects("truncated signature") { _ = try verify(envelope(original, signature: Data(repeating: 1, count: 63))) }
        rejects("oversize envelope") { _ = try verify(Data(repeating: 32, count: NimloUpdateManifest.maximumEnvelopeBytes + 1)) }
        let hugePayload = Data(repeating: 32, count: NimloUpdateManifest.maximumPayloadBytes + 1)
        rejects("oversize signed payload") { _ = try verify(envelope(hugePayload, signature: key.signature(for: hugePayload))) }
        for (name, changes) in [
            ("wrong schema", ["schema": 2]), ("wrong bundle", ["bundleIdentifier": "dev.attacker.editor"]),
            ("nonpositive build", ["build": 0]), ("invalid version", ["version": "bad\nversion"]),
            ("invalid publication date", ["publishedAt": "yesterday"]),
            ("invalid OS version", ["minimumSystemVersion": "13.x"]),
            ("oversize notes", ["releaseNotes": String(repeating: "é", count: 8193)]),
            ("empty archive", ["size": 0]), ("oversize archive", ["size": NimloUpdateManifest.maximumArchiveBytes + 1]),
            ("invalid checksum", ["sha256": String(repeating: "g", count: 64)]),
            ("HTTP download URL", ["url": "http://updates.example.test/update.zip"]),
            ("URL credentials", ["url": "https://user:secret@updates.example.test/update.zip"]),
            ("URL fragment", ["url": "https://updates.example.test/update.zip#fragment"])
        ] as [(String, [String: Any])] {
            rejects(name) { _ = try verify(signed(payload(changes))) }
        }
        do { _ = try verify(valid, currentBuild: 12); preconditionFailure("same build accepted") }
        catch NimloUpdateError.upToDate { checks.append("same build reports up to date") }
        do { _ = try verify(valid, currentBuild: 13); preconditionFailure("downgrade accepted") }
        catch NimloUpdateError.upToDate { checks.append("downgrade rejected") }
        do { _ = try verify(valid, system: "13.2.9"); preconditionFailure("old OS accepted") }
        catch NimloUpdateError.unsupportedSystem { checks.append("minimum macOS enforced") }
        do { _ = try verify(valid, architecture: "x86_64"); preconditionFailure("wrong architecture accepted") }
        catch NimloUpdateError.unsupportedArchitecture { checks.append("Mac architecture enforced") }
        rejects("signed invalid JSON") { _ = try verify(envelope(Data("not-json".utf8), signature: key.signature(for: Data("not-json".utf8)))) }

        UpdateFixtureProtocol.replies = [
            "/manifest": FixtureReply(status: 200, headers: ["Content-Length": String(valid.count)], body: valid),
            "/oversize-header": FixtureReply(status: 200, headers: ["Content-Length": "65537"], body: Data()),
            "/overflow": FixtureReply(status: 200, headers: [:], body: Data(repeating: 32, count: 65537)),
            "/encoded": FixtureReply(status: 200, headers: ["Content-Encoding": "gzip"], body: valid),
            "/missing": FixtureReply(status: 404, headers: [:], body: Data()),
            "/empty": FixtureReply(status: 200, headers: [:], body: Data()),
            "/download": FixtureReply(status: 200, headers: ["Content-Length": String(archive.count)], body: archive),
            "/truncated": FixtureReply(status: 200, headers: ["Content-Length": String(archive.count)], body: archive.dropLast()),
            "/digest": FixtureReply(status: 200, headers: ["Content-Length": String(archive.count)], body: Data(repeating: 0, count: archive.count)),
            "/archive-overflow": FixtureReply(status: 200, headers: [:], body: archive + Data([0])),
            "/cancel": FixtureReply(status: 200, headers: [:], body: Data(), stall: true)
        ]
        check("bounded native HTTPS manifest fetch", try fetch("/manifest").get() == valid)
        for path in ["/oversize-header", "/overflow", "/encoded", "/missing", "/empty"] {
            check("reject transfer " + path, failed(fetch(path)))
        }
        check("request cancellation completes", failed(fetch("/cancel", cancel: true)))
        let before = UpdateFixtureProtocol.starts
        let unsafe: Result<Data, Error> = transfer { done in
            NimloUpdateTransport.fetchManifest(from: URL(string: "http://updates.example.test/manifest")!,
                                               configuration: configuration(), completion: done)
        }
        check("HTTP feed rejected before networking", failed(unsafe) && UpdateFixtureProtocol.starts == before)

        func download(_ item: NimloUpdateManifest, _ name: String, cancel: Bool = false) -> Result<URL, Error> {
            transfer({ done in NimloUpdateTransport.download(item, to: temporary.appendingPathComponent(name),
                                                             configuration: configuration(), completion: done) }, cancel: cancel)
        }
        let downloaded = try download(manifest, "update.zip").get()
        check("streamed archive exact bytes and SHA256", try Data(contentsOf: downloaded) == archive)
        let attrs = try fm.attributesOfItem(atPath: downloaded.path)
        check("download file owner-only permissions", (attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        check("verified archive retains Gatekeeper quarantine", getxattr(downloaded.path, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW) > 0)
        check("existing download is never overwritten", try failed(download(manifest, "update.zip")) && Data(contentsOf: downloaded) == archive)
        let symlink = temporary.appendingPathComponent("symlink.zip")
        try fm.createSymbolicLink(at: symlink, withDestinationURL: downloaded)
        check("symlink destination refused", try failed(download(manifest, "symlink.zip")) && Data(contentsOf: downloaded) == archive)
        for path in ["/truncated", "/digest", "/archive-overflow", "/cancel"] {
            let fixture = try verify(signed(payload(["url": "https://updates.example.test" + path])))
            let name = String(path.dropFirst()) + ".zip"
            check("bad archive removed " + path,
                  failed(download(fixture, name, cancel: path == "/cancel")) && !fm.fileExists(atPath: temporary.appendingPathComponent(name).path))
        }
        // Test redirect policy directly while its underlying fixture task is
        // stalled. This exercises the real delegate before any network redirect.
        let stalled = NimloUpdateTransport.fetchManifest(from: URL(string: "https://updates.example.test/cancel")!, configuration: configuration()) { _ in }
        let fixtureSession = URLSession(configuration: configuration())
        defer { fixtureSession.invalidateAndCancel(); stalled.cancel() }
        let fixtureTask = fixtureSession.dataTask(with: URL(string: "https://updates.example.test/cancel")!)
        let redirectResponse = HTTPURLResponse(url: URL(string: "https://updates.example.test/redirect")!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: [:])!
        for index in 0..<5 {
            var accepted = false
            stalled.urlSession(fixtureSession, task: fixtureTask, willPerformHTTPRedirection: redirectResponse,
                               newRequest: URLRequest(url: URL(string: "https://cdn.example.test/\(index)")!)) { accepted = $0 != nil }
            check("HTTPS redirect allowed within cap \(index + 1)", accepted)
        }
        var capped = false
        stalled.urlSession(fixtureSession, task: fixtureTask, willPerformHTTPRedirection: redirectResponse,
                           newRequest: URLRequest(url: URL(string: "https://cdn.example.test/6")!)) { capped = $0 == nil }
        check("redirect chain capped at five", capped)
        let unsafeRedirect = NimloUpdateTransport.fetchManifest(from: URL(string: "https://updates.example.test/cancel")!, configuration: configuration()) { _ in }
        defer { unsafeRedirect.cancel() }
        var refused = false
        unsafeRedirect.urlSession(fixtureSession, task: fixtureTask, willPerformHTTPRedirection: redirectResponse,
                                 newRequest: URLRequest(url: URL(string: "http://cdn.example.test/update.zip")!)) { refused = $0 == nil }
        check("HTTPS to HTTP redirect refused", refused)
        let report: [String: Any] = ["status": "passed", "checks": checks, "count": checks.count,
                                     "network": "URLProtocol HTTPS fixtures; no actual network", "signatures": "fresh ephemeral Ed25519 key"]
        let json = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--report" {
            try json.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        }
        print("PASS \(checks.count) signed manifest and native transfer checks")
    }
}
