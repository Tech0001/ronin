#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCH="$(uname -m)"
BIN="$ROOT/src-tauri/target/release/ronin"
DAEMON="$ROOT/src-tauri/target/release/ronin-daemon"
OUT="$ROOT/release"

if [[ ! -x "$BIN" || ! -x "$DAEMON" ]]; then
  echo "Release binaries missing. Run 'npm run build:release' first." >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

# 1. Portable Linux tarball (user-local installer, works on any distro with webkit2gtk-4.1)
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

PKG_DIR="$STAGE_DIR/ronin-$VERSION-linux-$ARCH"
mkdir -p "$PKG_DIR"
install -m 0755 "$BIN" "$PKG_DIR/ronin"
install -m 0755 "$DAEMON" "$PKG_DIR/ronin-daemon"
install -m 0644 "$ROOT/src-tauri/icons/ronin.svg" "$PKG_DIR/ronin.svg"
install -m 0644 "$ROOT/src-tauri/icons/icon.png" "$PKG_DIR/ronin.png"
install -m 0644 "$ROOT/LICENSE" "$PKG_DIR/LICENSE"
install -m 0644 "$ROOT/README.md" "$PKG_DIR/README.md"

cat > "$PKG_DIR/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$HOME/.local/bin" \
         "$HOME/.local/share/applications" \
         "$HOME/.local/share/icons/hicolor/scalable/apps" \
         "$HOME/.local/share/icons/hicolor/512x512/apps"

install -m 0755 "$DIR/ronin" "$HOME/.local/bin/ronin"
install -m 0755 "$DIR/ronin-daemon" "$HOME/.local/bin/ronin-daemon"
install -m 0644 "$DIR/ronin.svg" "$HOME/.local/share/icons/hicolor/scalable/apps/ronin.svg"
install -m 0644 "$DIR/ronin.png" "$HOME/.local/share/icons/hicolor/512x512/apps/ronin.png"

cat > "$HOME/.local/share/applications/ronin.desktop" <<DESKTOP
[Desktop Entry]
Version=1.0
Name=Ronin
GenericName=Terminal Workspace
Comment=Persistent terminal canvas and lightweight file workspace
Exec=$HOME/.local/bin/ronin
TryExec=$HOME/.local/bin/ronin
Icon=ronin
Type=Application
Categories=Development;System;TerminalEmulator;
Keywords=terminal;agents;workspace;shell;
StartupNotify=true
StartupWMClass=ronin
Terminal=false
DESKTOP

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
fi

echo "Installed Ronin to $HOME/.local/bin/ronin"
EOF
chmod +x "$PKG_DIR/install.sh"

cat > "$PKG_DIR/uninstall.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

rm -f "$HOME/.local/bin/ronin" \
      "$HOME/.local/bin/ronin-daemon" \
      "$HOME/.local/share/applications/ronin.desktop" \
      "$HOME/.local/share/icons/hicolor/scalable/apps/ronin.svg" \
      "$HOME/.local/share/icons/hicolor/512x512/apps/ronin.png"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
fi

echo "Removed Ronin binaries and desktop entry (saved workspace config at ~/.config/ronin/state.json was kept)."
EOF
chmod +x "$PKG_DIR/uninstall.sh"

TARBALL="$OUT/ronin-$VERSION-linux-$ARCH.tar.gz"
tar -czf "$TARBALL" -C "$STAGE_DIR" "ronin-$VERSION-linux-$ARCH"

# 2. Arch Linux package (.pkg.tar.zst) if makepkg is available
if command -v makepkg >/dev/null 2>&1; then
  ARCH_BUILD="$STAGE_DIR/arch"
  mkdir -p "$ARCH_BUILD"
  cp "$BIN" "$DAEMON" "$ROOT/src-tauri/icons/ronin.svg" "$ROOT/src-tauri/icons/icon.png" "$ROOT/LICENSE" "$ARCH_BUILD/"

  cat > "$ARCH_BUILD/ronin.desktop" <<'DESKTOP'
[Desktop Entry]
Version=1.0
Name=Ronin
GenericName=Terminal Workspace
Comment=Persistent terminal canvas and lightweight file workspace
Exec=/usr/bin/ronin
TryExec=/usr/bin/ronin
Icon=ronin
Type=Application
Categories=Development;System;TerminalEmulator;
Keywords=terminal;agents;workspace;shell;
StartupNotify=true
StartupWMClass=ronin
Terminal=false
DESKTOP

  cat > "$ARCH_BUILD/PKGBUILD" <<PKGBUILD
pkgname=ronin
pkgver=$VERSION
pkgrel=1
pkgdesc="Lightweight Rust + Tauri desktop workspace for persistent terminal and AI agent panels"
arch=('$ARCH')
url="https://github.com/Tech0001/ronin"
license=('MIT')
depends=('webkit2gtk-4.1' 'gtk3')
optdepends=(
  'ripgrep: workspace content search and quick file open'
  'wl-clipboard: native Wayland copy and paste'
)
options=('!strip' '!debug')

package() {
  install -Dm755 "\$startdir/ronin" "\$pkgdir/usr/bin/ronin"
  install -Dm755 "\$startdir/ronin-daemon" "\$pkgdir/usr/bin/ronin-daemon"
  install -Dm644 "\$startdir/ronin.desktop" "\$pkgdir/usr/share/applications/ronin.desktop"
  install -Dm644 "\$startdir/ronin.svg" "\$pkgdir/usr/share/icons/hicolor/scalable/apps/ronin.svg"
  install -Dm644 "\$startdir/icon.png" "\$pkgdir/usr/share/icons/hicolor/512x512/apps/ronin.png"
  install -Dm644 "\$startdir/LICENSE" "\$pkgdir/usr/share/licenses/ronin/LICENSE"
}
PKGBUILD

  (cd "$ARCH_BUILD" && PKGDEST="$OUT" makepkg -f --nodeps --skipinteg)
fi

(cd "$OUT" && sha256sum ronin-* > SHA256SUMS.txt)
ls -lh "$OUT"
