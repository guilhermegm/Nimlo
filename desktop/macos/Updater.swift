import AppKit
import Foundation
import Darwin
import CryptoKit
import UniformTypeIdentifiers

struct NimloUpdateConfiguration {
    let feed: URL
    let publicKey: Data
    let bundleIdentifier: String
    let version: String
    let build: Int

    init?(bundle: Bundle) {
        guard let id = bundle.bundleIdentifier, !id.hasSuffix(".dev"),
              let feedText = bundle.object(forInfoDictionaryKey: "NimloUpdateFeedURL") as? String,
              let feed = URL(string: feedText), NimloUpdateManifest.validHTTPS(feed),
              let keyText = bundle.object(forInfoDictionaryKey: "NimloUpdatePublicKey") as? String,
              let key = Data(base64Encoded: keyText), key.count == 32,
              let buildText = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String,
              let build = Int(buildText), build > 0 else { return nil }
        self.feed = feed; self.publicKey = key; self.bundleIdentifier = id; self.build = build
        self.version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? buildText
    }
}

// An occasional native request; no observer, database connection, timer or
// helper remains active between checks. The installer runs only after consent.
final class NimloUpdater: NSObject {
    typealias Fetch = (URL, @escaping (Result<Data, Error>) -> Void) -> NimloUpdateRequest?
    typealias Download = (NimloUpdateManifest, URL, @escaping (Result<URL, Error>) -> Void) -> NimloUpdateRequest?
    enum Message { case current, available, failure }

    let configuration: NimloUpdateConfiguration?
    private(set) var busy = false
    var stateChanged: (() -> Void)?
    var canPresent: () -> Bool = { true }
    var presentationGate: ((@escaping (Bool) -> Void) -> Void)?
    var showMessage: ((Message, String, String) -> Void)?
    var chooseUpdate: ((NimloUpdateManifest, @escaping (Bool) -> Void) -> Void)?
    var readyToInstall: ((URL, URL, @escaping (Bool) -> Void) -> Void)?
    var saveDownload: ((NimloUpdateManifest, URL, @escaping (Result<URL?, Error>) -> Void) -> Void)?
    var revealDownload: ((URL) -> Void)?
    private let defaults: UserDefaults
    private let bundle: Bundle
    private let fetch: Fetch
    private let download: Download
    private let cacheRoot: URL
    private let now: () -> Date
    private var request: NimloUpdateRequest?
    private var progress: NSPanel?
    private var work: URL?
    private var cancelled = false
    private var deferred: (Data, NimloUpdateManifest)?

    init(bundle: Bundle = .main, defaults: UserDefaults = .standard, cacheRoot: URL? = nil,
         now: @escaping () -> Date = Date.init,
         fetch: @escaping Fetch = { url, done in NimloUpdateTransport.fetchManifest(from: url, completion: done) },
         download: @escaping Download = { manifest, destination, done in NimloUpdateTransport.download(manifest, to: destination, completion: done) }) {
        self.bundle = bundle; self.configuration = NimloUpdateConfiguration(bundle: bundle)
        self.defaults = defaults; self.now = now; self.fetch = fetch; self.download = download
        self.cacheRoot = cacheRoot ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Nimlo Updates", isDirectory: true)
        super.init()
    }

    var enabled: Bool { configuration != nil }
    private var preferenceKey: String { "nimlo.update." + (configuration?.bundleIdentifier ?? "unconfigured") }

    func checkAutomatically() {
        guard enabled, !busy, canPresent() else { return }
        let previous = defaults.double(forKey: preferenceKey + ".lastCheck")
        // A backwards wall clock must not suppress checks indefinitely.
        let elapsed = now().timeIntervalSince1970 - previous
        guard previous == 0 || elapsed >= 24 * 60 * 60 || elapsed < -60 else { return }
        check(manual: false)
    }

    func check(manual: Bool = true) {
        guard let config = configuration, !busy, canPresent() else { return }
        if let (envelope, manifest) = deferred {
            busy = true; cancelled = false; stateChanged?()
            allowPresentation { [weak self] allowed in
                guard let self else { return }; self.finish()
                guard !self.cancelled else { return }
                if allowed { self.deferred = nil; self.offer(envelope: envelope, manifest: manifest) }
            }
            return
        }
        busy = true; cancelled = false; stateChanged?()
        defaults.set(now().timeIntervalSince1970, forKey: preferenceKey + ".lastCheck")
        request = fetch(config.feed) { [weak self] result in
            guard let self else { return }; self.request = nil
            if self.cancelled { self.finish(); return }
            do {
                let envelope = try result.get()
                let system = ProcessInfo.processInfo.operatingSystemVersion
                let manifest = try NimloUpdateManifest.verify(envelope: envelope, publicKey: config.publicKey,
                    bundleIdentifier: config.bundleIdentifier, currentBuild: config.build,
                    architecture: Self.architecture, systemVersion: "\(system.majorVersion).\(system.minorVersion).\(system.patchVersion)")
                let highest = self.defaults.integer(forKey: self.preferenceKey + ".highestBuild")
                guard manifest.build >= highest else { throw NimloUpdateError.invalidSignature }
                self.defaults.set(manifest.build, forKey: self.preferenceKey + ".highestBuild")
                self.allowPresentation { [weak self] allowed in
                    guard let self else { return }
                    self.finish()
                    guard !self.cancelled else { return }
                    if allowed { self.offer(envelope: envelope, manifest: manifest) }
                    else { self.deferred = (envelope, manifest) }
                }
            } catch NimloUpdateError.upToDate {
                self.finish()
                if manual && self.canPresent() { self.message(.current, "You’re up to date", "Nimlo \(config.version) is the latest available version.") }
            } catch {
                self.finish()
                if manual && self.canPresent() { self.message(.failure, "Couldn’t check for updates", error.localizedDescription) }
            }
        }
    }

