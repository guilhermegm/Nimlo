#!/bin/sh
set -eu
nimlo_release_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(uname -s)" != Darwin ]; then
  echo 'Nimlo release signing requires macOS and the Swift command line tools.' >&2
  exit 1
fi
nimlo_release_build=$(mktemp -d "${TMPDIR:-/tmp}/nimlo-release-tool.XXXXXX")
trap 'rm -rf "$nimlo_release_build"' EXIT HUP INT TERM
swiftc -O -target "$(uname -m)-apple-macosx13.3" \
  "$nimlo_release_root/scripts/UpdateRelease.swift" -o "$nimlo_release_build/update-release" \
  -framework Foundation -framework CryptoKit
NIMLO_RELEASE_SOURCE_ROOT="$nimlo_release_root" "$nimlo_release_build/update-release" "$@"
