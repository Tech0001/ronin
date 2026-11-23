import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSettings,
  DaemonStatus,
  FilePreviewResult,
  Lane,
  PreviewRequest,
  RemoteTerminal,
  SidebarTab,
  ThemePalette,
  WorkspaceState,
} from './types';
import { api } from './lib/api';
import {
  arrangeTerminalPanels,
  autoFitPanels,
  dropTerminalPanel,
} from './lib/terminalLayout';
import { shortenHome } from './lib/terminalFiles';
import { applyThemeToDocument } from './lib/theme';
import { Icon, RoninMark } from './components/Icon';
import { OutputHandler, TerminalPane } from './components/TerminalPane';
import { Sidebar } from './components/Sidebar';
import { FilePreviewModal } from './components/FilePreviewModal';
import { QuickOpenModal } from './components/QuickOpenModal';
import { ConfirmModal, LaneModal, SettingsModal } from './components/Modals';

const DEFAULT_THEME: ThemePalette = {
  source: 'built-in',
  mode: 'dark',
  background: '#0b0d11',
  darkBg: '#080a0d',
  surface: '#14171f',
  elevated: '#1b1f2a',
  border: '#2d3640',
  foreground: '#f0b7ca',
  softFg: '#d8c6cc',
  muted: '#678270',
  brightFg: '#fff1f6',
  accent: '#f23888',
  cursor: '#f23888',
  selectionBackground: '#f23888',
  selectionForeground: '#0b0d11',
  ansi: [
    '#0b0d11', '#f23888', '#5aa15d', '#d7be96', '#67dd82', '#f0b7ca', '#6f9485', '#f0b7ca',
    '#678270', '#ff6aa7', '#86bf86', '#e6d3b4', '#8bf0a1', '#ffd0dc', '#8bb0a4', '#fff1f6',
  ],
};

const DEFAULT_WORKSPACE: WorkspaceState = {
  folders: [],
  lanes: [],
  columns: 0,
  autoFit: true,
  sidebarOpen: true,
  sidebarTab: 'explorer',
  sidebarWidth: 272,
  notes: '',
  tasks: [],
  settings: {
    fontSize: 13,
    fontFamily:
      "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'CaskaydiaMono Nerd Font', ui-monospace, monospace",
    shell: '',
    selectionStyle: 'solid',
    autoStartLanes: true,
    showHiddenFiles: false,
  },
};

let nextPreviewRequestId = 0;

