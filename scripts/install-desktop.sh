#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
nimlo_source="$nimlo_root/target/desktop/Nimlo.app"
nimlo_install=${INSTALL_DIR:-"$HOME/Applications"}

if [ "$(uname -s)" != Darwin ]; then
  echo 'Desktop installation currently targets macOS.' >&2
  exit 1
fi
if [ ! -d "$nimlo_source" ]; then
  echo 'Build Nimlo first with make build.' >&2
  exit 1
fi
codesign --verify --strict "$nimlo_source"
nimlo_source=$(CDPATH= cd -- "$nimlo_source" && pwd -P)
mkdir -p "$nimlo_install"
nimlo_install=$(CDPATH= cd -- "$nimlo_install" && pwd -P)
case "$nimlo_install/" in
  "$nimlo_source/"*) echo 'INSTALL_DIR must be outside the source app bundle.' >&2; exit 1 ;;
esac
nimlo_target="$nimlo_install/Nimlo.app"
if [ -L "$nimlo_target" ]; then
  echo 'Nimlo.app is a symbolic link. Choose another INSTALL_DIR.' >&2
  exit 1
fi
if [ -e "$nimlo_target" ]; then
  nimlo_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$nimlo_target/Contents/Info.plist" 2>/dev/null || true)
  if [ "$nimlo_id" != dev.nimlo.editor ]; then
    echo 'An unrelated or invalid Nimlo.app already exists. Choose another INSTALL_DIR.' >&2
    exit 1
  fi
fi
# File identity also catches launches through an aliased parent directory, such
# as /var versus /private/var, without parsing executable paths from ps output.
nimlo_running=$(/usr/sbin/lsof -t -- "$nimlo_target/Contents/MacOS/Nimlo" "$nimlo_target/Contents/Resources/nimlo-editor" 2>/dev/null || true)
if [ -n "$nimlo_running" ]; then
  echo 'Quit the installed Nimlo app before deploying. Closing its window keeps its host running.' >&2
  exit 1
fi

# Stage and verify the whole bundle before replacing an existing owned app.
# Recovery and project files are outside the bundle and never touched here.
nimlo_stage=$(mktemp -d "$nimlo_install/.nimlo-install.XXXXXX")
nimlo_previous="$nimlo_stage/previous-Nimlo.app"
nimlo_installed=no
nimlo_cleanup() {
  if [ "$nimlo_installed" = no ] && [ -d "$nimlo_previous" ] && [ ! -e "$nimlo_target" ]; then
    if ! mv "$nimlo_previous" "$nimlo_target"; then
      printf 'Previous app preserved at %s\n' "$nimlo_previous" >&2
      return
    fi
  fi
  rm -rf "$nimlo_stage"
}
trap nimlo_cleanup EXIT
trap 'exit 1' HUP INT TERM
ditto "$nimlo_source" "$nimlo_stage/Nimlo.app"
codesign --verify --strict "$nimlo_stage/Nimlo.app"
if [ -e "$nimlo_target" ]; then mv "$nimlo_target" "$nimlo_previous"; fi
mv "$nimlo_stage/Nimlo.app" "$nimlo_target"
nimlo_installed=yes
printf 'Installed %s\n' "$nimlo_target"
echo 'Open it with make open, using the same INSTALL_DIR.'
