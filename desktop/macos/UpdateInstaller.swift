import Foundation
import CryptoKit
import Security
import Darwin

// This file is compiled into both the app and the small, separately running helper.
// The helper never accepts a shell command or changes project/recovery data.
struct NimloUpdateInstallPlan: Codable {
    var formatVersion = 1
    let appPath: String
    let archivePath: String
    let envelopePath: String
    let parentPID: Int32
    let hostPID: Int32
    let relaunchArguments: [String]
    let receiptPath: String
    let nonce: String
}

enum NimloUpdateInstallError: Error, LocalizedError {
    case rejected(String)
    var errorDescription: String? {
        switch self { case .rejected(let reason): return reason }
    }
}

enum NimloUpdateInstaller {
    private struct Envelope: Decodable { let payload: String; let signature: String }
    private struct Manifest: Decodable {
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
    private struct Receipt: Codable { let nonce: String; let pid: Int32; let build: Int; let bundleIdentifier: String }
    private struct Cancellation: Codable { let nonce: String }
    private struct Status: Codable { let state: String; let message: String; let backupPath: String? }
    private struct Identity { let bundle: String; let version: String; let build: Int; let minimum: String; let key: String; let executable: URL; let team: String? }
    private static let fm = FileManager.default
    private static let archiveLimit: Int64 = 256 * 1024 * 1024
    private static let expandedLimit: UInt64 = 512 * 1024 * 1024
    private static let entryLimit = 4096

    private static func reject(_ text: String) -> NimloUpdateInstallError { .rejected(text) }

