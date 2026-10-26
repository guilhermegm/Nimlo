#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -x "$nimlo_root/target/release/nimlo-editor" ]; then
  cargo build --release --manifest-path "$nimlo_root/Cargo.toml"
fi
if [ "$#" -eq 0 ]; then
  cd "$nimlo_root"
  set -- --resume-project --listen 127.0.0.1:8875
fi
exec "$nimlo_root/target/release/nimlo-editor" --open-browser "$@"
