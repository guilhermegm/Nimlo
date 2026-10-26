#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
nimlo_source="$nimlo_root/target/desktop/Nimlo.app"
if [ "$(uname -s)" != Darwin ]; then
  echo 'Desktop packaging currently targets macOS.' >&2
  exit 1
fi
if [ ! -d "$nimlo_source" ]; then
  echo 'Build Nimlo first with make build.' >&2
  exit 1
fi
codesign --verify --strict "$nimlo_source"
nimlo_output="$nimlo_root/target/packages"
mkdir -p "$nimlo_output"
nimlo_stage=$(mktemp -d "$nimlo_output/.package.XXXXXX")
trap 'rm -rf "$nimlo_stage"' EXIT
trap 'exit 1' HUP INT TERM
nimlo_archive="Nimlo-macOS-$(uname -m).zip"
ditto -c -k --sequesterRsrc --keepParent "$nimlo_source" "$nimlo_stage/$nimlo_archive"
mv "$nimlo_stage/$nimlo_archive" "$nimlo_output/$nimlo_archive"
printf 'Packaged %s\n' "$nimlo_output/$nimlo_archive"
