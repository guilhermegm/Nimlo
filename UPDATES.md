# Nimlo updates

Nimlo's Mac updater uses a signed HTTPS manifest and versioned ZIP files. There is no database, Firebase SDK, account login, or persistent update connection. Feed checks do not send project names, paths, file contents, or a device identifier.

The app pins an Ed25519 public key. The release author keeps the matching private key outside the app, repository, and hosting. A manifest signature authenticates the exact payload bytes; its size and SHA-256 digest authenticate the downloaded archive. Code-signature and archive-structure validation provide additional checks. A valid release signature is not an Apple notarization ticket or proof that a release is bug-free.

## Distribution modes

Nimlo supports two explicit release paths:

- **Unnotarized:** the current distribution choice while no Developer ID identity is available. The signed payload contains `"distribution": "unnotarized"`. Nimlo offers a verified download for **manual installation**, preserving the running session. macOS can require explicit user approval or refuse launch under its security policy. The app does not remove quarantine attributes, disable Gatekeeper, or silently replace an app through this path.
- **Notarized:** the default when `distribution` is absent or explicitly `"notarized"`. Public preparation requires Developer ID Application signing, matching signing teams, Gatekeeper acceptance, and a stapled notarization ticket. This path supports a user-approved automatic install/restart after the current work is safe to close.

Both paths require the same pinned release key, valid HTTPS feed, matching bundle/version/architectures, strict code-signature verification, bounded ZIP validation, and archive hash/size checks. An ad-hoc signature checks internal integrity; it does not establish an Apple-recognized publisher identity. The signed release key is the publisher trust anchor for an unnotarized release.

The release and deployment commands require `--unnotarized-release` explicitly to use the unnotarized path. The hosting helper also requires the matching signed distribution marker: a flag alone cannot reclassify a notarized or private-preview manifest. `--local-preview` remains a private fixture and is mutually exclusive with `--unnotarized-release`.

## Selected Firebase project

The dedicated Firebase project is **Nimlo** (`nimlo-editor`, project number `679300317661`). Its update Hosting site is **`nimlo-editor-updates`**:

- Feed: `https://nimlo-editor-updates.web.app/stable/latest.json`
- Archives: `https://nimlo-editor-updates.web.app/stable/`

The public settings are recorded in `hosting/updates/project.json`. This is reference metadata, not a deployment command or credential store. The release hosting contains update files only; it must not republish the removed Nimlo marketing website or replace an unrelated application site.

The current signed preview is **0.2.1 (build 3)**, published on 2026-10-16 for verified manual installation. The live feed points to it, and the immutable **0.2.0 (build 2)** archive remains available for existing downloads. During initial setup the feed returned HTTP 404 until the first release; no placeholder website was deployed. For a new channel, reserve its dedicated site without a live release so the first-deployment guard can initialize it safely.

## Signing key setup

The existing public key is `desktop/macos/UpdatePublicKey.txt`; builds read it automatically. Use the matching existing private key for this channel. Do not regenerate an established channel's key.

For a new independent channel only, generate a key outside every Git repository:

```sh
scripts/update-release.sh keygen \
  --public-key path/to/new-channel-public-key.txt
```

The default private key is `~/Library/Application Support/Nimlo Release/ed25519.key`. Its parent must be owned by you with mode `0700`; the raw 32-byte private key is created exclusively with mode `0600`. Existing key files are never overwritten. The public file contains a base64-encoded raw 32-byte Ed25519 public key and may be committed. The private key must never be committed, copied into an app, stored in release output, or uploaded. Keep a secure offline backup; losing it strands installed clients that trust it.

A private-key override is available as `--private-key PATH` for release preparation. The app's `NimloUpdatePublicKey` must match that key's public bytes, including in previews. Private keys are never build environment variables. `NIMLO_UPDATE_PUBLIC_KEY` may override the **public** pin when deliberately building an independent channel.

## Building and preparing the selected unnotarized release

Increase `CFBundleVersion` to a new positive integer for every release. The dotted numeric `CFBundleShortVersionString` is the displayed version; the integer build controls update ordering. Keep `LSMinimumSystemVersion` accurate. The native app, Rust host, and updater helper must contain the declared architecture.

The source `Info.plist` points to the selected Firebase feed, so ordinary release builds enable update checks by default. Development bundles keep updater checks disabled. Build the final app:

```sh
make build
```

`NIMLO_UPDATE_FEED_URL` can override the source setting for a deliberately different channel; it does not change the source file. Users of a version that predates the updater need one manual installation of an updater-enabled version.

Write plain UTF-8 release notes of at most 16 KiB. The current preview was prepared with:

```sh
scripts/update-release.sh prepare \
  --app target/desktop/Nimlo.app \
  --base-url 'https://nimlo-editor-updates.web.app/stable/' \
  --notes releases/0.2.1.txt \
  --output target/update-release-3 \
  --unnotarized-release
```

