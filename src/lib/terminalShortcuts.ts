// CSI-u preserves Shift+Enter as a distinct key for terminal applications.
export const SHIFT_ENTER_SEQUENCE = '\x1b[13;2u';
export const ESCAPE_SEQUENCE = '\x1b';

export type TerminalShortcutAction =
  | 'interrupt'
  | 'copy'
  | 'paste'
  | 'shiftEnter'
  | 'escape'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'find'
  | 'paneNav';

export function terminalShortcut(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> & {
    isComposing?: boolean;
  },
  mac: boolean,
): TerminalShortcutAction | null {
  const key = event.key.toLowerCase();
  if (event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey) {
    if (key === 'f') return 'find';
    if (
      key === 'm' ||
      key === 'arrowleft' ||
      key === 'arrowright' ||
      key === 'arrowup' ||
      key === 'arrowdown' ||
      /^[1-9]$/.test(key)
    ) {
      return 'paneNav';
    }
  }
  if (event.altKey) return null;
  if (key === 'escape' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing) {
    return 'escape';
  }
  if (key === 'enter' && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
    return 'shiftEnter';
  }
  if (event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'c') return 'interrupt';
  const zoomMod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (zoomMod && (key === '=' || key === '+')) return 'zoomIn';
  if (zoomMod && !event.shiftKey && key === '-') return 'zoomOut';
  if (zoomMod && !event.shiftKey && key === '0') return 'zoomReset';
  const clipboard = mac
    ? event.metaKey && !event.ctrlKey && !event.shiftKey
    : event.ctrlKey && event.shiftKey && !event.metaKey;
  if (clipboard && key === 'c') return 'copy';
  if (clipboard && key === 'v') return 'paste';
  return null;
}
