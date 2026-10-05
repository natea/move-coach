#!/bin/bash
# Rebuilds plugins/move-coach from the dev copy of the mod and the skill, leaving out
# the book illustrations (copyrighted, personal use only) and generated files.
# usage: scripts/sync.sh [dev-mod-folder] [skill-folder]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dev="${1:-$HOME/.claude/dev-mods/6123eddb-2540-4bc3-97cf-6437d2a710c9/move-coach}"
skill="${2:-$HOME/.claude/skills/built-to-move-mobility-test}"
out="$here/plugins/move-coach"

rm -rf "$out"
mkdir -p "$out/assets/book" "$out/skills"
rsync -a \
  --exclude '__pycache__' --exclude '.claude-plugin/types' --exclude 'assets/book/*' \
  --exclude '*.bak*' --exclude '.DS_Store' \
  "$dev/" "$out/"
rsync -a --exclude '.DS_Store' "$skill/" "$out/skills/built-to-move-mobility-test/"

# the plugin's tsconfig extends types the engine writes per machine; keep it out of the package
rm -f "$out/tsconfig.json"

cat > "$out/assets/book/README.md" <<'TXT'
# Illustrations (not included)

The pane can show the book's illustration for each test next to the camera. The
illustrations from *Built to Move* are copyrighted, so they aren't part of this plugin.
The pane works fine without them.

To use your own (for example, photos or drawings you made), put them in
`~/.config/move-coach/book/`, named after the test:

sit-and-rise, couch-floor-p1, couch-floor-p2, couch-floor-p3, couch-couch-p1, couch-couch-p2,
airport-scanner, shoulder-rotation, squat-p1, squat-p3, squat-p4, solec, old-man

as `<name>.jpg` (Desktop app) and `<name>.png` (terminal).
TXT

# nothing secret or personal may ship
if grep -rIl -E 'sk_[A-Za-z0-9]{20,}|lin_api_|xi-api-key: *[A-Za-z0-9]{20,}' "$out" ; then
  echo "refusing: a file above looks like it contains a key" >&2
  exit 1
fi
echo "synced into $out"
