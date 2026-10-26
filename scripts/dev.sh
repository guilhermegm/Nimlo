#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$nimlo_root/scripts/build-desktop.sh" dev
echo 'Nimlo Dev: CSS updates live; HTML/JS reload safely; Rust rebuilds automatically.'
echo 'Close the window to keep the host running. Quit Nimlo to stop it. Ctrl+C also stops this dev launch.'
exec "$nimlo_root/target/desktop/Nimlo Dev.app/Contents/MacOS/Nimlo" --dev-root "$nimlo_root" "$@"
