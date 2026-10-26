#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
nimlo_app="$nimlo_root/target/desktop/Nimlo.app"
codesign --verify --deep --strict "$nimlo_app"
test -f "$nimlo_app/Contents/MacOS/Nimlo"
test -f "$nimlo_app/Contents/Resources/nimlo-host"
test -f "$nimlo_app/Contents/Resources/neovim/bin/nvim"
test -f "$nimlo_app/Contents/Resources/licenses/Neovim-LICENSE.txt"
nimlo_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$nimlo_app/Contents/Info.plist")
mkdir -p "$nimlo_root/target/packages"
nimlo_archive="$nimlo_root/target/packages/Nimlo-$nimlo_version-macos-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$nimlo_app" "$nimlo_archive"
printf '%s\n' "$nimlo_archive"
