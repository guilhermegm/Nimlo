import Foundation
import CryptoKit
import Darwin

enum NimloUpdateError: LocalizedError {
    case invalid(String)
    case invalidSignature
    case upToDate
    case unsupportedSystem
    case unsupportedArchitecture
    case cancelled

    var errorDescription: String? {
        switch self {
        case .invalid(let message): return message
        case .invalidSignature: return "The update manifest could not be verified."
        case .upToDate: return "Nimlo is up to date."
        case .unsupportedSystem: return "This update requires a newer version of macOS."
        case .unsupportedArchitecture: return "This update is for a different Mac architecture."
        case .cancelled: return "The update was cancelled."
        }
    }
}

// The signature covers the exact payload bytes, not re-encoded JSON. Nothing
// from the payload is used, including its URL, before Ed25519 verification.
struct NimloUpdateManifest: Codable {
    static let maximumEnvelopeBytes = 64 * 1024
    static let maximumPayloadBytes = 32 * 1024
    static let maximumNotesBytes = 16 * 1024
    static let maximumArchiveBytes: Int64 = 256 * 1024 * 1024

    let schema: Int
    let bundleIdentifier: String
    let version: String
    let build: Int
    let publishedAt: String
    let minimumSystemVersion: String
    let architecture: String
    let url: String
    let size: Int64
    let sha256: String
    let releaseNotes: String
    let distribution: String?

    var requiresManualInstallation: Bool { distribution == "unnotarized" }

    private struct Envelope: Decodable {
        let payload: String
        let signature: String
    }

    static func verify(envelope data: Data, publicKey: Data, bundleIdentifier: String,
                       currentBuild: Int, architecture: String, systemVersion: String) throws -> Self {
        guard !data.isEmpty, data.count <= maximumEnvelopeBytes,
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              let payload = Data(base64Encoded: envelope.payload), !payload.isEmpty,
              payload.count <= maximumPayloadBytes,
              let signature = Data(base64Encoded: envelope.signature), signature.count == 64,
              publicKey.count == 32,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey),
              key.isValidSignature(signature, for: payload) else {
            throw NimloUpdateError.invalidSignature
        }
        guard String(data: payload, encoding: .utf8) != nil,
              let manifest = try? JSONDecoder().decode(Self.self, from: payload) else {
            throw NimloUpdateError.invalid("The signed update manifest is not valid JSON.")
        }
        guard manifest.schema == 1,
              !bundleIdentifier.isEmpty, manifest.bundleIdentifier == bundleIdentifier,
              manifest.version.utf8.count <= 64, !manifest.version.isEmpty,
              !manifest.version.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              manifest.build > 0, currentBuild >= 0,
              manifest.distribution == nil || ["notarized", "unnotarized"].contains(manifest.distribution!),
              manifest.publishedAt.utf8.count <= 64, validDate(manifest.publishedAt),
              manifest.releaseNotes.utf8.count <= maximumNotesBytes,
              manifest.size > 0, manifest.size <= maximumArchiveBytes,
              manifest.sha256.count == 64,
              manifest.sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              let downloadURL = URL(string: manifest.url), validHTTPS(downloadURL) else {
            throw NimloUpdateError.invalid("The signed update manifest contains invalid release information.")
        }
        guard let required = numericVersion(manifest.minimumSystemVersion),
              let running = numericVersion(systemVersion) else {
            throw NimloUpdateError.invalid("The update contains an invalid macOS version.")
        }
        guard !running.lexicographicallyPrecedes(required) else { throw NimloUpdateError.unsupportedSystem }
        guard ["arm64", "x86_64", "universal"].contains(manifest.architecture),
              ["arm64", "x86_64"].contains(architecture),
              manifest.architecture == "universal" || manifest.architecture == architecture else {
            throw NimloUpdateError.unsupportedArchitecture
        }
        guard manifest.build > currentBuild else { throw NimloUpdateError.upToDate }
        return manifest
    }

    static func validHTTPS(_ url: URL) -> Bool {
        let text = url.absoluteString
        guard text.utf8.count <= 4096,
              !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || CharacterSet.whitespacesAndNewlines.contains($0) }),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https", let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil, components.fragment == nil else { return false }
        return true
    }

    private static func numericVersion(_ value: String) -> [Int]? {
        guard value.utf8.count <= 32 else { return nil }
        let pieces = value.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(pieces.count) else { return nil }
        var result = [Int]()
        for piece in pieces {
            guard !piece.isEmpty, piece.utf8.allSatisfy({ (48...57).contains($0) }),
                  let number = Int(piece), number <= 999999 else { return nil }
            result.append(number)
        }
        while result.count < 3 { result.append(0) }
        return result
    }

    private static func validDate(_ value: String) -> Bool {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime]
        if parser.date(from: value) != nil { return true }
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: value) != nil
    }
}

