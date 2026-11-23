import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { Lane, RemoteTerminal, TerminalSelectionStyle, ThemePalette } from '../types';
import { api } from '../lib/api';
import { terminalLinkMode, terminalLinks } from '../lib/terminalLinks';
import {
  hasTerminalFileData,
  quoteTerminalPaths,
  terminalDropPaths,
} from '../lib/terminalFiles';
import {
  ESCAPE_SEQUENCE,
  SHIFT_ENTER_SEQUENCE,
  terminalShortcut,
} from '../lib/terminalShortcuts';
import { buildXtermTheme } from '../lib/theme';

export type OutputHandler = (event: {
  id: number;
  generation: string;
  seq: number;
  data: string;
}) => void;

interface RenderItem {
  type: 'replay' | 'output';
  data: string;
  cols?: number;
  rows?: number;
}

export function TerminalPane({
  lane,
  remote,
  connected,
  fontSize,
  fontFamily,
  theme,
  selectionStyle,
  reconnectCounter,
  registerOutput,
  onOpenLink,
  onRefreshDisplay,
  onFocusChange,
}: {
  lane: Lane;
  remote?: RemoteTerminal;
  connected: boolean;
  fontSize: number;
  fontFamily: string;
  theme: ThemePalette;
  selectionStyle: TerminalSelectionStyle;
  reconnectCounter: number;
  registerOutput: (id: number, handler: OutputHandler | null, expected?: OutputHandler) => void;
  onOpenLink: (target: string, laneId: number, mode: 'preview' | 'external') => void;
  onRefreshDisplay: (laneId: number) => void;
  onFocusChange: (laneId: number, focused: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const running = Boolean(remote?.running && connected);
  const liveRef = useRef(running);
  liveRef.current = running;
  const cwdRef = useRef(lane.cwd);
  cwdRef.current = lane.cwd;
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;
  const onFocusRef = useRef(onFocusChange);
  onFocusRef.current = onFocusChange;

  const sessionStateRef = useRef<{ generation: string; seq: number }>({
    generation: '',
    seq: -1,
  });
  const enqueueRef = useRef<((item: RenderItem) => void) | null>(null);

  const requestCopy = () => {
    const sel = terminalRef.current?.getSelection() ?? '';
    void api.terminalCopy(lane.processId, sel, cwdRef.current).catch(() => {});
  };

  const requestPaste = async () => {
    if (!liveRef.current) return;
    const text = await api.clipboardRead().catch(() => '');
    if (text && terminalRef.current) {
      terminalRef.current.paste(text);
      terminalRef.current.focus();
    }
  };

  useEffect(() => {
    if (!contextMenu) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setContextMenu(null);
      terminalRef.current?.focus();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [contextMenu]);

  // Core xterm lifecycle
  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      fontSize,
      fontFamily,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      minimumContrastRatio: 4.5,
      drawBoldTextInBrightColors: true,
      theme: buildXtermTheme(theme, selectionStyle),
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (event, uri) => {
          if (!/^(file|https?):/i.test(uri)) return;
          const mode = terminalLinkMode(event);
          if (!mode) return;
          event.preventDefault();
          onOpenLinkRef.current(uri, lane.processId, mode);
        },
        hover: (_, uri) => {
          host.title = `${uri}\nCtrl+click: preview · Ctrl+Shift+click: open externally`;
        },
        leave: () => {
          host.title = '';
        },
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(host);
    terminalRef.current = term;
    fitRef.current = fitAddon;

    term.attachCustomKeyEventHandler((event) => {
      const action = terminalShortcut(event, /Mac/.test(navigator.platform));
      if (!action) return true;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === 'keydown') {
        if (action === 'interrupt' && liveRef.current) {
          void api.terminalWrite(lane.processId, '\x03').catch(() => {});
        } else if (action === 'shiftEnter' && liveRef.current) {
          void api.terminalWrite(lane.processId, SHIFT_ENTER_SEQUENCE).catch(() => {});
        } else if (action === 'escape' && liveRef.current) {
          void api.terminalWrite(lane.processId, ESCAPE_SEQUENCE).catch(() => {});
        } else if (action === 'copy') {
          requestCopy();
        } else if (action === 'paste') {
          void requestPaste();
        }
      }
      return false;
    });

    const inputSub = term.onData((data) => {
      if (liveRef.current) {
        void api.terminalWrite(lane.processId, data).catch(() => {});
      }
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (liveRef.current) {
        void api.terminalResize(lane.processId, cols, rows).catch(() => {});
      }
    });
    const linkSub = term.registerLinkProvider({
      provideLinks(row, callback) {
        callback(
          terminalLinks(term.buffer.active, term.cols, row).map((link) => ({
            ...link,
            activate: (event: MouseEvent) => {
              const mode = terminalLinkMode(event);
              if (!mode) return;
              event.preventDefault();
              onOpenLinkRef.current(link.text, lane.processId, mode);
            },
            hover: () => {
              host.title = `${link.text}\nCtrl+click: preview · Ctrl+Shift+click: open externally`;
            },
            leave: () => {
              host.title = '';
            },
          })),
        );
      },
    });

    // Serialize replays and output chunks cleanly so async xterm writes never interleave out of order.
    const queue: RenderItem[] = [];
    let rendering = false;
    let disposed = false;
    let outputTail = '';

    const pump = () => {
      if (rendering || disposed || !queue.length) return;
      rendering = true;
      const item = queue.shift()!;
      if (item.type === 'replay') {
        term.clearSelection();
        term.reset();
        outputTail = '';
        if (item.cols && item.rows) {
          term.resize(item.cols, item.rows);
        }
      }
      const data = item.data;
      const clearedScreen =
        item.type === 'output' && /\x1b\[(?:[023]?J|\?1049[hl])/.test(outputTail + data);
      if (item.type === 'output') outputTail = data.slice(-12);
      term.write(data, () => {
        if (disposed) return;
        if (clearedScreen || (term.hasSelection() && !term.getSelection().trim())) {
          term.clearSelection();
        }
        if (item.type === 'replay') {
          fitAddon.fit();
          if (liveRef.current) {
            void api.terminalResize(lane.processId, term.cols, term.rows).catch(() => {});
          }
        }
        rendering = false;
        pump();
      });
    };

    enqueueRef.current = (item) => {
      queue.push(item);
      pump();
    };

    const outputHandler: OutputHandler = (ev) => {
      const state = sessionStateRef.current;
      if (!state.generation || ev.generation !== state.generation || ev.seq <= state.seq) return;
      state.seq = ev.seq;
      enqueueRef.current?.({ type: 'output', data: ev.data });
    };
    registerOutput(lane.processId, outputHandler);

    let resizeTimer: ReturnType<typeof setTimeout>;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (host.clientWidth > 0 && host.clientHeight > 0) {
          fitAddon.fit();
        }
      }, 65);
    });
    observer.observe(host);

    const onWheel = (e: WheelEvent) => {
      if (!e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    host.addEventListener('wheel', onWheel, { passive: false });

    requestAnimationFrame(() => {
      if (!disposed && host.clientWidth > 0 && host.clientHeight > 0) {
        fitAddon.fit();
      }
    });

    return () => {
      disposed = true;
      queue.length = 0;
      enqueueRef.current = null;
      registerOutput(lane.processId, null, outputHandler);
      clearTimeout(resizeTimer);
      observer.disconnect();
      host.removeEventListener('wheel', onWheel);
      inputSub.dispose();
      resizeSub.dispose();
      linkSub.dispose();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [lane.processId]);

  // Attach and replay whenever daemon session exists / restarts / reconnects
  const remoteGen = remote?.generation ?? '';
  useEffect(() => {
    if (!connected || !remoteGen) return;
    let cancelled = false;
    void (async () => {
      try {
        const snap = await api.terminalAttach(lane.processId);
        if (cancelled) return;
        sessionStateRef.current = { generation: snap.generation, seq: snap.seq };
        enqueueRef.current?.({
          type: 'replay',
          data: snap.data,
          cols: snap.cols,
          rows: snap.rows,
        });
      } catch {
        // Terminal not started yet in daemon; leave pane ready for Start.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lane.processId, connected, remoteGen, reconnectCounter]);

  // Live typography updates
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    fitRef.current?.fit();
  }, [fontSize, fontFamily]);

  // Live Omarchy theme + selection style updates
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.theme = buildXtermTheme(theme, selectionStyle);
  }, [theme, selectionStyle]);

  const acceptFileDrag = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasTerminalFileData(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = liveRef.current ? 'copy' : 'none';
    if (liveRef.current) setDragOver(true);
  };

  return (
    <>
      <div className={`terminal-wrap${dragOver ? ' drag-over' : ''}`}>
        <div
          className="terminal-fit"
          ref={hostRef}
          onMouseDownCapture={(e) => {
            // Preserve fullscreen TUI (Pi) selection on right-click before opening Copy menu.
            if (e.button === 2) {
              e.stopPropagation();
              terminalRef.current?.focus();
            }
          }}
          onContextMenuCapture={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({
              x: Math.max(6, Math.min(e.clientX, window.innerWidth - 170)),
              y: Math.max(6, Math.min(e.clientY, window.innerHeight - 130)),
            });
          }}
          onFocus={() => onFocusRef.current(lane.processId, true)}
          onBlur={() => onFocusRef.current(lane.processId, false)}
          onDragEnterCapture={acceptFileDrag}
          onDragOverCapture={acceptFileDrag}
          onDragLeave={() => setDragOver(false)}
          onDropCapture={(e) => {
            setDragOver(false);
            if (!hasTerminalFileData(e.dataTransfer)) return;
            e.preventDefault();
            e.stopPropagation();
            if (!liveRef.current) return;
            const paths = terminalDropPaths(e.dataTransfer);
            if (paths.length) {
              try {
                const quoted = quoteTerminalPaths(paths);
                terminalRef.current?.focus();
                terminalRef.current?.paste(quoted);
              } catch {
                /* control chars rejected */
              }
            }
          }}
        />
      </div>
      {contextMenu &&
        createPortal(
          <div
            ref={menuRef}
            className="context-menu"
            role="menu"
            aria-label="Terminal actions"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <button
              role="menuitem"
              onClick={() => {
                requestCopy();
                setContextMenu(null);
                terminalRef.current?.focus();
              }}
            >
              <span>Copy</span>
              <kbd>Ctrl+Shift+C</kbd>
            </button>
            <button
              role="menuitem"
              disabled={!running}
              onClick={() => {
                void requestPaste();
                setContextMenu(null);
              }}
            >
              <span>Paste</span>
              <kbd>Ctrl+Shift+V</kbd>
            </button>
            <div className="context-sep" />
            <button
              role="menuitem"
              onClick={() => {
                terminalRef.current?.clearSelection();
                setContextMenu(null);
                terminalRef.current?.focus();
              }}
            >
              <span>Clear selection</span>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                onRefreshDisplay(lane.processId);
              }}
            >
              <span>Refresh display</span>
            </button>
            <button
              role="menuitem"
              disabled={!running}
              onClick={() => {
                setContextMenu(null);
                void api.terminalKill(lane.processId).catch(() => {});
              }}
            >
              <span>Stop shell</span>
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
