#!/bin/sh
set -eu
nimlo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$nimlo_root/scripts/build-desktop.sh" dev
nimlo_app="$nimlo_root/target/desktop/Nimlo Dev.app"
nimlo_logs="$nimlo_root/target/desktop/logs"
nimlo_log="$nimlo_logs/dev.log"
if [ -L "$nimlo_logs" ] || [ -L "$nimlo_log" ] || { [ -e "$nimlo_log" ] && [ ! -f "$nimlo_log" ]; }; then
  echo 'The dev log must be a regular file in the generated logs directory.' >&2
  exit 1
fi
mkdir -p "$nimlo_logs"
chmod 700 "$nimlo_logs"
touch "$nimlo_log"
chmod 600 "$nimlo_log"
# LaunchServices owns the GUI rather than the caller's terminal/tool session.
# PATH keeps Cargo and terminal-installed CLIs available to the dev watcher.
/usr/bin/open -a "$nimlo_app" --env "PATH=$PATH" --stdout "$nimlo_log" --stderr "$nimlo_log" --args --dev-root "$nimlo_root" "$@"
echo 'Nimlo Dev opened. This command returns while the app keeps running.'
printf 'Rust build output: %s\n' "$nimlo_log"
echo 'Quit Nimlo Dev with Cmd+Q to end its host. Quit and relaunch to change launch options.'
