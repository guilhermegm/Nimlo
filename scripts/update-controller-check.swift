import AppKit
import Foundation
import CryptoKit

// UI and transport are injected. These workflows never display an alert,
// launch an installer, quit an app, or connect to a real update feed.
private final class ControllerFixture {
    static let identifier = "dev.nimlo.editor.updater-fixture"
    static let key = Curve25519.Signing.PrivateKey()
    let root: URL
    let bundle: Bundle
    let defaults: UserDefaults
    let suite: String
    let cache: URL
    var clock = Date(timeIntervalSince1970: 1_800_000_000)
    var envelope: Data
    var autoFetch = true
    var fetchFailure = false
    var fetches = 0
    var fetchCallbacks: [(Result<Data, Error>) -> Void] = []
    var downloads = 0
    var autoDownload = true
    var downloadFailure = false
    var downloadCallbacks: [(Result<URL, Error>) -> Void] = []
    var destinations = [URL]()
    var offers = [NimloUpdateManifest]()
    var consent: Bool? = false
    var choices: [(Bool) -> Void] = []
    var messages = [String]()
    var ready = 0
    var exports = 0
    var reveals = 0
    var exportCancelled = false
    var exportFailure = false
    var readyArtifactsValid = true
    var readyAccepted = false
    var stateChanges = 0

    lazy var updater: NimloUpdater = {
        let item = NimloUpdater(bundle: bundle, defaults: defaults, cacheRoot: cache, now: { [unowned self] in self.clock },
            fetch: { [unowned self] _, complete in
                self.fetches += 1
                if self.autoFetch {
                    let result: Result<Data, Error> = self.fetchFailure ? .failure(Self.failure) : .success(self.envelope)
                    DispatchQueue.main.async { complete(result) }
                } else { self.fetchCallbacks.append(complete) }
                return nil
            }, download: { [unowned self] _, destination, complete in
                self.downloads += 1
                self.destinations.append(destination)
                // Mock output deliberately has no real update payload: archive
                // integrity is covered by update-manifest-check.swift instead.
                do { try Data("private mocked update".utf8).write(to: destination) }
                catch { DispatchQueue.main.async { complete(.failure(error)) }; return nil }
                if self.autoDownload {
                    let result: Result<URL, Error> = self.downloadFailure ? .failure(Self.failure) : .success(destination)
                    DispatchQueue.main.async { complete(result) }
                } else { self.downloadCallbacks.append(complete) }
                return nil
            })
        item.chooseUpdate = { [unowned self] manifest, complete in
            self.offers.append(manifest)
            if let choice = self.consent { DispatchQueue.main.async { complete(choice) } }
            else { self.choices.append(complete) }
        }
        item.showMessage = { [unowned self] kind, _, _ in
            switch kind { case .current: self.messages.append("current"); case .available: self.messages.append("available"); case .failure: self.messages.append("failure") }
        }
        item.readyToInstall = { [unowned self] archive, manifest, complete in
            self.ready += 1
            self.readyArtifactsValid = self.readyArtifactsValid &&
                FileManager.default.fileExists(atPath: archive.path) &&
                ((try? Data(contentsOf: manifest)) == self.envelope) &&
                archive.deletingLastPathComponent() == manifest.deletingLastPathComponent()
            DispatchQueue.main.async { complete(self.readyAccepted) }
        }
        item.saveDownload = { [unowned self] _, archive, complete in
            self.exports += 1
            self.readyArtifactsValid = self.readyArtifactsValid && FileManager.default.fileExists(atPath: archive.path)
            DispatchQueue.main.async {
                if self.exportFailure { complete(.failure(Self.failure)) }
                else { complete(.success(self.exportCancelled ? nil : self.root.appendingPathComponent("Nimlo-update.zip"))) }
            }
        }
        item.revealDownload = { [unowned self] _ in self.reveals += 1 }
        item.stateChanged = { [unowned self] in self.stateChanges += 1 }
        return item
    }()

