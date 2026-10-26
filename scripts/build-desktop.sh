#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(uname -s)" != Darwin ]; then
  echo 'The current native desktop shell targets macOS. The browser host remains cross-platform.' >&2
  exit 1
fi
nimlo_mode=${1:-release}
case "$nimlo_mode" in release|dev) ;; *) echo 'Usage: scripts/build-desktop.sh [release|dev]' >&2; exit 1;; esac
if [ ! -f "$nimlo_root/desktop/macos/Nimlo.icns" ] || \
   [ ! -f "$nimlo_root/desktop/macos/welcome-logo.png" ] || \
   [ "$nimlo_root/assets/nimlo-icon.png" -nt "$nimlo_root/desktop/macos/Nimlo.icns" ] || \
   [ "$nimlo_root/assets/nimlo-logo.png" -nt "$nimlo_root/desktop/macos/welcome-logo.png" ] || \
   [ "$nimlo_root/scripts/build-icons.sh" -nt "$nimlo_root/desktop/macos/Nimlo.icns" ] || \
   [ "$nimlo_root/scripts/build-icons.sh" -nt "$nimlo_root/desktop/macos/welcome-logo.png" ]; then
  sh "$nimlo_root/scripts/build-icons.sh"
fi
cargo build --release --manifest-path "$nimlo_root/Cargo.toml"
nimlo_app="$nimlo_root/target/desktop/Nimlo.app"
if [ "$nimlo_mode" = dev ]; then nimlo_app="$nimlo_root/target/desktop/Nimlo Dev.app"; fi
mkdir -p "$nimlo_app/Contents/MacOS" "$nimlo_app/Contents/Resources" "$nimlo_app/Contents/Helpers"
nimlo_build=$(mktemp -d "$nimlo_root/target/desktop/.build.XXXXXX")
trap 'rm -rf "$nimlo_build"' EXIT HUP INT TERM
cp "$nimlo_root/desktop/macos/Info.plist" "$nimlo_app/Contents/Info.plist"
if [ -n "${NIMLO_UPDATE_FEED_URL:-}" ]; then
  /usr/bin/plutil -replace NimloUpdateFeedURL -string "$NIMLO_UPDATE_FEED_URL" "$nimlo_app/Contents/Info.plist"
fi
if [ -n "${NIMLO_UPDATE_PUBLIC_KEY:-}" ]; then
  /usr/bin/plutil -replace NimloUpdatePublicKey -string "$NIMLO_UPDATE_PUBLIC_KEY" "$nimlo_app/Contents/Info.plist"
elif [ -f "$nimlo_root/desktop/macos/UpdatePublicKey.txt" ]; then
  nimlo_update_key=$(cat "$nimlo_root/desktop/macos/UpdatePublicKey.txt")
  /usr/bin/plutil -replace NimloUpdatePublicKey -string "$nimlo_update_key" "$nimlo_app/Contents/Info.plist"
fi
cp "$nimlo_root/desktop/macos/Nimlo.icns" "$nimlo_app/Contents/Resources/Nimlo.icns"
cp "$nimlo_root/desktop/macos/welcome-logo.png" "$nimlo_app/Contents/Resources/welcome-logo.png"
if [ "$nimlo_mode" = dev ]; then
  /usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier dev.nimlo.editor.dev' "$nimlo_app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Set :CFBundleName Nimlo Dev' "$nimlo_app/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Set :CFBundleDisplayName Nimlo Dev' "$nimlo_app/Contents/Info.plist"
fi
swiftc -O -target "$(uname -m)-apple-macosx13.3" \
  "$nimlo_root/desktop/macos/Policy.swift" "$nimlo_root/desktop/macos/main.swift" "$nimlo_root/desktop/macos/Metrics.swift" "$nimlo_root/desktop/macos/Downloads.swift" \
  "$nimlo_root/desktop/macos/UpdateManifest.swift" "$nimlo_root/desktop/macos/UpdateInstaller.swift" "$nimlo_root/desktop/macos/Updater.swift" \
  -o "$nimlo_build/Nimlo" -framework AppKit -framework WebKit
swiftc -O -target "$(uname -m)-apple-macosx13.3" \
  "$nimlo_root/desktop/macos/UpdateInstaller.swift" "$nimlo_root/desktop/macos/update-helper/main.swift" \
  -o "$nimlo_build/nimlo-update-helper"
cp "$nimlo_root/target/release/nimlo-editor" "$nimlo_build/nimlo-editor"
codesign --force --sign - "$nimlo_build/nimlo-editor"
codesign --force --sign - "$nimlo_build/Nimlo"
codesign --force --sign - "$nimlo_build/nimlo-update-helper"
mv "$nimlo_build/Nimlo" "$nimlo_app/Contents/MacOS/Nimlo"
mv "$nimlo_build/nimlo-editor" "$nimlo_app/Contents/Resources/nimlo-editor"
mv "$nimlo_build/nimlo-update-helper" "$nimlo_app/Contents/Helpers/nimlo-update-helper"
codesign --force --sign - "$nimlo_app"
echo "Built $nimlo_app"
