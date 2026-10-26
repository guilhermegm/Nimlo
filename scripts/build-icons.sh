#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
nimlo_icon_source="$nimlo_root/assets/nimlo-icon.png"
nimlo_logo_source="$nimlo_root/assets/nimlo-logo.png"
mkdir -p "$nimlo_root/target/branding"
nimlo_stage=$(mktemp -d "$nimlo_root/target/branding/.icons.XXXXXX")
trap 'rm -rf "$nimlo_stage"' EXIT HUP INT TERM
nimlo_iconset="$nimlo_stage/Nimlo.iconset"
mkdir -p "$nimlo_iconset"
for nimlo_size in 16 32 128 256 512; do
  sips -z "$nimlo_size" "$nimlo_size" "$nimlo_icon_source" --out "$nimlo_iconset/icon_${nimlo_size}x${nimlo_size}.png" >/dev/null
  nimlo_retina=$((nimlo_size * 2))
  sips -z "$nimlo_retina" "$nimlo_retina" "$nimlo_icon_source" --out "$nimlo_iconset/icon_${nimlo_size}x${nimlo_size}@2x.png" >/dev/null
done
iconutil -c icns "$nimlo_iconset" -o "$nimlo_stage/Nimlo.icns"
mv "$nimlo_stage/Nimlo.icns" "$nimlo_root/desktop/macos/Nimlo.icns"
for nimlo_asset in favicon:32 apple-touch-icon:180 logo:128; do
  nimlo_name=${nimlo_asset%:*}
  nimlo_size=${nimlo_asset#*:}
  nimlo_source="$nimlo_icon_source"
  if [ "$nimlo_name" = logo ]; then nimlo_source="$nimlo_logo_source"; fi
  sips -z "$nimlo_size" "$nimlo_size" "$nimlo_source" --out "$nimlo_stage/$nimlo_name.png" >/dev/null
  mv "$nimlo_stage/$nimlo_name.png" "$nimlo_root/web/$nimlo_name.png"
done
sips -z 256 256 "$nimlo_logo_source" --out "$nimlo_stage/welcome-logo.png" >/dev/null
mv "$nimlo_stage/welcome-logo.png" "$nimlo_root/desktop/macos/welcome-logo.png"
echo 'Built colored launcher icons and separate transparent welcome logos.'