This still requires valid strict code signatures on the bundle and its three executables, matching architectures, the release-key pin, and a valid HTTPS feed. It skips the Apple Developer ID/notarization prerequisite and prints an **UNNOTARIZED RELEASE** notice. It does not establish Gatekeeper acceptance for downloaded apps.

Packaging uses `ditto` to preserve bundle metadata. Archives are capped at 256 MiB. A signed `latest.json` appears only after the immutable archive is complete. Outputs resemble:

```text
Nimlo-0.2.1-3-macos-arm64.zip
latest.json
```

Actual version/build/architecture come from the final app. Do not regenerate or overwrite a published release: a subsequent release needs a higher build and fresh output directory. Existing archives are never overwritten. An existing `latest.json` must verify with the same key and have a lower build. The preparation directory is locked against concurrent writers; a private staged bundle snapshot is verified and packaged. Bundle links escaping the app and copies of the raw private signing key are rejected.

Verify the manifest before uploading:

```sh
scripts/update-release.sh verify \
  --manifest target/update-release-3/latest.json \
  --public-key desktop/macos/UpdatePublicKey.txt
```

This command verifies signed metadata, including the distribution marker. It does not prove notarization or run a complete installed-app test.

For notarized distribution later, sign the final app and all nested executables using a Developer ID Application identity, complete notarization, staple the accepted ticket, and omit `--unnotarized-release` from both preparation and deployment. An Apple Development certificate does not satisfy that default release gate. The tool does not obtain certificates or submit notarization credentials.

## Publishing to Firebase Hosting

Run preflight using the explicit selected project and site:

```sh
node scripts/deploy-updates.cjs \
  --project nimlo-editor \
  --site nimlo-editor-updates \
  --release-dir target/update-release-3 \
  --unnotarized-release
```

Add `--deploy` to publish the validated release. The selected site is already initialized. Only a new empty channel's first publication needs `--initialize-empty-site`; do not use a placeholder deployment to initialize it. A signed unnotarized manifest without the explicit flag, or the flag paired with a notarized/default manifest, is rejected. Preflight alone publishes nothing.

The helper uses the existing Firebase CLI login and an isolated temporary deployment target. It never chooses a project alias implicitly, creates a project/site, or writes Firebase configuration into the repository root. It safely inspects the ZIP before extraction and checks its signature/hash, app metadata, public pin, feed, and all executable architectures and strict code signatures. Default notarized mode additionally checks matching Developer ID teams, Gatekeeper, and the stapled ticket. The helper never reads the private release key.

This helper uses the Firebase-provided `web.app` feed/archive addresses shown above. Custom domains or a separate archive CDN need an explicit alternative deployment configuration. The generic release preparer supports a separate HTTPS archive base.

