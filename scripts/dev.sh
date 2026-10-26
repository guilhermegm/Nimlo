#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$nimlo_root/scripts/desktop.sh" "$@"
