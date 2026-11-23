#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/src-tauri/target/release/ronin"
DAEMON="$ROOT/src-tauri/target/release/ronin-daemon"

if [[ ! -x "$BIN" || ! -x "$DAEMON" ]]; then
  echo "Release binaries not found. Build first with:" >&2
  echo "  npm run build:release" >&2
  exit 1
fi

mkdir -p "$HOME/.local/bin" \
         "$HOME/.local/share/applications" \
         "$HOME/.local/share/icons/hicolor/scalable/apps"

install -m 0755 "$BIN" "$HOME/.local/bin/ronin"
install -m 0755 "$DAEMON" "$HOME/.local/bin/ronin-daemon"
install -m 0644 "$ROOT/src-tauri/icons/ronin.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/ronin.svg"

cat > "$HOME/.local/share/applications/ronin.desktop" <<EOF
[Desktop Entry]
Name=Ronin
Comment=Persistent terminal canvas and lightweight file workspace
Exec=$HOME/.local/bin/ronin
Icon=ronin
Type=Application
Categories=Development;System;TerminalEmulator;
StartupWMClass=ronin
Terminal=false
EOF

echo "Installed ronin and ronin-daemon to $HOME/.local/bin/ and desktop entry to $HOME/.local/share/applications/ronin.desktop"
