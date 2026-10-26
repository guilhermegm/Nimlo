import AppKit
import Foundation
import Darwin

// Read-only HTTPS integration against the chosen public release. All downloads,
// preferences, and saved ZIPs are disposable; no installed application is used.
@main struct NimloLiveUpdateCheck {
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count == 7, args[1] == "--feed", args[3] == "--public-key", args[5] == "--report",
              let feed = URL(string: args[2]), NimloUpdateManifest.validHTTPS(feed) else {
            throw NimloUpdateError.invalid("Usage: --feed HTTPS_URL --public-key PATH --report PATH")
        }
        let key = try String(contentsOfFile: args[4], encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard Data(base64Encoded: key)?.count == 32 else { throw NimloUpdateError.invalid("Invalid public key.") }
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("nimlo-live-update-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: work, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: work) }
        let contents = work.appendingPathComponent("Fixture.bundle/Contents", isDirectory: true)
        try fm.createDirectory(at: contents, withIntermediateDirectories: true)
        let info: [String: Any] = ["CFBundleIdentifier": "dev.nimlo.editor", "CFBundleName": "Nimlo live update fixture",
            "CFBundlePackageType": "BNDL", "CFBundleVersion": "1", "CFBundleShortVersionString": "0.1.0",
            "NimloUpdateFeedURL": feed.absoluteString, "NimloUpdatePublicKey": key]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: contents.appendingPathComponent("Info.plist"))
        guard let bundle = Bundle(url: contents.deletingLastPathComponent()) else { throw NimloUpdateError.invalid("Could not create disposable bundle metadata.") }
        let suite = "dev.nimlo.live-update-fixture." + UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let updater = NimloUpdater(bundle: bundle, defaults: preferences, cacheRoot: work.appendingPathComponent("cache", isDirectory: true))
        var checks = [String](), failure: Error?, version: String?, build: Int?, archiveURL: String?, checksum: String?
        var offered = 0, exported = 0, revealed = 0, installed = 0
        updater.chooseUpdate = { manifest, complete in
            offered += 1
            version = manifest.version; build = manifest.build; archiveURL = manifest.url; checksum = manifest.sha256
            guard manifest.requiresManualInstallation else {
                failure = NimloUpdateError.invalid("This integration fixture expects the explicit unnotarized release channel.")
                complete(false); return
            }
            checks.append("native HTTPS fetch verifies the public Ed25519-signed manifest")
            checks.append("signed release declares manual installation")
            complete(true)
        }
        updater.saveDownload = { manifest, archive, complete in
            exported += 1
            do {
                guard getxattr(archive.path, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW) > 0 else {
                    throw NimloUpdateError.invalid("Downloaded archive is missing quarantine.")
                }
                checks.append("native streamed download verifies exact size and SHA256")
                checks.append("native downloaded archive retains quarantine")
                let destination = work.appendingPathComponent("verified-update.zip")
                try NimloUpdater.saveVerifiedArchive(manifest, from: archive, to: destination)
                guard getxattr(destination.path, "com.apple.quarantine", nil, 0, 0, XATTR_NOFOLLOW) > 0 else {
                    throw NimloUpdateError.invalid("Exported archive is missing quarantine.")
                }
                checks.append("verified manual export retains quarantine")
                complete(.success(destination))
            } catch { failure = error; complete(.failure(error)) }
        }
        updater.revealDownload = { _ in revealed += 1 }
        updater.readyToInstall = { _, _, complete in installed += 1; complete(false) }
        updater.showMessage = { kind, _, detail in
            if case .failure = kind { failure = NimloUpdateError.invalid(detail) }
        }
        guard updater.enabled else { throw NimloUpdateError.invalid("Live update configuration is disabled.") }
        updater.check()
        let deadline = Date().addingTimeInterval(180)
        while updater.busy && Date() < deadline { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02)) }
        if updater.busy { updater.cancel(); throw NimloUpdateError.invalid("Public update verification timed out.") }
        if let failure { throw failure }
        guard offered == 1, exported == 1, revealed == 1, installed == 0 else {
            throw NimloUpdateError.invalid("The public manual update flow did not complete correctly.")
        }
        checks.append("controller completes verified save and reveal without invoking installer")
        let report: [String: Any] = ["status": "passed", "count": checks.count, "checks": checks,
            "feed": feed.absoluteString, "version": version ?? "", "build": build ?? 0,
            "archiveURL": archiveURL ?? "", "sha256": checksum ?? "",
            "actualPublicHTTPS": true, "currentAppTouched": false,
            "limitations": ["Save/reveal callbacks use disposable destinations; no user interface clicked", "Unnotarized public releases require manual installation and macOS approval; automatic lifecycle is tested separately on locally trusted fixtures"]]
        let destination = URL(fileURLWithPath: args[6])
        try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: destination)
        print("PASS \(checks.count) real Firebase HTTPS update checks; Nimlo \(version ?? "")")
    }
}