    static var failure: Error { NSError(domain: "NimloUpdaterFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Injected transfer failure"]) }

    init(base: URL, name: String, configuration: String = "enabled", envelope: Data? = nil) throws {
        root = base.appendingPathComponent(name, isDirectory: true)
        cache = root.appendingPathComponent("cache", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let bundleURL = root.appendingPathComponent("Fixture.bundle", isDirectory: true)
        let contents = bundleURL.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        var info: [String: Any] = [
            "CFBundleIdentifier": Self.identifier, "CFBundleName": "Nimlo updater fixture", "CFBundlePackageType": "BNDL",
            "CFBundleVersion": "2", "CFBundleShortVersionString": "1.0.2",
            "NimloUpdateFeedURL": "https://updates.example.test/manifest.json",
            "NimloUpdatePublicKey": Self.key.publicKey.rawRepresentation.base64EncodedString()
        ]
        switch configuration {
        case "unconfigured": info["NimloUpdateFeedURL"] = ""
        case "development": info["CFBundleIdentifier"] = Self.identifier + ".dev"
        case "http": info["NimloUpdateFeedURL"] = "http://updates.example.test/manifest.json"
        case "bad-key": info["NimloUpdatePublicKey"] = "not-a-key"
        default: break
        }
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: contents.appendingPathComponent("Info.plist"))
        guard let bundle = Bundle(url: bundleURL) else { throw Self.failure }
        self.bundle = bundle
        suite = "dev.nimlo.update-fixture." + UUID().uuidString
        defaults = UserDefaults(suiteName: suite)!
        self.envelope = try envelope ?? Self.signed(build: 3)
    }

    deinit { defaults.removePersistentDomain(forName: suite) }

    static func signed(build: Int, signingKey: Curve25519.Signing.PrivateKey = key, distribution: String? = nil) throws -> Data {
        var payload: [String: Any] = [
            "schema": 1, "bundleIdentifier": identifier, "version": "1.0.\(build)", "build": build,
            "publishedAt": "2026-10-15T12:30:00Z", "minimumSystemVersion": "13.3", "architecture": NimloUpdater.architecture,
            "url": "https://updates.example.test/Nimlo.zip", "size": 123,
            "sha256": String(repeating: "a", count: 64), "releaseNotes": "Fixture release notes"
        ]
        if let distribution { payload["distribution"] = distribution }
        let bytes = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        return try JSONSerialization.data(withJSONObject: ["payload": bytes.base64EncodedString(), "signature": signingKey.signature(for: bytes).base64EncodedString()])
    }

    func completeFetch(_ result: Result<Data, Error>? = nil) {
        precondition(!fetchCallbacks.isEmpty)
        let complete = fetchCallbacks.removeFirst(), value = result ?? .success(envelope)
        DispatchQueue.main.async { complete(value) }
    }

    func completeDownload(_ result: Result<URL, Error>) {
        precondition(!downloadCallbacks.isEmpty)
        let complete = downloadCallbacks.removeFirst()
        DispatchQueue.main.async { complete(result) }
    }

    var workIsClean: Bool { ((try? FileManager.default.contentsOfDirectory(atPath: cache.path)) ?? []).isEmpty }
    var preferenceKey: String { "nimlo.update." + Self.identifier }
}

@main
struct NimloUpdateControllerCheck {
    static var passed = [String]()
    static var failures = [String]()

    static func check(_ name: String, _ accepted: @autoclosure () -> Bool) {
        if accepted() { passed.append(name) } else { failures.append(name); print("FAIL " + name) }
    }

