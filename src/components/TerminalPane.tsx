import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
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
import { Icon } from './Icon';

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

const ANSI_STRIP_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function TerminalPane({
  lane,
  remote,
  connected,
  fontSize,
  defaultFontSize,
  fontFamily,
  theme,
  selectionStyle,
  reconnectCounter,
  searchTrigger,
  registerOutput,
  onOpenLink,
  onRefreshDisplay,
  onFocusChange,
  onAttention,
  onChangeFontSize,
}: {
  lane: Lane;
  remote?: RemoteTerminal;
  connected: boolean;
  fontSize: number;
  defaultFontSize: number;
  fontFamily: string;
  theme: ThemePalette;
  selectionStyle: TerminalSelectionStyle;
  reconnectCounter: number;
  searchTrigger: number;
  registerOutput: (id: number, handler: OutputHandler | null, expected?: OutputHandler) => void;
  onOpenLink: (target: string, laneId: number, mode: 'preview' | 'external') => void;
  onRefreshDisplay: (laneId: number) => void;
  onFocusChange: (laneId: number, focused: boolean) => void;
  onAttention: (laneId: number) => void;
  onChangeFontSize: (laneId: number, size: number | undefined) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // In-terminal scrollback search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchCase, setSearchCase] = useState(false);
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchResults, setSearchResults] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  });

  const running = Boolean(remote?.running && connected);
  const liveRef = useRef(running);
  liveRef.current = running;
  const focusedRef = useRef(false);
  const attachedRef = useRef(false);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const cwdRef = useRef(lane.cwd);
  cwdRef.current = lane.cwd;
  const onOpenLinkRef = useRef(onOpenLink);
  onOpenLinkRef.current = onOpenLink;
  const onFocusRef = useRef(onFocusChange);
  onFocusRef.current = onFocusChange;
  const onAttentionRef = useRef(onAttention);
  onAttentionRef.current = onAttention;
  const onChangeFontSizeRef = useRef(onChangeFontSize);
  onChangeFontSizeRef.current = onChangeFontSize;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const sessionStateRef = useRef<{ generation: string; seq: number }>({
    generation: '',
    seq: -1,
  });
  const enqueueRef = useRef<((item: RenderItem) => void) | null>(null);

  const openSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.select());
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchResults({ index: -1, count: 0 });
    searchAddonRef.current?.clearDecorations();
    terminalRef.current?.focus();
  };

  const searchDecorations = () => ({
    matchBackground: `${themeRef.current.accent}44`,
    matchBorder: `${themeRef.current.accent}88`,
    matchOverviewRuler: themeRef.current.accent,
    activeMatchBackground: themeRef.current.accent,
    activeMatchBorder: themeRef.current.brightFg,
    activeMatchColorOverviewRuler: themeRef.current.brightFg,
  });

  const runSearch = (direction: 'next' | 'prev' = 'next', incremental = false) => {
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (!searchQuery) {
      addon.clearDecorations();
      setSearchResults({ index: -1, count: 0 });
      return;
    }
    const opts = {
      caseSensitive: searchCase,
      regex: searchRegex,
      incremental,
      decorations: searchDecorations(),
    };
    if (direction === 'prev') addon.findPrevious(searchQuery, opts);
    else addon.findNext(searchQuery, opts);
  };

  useEffect(() => {
    if (searchTrigger > 0) openSearch();
  }, [searchTrigger]);

  useEffect(() => {
    if (!searchOpen) return;
    runSearch('next', true);
  }, [searchOpen, searchQuery, searchCase, searchRegex]);

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

  const zoomStep = (delta: number) => {
    const next = Math.max(9, Math.min(24, fontSizeRef.current + delta));
    onChangeFontSizeRef.current(lane.processId, next === defaultFontSize ? undefined : next);
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
      allowProposedApi: true,
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
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.open(host);
    terminalRef.current = term;
    fitRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    const searchResSub = searchAddon.onDidChangeResults((e) => {
      setSearchResults({ index: e.resultIndex, count: e.resultCount });
    });

    const bellSub = term.onBell(() => {
      if (attachedRef.current && !focusedRef.current) {
        onAttentionRef.current(lane.processId);
      }
    });

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
        } else if (action === 'zoomIn') {
          zoomStep(1);
        } else if (action === 'zoomOut') {
          zoomStep(-1);
        } else if (action === 'zoomReset') {
          onChangeFontSizeRef.current(lane.processId, undefined);
        } else if (action === 'find') {
          openSearch();
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

    const queue: RenderItem[] = [];
    let rendering = false;
    let disposed = false;
    let outputTail = '';
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let unfocusedVisibleChars = 0;

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
          attachedRef.current = true;
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

      // Detect settled live output on unfocused panes so finished agents subtly signal readiness.
      if (attachedRef.current && !focusedRef.current) {
        const plain = ev.data.replace(ANSI_STRIP_RE, '').trim();
        if (plain.length > 0) {
          unfocusedVisibleChars += plain.length;
          if (settleTimer) clearTimeout(settleTimer);
          if (unfocusedVisibleChars >= 12) {
            settleTimer = setTimeout(() => {
              settleTimer = null;
              if (!disposed && !focusedRef.current && unfocusedVisibleChars >= 12) {
                unfocusedVisibleChars = 0;
                onAttentionRef.current(lane.processId);
              }
            }, 1800);
          }
        }
      } else {
        unfocusedVisibleChars = 0;
        if (settleTimer) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
      }
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
      attachedRef.current = false;
      queue.length = 0;
      enqueueRef.current = null;
      if (settleTimer) clearTimeout(settleTimer);
      registerOutput(lane.processId, null, outputHandler);
      clearTimeout(resizeTimer);
      observer.disconnect();
      host.removeEventListener('wheel', onWheel);
      searchResSub.dispose();
      bellSub.dispose();
      inputSub.dispose();
      resizeSub.dispose();
      linkSub.dispose();
      searchAddon.dispose();
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      searchAddonRef.current = null;
    };
  }, [lane.processId]);

  const remoteGen = remote?.generation ?? '';
  useEffect(() => {
    if (!connected || !remoteGen) return;
    let cancelled = false;
    attachedRef.current = false;
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
        // Terminal not started yet in daemon.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lane.processId, connected, remoteGen, reconnectCounter]);

  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    fitRef.current?.fit();
  }, [fontSize, fontFamily]);

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
        {searchOpen && (
          <div className="term-search-bar" onKeyDown={(e) => e.stopPropagation()}>
            <Icon name="search" size={12} />
            <input
              ref={searchInputRef}
              value={searchQuery}
              placeholder="Find in scrollback…"
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeSearch();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  runSearch(e.shiftKey ? 'prev' : 'next');
                }
              }}
            />
            <span className="term-search-count">
              {searchQuery
                ? searchResults.count > 0
                  ? `${searchResults.index + 1}/${searchResults.count}`
                  : '0'
                : ''}
            </span>
            <button
              className={`mini-toggle${searchCase ? ' active' : ''}`}
              title="Match case"
              onClick={() => setSearchCase((v) => !v)}
            >
              Aa
            </button>
            <button
              className={`mini-toggle${searchRegex ? ' active' : ''}`}
              title="Regex"
              onClick={() => setSearchRegex((v) => !v)}
            >
              .*
            </button>
            <button
              className="icon-btn xs"
              title="Previous match (Shift+Enter)"
              disabled={!searchQuery}
              onClick={() => runSearch('prev')}
            >
              ↑
            </button>
            <button
              className="icon-btn xs"
              title="Next match (Enter)"
              disabled={!searchQuery}
              onClick={() => runSearch('next')}
            >
              ↓
            </button>
            <button className="icon-btn xs" title="Close (Escape)" onClick={closeSearch}>
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        <div
          className="terminal-fit"
          ref={hostRef}
          onMouseDownCapture={(e) => {
            if (e.button === 2) {
              e.stopPropagation();
              terminalRef.current?.focus();
            }
          }}
          onContextMenuCapture={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({
              x: Math.max(6, Math.min(e.clientX, window.innerWidth - 195)),
              y: Math.max(6, Math.min(e.clientY, window.innerHeight - 240)),
            });
          }}
          onFocus={() => {
            focusedRef.current = true;
            onFocusRef.current(lane.processId, true);
          }}
          onBlur={() => {
            focusedRef.current = false;
            onFocusRef.current(lane.processId, false);
          }}
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
            <button
              role="menuitem"
              onClick={() => {
                setContextMenu(null);
                openSearch();
              }}
            >
              <span>Find in scrollback</span>
              <kbd>Ctrl+Alt+F</kbd>
            </button>
            <div className="context-sep" />
            <button
              role="menuitem"
              onClick={() => {
                zoomStep(1);
                setContextMenu(null);
                terminalRef.current?.focus();
              }}
            >
              <span>Zoom in</span>
              <kbd>Ctrl+=</kbd>
            </button>
            <button
              role="menuitem"
              onClick={() => {
                zoomStep(-1);
                setContextMenu(null);
                terminalRef.current?.focus();
              }}
            >
              <span>Zoom out</span>
              <kbd>Ctrl+-</kbd>
            </button>
            {lane.fontSize !== undefined && (
              <button
                role="menuitem"
                onClick={() => {
                  onChangeFontSizeRef.current(lane.processId, undefined);
                  setContextMenu(null);
                  terminalRef.current?.focus();
                }}
              >
                <span>Reset zoom ({defaultFontSize}px)</span>
                <kbd>Ctrl+0</kbd>
              </button>
            )}
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