    // Returned directory intentionally survives app termination. Only the helper
    // copies and the downloaded release are stored there, never user documents.
    static func prepare(appURL: URL, archiveURL: URL, envelopeURL: URL,
                        parentPID: Int32, hostPID: Int32,
                        relaunchArguments: [String]) throws -> URL {
        let app = systemAliasURL(appURL.standardizedFileURL)
        let archiveURL = systemAliasURL(archiveURL.standardizedFileURL)
        let envelopeURL = systemAliasURL(envelopeURL.standardizedFileURL)
        try noSymlinks(app)
        let current = try identity(app)
        guard parentPID > 1, hostPID >= 0, parentPID != hostPID,
              !relaunchArguments.contains(where: { $0 == "--update-receipt" || $0 == "--update-token" }),
              relaunchArguments.count < 128,
              relaunchArguments.allSatisfy({ $0.utf8.count < 8192 && !$0.contains("\0") }) else {
            throw reject("The update restart arguments are invalid.")
        }
        let parent = app.deletingLastPathComponent()
        guard access(parent.path, W_OK) == 0 else { throw reject("Move Nimlo to a folder you can write to before updating.") }
        _ = try verifiedManifest(envelopeURL, identity: current, archive: archiveURL)
        let helper = app.appendingPathComponent("Contents/Helpers/nimlo-update-helper")
        try regular(helper, maximum: 32 * 1024 * 1024)
        let work = try privateDirectory(in: fm.temporaryDirectory.resolvingSymlinksInPath(), prefix: "nimlo-update-")
        do {
            let savedArchive = work.appendingPathComponent("release.zip")
            let savedEnvelope = work.appendingPathComponent("release.json")
            let savedHelper = work.appendingPathComponent("nimlo-update-helper")
            try fm.copyItem(at: archiveURL, to: savedArchive)
            try fm.copyItem(at: envelopeURL, to: savedEnvelope)
            try fm.copyItem(at: helper, to: savedHelper)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: savedArchive.path)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: savedEnvelope.path)
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: savedHelper.path)
            let plan = NimloUpdateInstallPlan(appPath: app.path, archivePath: savedArchive.path,
                envelopePath: savedEnvelope.path, parentPID: parentPID, hostPID: hostPID,
                relaunchArguments: relaunchArguments, receiptPath: work.appendingPathComponent("startup.json").path,
                nonce: UUID().uuidString + UUID().uuidString)
            let planURL = work.appendingPathComponent("plan.json")
            try writePrivate(JSONEncoder().encode(plan), to: planURL)
            return planURL
        } catch { try? fm.removeItem(at: work); throw error }
    }

    @discardableResult static func launch(planURL: URL) throws -> Process {
        let (_, work) = try loadPlan(planURL)
        let executable = work.appendingPathComponent("nimlo-update-helper")
        try regular(executable, maximum: 32 * 1024 * 1024)
        let log = work.appendingPathComponent("helper.log")
        try writePrivate(Data(), to: log)
        let output = try FileHandle(forWritingTo: log)
        let process = Process()
        process.executableURL = executable
        process.arguments = ["--plan", planURL.path]
        process.currentDirectoryURL = work
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = output
        try process.run()
        try? output.close()
        return process
    }

    // The app must remain open until this returns true. The helper publishes
    // "waiting" only after ZIP, identity, signature and Gatekeeper validation.
    static func installationReady(planURL: URL) throws -> Bool {
        let (_, work) = try loadPlan(planURL)
        let url = work.appendingPathComponent("status.json")
        guard fm.fileExists(atPath: url.path) else { return false }
        let result = try JSONDecoder().decode(Status.self, from: readPrivate(url, maximum: 8192))
        if ["failed", "cancelled"].contains(result.state) { throw reject(result.message) }
        return ["waiting", "starting", "complete"].contains(result.state)
    }

    // Cancellation is cooperative and never terminates the app or its host.
    // The helper checks this before swapping and while its tools/wait run.
    static func cancel(planURL: URL) throws {
        let (plan, work) = try loadPlan(planURL)
        try writePrivate(JSONEncoder().encode(Cancellation(nonce: plan.nonce)), to: work.appendingPathComponent("cancel.json"))
    }

    // Call only after the new app's welcome UI or authenticated editor is ready.
    // The private plan binds the receipt path, nonce, installed bundle and build.
    @discardableResult static func acknowledgeStartup(arguments: [String] = CommandLine.arguments) -> Bool {
        guard let i = arguments.firstIndex(of: "--update-receipt"), i + 1 < arguments.count,
              let j = arguments.firstIndex(of: "--update-token"), j + 1 < arguments.count else { return false }
        let receiptURL = systemAliasURL(URL(fileURLWithPath: arguments[i + 1]).standardizedFileURL)
        do {
            let planURL = receiptURL.deletingLastPathComponent().appendingPathComponent("plan.json")
            let (plan, _) = try loadPlan(planURL)
            guard receiptURL.path == plan.receiptPath, arguments[j + 1] == plan.nonce,
                  systemAliasURL(Bundle.main.bundleURL.standardizedFileURL).path == plan.appPath else { return false }
            let current = try identity(systemAliasURL(Bundle.main.bundleURL))
            let manifest = try verifiedManifest(URL(fileURLWithPath: plan.envelopePath), identity: current,
                archive: nil, allowCurrentBuild: true)
            guard current.build == manifest.build else { return false }
            try writePrivate(JSONEncoder().encode(Receipt(nonce: plan.nonce, pid: getpid(),
                build: current.build, bundleIdentifier: current.bundle)), to: receiptURL)
            return true
        } catch { return false }
    }

    // A separate process executes this, so orderly app/host shutdown is never
    // replaced with a kill. A timed-out shutdown simply cancels the update.
    static func install(planURL: URL) throws {
        let (plan, work) = try loadPlan(planURL)
        let planLock = try lockPrivatePlan(planURL)
        defer { close(planLock) }
        // The private download copy is never a lasting cache. Keep only the
        // small signed envelope/receipt/status needed for delayed confirmation.
        defer { try? fm.removeItem(at: URL(fileURLWithPath: plan.archivePath)) }
        try checkCancellation(plan, work: work)
        let app = URL(fileURLWithPath: plan.appPath)
        try noSymlinks(app)
        let parent = app.deletingLastPathComponent()
        guard access(parent.path, W_OK) == 0 else { throw reject("Nimlo's installation folder is not writable.") }
        let installationLock = try lockInstallation(app)
        defer { close(installationLock) }
        let current = try identity(app)
        let envelope = URL(fileURLWithPath: plan.envelopePath)
        let archive = URL(fileURLWithPath: plan.archivePath)
        let manifest = try verifiedManifest(envelope, identity: current, archive: archive)
        try validateProcess(plan.parentPID, expected: current.executable)
        if plan.hostPID > 1 { try validateProcess(plan.hostPID, expected: app.appendingPathComponent("Contents/Resources/nimlo-editor")) }
        let stage = try privateDirectory(in: parent, prefix: ".nimlo-update-")
        var swapped = false
        var keepStage = false
        var launched: Process?
        defer { if !keepStage { try? fm.removeItem(at: stage) } }
        do {
            try checkCancellation(plan, work: work)
            try inspectZIP(archive)
            try checkCancellation(plan, work: work)
            try run("/usr/bin/ditto", ["-x", "-k", archive.path, stage.path], timeout: 60,
                    cancellation: { try checkCancellation(plan, work: work) })
            try checkCancellation(plan, work: work)
            let candidate = stage.appendingPathComponent("Nimlo.app")
            try validateTree(stage)
            let replacement = try identity(candidate)
            guard replacement.bundle == manifest.bundleIdentifier, replacement.version == manifest.version,
                  replacement.build == manifest.build,
                  compareVersion(replacement.minimum, manifest.minimumSystemVersion) == 0,
                  replacement.key == current.key else { throw reject("The downloaded app does not match its signed release manifest.") }
            let required: Set<String> = manifest.architecture == "universal" ? ["arm64", "x86_64"] : [manifest.architecture]
            for executable in [replacement.executable, candidate.appendingPathComponent("Contents/Resources/nimlo-editor"), candidate.appendingPathComponent("Contents/Helpers/nimlo-update-helper")] {
                try regular(executable, maximum: archiveLimit)
                guard try binaryArchitectures(executable).isSuperset(of: required) else {
                    throw reject("The downloaded app, local host or updater does not contain the expected processor architecture.")
                }
            }
            try run("/usr/bin/codesign", ["--verify", "--deep", "--strict", candidate.path], timeout: 30,
                    cancellation: { try checkCancellation(plan, work: work) })
            if let team = current.team {
                guard replacement.team == team else { throw reject("The update was signed by a different Apple developer.") }
            }
            if current.team != nil || hasQuarantine(archive) || hasQuarantine(candidate) {
                try run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", candidate.path], timeout: 30,
                        cancellation: { try checkCancellation(plan, work: work) })
            }
            try checkCancellation(plan, work: work)
            try status("waiting", "Waiting for Nimlo and its local host to close safely.", work: work)
            let until = Date().addingTimeInterval(60)
            while alive(plan.parentPID) || alive(plan.hostPID) {
                try checkCancellation(plan, work: work)
                guard Date() < until else { throw reject("Nimlo is still running. The update was cancelled without changing your installation.") }
                Thread.sleep(forTimeInterval: 0.1)
            }
            // Recheck after the wait: another updater or manual replacement must
            // not turn this transaction into a downgrade or change of app.
            let beforeSwap = try identity(app)
            guard beforeSwap.bundle == current.bundle, beforeSwap.build == current.build,
                  beforeSwap.key == current.key else { throw reject("Nimlo changed while the update was waiting. Please check for updates again.") }
            try noSymlinks(app)
            try checkCancellation(plan, work: work)
            try swap(candidate, app)
            swapped = true
            try status("starting", "The update is installed; waiting for its startup confirmation.", backup: candidate.path, work: work)
            let child: Process
            do {
                child = try start(app, arguments: plan.relaunchArguments + ["--update-receipt", plan.receiptPath, "--update-token", plan.nonce])
                launched = child
            }
            catch {
                try swap(candidate, app); swapped = false
                _ = try? start(app, arguments: plan.relaunchArguments)
                throw reject("The update could not launch. The previous version was restored.")
            }
            let startupDeadline = Date().addingTimeInterval(45)
            while Date() < startupDeadline {
                if let data = try? readPrivate(URL(fileURLWithPath: plan.receiptPath), maximum: 4096),
                   let receipt = try? JSONDecoder().decode(Receipt.self, from: data),
                   receipt.nonce == plan.nonce, receipt.pid == child.processIdentifier,
                   receipt.build == manifest.build, receipt.bundleIdentifier == manifest.bundleIdentifier {
                    try status("complete", "Nimlo updated successfully.", work: work)
                    try? fm.removeItem(at: envelope)
                    // stage contains only the previous application bundle.
                    try? fm.removeItem(at: stage)
                    swapped = false
                    return
                }
                if !child.isRunning {
                    try swap(candidate, app); swapped = false
                    _ = try? start(app, arguments: plan.relaunchArguments)
                    throw reject("The update exited before startup completed. The previous version was restored.")
                }
                Thread.sleep(forTimeInterval: 0.1)
            }
            // Never kill a running app just because its receipt was delayed.
            // Retain its previous bundle and explain the recovery location.
            keepStage = true
            try status("unconfirmed", "The new app is still running without a startup confirmation. The previous app has been retained.", backup: candidate.path, work: work)
        } catch {
            if swapped && !(launched?.isRunning ?? false) {
                // This also covers a failure to write "starting" after swap,
                // before Process.run: restore when no new app is running.
                do {
                    try swap(stage.appendingPathComponent("Nimlo.app"), app)
                    swapped = false
                    _ = try? start(app, arguments: plan.relaunchArguments)
                } catch { keepStage = true }
            }
            if swapped { keepStage = true }
            try? status("failed", error.localizedDescription, backup: swapped ? stage.appendingPathComponent("Nimlo.app").path : nil, work: work)
            throw error
        }
    }

    private static func verifiedManifest(_ envelope: URL, identity current: Identity,
                                         archive: URL?, allowCurrentBuild: Bool = false) throws -> Manifest {
        try regular(envelope, maximum: 64 * 1024)
        let wrapper = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: envelope))
        guard let payload = Data(base64Encoded: wrapper.payload), !payload.isEmpty, payload.count <= 32 * 1024,
              let signature = Data(base64Encoded: wrapper.signature), signature.count == 64,
              let key = Data(base64Encoded: current.key), key.count == 32,
              let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: key),
              publicKey.isValidSignature(signature, for: payload) else { throw reject("The release manifest signature is invalid.") }
        let manifest = try JSONDecoder().decode(Manifest.self, from: payload)
        guard manifest.distribution == nil || manifest.distribution == "notarized" else {
            throw reject("This release requires manual installation. Download it from Check for Updates instead.")
        }
        guard manifest.schema == 1, manifest.bundleIdentifier == current.bundle,
              manifest.build > current.build || (allowCurrentBuild && manifest.build == current.build),
              manifest.build > 0, !manifest.version.isEmpty, manifest.version.utf8.count <= 64,
              !manifest.version.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
              manifest.publishedAt.utf8.count <= 64, validDate(manifest.publishedAt),
              numericVersion(manifest.minimumSystemVersion) != nil,
              compareVersion(manifest.minimumSystemVersion, ProcessInfo.processInfo.operatingSystemVersionStringComponents) <= 0,
              manifest.architecture == machineArchitecture || manifest.architecture == "universal",
              manifest.size > 0, manifest.size <= archiveLimit,
              manifest.sha256.count == 64, manifest.sha256.allSatisfy({ "0123456789abcdef".contains($0) }),
              manifest.releaseNotes.utf8.count <= 16 * 1024,
              manifest.url.utf8.count <= 4096,
              !manifest.url.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || CharacterSet.whitespacesAndNewlines.contains($0) }),
              let remote = URLComponents(string: manifest.url), remote.scheme?.lowercased() == "https", remote.host?.isEmpty == false,
              remote.user == nil, remote.password == nil, remote.fragment == nil else { throw reject("The release manifest is incompatible with this app or Mac.") }
        if let archive {
            try regular(archive, maximum: archiveLimit)
            let attributes = try fm.attributesOfItem(atPath: archive.path)
            guard (attributes[.size] as? NSNumber)?.int64Value == manifest.size else { throw reject("The update download size does not match the signed manifest.") }
            let handle = try FileHandle(forReadingFrom: archive)
            defer { try? handle.close() }
            var hash = SHA256()
            while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
            let actual = hash.finalize().map { String(format: "%02x", $0) }.joined()
            guard actual == manifest.sha256 else { throw reject("The update download failed its SHA-256 verification.") }
        }
        return manifest
    }

    private static var machineArchitecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unsupported"
        #endif
    }

    private static func identity(_ app: URL) throws -> Identity {
        try noSymlinks(app)
        let infoURL = app.appendingPathComponent("Contents/Info.plist")
        try regular(infoURL, maximum: 1024 * 1024)
        guard let info = try PropertyListSerialization.propertyList(from: Data(contentsOf: infoURL), format: nil) as? [String: Any],
              let bundle = info["CFBundleIdentifier"] as? String, ["dev.nimlo.editor", "dev.nimlo.editor.dev"].contains(bundle),
              let version = info["CFBundleShortVersionString"] as? String,
              let buildText = info["CFBundleVersion"] as? String, let build = Int(buildText), build > 0,
              let minimum = info["LSMinimumSystemVersion"] as? String,
              let key = info["NimloUpdatePublicKey"] as? String, Data(base64Encoded: key)?.count == 32,
              let executable = info["CFBundleExecutable"] as? String, executable == "Nimlo" else { throw reject("Nimlo's installation identity or update key is invalid.") }
        let binary = app.appendingPathComponent("Contents/MacOS/" + executable)
        try regular(binary, maximum: archiveLimit)
        return Identity(bundle: bundle, version: version, build: build, minimum: minimum, key: key, executable: binary, team: teamIdentifier(app))
    }

    private static func teamIdentifier(_ app: URL) -> String? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
              let dictionary = info as? [String: Any] else { return nil }
        return dictionary[kSecCodeInfoTeamIdentifier as String] as? String
    }

    private static func compareVersion(_ a: String, _ b: String) -> Int {
        guard let lhs = numericVersion(a), let rhs = numericVersion(b) else { return 1 }
        for i in 0..<3 {
            if lhs[i] != rhs[i] { return lhs[i] < rhs[i] ? -1 : 1 }
        }
        return 0
    }

    private static func numericVersion(_ value: String) -> [Int]? {
        guard value.utf8.count <= 32 else { return nil }
        let pieces = value.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(pieces.count) else { return nil }
        var result: [Int] = []
        for piece in pieces {
            guard !piece.isEmpty, piece.utf8.allSatisfy({ (48...57).contains($0) }),
                  let number = Int(piece), number <= 999999 else { return nil }
            result.append(number)
        }
        while result.count < 3 { result.append(0) }
        return result
    }

    private static func validDate(_ text: String) -> Bool {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime]
        if parser.date(from: text) != nil { return true }
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return parser.date(from: text) != nil
    }

    private static func noSymlinks(_ url: URL) throws {
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: false)
        guard url.isFileURL, url.path.hasPrefix("/"),
              url.path == "/" || parts.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw reject("An update path is invalid.") }
        var path = ""
        for part in url.path.split(separator: "/") {
            path += "/" + part
            var entry = stat()
            guard lstat(path, &entry) == 0, entry.st_mode & S_IFMT != S_IFLNK else { throw reject("Update paths must exist and cannot contain symbolic links.") }
        }
    }

    private static func systemAliasURL(_ url: URL) -> URL {
        // macOS provides these fixed system aliases; do not resolve arbitrary
        // caller-controlled links in an installation or downloaded payload.
        if url.path.hasPrefix("/var/") || url.path.hasPrefix("/tmp/") {
            return URL(fileURLWithPath: "/private" + url.path)
        }
        return url
    }

    private static func regular(_ url: URL, maximum: Int64) throws {
        try noSymlinks(url)
        var entry = stat()
        guard lstat(url.path, &entry) == 0, entry.st_mode & S_IFMT == S_IFREG,
              entry.st_size >= 0, entry.st_size <= maximum else { throw reject("An update file is invalid or exceeds its size limit.") }
    }

    private static func privateDirectory(in parent: URL, prefix: String) throws -> URL {
        // Foundation deliberately preserves /var aliases on macOS. realpath is
        // needed to make the private system temporary directory unambiguous.
        guard let resolved = realpath(parent.path, nil) else { throw reject("The update staging parent does not exist.") }
        let canonical = URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
        free(resolved)
        try noSymlinks(canonical)
        var template = Array(canonical.appendingPathComponent(prefix + "XXXXXX").path.utf8CString)
        guard let created = mkdtemp(&template) else { throw reject("Could not create a private update staging folder.") }
        let url = URL(fileURLWithPath: String(cString: created), isDirectory: true)
        guard chmod(url.path, 0o700) == 0 else { throw reject("Could not protect the update staging folder.") }
        return url
    }

    private static func writePrivate(_ data: Data, to url: URL) throws {
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".write-" + UUID().uuidString)
        let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw reject("Could not write the private update state.") }
        defer { close(descriptor); try? fm.removeItem(at: temporary) }
        guard fchmod(descriptor, 0o600) == 0 else { throw reject("Could not protect the private update state.") }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                guard count > 0 else { throw reject("Could not finish writing update state.") }
                offset += count
            }
        }
        guard fsync(descriptor) == 0 else { throw reject("Could not save the update state.") }
        var previous = stat()
        if lstat(url.path, &previous) == 0 {
            guard previous.st_mode & S_IFMT == S_IFREG, previous.st_uid == getuid(), previous.st_nlink == 1,
                  previous.st_mode & 0o077 == 0 else { throw reject("The existing update state is not a private regular file.") }
        } else if errno != ENOENT { throw reject("Could not inspect the update state destination.") }
        guard rename(temporary.path, url.path) == 0 else { throw reject("Could not atomically publish the update state.") }
    }

    private static func readPrivate(_ url: URL, maximum: Int64) throws -> Data {
        try regular(url, maximum: maximum)
        var entry = stat()
        guard lstat(url.path, &entry) == 0, entry.st_uid == getuid(), entry.st_mode & 0o077 == 0 else { throw reject("The update state is not private to this user.") }
        return try Data(contentsOf: url)
    }

    private static func loadPlan(_ url: URL) throws -> (NimloUpdateInstallPlan, URL) {
        let url = systemAliasURL(url)
        let work = url.deletingLastPathComponent()
        try noSymlinks(work)
        var entry = stat()
        guard lstat(work.path, &entry) == 0, entry.st_mode & S_IFMT == S_IFDIR,
              entry.st_uid == getuid(), entry.st_mode & 0o077 == 0,
              url.lastPathComponent == "plan.json" else { throw reject("The update plan directory is not private.") }
        let plan = try JSONDecoder().decode(NimloUpdateInstallPlan.self, from: readPrivate(url, maximum: 64 * 1024))
        guard plan.formatVersion == 1, plan.parentPID > 1, plan.hostPID >= 0, plan.parentPID != plan.hostPID,
              plan.nonce.utf8.count >= 64, plan.nonce.utf8.count <= 128,
              plan.archivePath == work.appendingPathComponent("release.zip").path,
              plan.envelopePath == work.appendingPathComponent("release.json").path,
              plan.receiptPath == work.appendingPathComponent("startup.json").path,
              plan.relaunchArguments.count < 128,
              plan.relaunchArguments.allSatisfy({ $0.utf8.count < 8192 && !$0.contains("\0") && $0 != "--update-receipt" && $0 != "--update-token" }) else { throw reject("The private update plan is invalid.") }
        return (plan, work)
    }

    private static func status(_ state: String, _ message: String, backup: String? = nil, work: URL) throws {
        try writePrivate(JSONEncoder().encode(Status(state: state, message: message, backupPath: backup)), to: work.appendingPathComponent("status.json"))
    }

    private static func checkCancellation(_ plan: NimloUpdateInstallPlan, work: URL) throws {
        let url = work.appendingPathComponent("cancel.json")
        guard fm.fileExists(atPath: url.path) else { return }
        let record = try JSONDecoder().decode(Cancellation.self, from: readPrivate(url, maximum: 4096))
        guard record.nonce == plan.nonce else { throw reject("The update cancellation state is invalid.") }
        let message = "The update was cancelled. Nimlo's current installation was kept."
        try? status("cancelled", message, work: work)
        throw reject(message)
    }

    private static func alive(_ pid: Int32) -> Bool { pid > 1 && (kill(pid, 0) == 0 || errno == EPERM) }

    private static func lockPrivatePlan(_ url: URL) throws -> Int32 {
        let descriptor = open(systemAliasURL(url).path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw reject("Could not open the private update plan.") }
        var entry = stat()
        guard fstat(descriptor, &entry) == 0, entry.st_uid == getuid(),
              entry.st_mode & S_IFMT == S_IFREG, entry.st_mode & 0o077 == 0, entry.st_nlink == 1,
              flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            throw reject("This private update plan is already running or is not safe to use.")
        }
        return descriptor
    }

    private static func lockInstallation(_ app: URL) throws -> Int32 {
        let suffix = SHA256.hash(data: Data(app.path.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
        let url = app.deletingLastPathComponent().appendingPathComponent(".nimlo-update-lock-" + suffix)
        let descriptor = open(url.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw reject("Could not lock the Nimlo installation for updating.") }
        var entry = stat()
        guard fstat(descriptor, &entry) == 0, entry.st_mode & S_IFMT == S_IFREG,
              entry.st_uid == getuid(), entry.st_nlink == 1, entry.st_mode & 0o077 == 0,
              flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            throw reject("Another updater is already using this installation, or its lock is not private.")
        }
        return descriptor
    }

    private static func validateProcess(_ pid: Int32, expected: URL) throws {
        guard alive(pid) else { return }
        var buffer = [CChar](repeating: 0, count: 4096)
        let count = nimlo_proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard count > 0, systemAliasURL(URL(fileURLWithPath: String(cString: buffer)).standardizedFileURL).path == expected.path else {
            throw reject("The update plan does not refer to the running Nimlo processes.")
        }
    }

    private static func run(_ executable: String, _ arguments: [String], timeout: TimeInterval,
                            cancellation: (() throws -> Void)? = nil) throws {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executable)
        task.arguments = arguments
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try task.run()
        let deadline = Date().addingTimeInterval(timeout)
        while task.isRunning && Date() < deadline {
            do { try cancellation?() }
            catch { stopTool(task); throw error }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if task.isRunning {
            stopTool(task)
            throw reject("The update verification tool timed out.")
        }
        guard task.terminationStatus == 0 else { throw reject("The update could not be verified by " + URL(fileURLWithPath: executable).lastPathComponent + ".") }
    }

    private static func stopTool(_ task: Process) {
        guard task.isRunning else { return }
        task.terminate()
        let stop = Date().addingTimeInterval(2)
        while task.isRunning && Date() < stop { Thread.sleep(forTimeInterval: 0.05) }
        // Only our own fixed verification/extraction tool, never Nimlo or its
        // host, may be killed. Reap it before removing its staging area.
        if task.isRunning { _ = kill(task.processIdentifier, SIGKILL) }
        task.waitUntilExit()
    }

    private static func start(_ app: URL, arguments: [String]) throws -> Process {
        let executable = try identity(app).executable
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        return process
    }

    private static func swap(_ a: URL, _ b: URL) throws {
        guard a.withUnsafeFileSystemRepresentation({ first in b.withUnsafeFileSystemRepresentation { second in
            renamex_np(first, second, UInt32(RENAME_SWAP))
        } }) == 0 else { throw reject("The update could not atomically replace Nimlo. The current installation was kept.") }
    }

    private static func hasQuarantine(_ url: URL) -> Bool {
        getxattr(url.path, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW) >= 0
    }

    private static func validateTree(_ stage: URL) throws {
        guard let iterator = fm.enumerator(at: stage, includingPropertiesForKeys: nil) else { throw reject("Could not inspect the extracted update.") }
        var total: UInt64 = 0, count = 0
        for case let url as URL in iterator {
            count += 1
            var entry = stat()
            guard count <= entryLimit + 32, lstat(url.path, &entry) == 0,
                  [S_IFDIR, S_IFREG].contains(entry.st_mode & S_IFMT), entry.st_nlink <= (entry.st_mode & S_IFMT == S_IFDIR ? UInt16.max : 1) else {
                throw reject("The extracted update contains an unsupported link or file type.")
            }
            total += UInt64(max(0, entry.st_size))
            guard total <= expandedLimit else { throw reject("The extracted update is too large.") }
        }
    }

    private static func binaryArchitectures(_ executable: URL) throws -> Set<String> {
        let data = try Data(contentsOf: executable, options: .mappedIfSafe)
        guard data.count >= 8 else { throw reject("The update executable is invalid.") }
        func name(_ type: UInt32) -> String? {
            switch type { case 0x0100000c: return "arm64"; case 0x01000007: return "x86_64"; default: return nil }
        }
        let magic = data.u32(0)
        if magic == 0xfeedfacf || magic == 0xfeedface { return Set(name(data.u32(4)).map { [$0] } ?? []) }
        guard magic == 0xbebafeca || magic == 0xbfbafeca else { throw reject("The update executable is not a supported Mach-O binary.") }
        let count = Int(data.u32be(4)), stride = magic == 0xbfbafeca ? 32 : 20
        guard count <= 16, 8 + count * stride <= data.count else { throw reject("The universal update executable is invalid.") }
        return Set((0..<count).compactMap { name(data.u32be(8 + $0 * stride)) })
    }

    // Inspect both central and local headers before invoking the system ZIP
    // extractor. No ZIP64, encryption, links, special files, duplicate/colliding
    // paths, alternate Unicode-path metadata, or unbounded expansion is accepted.
    private static func inspectZIP(_ archive: URL) throws {
        let data = try Data(contentsOf: archive, options: .mappedIfSafe)
        guard data.count >= 22, data.count <= archiveLimit else { throw reject("The update ZIP is invalid.") }
        var eocd: Int?
        for i in stride(from: data.count - 22, through: max(0, data.count - 65557), by: -1) {
            if data.u32(i) == 0x06054b50, i + 22 + Int(data.u16(i + 20)) == data.count { eocd = i; break }
        }
        guard let end = eocd, data.u16(end + 4) == 0, data.u16(end + 6) == 0,
              data.u16(end + 8) == data.u16(end + 10) else { throw reject("Split or malformed ZIP updates are not supported.") }
        let count = Int(data.u16(end + 10)), size = Int(data.u32(end + 12)), offset = Int(data.u32(end + 16))
        guard count > 0, count <= entryLimit, offset >= 0, size > 0, offset + size == end else { throw reject("The update ZIP directory is invalid.") }
        var cursor = offset, expanded: UInt64 = 0
        var paths = Set<String>(), ranges: [Range<Int>] = []
        for _ in 0..<count {
            guard cursor + 46 <= end, data.u32(cursor) == 0x02014b50 else { throw reject("The update ZIP directory is truncated.") }
            let flags = data.u16(cursor + 8), method = data.u16(cursor + 10)
            let crc = data.u32(cursor + 16), compressed = Int(data.u32(cursor + 20)), uncompressed = UInt64(data.u32(cursor + 24))
            let nameSize = Int(data.u16(cursor + 28)), extraSize = Int(data.u16(cursor + 30)), commentSize = Int(data.u16(cursor + 32))
            let mode = UInt16(data.u32(cursor + 38) >> 16), local = Int(data.u32(cursor + 42))
            let next = cursor + 46 + nameSize + extraSize + commentSize
            guard next <= end, nameSize > 0, nameSize <= 1024, flags & ~UInt16(0x080e) == 0,
                  method == 0 || method == 8, data.u16(cursor + 34) == 0,
                  let path = String(data: data.subdata(in: cursor + 46..<cursor + 46 + nameSize), encoding: .utf8),
                  !path.contains("\\"), !path.contains(":"), !path.hasPrefix("/"), !path.contains("\0"),
                  !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw reject("The update ZIP contains an unsafe entry.") }
            let pieces = path.split(separator: "/", omittingEmptySubsequences: false)
            let components = path.hasSuffix("/") ? Array(pieces.dropLast()) : pieces
            guard !components.isEmpty, components.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }),
                  components[0] == "Nimlo.app" ||
                    (components[0] == "__MACOSX" && ((components.count == 1 && path.hasSuffix("/")) || (components.count >= 2 && components[1] == "Nimlo.app"))) else {
                throw reject("The update ZIP may contain only Nimlo.app and its resource metadata.")
            }
            let normalized = String(path.drop(while: { $0 == "/" })).trimmingCharacters(in: CharacterSet(charactersIn: "/")).precomposedStringWithCanonicalMapping.lowercased()
            guard paths.insert(normalized).inserted else { throw reject("The update ZIP contains duplicate paths.") }
            let type = mode & 0xf000
            guard type == 0 || type == UInt16(S_IFREG) || type == UInt16(S_IFDIR), mode & 0o6000 == 0,
                  (type != UInt16(S_IFDIR) || path.hasSuffix("/")),
                  (!path.hasSuffix("/") || uncompressed == 0),
                  method != 0 || compressed == Int(uncompressed) else { throw reject("The update ZIP contains a link or unsupported file type.") }
            expanded += uncompressed
            guard expanded <= expandedLimit, uncompressed <= expandedLimit,
                  uncompressed <= UInt64(max(compressed, 1)) * 2000 else { throw reject("The update ZIP exceeds its extraction limits.") }
            try checkExtra(data, range: cursor + 46 + nameSize..<cursor + 46 + nameSize + extraSize)
            guard local + 30 <= offset, data.u32(local) == 0x04034b50,
                  data.u16(local + 6) == flags, data.u16(local + 8) == method,
                  Int(data.u16(local + 26)) == nameSize else { throw reject("The ZIP local and central entries disagree.") }
            let localExtra = Int(data.u16(local + 28)), payload = local + 30 + nameSize + localExtra
            guard payload <= offset, compressed <= offset - payload,
                  data.subdata(in: local + 30..<local + 30 + nameSize) == data.subdata(in: cursor + 46..<cursor + 46 + nameSize) else {
                throw reject("The ZIP local filename does not match its signed archive directory.")
            }
            try checkExtra(data, range: local + 30 + nameSize..<payload)
            var payloadEnd = payload + compressed
            if flags & 8 == 0 {
                guard data.u32(local + 14) == crc, data.u32(local + 18) == UInt32(compressed), data.u32(local + 22) == UInt32(uncompressed) else { throw reject("The ZIP local sizes are inconsistent.") }
            } else {
                let descriptor = payloadEnd + (data.u32(payloadEnd) == 0x08074b50 ? 4 : 0)
                guard descriptor + 12 <= offset, data.u32(descriptor) == crc,
                      data.u32(descriptor + 4) == UInt32(compressed), data.u32(descriptor + 8) == UInt32(uncompressed) else { throw reject("The ZIP streaming descriptor is inconsistent.") }
                payloadEnd = descriptor + 12
            }
            ranges.append(local..<payloadEnd)
            cursor = next
        }
        guard cursor == end, paths.contains("nimlo.app/contents/info.plist"), paths.contains("nimlo.app/contents/macos/nimlo") else { throw reject("The update ZIP is missing Nimlo's application files.") }
        let ordered = ranges.sorted { $0.lowerBound < $1.lowerBound }
        var position = 0
        for range in ordered {
            guard range.lowerBound == position else { throw reject("The update ZIP contains overlapping or hidden local entries.") }
            position = range.upperBound
        }
        guard position == offset else { throw reject("The update ZIP contains unlisted data.") }
    }

    private static func checkExtra(_ data: Data, range: Range<Int>) throws {
        var i = range.lowerBound
        while i < range.upperBound {
            guard i + 4 <= range.upperBound else { throw reject("The ZIP extra fields are truncated.") }
            let tag = data.u16(i), size = Int(data.u16(i + 2))
            // These timestamp/UID/GID fields cannot override a filename or file
            // type. Reject unknown extras too: some Unix/NTFS extensions can
            // otherwise encode links independently of the central Unix mode.
            guard [UInt16(0x5455), 0x5855, 0x7855, 0x7875].contains(tag), size <= 32,
                  i + 4 + size <= range.upperBound else { throw reject("The ZIP contains unsupported path, link or ZIP64 metadata.") }
            i += 4 + size
        }
    }
}

private extension ProcessInfo {
    var operatingSystemVersionStringComponents: String {
        let v = operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }
}

private extension Data {
    func u16(_ offset: Int) -> UInt16 {
        guard offset >= 0, offset + 2 <= count else { return 0xffff }
        return UInt16(self[offset]) | UInt16(self[offset + 1]) << 8
    }
    func u32(_ offset: Int) -> UInt32 {
        guard offset >= 0, offset + 4 <= count else { return 0xffffffff }
        return UInt32(self[offset]) | UInt32(self[offset + 1]) << 8 | UInt32(self[offset + 2]) << 16 | UInt32(self[offset + 3]) << 24
    }
    func u32be(_ offset: Int) -> UInt32 { u32(offset).byteSwapped }
}

@_silgen_name("proc_pidpath")
private func nimlo_proc_pidpath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer, _ buffersize: UInt32) -> Int32