    static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }

    private func offer(envelope: Data, manifest: NimloUpdateManifest) {
        guard !busy else { return }
        busy = true; stateChanged?()
        let answer: (Bool) -> Void = { [weak self] update in
            guard let self else { return }
            guard !self.cancelled else { self.finish(); return }
            if update { self.beginDownload(envelope: envelope, manifest: manifest) }
            else { self.finish() }
        }
        if let chooseUpdate { chooseUpdate(manifest, answer); return }
        let alert = NSAlert(); alert.messageText = "Nimlo \(manifest.version) is available"
        alert.informativeText = manifest.requiresManualInstallation
            ? "This release needs manual installation. Nimlo will verify the download and keep your session running. macOS may require approval when you open the new app."
            : "You’re using version \(configuration?.version ?? ""). The update will restart Nimlo after you approve."
        alert.addButton(withTitle: manifest.requiresManualInstallation ? "Download Update…" : "Update"); alert.addButton(withTitle: "Later")
        if !manifest.releaseNotes.isEmpty {
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 420, height: 150))
            scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
            let notes = NSTextView(frame: scroll.bounds); notes.isEditable = false; notes.isSelectable = true
            notes.font = NSFont.systemFont(ofSize: 12); notes.textContainerInset = NSSize(width: 8, height: 8)
            notes.isHorizontallyResizable = false; notes.autoresizingMask = [.width]
            notes.string = manifest.releaseNotes; notes.setAccessibilityLabel("Release notes")
            scroll.documentView = notes; alert.accessoryView = scroll
        }
        answer(alert.runModal() == .alertFirstButtonReturn)
    }

    private func beginDownload(envelope: Data, manifest: NimloUpdateManifest) {
        do {
            let directory = try privateWorkDirectory(); work = directory
            let manifestURL = directory.appendingPathComponent("manifest.json")
            try envelope.write(to: manifestURL, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: manifestURL.path)
            cancelled = false
            if chooseUpdate == nil { showProgress() }
            request = download(manifest, directory.appendingPathComponent("update.zip")) { [weak self] result in
                guard let self else { return }; self.request = nil; self.closeProgress()
                if self.cancelled { self.finish(cleanup: true); return }
                do {
                    let archiveURL = try result.get()
                    if manifest.requiresManualInstallation {
                        self.saveManualUpdate(manifest, archive: archiveURL)
                        return
                    }
                    guard let ready = self.readyToInstall else { throw NimloUpdateError.invalid("The update could not be prepared for installation.") }
                    // prepare() hands the helper its own private copies before
                    // accepting installation, so download storage can be freed.
                    ready(archiveURL, manifestURL) { [weak self] _ in self?.finish(cleanup: true) }
                } catch { self.finish(cleanup: true); self.message(.failure, "Couldn’t download the update", error.localizedDescription) }
            }
        } catch { finish(cleanup: true); message(.failure, "Couldn’t prepare the update", error.localizedDescription) }
    }

    private func saveManualUpdate(_ manifest: NimloUpdateManifest, archive: URL) {
        let complete: (Result<URL?, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            self.finish(cleanup: true)
            guard !self.cancelled else { return }
            do {
                guard let saved = try result.get() else { return }
                if let reveal = self.revealDownload { reveal(saved) }
                else { NSWorkspace.shared.activateFileViewerSelecting([saved]) }
                self.message(.available, "Nimlo \(manifest.version) downloaded",
                    "Quit Nimlo when you’re ready, extract this ZIP and replace the installed app. Your projects and recovery data stay in place. This release is not notarized; macOS may require approval when opening it.")
            } catch { self.message(.failure, "Couldn’t save the update", error.localizedDescription) }
        }
        if let saveDownload { saveDownload(manifest, archive, complete); return }
        allowPresentation { [weak self] allowed in
            guard let self else { return }
            guard allowed, !self.cancelled else { complete(.success(nil)); return }
            let panel = NSSavePanel(); panel.title = "Save Nimlo Update"; panel.prompt = "Save Update"
            panel.nameFieldStringValue = URL(string: manifest.url)?.lastPathComponent ?? "Nimlo-update.zip"
            panel.allowedContentTypes = [.zip]; panel.canCreateDirectories = true
            panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            guard panel.runModal() == .OK, let destination = panel.url else { complete(.success(nil)); return }
            complete(Result { try Self.saveVerifiedArchive(manifest, from: archive, to: destination); return destination })
        }
    }

    // Preserve quarantine and verify bytes again while exporting. An existing
    // file or a symlink is never replaced, including a Save panel replacement.
    static func saveVerifiedArchive(_ manifest: NimloUpdateManifest, from source: URL, to destination: URL) throws {
        guard manifest.requiresManualInstallation else { throw NimloUpdateError.invalid("This release does not use manual installation.") }
        guard source.isFileURL, destination.isFileURL else { throw NimloUpdateError.invalid("Choose a local ZIP filename.") }
        let input = open(source.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard input >= 0 else { throw NimloUpdateError.invalid("The verified download is unavailable.") }
        let reader = FileHandle(fileDescriptor: input, closeOnDealloc: true)
        defer { try? reader.close() }
        var attributes = stat()
        guard fstat(input, &attributes) == 0, attributes.st_mode & S_IFMT == S_IFREG,
              attributes.st_size == manifest.size, manifest.size > 0,
              manifest.size <= NimloUpdateManifest.maximumArchiveBytes else { throw NimloUpdateError.invalid("The update download has changed.") }
        let output = open(destination.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard output >= 0 else { throw NimloUpdateError.invalid("Choose a new filename. An existing file will not be replaced.") }
        let writer = FileHandle(fileDescriptor: output, closeOnDealloc: true)
        var saved = false
        defer { try? writer.close(); if !saved { try? FileManager.default.removeItem(at: destination) } }
        guard fchmod(output, 0o600) == 0 else { throw NimloUpdateError.invalid("Could not protect the saved update file.") }
        // Apply download policy before writing into the user-visible ZIP path.
        let quarantine = Data(String(format: "0083;%08x;Nimlo;%@", Int(Date().timeIntervalSince1970), UUID().uuidString).utf8)
        guard quarantine.withUnsafeBytes({ fsetxattr(output, "com.apple.quarantine", $0.baseAddress, $0.count, 0, XATTR_CREATE) }) == 0 else {
            throw NimloUpdateError.invalid("Could not retain macOS download security information.")
        }
        var hash = SHA256(), copied: Int64 = 0
        while let chunk = try reader.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            copied += Int64(chunk.count)
            guard copied <= manifest.size else { throw NimloUpdateError.invalid("The update download has changed.") }
            hash.update(data: chunk); try writer.write(contentsOf: chunk)
        }
        guard copied == manifest.size, hash.finalize().map({ String(format: "%02x", $0) }).joined() == manifest.sha256 else {
            throw NimloUpdateError.invalid("The update download does not match its signed checksum.")
        }
        try writer.synchronize(); try writer.close(); saved = true
    }

    @objc func cancel() { cancelled = true; request?.cancel(); closeProgress() }

    func shutdown() {
        cancelled = true; request?.cancel(); closeProgress()
        if busy, let work { try? FileManager.default.removeItem(at: work); self.work = nil }
    }

    private func allowPresentation(_ complete: @escaping (Bool) -> Void) {
        guard canPresent() else { complete(false); return }
        if let presentationGate { presentationGate(complete) } else { complete(true) }
    }

    private func privateWorkDirectory() throws -> URL {
        let fm = FileManager.default
        if !fm.fileExists(atPath: cacheRoot.path) { try fm.createDirectory(at: cacheRoot, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        var info = stat()
        guard lstat(cacheRoot.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0 else {
            throw NimloUpdateError.invalid("The update download folder is not private or writable.")
        }
        let next = cacheRoot.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: next, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return next
    }

    private func showProgress() {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 112), styleMask: [.titled], backing: .buffered, defer: false)
        panel.title = "Updating Nimlo"; panel.isReleasedWhenClosed = false
        let label = NSTextField(labelWithString: "Downloading and verifying update…")
        label.frame = NSRect(x: 20, y: 65, width: 320, height: 20)
        let spinner = NSProgressIndicator(frame: NSRect(x: 20, y: 27, width: 22, height: 22))
        spinner.style = .spinning; spinner.startAnimation(nil)
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(self.cancel))
        cancel.frame = NSRect(x: 260, y: 20, width: 80, height: 30); cancel.bezelStyle = .rounded
        panel.contentView?.addSubview(label); panel.contentView?.addSubview(spinner); panel.contentView?.addSubview(cancel)
        progress = panel; panel.center(); panel.makeKeyAndOrderFront(nil)
    }

    private func closeProgress() { progress?.close(); progress = nil }
    private func finish(cleanup: Bool = false) {
        busy = false; stateChanged?()
        if cleanup, let work { try? FileManager.default.removeItem(at: work); self.work = nil }
    }
    private func message(_ kind: Message, _ title: String, _ detail: String) {
        if let showMessage { showMessage(kind, title, detail); return }
        let alert = NSAlert(); alert.messageText = title; alert.informativeText = detail
        alert.addButton(withTitle: "OK"); alert.runModal()
    }
}