export function App() {
  const [booted, setBooted] = useState(false);
  const [version, setVersion] = useState('1.0.0');
  const [homeDir, setHomeDir] = useState('/');
  const [defaultShell, setDefaultShell] = useState('/bin/bash');
  const [workspace, setWorkspace] = useState<WorkspaceState>(DEFAULT_WORKSPACE);
  const [theme, setTheme] = useState<ThemePalette>(DEFAULT_THEME);
  const [remotes, setRemotes] = useState<Map<number, RemoteTerminal>>(() => new Map());
  const [daemon, setDaemon] = useState<DaemonStatus>({
    connected: false,
    pid: null,
    runtimeDir: '',
  });
  const [reconnectCounter, setReconnectCounter] = useState(0);
  const [maximizedId, setMaximizedId] = useState<number | null>(null);
  const [displayVersions, setDisplayVersions] = useState<Record<number, number>>({});
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [toast, setToast] = useState<string | null>(null);

  // Modals
  const [preview, setPreview] = useState<{ request: PreviewRequest; data?: FilePreviewResult }>();
  const [quickOpen, setQuickOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef<HTMLDivElement>(null);
  const [laneModal, setLaneModal] = useState<
    | { mode: 'create'; kind: 'terminal' | 'agent'; cwd?: string }
    | { mode: 'edit'; lane: Lane }
    | null
  >(null);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const activeLaneRef = useRef<number | null>(null);
  const terminalFocusedRef = useRef(false);
  const outputHandlersRef = useRef<Map<number, OutputHandler>>(new Map());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((curr) => (curr === msg ? null : curr));
    }, 3400);
  }, []);

  const persistWorkspace = useCallback((next: WorkspaceState, immediate = false) => {
    workspaceRef.current = next;
    setWorkspace(next);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    const flush = () => {
      void api.saveWorkspace(workspaceRef.current).catch(() => {});
    };
    if (immediate) flush();
    else saveTimerRef.current = setTimeout(flush, 180);
  }, []);

  const updateWorkspace = useCallback(
    (updater: (prev: WorkspaceState) => WorkspaceState, immediate = false) => {
      persistWorkspace(updater(workspaceRef.current), immediate);
    },
    [persistWorkspace],
  );

  const focusLane = useCallback((id: number | null) => {
    const target = id ?? workspaceRef.current.lanes[0]?.processId;
    if (target !== undefined) {
      document
        .querySelector<HTMLTextAreaElement>(`[data-lane-id="${target}"] .xterm-helper-textarea`)
        ?.focus();
    }
  }, []);

  const registerOutput = useCallback(
    (id: number, handler: OutputHandler | null, expected?: OutputHandler) => {
      if (handler) {
        outputHandlersRef.current.set(id, handler);
      } else if (!expected || outputHandlersRef.current.get(id) === expected) {
        outputHandlersRef.current.delete(id);
      }
    },
    [],
  );

  // Close columns popover on outside click or Escape
  useEffect(() => {
    if (!colsOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!colsRef.current?.contains(e.target as Node)) setColsOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setColsOpen(false);
        focusLane(activeLaneRef.current);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [colsOpen, focusLane]);

  // Apply theme CSS vars on change
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);

  // Bootstrap + live Tauri event subscriptions
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];

    void (async () => {
      try {
        const [uState, uOutput, uConn, uTheme] = await Promise.all([
          api.onDaemonState((terminals) => {
            if (disposed) return;
            const next = new Map<number, RemoteTerminal>();
            for (const t of terminals) next.set(t.id, t);
            setRemotes(next);
          }),
          api.onDaemonOutput((ev) => {
            outputHandlersRef.current.get(ev.id)?.(ev);
          }),
          api.onDaemonConnection((status) => {
            if (disposed) return;
            const isUp = status === 'connected';
            setDaemon((prev) => ({ ...prev, connected: isUp }));
            if (isUp) {
              setReconnectCounter((c) => c + 1);
              void api.daemonStatus().then((s) => !disposed && setDaemon(s)).catch(() => {});
              void api.daemonList().then((list) => {
                if (disposed) return;
                const next = new Map<number, RemoteTerminal>();
                for (const t of list) next.set(t.id, t);
                setRemotes(next);
              }).catch(() => {});
            }
          }),
          api.onThemeChanged((nextTheme) => {
            if (!disposed) setTheme(nextTheme);
          }),
        ]);
        if (disposed) {
          uState();
          uOutput();
          uConn();
          uTheme();
          return;
        }
        unlisteners.push(uState, uOutput, uConn, uTheme);

        const data = await api.bootstrap();
        if (disposed) return;
        setVersion(data.version);
        setHomeDir(data.homeDir);
        setDefaultShell(data.defaultShell);
        workspaceRef.current = data.workspace;
        setWorkspace(data.workspace);
        setTheme(data.theme);
        setDaemon({
          connected: data.connected,
          pid: data.daemonPid ?? null,
          runtimeDir: data.runtimeDir,
        });
        const map = new Map<number, RemoteTerminal>();
        for (const t of data.terminals) map.set(t.id, t);
        setRemotes(map);
        setBooted(true);

        // Start saved lanes that aren't already live in the detached daemon
        if (data.workspace.settings.autoStartLanes) {
          for (const lane of data.workspace.lanes) {
            if (!map.get(lane.processId)?.running) {
              void api.terminalStart(lane.processId, lane.cwd).catch(() => {});
            }
          }
        }
      } catch (err) {
        showToast(`Startup error: ${String(err)}`);
        setBooted(true);
      }
    })();

    return () => {
      disposed = true;
      for (const un of unlisteners) un();
      dragCleanupRef.current?.();
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [showToast]);

  // Measure canvas viewport
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setCanvasSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [booted]);

  // Auto-fit panels when viewport, columns, or lane count changes
  useEffect(() => {
    if (
      !booted ||
      !workspace.autoFit ||
      !canvasSize.width ||
      !canvasSize.height ||
      maximizedId !== null ||
      dragCleanupRef.current
    ) {
      return;
    }
    const lanes = workspaceRef.current.lanes;
    if (!lanes.length) return;
    const next = autoFitPanels(lanes, canvasSize.width, canvasSize.height, workspace.columns);
    const changed = next.some(
      (l, i) =>
        l.x !== lanes[i].x ||
        l.y !== lanes[i].y ||
        l.width !== lanes[i].width ||
        l.height !== lanes[i].height,
    );
    if (changed) {
      updateWorkspace((prev) => ({ ...prev, lanes: next }));
    }
  }, [
    booted,
    workspace.autoFit,
    workspace.columns,
    workspace.lanes.length,
    canvasSize.width,
    canvasSize.height,
    maximizedId,
    updateWorkspace,
  ]);

  // Global keyboard shortcuts (carefully avoiding single-Ctrl terminal readline bindings!)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const inTerminal = terminalFocusedRef.current;

      if (key === 'p' && (e.shiftKey || !inTerminal)) {
        e.preventDefault();
        setQuickOpen(true);
      } else if (key === 'b' && (e.shiftKey || !inTerminal)) {
        e.preventDefault();
        updateWorkspace((prev) => ({ ...prev, sidebarOpen: !prev.sidebarOpen }));
      } else if (e.shiftKey && key === 'e') {
        e.preventDefault();
        updateWorkspace((prev) => ({ ...prev, sidebarOpen: true, sidebarTab: 'explorer' }));
      } else if (e.shiftKey && key === 'f') {
        e.preventDefault();
        updateWorkspace((prev) => ({ ...prev, sidebarOpen: true, sidebarTab: 'search' }));
        requestAnimationFrame(() => searchInputRef.current?.select());
      } else if (e.shiftKey && key === 'l') {
        e.preventDefault();
        updateWorkspace((prev) => ({ ...prev, sidebarOpen: true, sidebarTab: 'lanes' }));
      } else if (key === ',' && !e.shiftKey) {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [updateWorkspace]);

  const openFilePreview = useCallback(
    (path: string, cwd?: string, line?: number, column?: number, sourceLaneId?: number) => {
      const requestId = ++nextPreviewRequestId;
      const request: PreviewRequest = { requestId, path, cwd, line, column, sourceLaneId };
      setPreview({ request });
      void api
        .previewFile(path, cwd, line, column)
        .then((result) => {
          setPreview((curr) =>
            curr && curr.request.requestId === requestId ? { ...curr, data: result } : curr,
          );
        })
        .catch((err) => {
          setPreview((curr) =>
            curr && curr.request.requestId === requestId
              ? {
                  ...curr,
                  data: { path, kind: 'error', error: String(err) },
                }
              : curr,
          );
        });
    },
    [],
  );

  const handleOpenLink = useCallback(
    (target: string, laneId: number, mode: 'preview' | 'external') => {
      const lane = workspaceRef.current.lanes.find((l) => l.processId === laneId);
      if (/^https?:\/\//i.test(target) || mode === 'external') {
        void api.openExternal(target, lane?.cwd).catch((err) => showToast(String(err)));
      } else {
        openFilePreview(target, lane?.cwd, undefined, undefined, laneId);
      }
    },
    [openFilePreview, showToast],
  );

  const handleAddFolder = async () => {
    const picked = await api.pickFolder(workspace.folders[0] || homeDir).catch(() => null);
    if (!picked) return;
    if (workspaceRef.current.folders.includes(picked)) {
      updateWorkspace((prev) => ({ ...prev, sidebarOpen: true, sidebarTab: 'explorer' }));
      return;
    }
    updateWorkspace(
      (prev) => ({
        ...prev,
        folders: [...prev.folders, picked],
        sidebarOpen: true,
        sidebarTab: 'explorer',
      }),
      true,
    );
  };

  const handleRemoveFolder = (folder: string) => {
    updateWorkspace(
      (prev) => ({ ...prev, folders: prev.folders.filter((f) => f !== folder) }),
      true,
    );
  };

  const handleStartLane = async (id: number) => {
    const lane = workspaceRef.current.lanes.find((l) => l.processId === id);
    if (!lane) return;
    try {
      await api.terminalStart(id, lane.cwd);
      const list = await api.daemonList();
      const next = new Map<number, RemoteTerminal>();
      for (const t of list) next.set(t.id, t);
      setRemotes(next);
      requestAnimationFrame(() => focusLane(id));
    } catch (err) {
      showToast(String(err));
    }
  };

  const handleRunCommand = async (id: number) => {
    const lane = workspaceRef.current.lanes.find((l) => l.processId === id);
    if (!lane || !lane.command) return;
    try {
      if (!remotes.get(id)?.running) {
        await api.terminalStart(id, lane.cwd);
        const list = await api.daemonList();
        const next = new Map<number, RemoteTerminal>();
        for (const t of list) next.set(t.id, t);
        setRemotes(next);
        await new Promise((r) => setTimeout(r, 140));
      }
      await api.terminalWrite(id, lane.command + '\r');
      focusLane(id);
    } catch (err) {
      showToast(String(err));
    }
  };

  const handleRefreshDisplay = useCallback(
    async (id: number) => {
      try {
        await api.terminalRefreshDisplay(id);
        setDisplayVersions((curr) => ({ ...curr, [id]: (curr[id] ?? 0) + 1 }));
      } catch (err) {
        showToast(String(err));
      }
    },
    [showToast],
  );

  const handleCreateLane = async (data: {
    name: string;
    kind: 'terminal' | 'agent';
    command: string;
    cwd: string;
  }) => {
    const existing = workspaceRef.current.lanes;
    const processId = Math.max(0, ...existing.map((l) => l.processId)) + 1;
    const bottom = Math.max(10, ...existing.map((l) => l.y + l.height));
    const created: Lane = {
      processId,
      name: data.name,
      kind: data.kind,
      command: data.command,
      cwd: data.cwd,
      x: 10,
      y: bottom + 8,
      width: 560,
      height: 380,
    };
    const nextLanes = [...existing, created];
    updateWorkspace((prev) => ({ ...prev, lanes: nextLanes }), true);
    setMaximizedId(null);
    await api.terminalStart(processId, data.cwd);
    const list = await api.daemonList().catch(() => []);
    if (list.length) {
      const next = new Map<number, RemoteTerminal>();
      for (const t of list) next.set(t.id, t);
      setRemotes(next);
    }
    requestAnimationFrame(() => focusLane(processId));
  };

  const handleEditLane = async (
    id: number,
    data: { name: string; kind: 'terminal' | 'agent'; command: string; cwd: string },
  ) => {
    updateWorkspace(
      (prev) => ({
        ...prev,
        lanes: prev.lanes.map((l) =>
          l.processId === id
            ? { ...l, name: data.name, kind: data.kind, command: data.command, cwd: data.cwd }
            : l,
        ),
      }),
      true,
    );
    requestAnimationFrame(() => focusLane(id));
  };

  const handleRemoveLane = (lane: Lane) => {
    setConfirmModal({
      title: `Remove "${lane.name}"?`,
      message:
        'This closes the panel and stops its running terminal process. Files on disk are untouched.',
      confirmLabel: 'Remove lane',
      danger: true,
      onConfirm: () => {
        void (async () => {
          await api.terminalDetach(lane.processId).catch(() => {});
          await api.terminalKill(lane.processId).catch(() => {});
          if (maximizedId === lane.processId) setMaximizedId(null);
          updateWorkspace(
            (prev) => ({
              ...prev,
              lanes: prev.lanes.filter((l) => l.processId !== lane.processId),
            }),
            true,
          );
        })();
      },
    });
  };

  const handleStopAll = () => {
    setConfirmModal({
      title: 'Stop all running terminals?',
      message:
        'All background shells and agents will be stopped. Your saved lanes, commands, and layout will stay intact.',
      confirmLabel: 'Stop all',
      danger: true,
      onConfirm: () => {
        void api
          .daemonStopAll()
          .then(() => showToast('Stopped all running terminals.'))
          .catch((err) => showToast(String(err)));
      },
    });
  };

  const handleRestartDaemon = () => {
    setConfirmModal({
      title: 'Restart background terminal daemon?',
      message:
        'This stops all running terminals and agents and clears their scrollback. Saved lanes and workspace folders are kept.',
      confirmLabel: 'Restart daemon',
      danger: true,
      onConfirm: () => {
        void api
          .daemonRestart()
          .then((status) => {
            setDaemon(status);
            setReconnectCounter((c) => c + 1);
            showToast('Background daemon restarted.');
          })
          .catch((err) => showToast(String(err)));
      },
    });
  };

  const beginPaneDrag = (lane: Lane, event: React.PointerEvent, resize = false) => {
    if (maximizedId !== null || event.button !== 0 || (event.target as Element).closest('button')) {
      return;
    }
    event.preventDefault();
    dragCleanupRef.current?.();

    const original = workspaceRef.current.lanes.map((l) => ({ ...l }));
    if (resize && workspaceRef.current.autoFit) {
      updateWorkspace((prev) => ({ ...prev, autoFit: false }));
    }

    const startX = event.clientX;
    const startY = event.clientY;
    const view = viewportRef.current!;
    const scrollX = view.scrollLeft;
    const scrollY = view.scrollTop;

    const onMove = (e: PointerEvent) => {
      const box = view.getBoundingClientRect();
      if (e.clientX > box.right - 28) view.scrollLeft += 16;
      if (e.clientY > box.bottom - 28) view.scrollTop += 16;
      if (e.clientX < box.left + 28) view.scrollLeft -= 16;
      if (e.clientY < box.top + 28) view.scrollTop -= 16;

      const dx = e.clientX - startX + view.scrollLeft - scrollX;
      const dy = e.clientY - startY + view.scrollTop - scrollY;
      const changed = resize
        ? {
            ...lane,
            width: Math.max(300, lane.width + dx),
            height: Math.max(220, lane.height + dy),
          }
        : { ...lane, x: Math.max(10, lane.x + dx), y: Math.max(10, lane.y + dy) };

      if (resize) {
        for (const other of original.filter((l) => l.processId !== lane.processId)) {
          if (
            other.x >= lane.x + lane.width &&
            changed.y < other.y + other.height &&
            changed.y + changed.height > other.y
          ) {
            changed.width = Math.min(changed.width, other.x - lane.x - 8);
          }
          if (
            other.y >= lane.y + lane.height &&
            changed.x < other.x + other.width &&
            changed.x + changed.width > other.x
          ) {
            changed.height = Math.min(changed.height, other.y - lane.y - 8);
          }
        }
      }
      const next = original.map((l) => (l.processId === lane.processId ? changed : l));
      workspaceRef.current = { ...workspaceRef.current, lanes: next };
      setWorkspace(workspaceRef.current);
    };

    const finish = (e?: Event) => {
      const current = workspaceRef.current.lanes.find((l) => l.processId === lane.processId)!;
      let result =
        e?.type === 'pointerup'
          ? resize
            ? workspaceRef.current.lanes
            : dropTerminalPanel(original, current)
          : original;
      if (workspaceRef.current.autoFit && !resize && canvasSize.width && canvasSize.height) {
        result = autoFitPanels(
          result,
          canvasSize.width,
          canvasSize.height,
          workspaceRef.current.columns,
        );
      }
      updateWorkspace((prev) => ({ ...prev, lanes: result }), true);
      if (e?.type === 'pointerup') focusLane(lane.processId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      dragCleanupRef.current = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    dragCleanupRef.current = finish;
  };

  const arrangePanels = () => {
    setMaximizedId(null);
    const arranged = arrangeTerminalPanels(
      workspaceRef.current.lanes,
      viewportRef.current?.clientWidth ?? 1200,
      workspaceRef.current.columns,
    );
    updateWorkspace((prev) => ({ ...prev, autoFit: false, lanes: arranged }), true);
  };

  const resetSizes = () => {
    setMaximizedId(null);
    const fitted = autoFitPanels(
      workspaceRef.current.lanes,
      canvasSize.width,
      canvasSize.height,
      workspaceRef.current.columns,
    );
    updateWorkspace((prev) => ({ ...prev, autoFit: true, lanes: fitted }), true);
  };

  const toggleRailTab = (tab: SidebarTab) => {
    updateWorkspace((prev) => {
      if (prev.sidebarOpen && prev.sidebarTab === tab) {
        return { ...prev, sidebarOpen: false };
      }
      return { ...prev, sidebarOpen: true, sidebarTab: tab };
    });
    if (tab === 'search') {
      requestAnimationFrame(() => searchInputRef.current?.select());
    }
  };

  const runningCount = useMemo(
    () =>
      workspace.lanes.filter((l) => remotes.get(l.processId)?.running).length,
    [workspace.lanes, remotes],
  );

  const canvasDimensions = useMemo(() => {
    if (maximizedId !== null) return { width: '100%', height: '100%' };
    const maxW = Math.max(0, ...workspace.lanes.map((l) => l.x + l.width + 10));
    const maxH = Math.max(0, ...workspace.lanes.map((l) => l.y + l.height + 10));
    return { width: maxW, height: maxH };
  }, [workspace.lanes, maximizedId]);

  const defaultLaneCwd = workspace.folders[0] || homeDir;

  return (
    <div
      className="app-shell"
      onFocusCapture={(e) => {
        const article = (e.target as Element).closest<HTMLElement>('[data-lane-id]');
        if (article) activeLaneRef.current = Number(article.dataset.laneId);
      }}
    >
      {/* Left Activity Rail */}
      <nav className="activity-rail" aria-label="Workspace views">
        <div className="rail-brand" title={`Ronin v${version}`}>
          <RoninMark size={22} />
        </div>
        <button
          className={`rail-btn${workspace.sidebarOpen && workspace.sidebarTab === 'explorer' ? ' active' : ''}`}
          title="Explorer (Ctrl+Shift+E)"
          aria-label="Explorer"
          onClick={() => toggleRailTab('explorer')}
        >
          <Icon name="explorer" size={18} />
        </button>
        <button
          className={`rail-btn${workspace.sidebarOpen && workspace.sidebarTab === 'search' ? ' active' : ''}`}
          title="Search across repos (Ctrl+Shift+F)"
          aria-label="Search"
          onClick={() => toggleRailTab('search')}
        >
          <Icon name="search" size={18} />
        </button>
        <button
          className={`rail-btn${workspace.sidebarOpen && workspace.sidebarTab === 'lanes' ? ' active' : ''}`}
          title="Lanes, Tasks & Notes (Ctrl+Shift+L)"
          aria-label="Lanes"
          onClick={() => toggleRailTab('lanes')}
        >
          <Icon name="terminal" size={18} />
          {workspace.lanes.length > 0 && (
            <span className="rail-badge">{workspace.lanes.length}</span>
          )}
        </button>

        <div className="rail-spacer" />

        <button
          className="rail-btn"
          title="Quick Open File (Ctrl+Shift+P)"
          aria-label="Quick Open"
          onClick={() => setQuickOpen(true)}
        >
          <Icon name="command" size={17} />
        </button>
        <button
          className="rail-btn"
          title="Settings & Background Daemon (Ctrl+,)"
          aria-label="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="settings" size={17} />
          <span
            className={`rail-status-dot${daemon.connected ? ' ok' : ' warn'}`}
            aria-hidden="true"
          />
        </button>
        <span className="rail-version" title={`Ronin v${version}`}>
          {version}
        </span>
      </nav>

      {/* Collapsible, Resizable Sidebar */}
      {workspace.sidebarOpen && (
        <Sidebar
          tab={workspace.sidebarTab}
          width={workspace.sidebarWidth}
          folders={workspace.folders}
          lanes={workspace.lanes}
          remotes={remotes}
          notes={workspace.notes}
          tasks={workspace.tasks}
          homeDir={homeDir}
          showHidden={workspace.settings.showHiddenFiles}
          onToggleHidden={() =>
            updateWorkspace(
              (prev) => ({
                ...prev,
                settings: {
                  ...prev.settings,
                  showHiddenFiles: !prev.settings.showHiddenFiles,
                },
              }),
              true,
            )
          }
          onAddFolder={() => void handleAddFolder()}
          onRemoveFolder={handleRemoveFolder}
          onOpenFile={(path, line, col) => openFilePreview(path, undefined, line, col)}
          onOpenExternal={(path) =>
            void api.openExternal(path).catch((err) => showToast(String(err)))
          }
          onNewTerminalInDir={(dir) => setLaneModal({ mode: 'create', kind: 'terminal', cwd: dir })}
          onSelectLane={(id) => {
            setMaximizedId(null);
            requestAnimationFrame(() => {
              document
                .querySelector(`[data-lane-id="${id}"]`)
                ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              focusLane(id);
            });
          }}
          onAddLane={(kind) => setLaneModal({ mode: 'create', kind })}
          onEditLane={(lane) => setLaneModal({ mode: 'edit', lane })}
          onStartLane={(id) => void handleStartLane(id)}
          onRunCommand={(id) => void handleRunCommand(id)}
          onChangeNotes={(notes) => updateWorkspace((prev) => ({ ...prev, notes }))}
          onChangeTasks={(tasks) => updateWorkspace((prev) => ({ ...prev, tasks }))}
          onResizeWidth={(sidebarWidth) => updateWorkspace((prev) => ({ ...prev, sidebarWidth }))}
          searchInputRef={searchInputRef}
        />
      )}

      {/* Main Canvas Area */}
      <main className="main-area">
        <header
          className="topbar"
          onMouseDown={(e) => {
            if ((e.target as Element).closest('button')) e.preventDefault();
          }}
        >
          <div className="topbar-left">
            <button
              className={`icon-btn${workspace.sidebarOpen ? ' active' : ''}`}
              title="Toggle sidebar (Ctrl+Shift+B)"
              aria-label="Toggle sidebar"
              onClick={() => updateWorkspace((prev) => ({ ...prev, sidebarOpen: !prev.sidebarOpen }))}
            >
              <Icon name="sidebar" size={15} />
            </button>

            <button
              className="topbar-btn"
              onClick={() => setLaneModal({ mode: 'create', kind: 'terminal' })}
            >
              <Icon name="plus" size={14} />
              <span>Terminal</span>
            </button>
            <button
              className="topbar-btn"
              onClick={() => setLaneModal({ mode: 'create', kind: 'agent' })}
            >
              <Icon name="agent" size={14} />
              <span>Agent</span>
            </button>

            <button
              className="quick-open-pill"
              title="Find file across loaded repos (Ctrl+Shift+P)"
              onClick={() => setQuickOpen(true)}
            >
              <Icon name="search" size={13} />
              <span>Find file…</span>
              <kbd>Ctrl+Shift+P</kbd>
            </button>
          </div>

          <div className="topbar-right">
            <button
              className={`icon-btn${workspace.autoFit ? ' active' : ''}`}
              title="Auto-fit terminals to viewport"
              aria-pressed={workspace.autoFit}
              onClick={() =>
                updateWorkspace((prev) => ({ ...prev, autoFit: !prev.autoFit }), true)
              }
            >
              <Icon name="fit" size={15} />
            </button>

            <div className="cols-picker" ref={colsRef}>
              <button
                className={`cols-trigger${colsOpen ? ' open' : ''}`}
                title="Grid column count"
                aria-haspopup="listbox"
                aria-expanded={colsOpen}
                onClick={() => setColsOpen((v) => !v)}
              >
                <span className="cols-label">Cols</span>
                <strong className="cols-value">
                  {workspace.columns === 0 ? 'Auto' : workspace.columns}
                </strong>
                <Icon name="chevronDown" size={12} />
              </button>
              {colsOpen && (
                <div className="cols-menu" role="listbox" aria-label="Grid columns">
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((val) => (
                    <button
                      key={val}
                      role="option"
                      aria-selected={workspace.columns === val}
                      className={`cols-option${workspace.columns === val ? ' active' : ''}`}
                      onClick={() => {
                        setColsOpen(false);
                        updateWorkspace((prev) => ({ ...prev, columns: val }), true);
                        requestAnimationFrame(() => focusLane(activeLaneRef.current));
                      }}
                    >
                      {val === 0 ? 'Auto' : val}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              className="icon-btn"
              title="Arrange panes without resizing"
              aria-label="Arrange"
              onClick={arrangePanels}
            >
              <Icon name="arrange" size={15} />
            </button>
            <button
              className="icon-btn"
              title="Reset sizes and fit to canvas"
              aria-label="Reset sizes"
              onClick={resetSizes}
            >
              <Icon name="reset" size={15} />
            </button>

            <button
              className="status-pill"
              title={
                daemon.connected
                  ? `Rust daemon connected (PID ${daemon.pid ?? '?'}) — click for settings`
                  : 'Reconnecting to background daemon…'
              }
              onClick={() => setSettingsOpen(true)}
            >
              <span className={`dot${daemon.connected ? ' running' : ''}`} />
              <span>
                {runningCount}/{workspace.lanes.length} running
              </span>
            </button>
          </div>
        </header>

        {booted && !daemon.connected && (
          <div className="connection-banner" role="status">
            Reconnecting to background terminal daemon… Existing shells and agents continue running.
          </div>
        )}

        <div className="canvas-viewport" ref={viewportRef}>
          <div className="canvas-stage" style={canvasDimensions}>
            {booted && !workspace.lanes.length && (
              <div className="empty-state">
                <div className="empty-emblem">
                  <RoninMark size={40} />
                </div>
                <h1>Your terminals, without the IDE weight.</h1>
                <p>
                  Add terminal or agent panels above. Drag headers to reorder, resize from any
                  bottom-right corner, and load repos in the sidebar to browse or search files.
                </p>
                <p className="empty-sub">
                  Every shell runs in Ronin’s detached Rust daemon — closing or reloading this
                  window never stops your agents.
                </p>
                <div className="empty-actions">
                  <button
                    className="btn-accent"
                    onClick={() => setLaneModal({ mode: 'create', kind: 'terminal' })}
                  >
                    <Icon name="plus" size={14} />
                    New Terminal
                  </button>
                  <button onClick={() => setLaneModal({ mode: 'create', kind: 'agent' })}>
                    <Icon name="agent" size={14} />
                    New Agent Lane
                  </button>
                  <button onClick={() => void handleAddFolder()}>
                    <Icon name="folderPlus" size={14} />
                    Load Repo Folder
                  </button>
                </div>
              </div>
            )}

            {workspace.lanes.map((lane) => {
              const remote = remotes.get(lane.processId);
              const isRunning = Boolean(remote?.running);
              const isMax = maximizedId === lane.processId;
              return (
                <article
                  key={lane.processId}
                  data-lane-id={lane.processId}
                  className={`lane-card${isMax ? ' maximized' : ''}`}
                  style={
                    isMax
                      ? { inset: 8 }
                      : {
                          left: lane.x,
                          top: lane.y,
                          width: lane.width,
                          height: lane.height,
                          display: maximizedId !== null ? 'none' : undefined,
                        }
                  }
                >
                  <header
                    className="lane-header"
                    onPointerDown={(e) => beginPaneDrag(lane, e, false)}
                    onDoubleClick={(e) => {
                      if ((e.target as Element).closest('button')) return;
                      setMaximizedId((m) => (m === lane.processId ? null : lane.processId));
                    }}
                  >
                    <span className={`dot${isRunning ? ' running' : ''}`} />
                    <strong
                      className="lane-title"
                      title={`${lane.cwd}${lane.command ? '\n' + lane.command : ''}`}
                    >
                      {lane.name}
                    </strong>
                    <span className={`lane-kind${remote?.agent ? ' agent-live' : ''}`}>
                      {remote?.agent ? remote.agent : lane.kind}
                    </span>
                    <span className="spacer" />
                    <button
                      className="icon-btn xs"
                      title="Refresh display without restarting terminal"
                      aria-label={`Refresh ${lane.name}`}
                      onClick={() => void handleRefreshDisplay(lane.processId)}
                    >
                      <Icon name="refresh" size={13} />
                    </button>
                    <button
                      className="icon-btn xs"
                      title="Edit lane"
                      aria-label={`Edit ${lane.name}`}
                      onClick={() => setLaneModal({ mode: 'edit', lane })}
                    >
                      <Icon name="edit" size={13} />
                    </button>
                    <button
                      className="icon-btn xs"
                      title={isMax ? 'Restore size' : 'Maximize pane'}
                      aria-label={isMax ? 'Restore size' : 'Maximize pane'}
                      onClick={() =>
                        setMaximizedId((m) => (m === lane.processId ? null : lane.processId))
                      }
                    >
                      <Icon name={isMax ? 'restore' : 'maximize'} size={13} />
                    </button>
                    <button
                      className="icon-btn xs"
                      title="Remove lane"
                      aria-label={`Remove ${lane.name}`}
                      onClick={() => handleRemoveLane(lane)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </header>

                  <TerminalPane
                    key={displayVersions[lane.processId] ?? 0}
                    lane={lane}
                    remote={remote}
                    connected={daemon.connected}
                    fontSize={workspace.settings.fontSize}
                    fontFamily={workspace.settings.fontFamily}
                    theme={theme}
                    selectionStyle={workspace.settings.selectionStyle}
                    reconnectCounter={reconnectCounter}
                    registerOutput={registerOutput}
                    onOpenLink={handleOpenLink}
                    onRefreshDisplay={(id) => void handleRefreshDisplay(id)}
                    onFocusChange={(id, focused) => {
                      terminalFocusedRef.current = focused;
                      if (focused) activeLaneRef.current = id;
                    }}
                  />

                  <footer className="lane-footer">
                    {!isRunning && (
                      <button
                        className="footer-action accent"
                        onClick={() => void handleStartLane(lane.processId)}
                      >
                        <Icon name="play" size={11} />
                        Start
                      </button>
                    )}
                    {lane.command && (
                      <button
                        className="footer-action"
                        title={`Run: ${lane.command}`}
                        onClick={() => void handleRunCommand(lane.processId)}
                      >
                        Run command
                      </button>
                    )}
                    <span className="lane-cwd" title={lane.cwd}>
                      {shortenHome(lane.cwd, homeDir)}
                    </span>
                  </footer>

                  {!isMax && (
                    <div
                      className="lane-resize"
                      title="Drag to resize"
                      onPointerDown={(e) => beginPaneDrag(lane, e, true)}
                    />
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </main>

      {/* Modals */}
      {preview && (
        <FilePreviewModal
          key={preview.request.requestId}
          request={preview.request}
          data={preview.data}
          homeDir={homeDir}
          onClose={() => {
            const sourceId = preview.request.sourceLaneId ?? activeLaneRef.current;
            setPreview(undefined);
            requestAnimationFrame(() => focusLane(sourceId));
          }}
          onOpenExternal={(target, cwd) =>
            void api.openExternal(target, cwd).catch((err) => showToast(String(err)))
          }
          onOpenRelated={(path, cwd) =>
            openFilePreview(path, cwd, undefined, undefined, preview.request.sourceLaneId)
          }
        />
      )}

      {quickOpen && (
        <QuickOpenModal
          roots={workspace.folders}
          onSelect={(path) => {
            setQuickOpen(false);
            openFilePreview(path);
          }}
          onClose={() => {
            setQuickOpen(false);
            requestAnimationFrame(() => focusLane(activeLaneRef.current));
          }}
        />
      )}

      {laneModal && (
        <LaneModal
          mode={laneModal.mode}
          initialKind={laneModal.mode === 'create' ? laneModal.kind : laneModal.lane.kind}
          initialCwd={
            laneModal.mode === 'create'
              ? laneModal.cwd ?? defaultLaneCwd
              : laneModal.lane.cwd
          }
          lane={laneModal.mode === 'edit' ? laneModal.lane : undefined}
          folders={workspace.folders}
          homeDir={homeDir}
          onSave={async (data) => {
            if (laneModal.mode === 'create') await handleCreateLane(data);
            else await handleEditLane(laneModal.lane.processId, data);
          }}
          onClose={() => {
            setLaneModal(null);
            requestAnimationFrame(() => focusLane(activeLaneRef.current));
          }}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          version={version}
          settings={workspace.settings}
          defaultShell={defaultShell}
          theme={theme}
          daemon={daemon}
          runningCount={runningCount}
          onChangeSettings={(settings: AppSettings) =>
            updateWorkspace((prev) => ({ ...prev, settings }), true)
          }
          onStopAll={handleStopAll}
          onRestartDaemon={handleRestartDaemon}
          onClose={() => {
            setSettingsOpen(false);
            requestAnimationFrame(() => focusLane(activeLaneRef.current));
          }}
        />
      )}

      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel}
          danger={confirmModal.danger}
          onConfirm={confirmModal.onConfirm}
          onClose={() => setConfirmModal(null)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
