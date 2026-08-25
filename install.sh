#!/usr/bin/env bash
# Installs the cursor-w skill into every agent harness found on this machine.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME="cursor-w"
FILES=(SKILL.md AGENTS.md cursor-fan.mjs cursor-fanout.js examples)

installed=0
for base in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
  parent="$(dirname "$base")"
  [ -d "$parent" ] || continue          # harness not present — skip quietly
  dest="$base/$NAME"
  mkdir -p "$dest"
  for f in "${FILES[@]}"; do
    cp -r "$SRC/$f" "$dest/"
  done
  echo "installed -> $dest"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "No agent harness found (looked for ~/.claude and ~/.codex)."
  echo "Nothing here needs installing: point your agent at $SRC/SKILL.md and run"
  echo "  node $SRC/cursor-fan.mjs --tasks-file wave.json --out-dir wave-out"
  exit 0
fi

echo
echo "Next:"
echo "  1. curl https://cursor.com/install -fsS | bash   # if you have not already"
echo "  2. agent login                                   # once, interactive"
echo "  3. say \"Cursor-W\" to your agent"