    static func spin(until condition: () -> Bool, timeout: TimeInterval = 3) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.005))
        }
        if !condition() { failures.append("asynchronous fixture timed out") }
    }

    static func drain() {
        let end = Date().addingTimeInterval(0.03)
        while Date() < end { _ = RunLoop.current.run(mode: .default, before: end) }
    }

    static func main() throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent("nimlo-update-controller-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: base, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? fm.removeItem(at: base) }

        for mode in ["unconfigured", "development", "http", "bad-key"] {
            let item = try ControllerFixture(base: base, name: mode, configuration: mode)
            item.updater.checkAutomatically(); item.updater.check(); drain()
            check(mode + " configuration disables checks", !item.updater.enabled && item.fetches == 0 && item.offers.isEmpty && item.downloads == 0)
        }

        let cadence = try ControllerFixture(base: base, name: "cadence")
        cadence.updater.checkAutomatically(); spin { !cadence.updater.busy }
        check("first automatic check offers verified update", cadence.fetches == 1 && cadence.offers.count == 1)
        cadence.updater.checkAutomatically(); drain()
        check("automatic checks limited to once per day", cadence.fetches == 1)
        cadence.clock.addTimeInterval(86399); cadence.updater.checkAutomatically(); drain()
        check("automatic check waits full 24 hours", cadence.fetches == 1)
        cadence.clock.addTimeInterval(1); cadence.updater.checkAutomatically(); spin { !cadence.updater.busy }
        check("automatic check resumes at 24 hours", cadence.fetches == 2)
        cadence.updater.check(); spin { !cadence.updater.busy }
        check("manual check bypasses daily interval", cadence.fetches == 3)
        cadence.clock.addTimeInterval(-120); cadence.updater.checkAutomatically(); spin { !cadence.updater.busy }
        check("backward wall clock does not suppress checks", cadence.fetches == 4)
        check("Later neither downloads nor restarts", cadence.downloads == 0 && cadence.ready == 0 && cadence.workIsClean)

        let busy = try ControllerFixture(base: base, name: "busy")
        busy.autoFetch = false
        busy.updater.check(); busy.updater.check(); busy.updater.checkAutomatically()
        check("overlapping fetch checks are coalesced", busy.fetches == 1 && busy.updater.busy)
        busy.completeFetch(); spin { !busy.updater.busy }

        let hidden = try ControllerFixture(base: base, name: "hidden")
        hidden.updater.canPresent = { false }; hidden.updater.checkAutomatically(); hidden.updater.check(); drain()
        check("unsafe presentation state prevents checks", hidden.fetches == 0 && !hidden.updater.busy)

        let bad = try ControllerFixture(base: base, name: "bad-signature", envelope: ControllerFixture.signed(build: 3, signingKey: Curve25519.Signing.PrivateKey()))
        bad.updater.check(); spin { !bad.updater.busy }
        check("invalid signature never offers downloads or restart", bad.offers.isEmpty && bad.downloads == 0 && bad.ready == 0)
        check("manual signature failure is visible", bad.messages == ["failure"])
        let badAuto = try ControllerFixture(base: base, name: "bad-signature-auto", envelope: bad.envelope)
        badAuto.updater.checkAutomatically(); spin { !badAuto.updater.busy }
        check("automatic signature failure stays quiet", badAuto.messages.isEmpty && badAuto.offers.isEmpty)

        let current = try ControllerFixture(base: base, name: "current", envelope: ControllerFixture.signed(build: 2))
        current.updater.check(); spin { !current.updater.busy }
        check("manual up-to-date check reports current version", current.messages == ["current"] && current.offers.isEmpty)
        let currentAuto = try ControllerFixture(base: base, name: "current-auto", envelope: current.envelope)
        currentAuto.updater.checkAutomatically(); spin { !currentAuto.updater.busy }
        check("automatic up-to-date check is quiet", currentAuto.messages.isEmpty && currentAuto.offers.isEmpty)

        let failure = try ControllerFixture(base: base, name: "network-failure")
        failure.fetchFailure = true; failure.updater.check(); spin { !failure.updater.busy }
        check("fetch failure cannot download or restart", failure.messages == ["failure"] && failure.offers.isEmpty && failure.downloads == 0 && failure.ready == 0)

        let success = try ControllerFixture(base: base, name: "success")
        success.consent = true; success.updater.check(); spin { !success.updater.busy }
        check("confirmed Update downloads exactly once", success.offers.count == 1 && success.downloads == 1)
        check("verified update alone reaches installer handoff", success.ready == 1 && success.readyArtifactsValid)
        check("installer handoff cleans download staging", success.workIsClean)
        check("workflow emits busy state changes", success.stateChanges >= 3)

        let manual = try ControllerFixture(base: base, name: "manual", envelope: ControllerFixture.signed(build: 3, distribution: "unnotarized"))
        manual.consent = true; manual.updater.check(); spin { !manual.updater.busy }
        check("unnotarized update verifies and exports download", manual.downloads == 1 && manual.exports == 1 && manual.readyArtifactsValid)
        check("unnotarized update never invokes automatic installer", manual.ready == 0)
        check("manual update reveals saved archive and leaves app running", manual.reveals == 1 && manual.messages == ["available"])
        check("manual update releases private download staging", manual.workIsClean)
        let manualCancel = try ControllerFixture(base: base, name: "manual-cancel", envelope: manual.envelope)
        manualCancel.consent = true; manualCancel.exportCancelled = true; manualCancel.updater.check(); spin { !manualCancel.updater.busy }
        check("cancelled Save never installs or reveals an archive", manualCancel.ready == 0 && manualCancel.reveals == 0 && manualCancel.messages.isEmpty && manualCancel.workIsClean)
        let manualFailure = try ControllerFixture(base: base, name: "manual-failure", envelope: manual.envelope)
        manualFailure.consent = true; manualFailure.exportFailure = true; manualFailure.updater.check(); spin { !manualFailure.updater.busy }
        check("failed export keeps app running and cleans staging", manualFailure.ready == 0 && manualFailure.reveals == 0 && manualFailure.messages == ["failure"] && manualFailure.workIsClean)

        let downloadFailure = try ControllerFixture(base: base, name: "download-failure")
        downloadFailure.consent = true; downloadFailure.downloadFailure = true
        downloadFailure.updater.check(); spin { !downloadFailure.updater.busy }
        check("failed download cannot reach installer", downloadFailure.downloads == 1 && downloadFailure.ready == 0 && downloadFailure.messages == ["failure"])
        check("failed download cleans partial private artifacts", downloadFailure.workIsClean && downloadFailure.destinations.allSatisfy { !fm.fileExists(atPath: $0.path) })

        let publicCache = try ControllerFixture(base: base, name: "public-cache")
        try fm.createDirectory(at: publicCache.cache, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o755])
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: publicCache.cache.path)
        let sentinel = publicCache.cache.appendingPathComponent("unrelated-file")
        try Data("preserve me".utf8).write(to: sentinel)
        publicCache.consent = true; publicCache.updater.check(); spin { !publicCache.updater.busy }
        check("public cache directory refuses download", publicCache.downloads == 0 && publicCache.ready == 0 && publicCache.messages == ["failure"])
        check("cache refusal preserves unrelated files", (try? Data(contentsOf: sentinel)) == Data("preserve me".utf8))
        let linkedCache = try ControllerFixture(base: base, name: "linked-cache")
        let linkedTarget = linkedCache.root.appendingPathComponent("elsewhere", isDirectory: true)
        try fm.createDirectory(at: linkedTarget, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try fm.createSymbolicLink(at: linkedCache.cache, withDestinationURL: linkedTarget)
        linkedCache.consent = true; linkedCache.updater.check(); spin { !linkedCache.updater.busy }
        check("symlink cache directory refuses download", linkedCache.downloads == 0 && linkedCache.ready == 0 && ((try? fm.contentsOfDirectory(atPath: linkedTarget.path)) ?? []).isEmpty)

        let cancelFetch = try ControllerFixture(base: base, name: "cancel-fetch")
        cancelFetch.autoFetch = false; cancelFetch.updater.check(); cancelFetch.updater.cancel(); cancelFetch.completeFetch()
        spin { !cancelFetch.updater.busy }
        check("cancelled check never offers a completed late result", cancelFetch.offers.isEmpty && cancelFetch.downloads == 0 && cancelFetch.ready == 0 && cancelFetch.messages.isEmpty)

        let cancelDownload = try ControllerFixture(base: base, name: "cancel-download")
        cancelDownload.consent = true; cancelDownload.autoDownload = false; cancelDownload.updater.check()
        spin { cancelDownload.downloads == 1 }
        cancelDownload.updater.cancel()
        cancelDownload.completeDownload(.success(cancelDownload.destinations[0])); spin { !cancelDownload.updater.busy }
        check("cancelled download cannot install a late success", cancelDownload.ready == 0 && cancelDownload.messages.isEmpty)
        check("cancelled download cleans private staging", cancelDownload.workIsClean)

        let cancelChoice = try ControllerFixture(base: base, name: "cancel-choice")
        cancelChoice.consent = nil; cancelChoice.updater.check(); spin { !cancelChoice.choices.isEmpty }
        cancelChoice.updater.cancel(); cancelChoice.choices.removeFirst()(true); spin { !cancelChoice.updater.busy }
        check("cancelled prompt cannot begin a late accepted download", cancelChoice.downloads == 0 && cancelChoice.ready == 0 && cancelChoice.workIsClean)
        let shutdownChoice = try ControllerFixture(base: base, name: "shutdown-choice")
        shutdownChoice.consent = nil; shutdownChoice.updater.check(); spin { !shutdownChoice.choices.isEmpty }
        shutdownChoice.updater.shutdown(); shutdownChoice.choices.removeFirst()(true); spin { !shutdownChoice.updater.busy }
        check("shutdown prevents late consent from restarting update", shutdownChoice.downloads == 0 && shutdownChoice.ready == 0 && shutdownChoice.workIsClean)

        let deferred = try ControllerFixture(base: base, name: "deferred")
        deferred.updater.presentationGate = { complete in DispatchQueue.main.async { complete(false) } }
        deferred.updater.check(); spin { !deferred.updater.busy }; drain()
        check("denied presentation gate defers prompt", deferred.fetches == 1 && deferred.offers.isEmpty && deferred.downloads == 0)
        deferred.updater.presentationGate = { complete in DispatchQueue.main.async { complete(true) } }
        deferred.updater.check(); spin { !deferred.updater.busy }
        check("deferred verified prompt reuses manifest", deferred.fetches == 1 && deferred.offers.count == 1 && deferred.downloads == 0)

        let rollback = try ControllerFixture(base: base, name: "rollback", envelope: ControllerFixture.signed(build: 4))
        rollback.updater.check(); spin { !rollback.updater.busy }
        check("highest verified offered build is persisted", rollback.defaults.integer(forKey: rollback.preferenceKey + ".highestBuild") == 4)
        rollback.envelope = try ControllerFixture.signed(build: 3)
        rollback.updater.check(); spin { !rollback.updater.busy }
        check("replayed older signed release cannot downgrade offered version", rollback.offers.count == 1 && rollback.messages == ["failure"] && rollback.downloads == 0)
        rollback.envelope = try ControllerFixture.signed(build: 4)
        rollback.updater.check(); spin { !rollback.updater.busy }
        check("same highest release can be offered again after Later", rollback.offers.count == 2 && rollback.downloads == 0)
        let replay = try ControllerFixture.signed(build: 3)
        var relaunchedOffers = 0, relaunchedFailures = 0
        let relaunched = NimloUpdater(bundle: rollback.bundle, defaults: rollback.defaults, cacheRoot: rollback.cache,
            fetch: { _, complete in DispatchQueue.main.async { complete(.success(replay)) }; return nil },
            download: { _, _, _ in preconditionFailure("Replayed release must not download") })
        relaunched.chooseUpdate = { _, complete in relaunchedOffers += 1; complete(false) }
        relaunched.showMessage = { kind, _, _ in if case .failure = kind { relaunchedFailures += 1 } }
        relaunched.check(); spin { !relaunched.busy }
        check("highest verified build survives controller recreation", relaunchedOffers == 0 && relaunchedFailures == 1)

        let heldGate = try ControllerFixture(base: base, name: "held-gate")
        var gateReply: ((Bool) -> Void)?
        heldGate.updater.presentationGate = { gateReply = $0 }
        heldGate.updater.check(); spin { gateReply != nil }
        heldGate.updater.check(); drain()
        check("presentation gate remains part of the busy workflow", heldGate.fetches == 1)
        heldGate.updater.cancel(); gateReply?(true); drain()
        check("cancellation during presentation gate prevents late prompt", heldGate.offers.isEmpty && heldGate.downloads == 0 && heldGate.ready == 0)

        let report: [String: Any] = [
            "status": failures.isEmpty ? "passed" : "failed", "count": passed.count, "checks": passed, "failures": failures,
            "network": "Injected asynchronous native callbacks; no network",
            "limitations": ["No real UI shown", "Mocked downloads are controller fixtures; SHA256/quarantine covered separately", "No installer launched and no running app was quit"]
        ]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--report" {
            try data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        }
        print("\(failures.isEmpty ? "PASS" : "FAIL") \(passed.count) updater controller checks; \(failures.count) failures")
        if !failures.isEmpty { exit(1) }
    }
}