enum NimloUpdateTransport {
    // A new ephemeral session exists only while an individual request runs.
    // Optional configuration injection is used by the network-free test fixture.
    @discardableResult
    static func fetchManifest(from url: URL, configuration: URLSessionConfiguration? = nil,
                              completion: @escaping (Result<Data, Error>) -> Void) -> NimloUpdateRequest {
        NimloUpdateRequest(url: url, destination: nil, manifest: nil,
                           configuration: configuration, manifestCompletion: completion, downloadCompletion: nil)
    }

    @discardableResult
    static func download(_ manifest: NimloUpdateManifest, to destination: URL,
                         configuration: URLSessionConfiguration? = nil,
                         completion: @escaping (Result<URL, Error>) -> Void) -> NimloUpdateRequest {
        NimloUpdateRequest(url: URL(string: manifest.url), destination: destination, manifest: manifest,
                           configuration: configuration, manifestCompletion: nil, downloadCompletion: completion)
    }
}

// Delegate callbacks use a serial queue. Only the small manifest is retained in
// memory; archive chunks go straight to an exclusively created, owner-only file.
final class NimloUpdateRequest: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var received: Int64 = 0
    private var redirects = 0
    private var buffer = Data()
    private var hasher = SHA256()
    private var handle: FileHandle?
    private var createdDestination: URL?
    private var finished = false
    private var responseAccepted = false
    private var failure: Error?
    private let manifest: NimloUpdateManifest?
    private let destination: URL?
    private let manifestCompletion: ((Result<Data, Error>) -> Void)?
    private let downloadCompletion: ((Result<URL, Error>) -> Void)?

    fileprivate init(url: URL?, destination: URL?, manifest: NimloUpdateManifest?,
                     configuration supplied: URLSessionConfiguration?,
                     manifestCompletion: ((Result<Data, Error>) -> Void)?,
                     downloadCompletion: ((Result<URL, Error>) -> Void)?) {
        self.manifest = manifest
        self.destination = destination
        self.manifestCompletion = manifestCompletion
        self.downloadCompletion = downloadCompletion
        super.init()
        guard let url, NimloUpdateManifest.validHTTPS(url) else {
            finish(error: NimloUpdateError.invalid("Updates require an HTTPS URL without credentials or a fragment.")); return
        }
        if let manifest {
            guard manifest.size > 0, manifest.size <= NimloUpdateManifest.maximumArchiveBytes,
                  manifest.sha256.count == 64,
                  manifest.sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                  let destination, destination.isFileURL else {
                finish(error: NimloUpdateError.invalid("The update download information is invalid.")); return
            }
            let descriptor = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else {
                finish(error: NimloUpdateError.invalid("Could not create a private update download. An existing file will not be replaced.")); return
            }
            createdDestination = destination
            handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        }
        let configuration = supplied ?? URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.timeoutIntervalForRequest = manifest == nil ? 20 : 60
        configuration.timeoutIntervalForResource = manifest == nil ? 60 : 600
        let queue = OperationQueue()
        queue.name = "dev.nimlo.update-transfer"
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.httpMethod = "GET"
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.setValue(manifest == nil ? "application/json" : "application/zip", forHTTPHeaderField: "Accept")
        task = session?.dataTask(with: request)
        task?.resume()
    }

    func cancel() { task?.cancel() }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard redirects < 5, let url = request.url, NimloUpdateManifest.validHTTPS(url) else {
            failure = NimloUpdateError.invalid("The update server returned an unsafe redirect.")
            completionHandler(nil)
            task.cancel()
            return
        }
        redirects += 1
        // Recreate the GET instead of forwarding server-provided request fields.
        var safe = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        safe.httpMethod = "GET"
        safe.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        safe.setValue(manifest == nil ? "application/json" : "application/zip", forHTTPHeaderField: "Accept")
        completionHandler(safe)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              let url = response.url, NimloUpdateManifest.validHTTPS(url),
              response.value(forHTTPHeaderField: "Content-Encoding").map({ $0.lowercased() == "identity" }) ?? true else {
            failure = NimloUpdateError.invalid("The update server returned an unexpected response.")
            completionHandler(.cancel)
            return
        }
        let expected = response.expectedContentLength
        let limit = manifest?.size ?? Int64(NimloUpdateManifest.maximumEnvelopeBytes)
        guard expected < 0 || (expected <= limit && (manifest == nil || expected == limit)) else {
            failure = NimloUpdateError.invalid("The update server returned an unexpected download size.")
            completionHandler(.cancel)
            return
        }
        responseAccepted = true
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !finished, failure == nil, responseAccepted else { return }
        let limit = manifest?.size ?? Int64(NimloUpdateManifest.maximumEnvelopeBytes)
        guard Int64(data.count) <= limit - received else {
            failure = NimloUpdateError.invalid("The update download exceeded its allowed size.")
            dataTask.cancel()
            return
        }
        received += Int64(data.count)
        if let handle {
            do { try handle.write(contentsOf: data); hasher.update(data: data) }
            catch { failure = error; dataTask.cancel() }
        } else {
            buffer.append(data)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let failure { finish(error: failure); return }
        if let error {
            let cancelled = (error as NSError).domain == NSURLErrorDomain && (error as NSError).code == NSURLErrorCancelled
            finish(error: cancelled ? NimloUpdateError.cancelled : error)
            return
        }
        guard responseAccepted else {
            finish(error: NimloUpdateError.invalid("The update server did not return a valid response.")); return
        }
        if let manifest {
            guard received == manifest.size,
                  hasher.finalize().map({ String(format: "%02x", $0) }).joined() == manifest.sha256 else {
                finish(error: NimloUpdateError.invalid("The downloaded update does not match its signed checksum.")); return
            }
            do {
                guard let handle else { throw NimloUpdateError.invalid("The update download is missing its private file.") }
                // Keep Gatekeeper's normal downloaded-app policy in force.
                // Quarantine is attached to our still-open file, never stripped
                // from the archive or its extracted application.
                let quarantine = Data(String(format: "0083;%08x;Nimlo;%@", Int(Date().timeIntervalSince1970), UUID().uuidString).utf8)
                let result = quarantine.withUnsafeBytes { bytes in
                    fsetxattr(handle.fileDescriptor, "com.apple.quarantine", bytes.baseAddress, bytes.count, 0, XATTR_CREATE)
                }
                guard result == 0 else { throw NimloUpdateError.invalid("Could not mark the downloaded update for macOS security verification.") }
                try handle.synchronize()
                try handle.close()
                self.handle = nil
            }
            catch { finish(error: error); return }
        } else if buffer.isEmpty {
            finish(error: NimloUpdateError.invalid("The update server returned an empty manifest.")); return
        }
        finish(error: nil)
    }

    private func finish(error: Error?) {
        guard !finished else { return }
        finished = true
        try? handle?.close()
        handle = nil
        if error != nil, let createdDestination { try? FileManager.default.removeItem(at: createdDestination) }
        let data = buffer
        buffer.removeAll(keepingCapacity: false)
        let resultURL = destination
        let manifestCompletion = self.manifestCompletion, downloadCompletion = self.downloadCompletion
        session?.invalidateAndCancel()
        session = nil
        // Keep this immutable-after-start task reference until deallocation so
        // cancel(), which may be called by the main thread, never races a
        // delegate-queue write to the reference. Invalidating the session breaks
        // its delegate retention when the outstanding callbacks finish.
        DispatchQueue.main.async {
            if let error {
                manifestCompletion?(.failure(error))
                downloadCompletion?(.failure(error))
            } else if let resultURL {
                downloadCompletion?(.success(resultURL))
            } else {
                manifestCompletion?(.success(data))
            }
        }
    }
}
