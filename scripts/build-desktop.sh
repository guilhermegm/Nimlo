#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$nimlo_root"
[ "$(uname -s)" = Darwin ] || { echo 'Nimlo currently targets macOS.' >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo 'This release bundles Neovim for Apple silicon.' >&2; exit 1; }
python3 "$nimlo_root/scripts/fetch-neovim.py"
cargo build --release --locked
mkdir -p "$nimlo_root/target/desktop"
nimlo_build=$(mktemp -d "$nimlo_root/target/desktop/.build.XXXXXX")
trap 'rm -rf "$nimlo_build"' EXIT HUP INT TERM
nimlo_app="$nimlo_build/Nimlo.app"
mkdir -p "$nimlo_app/Contents/MacOS" "$nimlo_app/Contents/Resources"
swiftc -O -target "$(uname -m)-apple-macosx13.3" desktop/neovim/*.swift desktop/macos/Policy.swift -o "$nimlo_app/Contents/MacOS/Nimlo" -framework AppKit -framework WebKit
cp target/release/nimlo-editor "$nimlo_app/Contents/Resources/nimlo-host"
cp desktop/neovim/Info.plist "$nimlo_app/Contents/Info.plist"
cp desktop/macos/Nimlo.icns "$nimlo_app/Contents/Resources/Nimlo.icns"
cp desktop/macos/welcome-logo.png "$nimlo_app/Contents/Resources/welcome-logo.png"
cp runtime/nimlo.lua "$nimlo_app/Contents/Resources/nimlo.lua"
mkdir -p "$nimlo_app/Contents/Resources/licenses"
cp licenses/Neovim-LICENSE.txt "$nimlo_app/Contents/Resources/licenses/Neovim-LICENSE.txt"
ditto target/vendor/nvim-macos-arm64 "$nimlo_app/Contents/Resources/neovim"
codesign --force --sign - "$nimlo_app/Contents/Resources/neovim/bin/nvim"
codesign --force --sign - "$nimlo_app/Contents/Resources/nimlo-host"
codesign --force --sign - "$nimlo_app/Contents/MacOS/Nimlo"
codesign --force --sign - "$nimlo_app"
codesign --verify --deep --strict "$nimlo_app"
# Replace the complete generated bundle so no stale executables are retained.
if [ -e "$nimlo_root/target/desktop/Nimlo.app" ]; then
  mv "$nimlo_root/target/desktop/Nimlo.app" "$nimlo_build/previous.app"
fi
mv "$nimlo_app" "$nimlo_root/target/desktop/Nimlo.app"
printf 'Built %s\n' "$nimlo_root/target/desktop/Nimlo.app"
