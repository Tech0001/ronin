import type { ITheme } from '@xterm/xterm';
import type { TerminalSelectionStyle, ThemePalette } from '../types';

export function applyThemeToDocument(theme: ThemePalette) {
  const root = document.documentElement;
  const mode = theme.mode === 'light' ? 'light' : 'dark';
  root.dataset.themeMode = mode;
  root.style.colorScheme = mode;
  root.style.setProperty('--bg', theme.background);
  root.style.setProperty('--bg-dark', theme.darkBg);
  root.style.setProperty('--surface', theme.surface);
  root.style.setProperty('--elevated', theme.elevated);
  root.style.setProperty('--border', theme.border);
  root.style.setProperty('--fg', theme.foreground);
  root.style.setProperty('--fg-soft', theme.softFg);
  root.style.setProperty('--fg-muted', theme.muted);
  root.style.setProperty('--fg-bright', theme.brightFg);
  root.style.setProperty('--accent', theme.accent);
  root.style.setProperty('--cursor', theme.cursor);
  root.style.setProperty('--selection-bg', theme.selectionBackground);
  root.style.setProperty('--selection-fg', theme.selectionForeground);
  root.style.setProperty('--ansi-green', theme.ansi[2] || '#5aa15d');
  root.style.setProperty('--ansi-yellow', theme.ansi[3] || '#d7be96');
  root.style.setProperty('--ansi-blue', theme.ansi[4] || '#67dd82');
  root.style.setProperty('--ansi-red', theme.ansi[1] || theme.accent);
  root.style.setProperty('--ansi-cyan', theme.ansi[6] || '#6f9485');
  root.style.setProperty('--ansi-magenta', theme.ansi[5] || theme.foreground);
}

function opaqueHex(value: string): string {
  return value
    .replace(/^(#[\da-f]{6})[\da-f]{2}$/i, '$1')
    .replace(/^(#[\da-f]{3})[\da-f]$/i, '$1');
}

function translucentHex(hex: string, alphaHex = '4d'): string {
  const clean = opaqueHex(hex);
  if (/^#[\da-f]{6}$/i.test(clean)) return `${clean}${alphaHex}`;
  return clean;
}

export function buildXtermTheme(
  theme: ThemePalette,
  selectionStyle: TerminalSelectionStyle,
): ITheme {
  const solidSel = opaqueHex(theme.selectionBackground || theme.accent);
  const a = theme.ansi;
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor || theme.accent,
    cursorAccent: theme.background,
    selectionBackground: selectionStyle === 'solid' ? solidSel : translucentHex(solidSel, '55'),
    selectionInactiveBackground:
      selectionStyle === 'solid' ? solidSel : translucentHex(solidSel, '33'),
    selectionForeground:
      selectionStyle === 'solid' ? theme.selectionForeground || theme.background : undefined,
    black: a[0],
    red: a[1],
    green: a[2],
    yellow: a[3],
    blue: a[4],
    magenta: a[5],
    cyan: a[6],
    white: a[7],
    brightBlack: a[8],
    brightRed: a[9],
    brightGreen: a[10],
    brightYellow: a[11],
    brightBlue: a[12],
    brightMagenta: a[13],
    brightCyan: a[14],
    brightWhite: a[15],
  };
}
