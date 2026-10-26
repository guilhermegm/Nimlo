import Foundation
import CryptoKit
import Darwin

private let archiveLimit: Int64 = 256 * 1024 * 1024
private let manifestLimit = 64 * 1024
private let notesLimit = 16 * 1024
private let manager = FileManager.default

private struct ReleaseError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
private func fail(_ message: String) throws -> Never { throw ReleaseError(message: message) }

private struct Envelope: Codable {
    let payload: String
    let signature: String
}
private struct Release: Codable {
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
}
private struct Options {
    let command: String
    var values: [String: String] = [:]
    var localPreview = false
    var unnotarizedRelease = false
    init(_ arguments: [String]) throws {
        guard let first = arguments.first else { try fail(usage) }
        command = first
        var i = 1
        while i < arguments.count {
            let key = arguments[i]
            if key == "--local-preview" {
                guard !localPreview else { try fail("Duplicate option: \(key)") }
                localPreview = true
                i += 1
            } else if key == "--unnotarized-release" {
                guard !unnotarizedRelease else { try fail("Duplicate option: \(key)") }
                unnotarizedRelease = true
                i += 1
            } else {
                guard key.hasPrefix("--"), i + 1 < arguments.count, values[key] == nil else {
                    try fail("Invalid or duplicate option: \(key)\n\(usage)")
                }
                values[key] = arguments[i + 1]
                i += 2
            }
        }
    }
    func validate(_ allowed: Set<String>, preview: Bool = false) throws {
        for key in values.keys where !allowed.contains(key) { try fail("Unknown option: \(key)") }
        if localPreview && !preview { try fail("--local-preview is only valid for prepare.") }
        if unnotarizedRelease && !preview { try fail("--unnotarized-release is only valid for prepare.") }
        if unnotarizedRelease && localPreview { try fail("--unnotarized-release and --local-preview are mutually exclusive.") }
    }
    func required(_ key: String) throws -> String {
        guard let value = values[key], !value.isEmpty else { try fail("Missing \(key).\n\(usage)") }
        return value
    }
}
private let usage = """
Usage:
  scripts/update-release.sh keygen [--private-key PATH] --public-key PATH
  scripts/update-release.sh prepare --app PATH --base-url HTTPS --notes PATH --output DIR [--private-key PATH] [--local-preview | --unnotarized-release]
  scripts/update-release.sh verify --manifest PATH --public-key PATH

Private keys default to ~/Library/Application Support/Nimlo Release/ed25519.key.
Private keys must stay outside the repository and release output, in a private directory.
prepare defaults to Developer ID signed, stapled, notarized distribution.
--unnotarized-release explicitly prepares a signed-manifest manual-install release without Apple notarization.
--local-preview remains a private test fixture; it is not a publishable release.
"""
private var defaultPrivateKey: String {
    manager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Nimlo Release/ed25519.key").path
}
private func path(_ value: String) -> URL {
    URL(fileURLWithPath: (value as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath()
}
private func contains(_ directory: URL, _ item: URL) -> Bool {
    item.path == directory.path || item.path.hasPrefix(directory.path + "/")
}
private var sourceRoot: URL {
    if let root = ProcessInfo.processInfo.environment["NIMLO_RELEASE_SOURCE_ROOT"] { return path(root) }
    return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath()
}
private func privateLocation(_ location: URL) throws {
    if contains(sourceRoot, location) { try fail("Private signing keys must be stored outside the source repository.") }
    var parent = location.deletingLastPathComponent()
    while parent.path != "/" {
        if manager.fileExists(atPath: parent.appendingPathComponent(".git").path) {
            try fail("Private signing keys must not be stored inside a Git repository.")
        }
        parent.deleteLastPathComponent()
    }
}
private func privateDirectory(_ directory: URL, create: Bool) throws {
    if create { try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
    var info = stat()
    guard lstat(directory.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
          info.st_uid == geteuid(), (info.st_mode & 0o077) == 0 else {
        try fail("The private key directory must be owned by you with mode 0700. Use a dedicated private directory.")
    }
}
private func exclusiveWrite(_ data: Data, to location: URL, permissions: mode_t) throws {
    let descriptor = open(location.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, permissions)
    guard descriptor >= 0 else { try fail("Cannot create \(location.lastPathComponent): \(String(cString: strerror(errno))). Existing files are never overwritten.") }
    var succeeded = false
    defer {
        close(descriptor)
        if !succeeded { unlink(location.path) }
    }
    try data.withUnsafeBytes { bytes in
        var written = 0
        while written < bytes.count {
            let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: written), bytes.count - written)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { try fail("Could not write \(location.lastPathComponent).") }
            written += count
        }
    }
    guard fsync(descriptor) == 0 else { try fail("Could not flush \(location.lastPathComponent).") }
    succeeded = true
}
private func privateKey(at location: URL) throws -> Curve25519.Signing.PrivateKey {
    try privateLocation(location)
    try privateDirectory(location.deletingLastPathComponent(), create: false)
    let descriptor = open(location.path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { try fail("Cannot open the private signing key.") }
    defer { close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == geteuid(), (info.st_mode & 0o077) == 0, info.st_size == 32 else {
        try fail("Private key must be a 32-byte regular file owned by you with mode 0600 (or 0400).")
    }
    var data = Data(count: 32)
    let readCount = data.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress!, 32) }
    guard readCount == 32 else { try fail("Cannot read the private signing key.") }
    return try Curve25519.Signing.PrivateKey(rawRepresentation: data)
}
private func boundedData(at location: URL, limit: Int) throws -> Data {
    let handle = try FileHandle(forReadingFrom: location)
    defer { try? handle.close() }
    let data = try handle.read(upToCount: limit + 1) ?? Data()
    guard data.count <= limit else { try fail("\(location.lastPathComponent) exceeds the allowed size.") }
    return data
}
private func publicKey(at location: URL) throws -> Curve25519.Signing.PublicKey {
    let data = try boundedData(at: location, limit: 1024)
    guard let text = String(data: data, encoding: .utf8),
          let bytes = Data(base64Encoded: text.trimmingCharacters(in: .whitespacesAndNewlines)), bytes.count == 32 else {
        try fail("Public key must contain a base64-encoded 32-byte Ed25519 public key.")
    }
    return try Curve25519.Signing.PublicKey(rawRepresentation: bytes)
}
private func matches(_ string: String, _ expression: String) -> Bool {
    string.range(of: expression, options: .regularExpression) != nil
}
private func httpsURL(_ value: String, base: Bool = false) throws -> URL {
    guard value.utf8.count <= 4096, let components = URLComponents(string: value),
          components.scheme == "https", let host = components.host, !host.isEmpty,
          components.user == nil, components.password == nil, components.fragment == nil,
          !base || components.query == nil, let url = components.url else {
        try fail("Release URLs must use HTTPS, without credentials or fragments. A base URL must not have a query.")
    }
    return url
}
private func validate(_ release: Release) throws {
    guard release.schema == 1, release.bundleIdentifier == "dev.nimlo.editor",
          matches(release.version, "^[0-9]+(\\.[0-9]+){1,3}$"), release.version.utf8.count <= 32,
          release.build > 0,
          release.distribution == nil || ["notarized", "unnotarized"].contains(release.distribution!),
          matches(release.minimumSystemVersion, "^[0-9]+(\\.[0-9]+){1,2}$"),
          ["arm64", "x86_64", "universal"].contains(release.architecture),
          release.size > 0, release.size <= archiveLimit,
          matches(release.sha256, "^[0-9a-f]{64}$"),
          release.releaseNotes.utf8.count <= notesLimit,
          !release.releaseNotes.unicodeScalars.contains(where: { $0.value == 0 || ($0.value < 32 && $0 != "\n" && $0 != "\r" && $0 != "\t") }),
          ISO8601DateFormatter().date(from: release.publishedAt) != nil else {
        try fail("Invalid release metadata.")
    }
    _ = try httpsURL(release.url)
}
private func verified(_ data: Data, using key: Curve25519.Signing.PublicKey) throws -> Release {
    guard data.count <= manifestLimit,
          let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
          let payload = Data(base64Encoded: envelope.payload), payload.count <= 32 * 1024,
          let signature = Data(base64Encoded: envelope.signature), signature.count == 64,
          key.isValidSignature(signature, for: payload) else { try fail("Release manifest signature is invalid.") }
    let release = try JSONDecoder().decode(Release.self, from: payload)
    try validate(release)
    return release
}
@discardableResult private func run(_ executable: String, _ arguments: [String]) throws -> String {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = pipe
    try process.run()
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let description = String(data: output.prefix(64 * 1024), encoding: .utf8) ?? ""
    guard process.terminationStatus == 0 else {
        try fail("\(URL(fileURLWithPath: executable).lastPathComponent) failed (\(process.terminationStatus)): \(description.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    return description
}
private func architecture(of executable: URL) throws -> Set<String> {
    let result = try run("/usr/bin/lipo", ["-archs", executable.path])
    let values = Set(result.split(whereSeparator: { $0.isWhitespace }).map(String.init))
    guard !values.isEmpty, values.isSubset(of: ["arm64", "x86_64"]) else { try fail("Unsupported executable architecture.") }
    return values
}
private func signatureTeam(_ app: URL) throws -> String {
    let details = try run("/usr/bin/codesign", ["--display", "--verbose=4", app.path])
    guard details.contains("Authority=Developer ID Application:"),
          let line = details.split(separator: "\n").first(where: { $0.hasPrefix("TeamIdentifier=") }) else {
        try fail("Public releases require Developer ID Application signing. --local-preview is only for private test archives.")
    }
    let team = String(line.dropFirst("TeamIdentifier=".count))
    guard matches(team, "^[A-Z0-9]{10}$") else { try fail("Missing Developer ID team identifier.") }
    return team
}
private func digest(_ archive: URL) throws -> (Int64, String) {
    let handle = try FileHandle(forReadingFrom: archive)
    defer { try? handle.close() }
    var hasher = SHA256()
    var total: Int64 = 0
    while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
        total += Int64(chunk.count)
        guard total <= archiveLimit else { try fail("Release archive exceeds 256 MiB.") }
        hasher.update(data: chunk)
    }
    return (total, hasher.finalize().map { String(format: "%02x", $0) }.joined())
}
private func isolatedBundle(_ app: URL, excluding key: Curve25519.Signing.PrivateKey) throws {
    guard let entries = manager.enumerator(at: app, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey]) else {
        try fail("Cannot inspect the release app bundle.")
    }
    for case let entry as URL in entries {
        let attributes = try entry.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey])
        if attributes.isSymbolicLink == true && !contains(app, entry.resolvingSymlinksInPath()) {
            try fail("Release app contains a symlink outside its bundle.")
        }
        if attributes.isRegularFile == true && attributes.fileSize == 32,
           try boundedData(at: entry, limit: 32) == key.rawRepresentation {
            try fail("Release app contains the private update signing key. Remove it before packaging.")
        }
    }
}
private func lockOutput(_ output: URL) throws -> Int32 {
    let location = output.appendingPathComponent(".prepare.lock")
    let descriptor = open(location.path, O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { try fail("Cannot open the release output lock.") }
    guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
        close(descriptor)
        try fail("Another release preparation is using this output directory.")
    }
    return descriptor
}
private func keygen(_ options: Options) throws {
    try options.validate(["--private-key", "--public-key"])
    let secret = path(options.values["--private-key"] ?? defaultPrivateKey)
    let destination = path(try options.required("--public-key"))
    try privateLocation(secret)
    guard secret != destination else { try fail("Private and public key paths must differ.") }
    guard !manager.fileExists(atPath: destination.path), !manager.fileExists(atPath: secret.path) else {
        try fail("A key file already exists. Key generation never overwrites existing files.")
    }
    try privateDirectory(secret.deletingLastPathComponent(), create: true)
    try manager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    let key = Curve25519.Signing.PrivateKey()
    let encoded = key.publicKey.rawRepresentation.base64EncodedString()
    try exclusiveWrite(key.rawRepresentation, to: secret, permissions: 0o600)
    do {
        try exclusiveWrite(Data((encoded + "\n").utf8), to: destination, permissions: 0o644)
    } catch {
        try? manager.removeItem(at: secret)
        throw error
    }
    print("Created signing key in the private key directory. Keep it backed up and outside release artifacts.")
    print("Public key: \(encoded)")
    print("Public key file: \(destination.path)")
}
private func prepare(_ options: Options) throws {
    try options.validate(["--app", "--base-url", "--private-key", "--notes", "--output"], preview: true)
    let sourceApp = path(try options.required("--app"))
    let output = path(try options.required("--output"))
    let secret = path(options.values["--private-key"] ?? defaultPrivateKey)
    let base = try httpsURL(try options.required("--base-url"), base: true)
    guard sourceApp.lastPathComponent == "Nimlo.app", !contains(sourceApp, output), !contains(output, sourceApp),
          !contains(sourceApp, secret), !contains(output, secret) else {
        try fail("Use a Nimlo.app bundle and separate release output. A private key must never be inside either.")
    }
    let key = try privateKey(at: secret)
    let notesData = try boundedData(at: path(try options.required("--notes")), limit: notesLimit)
    guard let notes = String(data: notesData, encoding: .utf8) else { try fail("Release notes must be UTF-8 plain text.") }
    try manager.createDirectory(at: output, withIntermediateDirectories: true)
    let lock = try lockOutput(output)
    defer { close(lock) }
    let stage = output.appendingPathComponent(".release-\(UUID().uuidString)", isDirectory: true)
    try manager.createDirectory(at: stage, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? manager.removeItem(at: stage) }
    let app = stage.appendingPathComponent("Nimlo.app", isDirectory: true)
    // Verify and package one private snapshot, even if a local build replaces the source app.
    try isolatedBundle(sourceApp, excluding: key)
    try run("/usr/bin/ditto", [sourceApp.path, app.path])
    try isolatedBundle(app, excluding: key)
    let infoData = try Data(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
    guard let info = try PropertyListSerialization.propertyList(from: infoData, format: nil) as? [String: Any],
          let bundleID = info["CFBundleIdentifier"] as? String,
          let version = info["CFBundleShortVersionString"] as? String,
          let buildText = info["CFBundleVersion"] as? String,
          matches(buildText, "^[0-9]+$"), let build = Int(buildText), build > 0,
          let minimum = info["LSMinimumSystemVersion"] as? String,
          let executableName = info["CFBundleExecutable"] as? String,
          matches(executableName, "^[A-Za-z0-9 _-]+$") else { try fail("App Info.plist is missing valid release metadata.") }
    guard let pinnedText = info["NimloUpdatePublicKey"] as? String,
          let pinnedKey = Data(base64Encoded: pinnedText), pinnedKey.count == 32,
          pinnedKey == key.publicKey.rawRepresentation else {
        try fail("The app's NimloUpdatePublicKey must match the release signing key. Rebuild with the matching pinned public key before packaging.")
    }
    if !options.localPreview {
        guard let feed = info["NimloUpdateFeedURL"] as? String, !feed.isEmpty else {
            try fail("A public release must include a nonempty HTTPS NimloUpdateFeedURL.")
        }
        do { _ = try httpsURL(feed) }
        catch { try fail("The app's NimloUpdateFeedURL must be a valid HTTPS URL without credentials or a fragment.") }
    }
    try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path])
    let executable = app.appendingPathComponent("Contents/MacOS/\(executableName)")
    let host = app.appendingPathComponent("Contents/Resources/nimlo-editor")
    let helper = app.appendingPathComponent("Contents/Helpers/nimlo-update-helper")
    let shellArch = try architecture(of: executable)
    guard shellArch == (try architecture(of: host)), shellArch == (try architecture(of: helper)) else {
        try fail("Native shell, editor host, and updater helper architectures must match.")
    }
    for binary in [executable, host, helper] { try run("/usr/bin/codesign", ["--verify", "--strict", binary.path]) }
    let arch = shellArch.count == 2 ? "universal" : shellArch.first!
    if !options.localPreview && !options.unnotarizedRelease {
        let team = try signatureTeam(app)
        guard team == (try signatureTeam(host)), team == (try signatureTeam(helper)) else { try fail("App, editor host, and updater helper must use the same Developer ID team.") }
        try run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app.path])
        try run("/usr/bin/xcrun", ["stapler", "validate", app.path])
    }
    let name = "Nimlo-\(version)-\(build)-macos-\(arch).zip"
    // Validate all metadata before creating paths from version strings.
    let provisional = Release(schema: 1, bundleIdentifier: bundleID, version: version, build: build,
                              publishedAt: ISO8601DateFormatter().string(from: Date()), minimumSystemVersion: minimum,
                              architecture: arch, url: base.appendingPathComponent(name).absoluteString,
                              size: 1, sha256: String(repeating: "0", count: 64), releaseNotes: notes,
                              distribution: options.unnotarizedRelease ? "unnotarized" : nil)
    try validate(provisional)
    let manifest = output.appendingPathComponent("latest.json")
    if manager.fileExists(atPath: manifest.path) {
        let previous = try verified(boundedData(at: manifest, limit: manifestLimit), using: key.publicKey)
        guard previous.build < build else { try fail("Release builds must increase beyond the existing signed latest.json. Use a new build number.") }
    }
    let archive = output.appendingPathComponent(name)
    guard !manager.fileExists(atPath: archive.path) else { try fail("The versioned release archive already exists. Use a new build number.") }
    let stagedArchive = stage.appendingPathComponent(name)
    try run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app.path, stagedArchive.path])
    let (size, sha256) = try digest(stagedArchive)
    let release = Release(schema: 1, bundleIdentifier: bundleID, version: version, build: build,
                          publishedAt: provisional.publishedAt, minimumSystemVersion: minimum, architecture: arch,
                          url: provisional.url, size: size, sha256: sha256, releaseNotes: notes,
                          distribution: provisional.distribution)
    try validate(release)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let payload = try encoder.encode(release)
    let signature = try key.signature(for: payload)
    let envelope = Envelope(payload: payload.base64EncodedString(), signature: signature.base64EncodedString())
    encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
    let encoded = try encoder.encode(envelope)
    _ = try verified(encoded, using: key.publicKey)
    // The immutable archive becomes visible first. latest.json changes atomically afterwards.
    try manager.moveItem(at: stagedArchive, to: archive)
    try encoded.write(to: manifest, options: [.atomic])
    if options.localPreview { print("LOCAL PREVIEW ONLY: app distribution identity and notarization were not required.") }
    if options.unnotarizedRelease { print("UNNOTARIZED RELEASE: verified manual installation; macOS may require the user's explicit approval. Quarantine and Gatekeeper are not bypassed.") }
    print("Prepared \(archive.path) (\(size) bytes)")
    print("Signed manifest: \(manifest.path)")
    print("Upload the versioned archive first, then latest.json to \(base.absoluteString).")
}
private func verify(_ options: Options) throws {
    try options.validate(["--manifest", "--public-key"])
    let key = try publicKey(at: path(try options.required("--public-key")))
    let release = try verified(boundedData(at: path(try options.required("--manifest")), limit: manifestLimit), using: key)
    print("Valid signed manifest: Nimlo \(release.version) (build \(release.build)), \(release.architecture), \(release.size) bytes.")
    print("Archive URL: \(release.url)")
    print("Distribution: \(release.distribution ?? "notarized")")
}

do {
    let options = try Options(Array(CommandLine.arguments.dropFirst()))
    switch options.command {
    case "keygen": try keygen(options)
    case "prepare": try prepare(options)
    case "verify": try verify(options)
    case "help", "--help", "-h": print(usage)
    default: try fail(usage)
    }
} catch {
    fputs("Release error: \(error.localizedDescription)\n", stderr)
    exit(1)
}
