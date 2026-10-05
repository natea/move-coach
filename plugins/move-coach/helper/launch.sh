#!/bin/bash
# Runs pose_coach.py inside "Move Coach Camera.app" so macOS asks about (and remembers)
# camera access for that app, and relays the helper's stdout to our stdout for the mod.
# usage: launch.sh <out-dir> <program> [args...]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
app="$HOME/Library/Application Support/move-coach/Move Coach Camera.app"
bin="$app/Contents/MacOS/move-coach-camera"
src="$here/camera-app"

# build once (and again if the stub or plist changes)
if [[ ! -x "$bin" || "$src/stub.c" -nt "$bin" || "$src/Info.plist" -nt "$bin" ]]; then
  mkdir -p "$app/Contents/MacOS"
  cp "$src/Info.plist" "$app/Contents/Info.plist"
  /usr/bin/xcrun clang -O2 -o "$bin" "$src/stub.c"
  /usr/bin/codesign --force --sign - "$app" >/dev/null 2>&1
fi

dir="$1"; shift
pipe="$dir/stdout.fifo"
rm -f "$pipe"; mkfifo "$pipe"
/usr/bin/open -n -g -a "$app" --stdout "$pipe" --stderr "$dir/stderr.log" --args "$@"
# EOF when the helper exits; if the mod stops reading, the helper gets SIGPIPE and exits too
exec cat "$pipe"
