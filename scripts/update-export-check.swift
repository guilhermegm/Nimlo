import Foundation
import CryptoKit
import Darwin

// Exercises the actual manual-export function. No NSApplication, dialogs,
// Downloads directory, network, installed app, or installer is used.
@main
struct UpdateExportCheck {
    static func main() throws {
        let manager = FileManager.default
        let root = manager.temporaryDirectory.appendingPathComponent("nimlo-export-check-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: root) }
        let arguments = CommandLine.arguments
        let reportURL: URL
        if let at = arguments.firstIndex(of: "--report"), at + 1 < arguments.count {
            reportURL = URL(fileURLWithPath: arguments[at + 1])
        } else { reportURL = URL(fileURLWithPath: "target/update-export-review/report.json") }
        var checks = [String]()
        func check(_ name: String, _ condition: @autoclosure () throws -> Bool) throws {
            guard try condition() else { throw NSError(domain: "UpdateExportCheck", code: 1, userInfo: [NSLocalizedDescriptionKey: name]) }
            checks.append(name)
        }
        func rejects(_ name: String, _ action: () throws -> Void) throws {
            var rejected = false
            do { try action() } catch { rejected = true }
            try check(name, rejected)
        }
        func report(_ passed: Bool, error: String? = nil) throws {
            var value: [String: Any] = ["passed": passed, "count": checks.count, "checks": checks,
                                      "networkUsed": false, "dialogsShown": false, "installedAppTouched": false]
            if let error { value["error"] = error }
            try manager.createDirectory(at: reportURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]).write(to: reportURL, options: [.atomic])
        }
        let key = Curve25519.Signing.PrivateKey()
        let bytes = Data((0..<(1024 * 1024 + 17)).map { UInt8($0 % 251) })
        let checksum = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        func signed(_ changes: [String: Any] = [:], removeDistribution: Bool = false) throws -> Data {
            var payload: [String: Any] = ["schema": 1, "bundleIdentifier": "dev.nimlo.editor", "version": "0.2.0", "build": 2,
                "publishedAt": "2026-10-16T00:00:00Z", "minimumSystemVersion": "13.3", "architecture": NimloUpdater.architecture,
                "url": "https://updates.example.invalid/Nimlo.zip", "size": bytes.count, "sha256": checksum,
                "releaseNotes": "Temporary export fixture.", "distribution": "unnotarized"]
            for (name, value) in changes { payload[name] = value }
            if removeDistribution { payload.removeValue(forKey: "distribution") }
            let encoded = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            return try JSONSerialization.data(withJSONObject: ["payload": encoded.base64EncodedString(), "signature": key.signature(for: encoded).base64EncodedString()])
        }
        func verify(_ envelope: Data) throws -> NimloUpdateManifest {
            try NimloUpdateManifest.verify(envelope: envelope, publicKey: key.publicKey.rawRepresentation,
                bundleIdentifier: "dev.nimlo.editor", currentBuild: 1, architecture: NimloUpdater.architecture, systemVersion: "99.0")
        }
        func attribute(_ file: URL) throws -> Data? {
            let count = getxattr(file.path, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW)
            if count < 0 { return nil }
            var data = Data(count: count)
            let read = data.withUnsafeMutableBytes { getxattr(file.path, "com.apple.quarantine", $0.baseAddress, $0.count, 0, XATTR_NOFOLLOW) }
            guard read == count else { throw NSError(domain: "UpdateExportCheck", code: 2) }
            return data
        }
        func permissions(_ file: URL) throws -> Int {
            (try manager.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
        }
        let source = root.appendingPathComponent("source.zip")
        try bytes.write(to: source)
        try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: source.path)
        do {
            let manifest = try verify(signed())
            try check("verified unnotarized release uses manual installation", manifest.requiresManualInstallation)
            let saved = root.appendingPathComponent("saved.zip")
            try NimloUpdater.saveVerifiedArchive(manifest, from: source, to: saved)
            try check("export preserves every verified byte across chunk boundaries", try Data(contentsOf: saved) == bytes)
            try check("export output permissions are exactly 0600", try permissions(saved) == 0o600)
            try check("export adds macOS quarantine even when source lacked it", try attribute(saved)?.isEmpty == false)
            try check("export leaves source bytes and attributes untouched", try Data(contentsOf: source) == bytes && attribute(source) == nil)
            let quarantine = Data("0081;00000000;ExportFixture;original-origin".utf8)
            let set = quarantine.withUnsafeBytes { setxattr(source.path, "com.apple.quarantine", $0.baseAddress, $0.count, 0, XATTR_CREATE) }
            try check("fixture sets source quarantine", set == 0)
            let quarantined = root.appendingPathComponent("quarantined.zip")
            try NimloUpdater.saveVerifiedArchive(manifest, from: source, to: quarantined)
            try check("already quarantined source remains quarantined", try attribute(source) == quarantine)
            try check("export enforces quarantine on saved download", try attribute(quarantined)?.isEmpty == false)
            let restrictive = root.appendingPathComponent("restrictive-umask.zip")
            do {
                let original = umask(0o777)
                defer { umask(original) }
                try NimloUpdater.saveVerifiedArchive(manifest, from: source, to: restrictive)
            }
            try check("restrictive inherited umask still yields usable private output", try permissions(restrictive) == 0o600 && Data(contentsOf: restrictive) == bytes)
            let existing = root.appendingPathComponent("existing.zip"), existingBytes = Data("preserve existing file".utf8)
            try existingBytes.write(to: existing)
            try manager.setAttributes([.posixPermissions: 0o644], ofItemAtPath: existing.path)
            try rejects("existing export destination is rejected") { try NimloUpdater.saveVerifiedArchive(manifest, from: source, to: existing) }
            try check("existing destination bytes and permissions are preserved", try Data(contentsOf: existing) == existingBytes && permissions(existing) == 0o644)
            let destinationLink = root.appendingPathComponent("destination-link.zip")
            try manager.createSymbolicLink(at: destinationLink, withDestinationURL: existing)
            try rejects("destination symlink is rejected") { try NimloUpdater.saveVerifiedArchive(manifest, from: source, to: destinationLink) }
            try check("destination symlink and target remain intact", try manager.destinationOfSymbolicLink(atPath: destinationLink.path) == existing.path && Data(contentsOf: existing) == existingBytes)
            let sourceLink = root.appendingPathComponent("source-link.zip"), sourceLinkOutput = root.appendingPathComponent("source-link-output.zip")
            try manager.createSymbolicLink(at: sourceLink, withDestinationURL: source)
            try rejects("source symlink is rejected") { try NimloUpdater.saveVerifiedArchive(manifest, from: sourceLink, to: sourceLinkOutput) }
            try check("source symlink failure creates no destination", !manager.fileExists(atPath: sourceLinkOutput.path))
            try rejects("source and destination cannot be the same file") { try NimloUpdater.saveVerifiedArchive(manifest, from: source, to: source) }
            try check("same-file refusal preserves source", try Data(contentsOf: source) == bytes)
            let directory = root.appendingPathComponent("directory", isDirectory: true)
            try manager.createDirectory(at: directory, withIntermediateDirectories: false)
            try rejects("nonregular source is rejected") { try NimloUpdater.saveVerifiedArchive(manifest, from: directory, to: root.appendingPathComponent("directory-output.zip")) }
            let fifo = root.appendingPathComponent("source-fifo")
            try check("fixture creates FIFO", mkfifo(fifo.path, 0o600) == 0)
            try rejects("FIFO source is rejected without blocking") { try NimloUpdater.saveVerifiedArchive(manifest, from: fifo, to: root.appendingPathComponent("fifo-output.zip")) }
            let wrongSize = try verify(signed(["size": bytes.count - 1])), wrongSizeOutput = root.appendingPathComponent("wrong-size.zip")
            try rejects("signed size mismatch is rejected") { try NimloUpdater.saveVerifiedArchive(wrongSize, from: source, to: wrongSizeOutput) }
            try check("size mismatch leaves no output", !manager.fileExists(atPath: wrongSizeOutput.path))
            let wrongHash = try verify(signed(["sha256": String(repeating: "0", count: 64)])), wrongHashOutput = root.appendingPathComponent("wrong-hash.zip")
            try rejects("signed SHA256 mismatch is rejected after copying") { try NimloUpdater.saveVerifiedArchive(wrongHash, from: source, to: wrongHashOutput) }
            try check("failed partial export is removed", !manager.fileExists(atPath: wrongHashOutput.path))
            try check("failed partial export leaves source intact", try Data(contentsOf: source) == bytes && attribute(source) == quarantine)
            let https = URL(string: "https://updates.example.invalid/Nimlo.zip")!
            try rejects("remote source URL cannot be exported") { try NimloUpdater.saveVerifiedArchive(manifest, from: https, to: root.appendingPathComponent("remote-source.zip")) }
            try rejects("remote destination URL cannot be used") { try NimloUpdater.saveVerifiedArchive(manifest, from: source, to: https) }
            let legacy = try verify(signed(removeDistribution: true))
            try check("legacy signed distribution retains automatic policy", !legacy.requiresManualInstallation)
            try rejects("manual exporter rejects legacy automatic release") { try NimloUpdater.saveVerifiedArchive(legacy, from: source, to: root.appendingPathComponent("legacy.zip")) }
            let notarized = try verify(signed(["distribution": "notarized"]))
            try rejects("manual exporter rejects explicit automatic release") { try NimloUpdater.saveVerifiedArchive(notarized, from: source, to: root.appendingPathComponent("notarized.zip")) }
            try rejects("unknown signed distribution is rejected before exporting") { _ = try verify(signed(["distribution": "unknown"])) }
            let unknown = try JSONDecoder().decode(NimloUpdateManifest.self, from: JSONSerialization.data(withJSONObject: ["schema": 1, "bundleIdentifier": "dev.nimlo.editor", "version": "0.2.0", "build": 2, "publishedAt": "2026-10-16T00:00:00Z", "minimumSystemVersion": "13.3", "architecture": NimloUpdater.architecture, "url": https.absoluteString, "size": bytes.count, "sha256": checksum, "releaseNotes": "", "distribution": "unknown"]))
            try rejects("manual exporter independently rejects unknown distribution") { try NimloUpdater.saveVerifiedArchive(unknown, from: source, to: root.appendingPathComponent("unknown.zip")) }
            let envelope = try JSONSerialization.jsonObject(with: signed()) as! [String: String]
            var payload = try JSONSerialization.jsonObject(with: Data(base64Encoded: envelope["payload"]!)!) as! [String: Any]
            payload.removeValue(forKey: "distribution")
            let changed = try JSONSerialization.data(withJSONObject: ["payload": JSONSerialization.data(withJSONObject: payload).base64EncodedString(), "signature": envelope["signature"]!])
            try rejects("distribution tampering cannot promote manual release to automatic") { _ = try verify(changed) }
            try report(true)
            print("Manual export checks passed: \(checks.count)")
        } catch {
            try? report(false, error: error.localizedDescription)
            throw error
        }
    }
}