`hosting/updates/firebase.template.json` serves manifests/history with no-cache headers and immutable ZIP files with a long cache lifetime. It contains no marketing content or single-page-app rewrite. See [Firebase Hosting configuration](https://firebase.google.com/docs/hosting/full-config) and [multiple-site deploy targets](https://firebase.google.com/docs/hosting/multisites).

**Hosting deployments replace complete snapshots.** Firebase requires [every file intended for the next version](https://firebase.google.com/docs/hosting/api-deploy) to be listed. The helper keeps a cumulative store at `target/firebase-updates/PROJECT_ID/SITE_ID/public`, with an optional parent override `--state-dir PATH`. Back up this store. Every deployment includes all previous immutable archives, the new archive, signed `latest.json`, and `nimlo-updates.json`, whose history entries contain independently signed manifests. Only those allowlisted files are deployed.

Before replacing a snapshot, the helper verifies the live history/latest manifest and enumerates every active path through Firebase's authenticated read-only Hosting API, checking the complete result against the live version's file count. Every managed release file must be present; the only additional paths allowed are Firebase's automatically generated `/__/firebase/init.js` and `/__/firebase/init.json`, which Hosting regenerates itself. These [documented reserved URLs](https://firebase.google.com/docs/hosting/reserved-urls) do not belong in the cumulative local archive store. Other files are refused even if the total count looks correct. The helper uses the installed Node-based Firebase CLI's authentication/API modules and fails closed if they are unavailable.

The helper validates every retained archive and rechecks the live version. Missing old archives, unrecognized live content, conflicting/lower builds, changed keys, or an incomplete store cause refusal. Restore missing files from a trusted backup; do not bypass this refusal by uploading only the newest ZIP. Previously published archives must remain available to clients finishing downloads.

ZIP limits match the installed client: 4,096 entries, 512 MiB expanded data, and 256 MiB compressed archive. Traversal paths, links, special files, alternate filename metadata, duplicates, hidden local records, and unsafe expansion are rejected.

An exclusive local `.deploy.lock` records the publishing PID and start time. A crash can leave it behind; verify the recorded process has stopped before removing a stale lock. **Serialize publishing jobs across machines.** The live-history recheck detects intervening deployments but cannot atomically commit through the Firebase CLI: separate-machine publishers can still race between the last check and publication. The helper provides no distributed lock or server-side transaction. Firebase rollback history does not replace the cumulative archive store.

## Installation and recovery

Unnotarized releases use verified download/manual installation. The app preserves the running session and hands the downloaded artifact to the user; macOS quarantine and approval rules remain active. A successful local automatic-install fixture is not a promise that a publicly downloaded unnotarized app can restart automatically on another Mac.

For notarized automatic installs, the helper validates ZIP contents and performs code-signing/Gatekeeper checks before requesting quit. Cancel preserves the current session. A confirmed startup receipt allows removal of the previous bundle. If the replacement crashes during startup, the helper restores and relaunches the previous app. If it remains running without confirming startup, the helper keeps the previous app in an adjacent `.nimlo-update-*/Nimlo.app` directory rather than forcibly terminating it. Private status/log files are in the operating system's temporary `nimlo-update-*/` directory. Projects, preferences, and recovery data remain outside the application bundle.

Test the exact published artifact on a disposable installed app, covering deferred installation, download failure, successful launch, and rollback. Local trusted-fixture restart/rollback and real HTTPS transport tests verify different parts of the system; neither establishes Gatekeeper acceptance for every user's Mac.

## Local private fixtures

`prepare --local-preview` packages an internally valid signed app without Developer ID/notarization, permits an empty feed, and prints **LOCAL PREVIEW ONLY**. It omits the unnotarized release marker and cannot be combined with `--unnotarized-release`. It is for disposable local tests, not publishing.

```sh
scripts/update-release.sh prepare \
  --app target/desktop/Nimlo.app \
  --base-url 'https://updates.example.invalid/preview/' \
  --notes path/to/release-notes.txt \
  --output target/update-preview \
  --local-preview
```

`node scripts/update-release-check.cjs` tests temporary key creation, signatures, packaging, distribution flags, and release safety. `node scripts/deploy-updates-check.cjs` tests deployment guards without Firebase operations. `node scripts/update-hosting-inventory-check.cjs` exercises complete inventory pagination and the exact generated-file allowlist without network access or credentials. Fixtures copy/re-pin/re-sign disposable app bundles, never read the real private key, and never stop the running app. `make test-updates` also runs the native manifest, transport, and installer fixtures. The actual manual-export function has a separate fixture:

```sh
mkdir -p target/update-export-review
swiftc -O desktop/macos/UpdateManifest.swift desktop/macos/Updater.swift \
  scripts/update-export-check.swift -o target/update-export-review/export-check \
  -framework AppKit -framework CryptoKit
target/update-export-review/export-check --report target/update-export-review/report.json
```

This fixture uses temporary local files only and checks checksums, byte counts, owner-only permissions, quarantine, symlink/existing-file refusal, failure cleanup, and signed distribution policy without displaying a dialog or launching an installer.

## Manifest format

`latest.json` is a UTF-8 JSON envelope:

```json
{
  "payload": "BASE64_OF_EXACT_UTF8_JSON_BYTES",
  "signature": "BASE64_OF_64_BYTE_ED25519_SIGNATURE"
}
```

The signature covers decoded payload bytes, not reserialized JSON or the envelope. A payload resembles:

```json
{
  "schema": 1,
  "bundleIdentifier": "dev.nimlo.editor",
  "version": "0.2.1",
  "build": 3,
  "publishedAt": "2026-10-16T00:00:00Z",
  "minimumSystemVersion": "13.3",
  "architecture": "arm64",
  "url": "https://nimlo-editor-updates.web.app/stable/Nimlo-0.2.1-3-macos-arm64.zip",
  "size": 1234567,
  "sha256": "LOWERCASE_64_CHARACTER_HEX_DIGEST",
  "releaseNotes": "Improvements and fixes.",
  "distribution": "unnotarized"
}
```

`distribution` is optional: absent or `"notarized"` selects the notarized contract; `"unnotarized"` selects verified manual installation. Unknown values are rejected. `architecture` is `arm64`, `x86_64`, or `universal`. URLs require HTTPS and cannot embed credentials or a fragment. Envelope/payload/notes caps are 64 KiB/32 KiB/16 KiB. Notes are plain text.

Keep the signing key and bundle identifier stable; notarized releases must also preserve their expected Developer ID team. A pinned-key or team migration needs a deliberate version that existing clients trust. Replacing a server-side key alone strands installed apps. If the signing key is compromised, remove the affected feed and arrange a trusted replacement rather than weakening verification.
