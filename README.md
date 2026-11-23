# Ronin

Lightweight **Rust + Tauri 2** desktop workspace for running persistent terminals and AI coding agents in movable panels, with repo browsing, ripgrep search, and quick file previews.

## Architecture

- **Split Rust binaries (`ronin` GUI + `ronin-daemon`):**
  - `ronin` (~4 MB): Lean Tauri 2 shell hosting the terminal canvas, sidebar, and preview overlays.
  - `ronin-daemon` (~800 KB, ~3.5 MB RSS): Pure-Rust detached PTY daemon linking zero GTK/WebKit libraries, using `portable-pty` + `vt100` screen/scrollback/mouse-encoding replay inside its own `systemd` user scope. Closing or restarting Ronin never kills running agents or drops scrollback.
- **Terminal Canvas:** Auto-fit grid, `Auto`/`1–12` column picker, drag-to-reorder, manual resize, maximize, per-pane display refresh, wrapped multi-line file links (`Ctrl+click` preview, `Ctrl+Shift+click` open externally), Pi-aware copy (`Ctrl+Shift+C` & right-click menu), Wayland-native clipboard (`wl-copy`/`wl-paste`), `Shift+Enter` (CSI-u), drag-and-drop file paths, and Ghostty-style solid selection.
- **Lightweight Sidebar (`Ctrl+Shift+B`):**
  - **Explorer (`Ctrl+Shift+E`):** Multi-root repo folders, lazy tree, toggle dotfiles, drag file paths straight onto terminals, quick new-terminal-here.
  - **Search (`Ctrl+Shift+F`):** Ripgrep-powered workspace search with case (`Aa`), regex (`.*`), and glob filters.
  - **Lanes (`Ctrl+Shift+L`):** Terminal/agent overview, quick tasks, and workspace notes.
  - **Quick Open (`Ctrl+Shift+P`):** Fuzzy file finder across all loaded folders.
- **Quick File Preview Overlay:** Line-numbered syntax-tinted code view with in-file search (`Ctrl+F`), sandboxed rendered/source **HTML** and **Markdown** preview, and zoom/pan **image** preview.
- **Live Omarchy Theming:** Watches `~/.local/state/omarchy/current/theme/colors.toml` and updates UI chrome and all terminal panes live.

## Build & Install (Linux)

```bash
npm install
npm test
cargo test --workspace --manifest-path src-tauri/Cargo.toml

# Build optimized release binaries (ronin + ronin-daemon)
npm run build:release

# Install binaries to ~/.local/bin and add desktop launcher entry
npm run install:linux
```

## Development

```bash
cargo build --manifest-path src-tauri/Cargo.toml -p ronin-daemon
npm run tauri dev
```
