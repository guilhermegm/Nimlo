#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$nimlo_root/scripts/build-desktop.sh"
exec "$nimlo_root/target/desktop/Nimlo.app/Contents/MacOS/Nimlo" "$@"
