import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSettings,
  CanvasTab,
  DaemonStatus,
  FilePreviewResult,
  Lane,
  LaneGitInfo,
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
import { baseName, shortenHome } from './lib/terminalFiles';
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
  tabs: [{ id: 'main', name: 'Main' }],
  activeTabId: 'main',
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
  const [searchTriggers, setSearchTriggers] = useState<Record<number, number>>({});
  const [attentionIds, setAttentionIds] = useState<Set<number>>(() => new Set());
  const [folderBranches, setFolderBranches] = useState<Record<string, string>>({});
  const [laneGit, setLaneGit] = useState<Map<number, LaneGitInfo>>(() => new Map());
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [tabRenameDraft, setTabRenameDraft] = useState('');
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

  const tabs: CanvasTab[] = workspace.tabs?.length
    ? workspace.tabs
    : [{ id: 'main', name: 'Main' }];
  const activeTabId = tabs.some((t) => t.id === workspace.activeTabId)
    ? workspace.activeTabId
    : tabs[0].id;

  const visibleLanes = useMemo(
    () => workspace.lanes.filter((l) => (l.tabId || 'main') === activeTabId),
    [workspace.lanes, activeTabId],
  );

  const focusLane = useCallback((id: number | null) => {
    const ws = workspaceRef.current;
    const currentTab = ws.tabs?.some((t) => t.id === ws.activeTabId)
      ? ws.activeTabId
      : ws.tabs?.[0]?.id ?? 'main';
    const fallback = ws.lanes.find((l) => (l.tabId || 'main') === currentTab)?.processId;
    const target = id ?? fallback;
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

  // Poll live git branches (.git/HEAD + /proc cwd) every 5s when visible (zero subprocesses)
  const gitDepsKey = useMemo(
    () =>
      JSON.stringify({
        f: workspace.folders,
        l: workspace.lanes.map((l) => [l.processId, l.cwd, l.projectDir ?? '']),
      }),
    [workspace.folders, workspace.lanes],
  );

  useEffect(() => {
    if (!booted) return;
    let cancelled = false;
    const refreshGit = async () => {
      if (document.visibilityState === 'hidden') return;
      const ws = workspaceRef.current;
      try {
        const [branches, info] = await Promise.all([
          ws.folders.length ? api.gitBranches(ws.folders) : Promise.resolve({}),
          ws.lanes.length
            ? api.laneGitInfo(
                ws.lanes.map((l) => ({
                  id: l.processId,
                  cwd: l.cwd,
                  projectDir: l.projectDir,
                })),
              )
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setFolderBranches(branches);
        const map = new Map<number, LaneGitInfo>();
        for (const item of info) map.set(item.id, item);
        setLaneGit(map);
      } catch {
        /* ignore transient git poll errors */
      }
    };
    void refreshGit();
    const timer = setInterval(() => void refreshGit(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [booted, gitDepsKey, daemon.connected]);

  // Auto-fit visible tab panels when viewport, columns, tab, or visible lane count changes
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
    const all = workspaceRef.current.lanes;
    const active = all.filter((l) => (l.tabId || 'main') === activeTabId);
    if (!active.length) return;
    const fitted = autoFitPanels(active, canvasSize.width, canvasSize.height, workspace.columns);
    const byId = new Map(fitted.map((l) => [l.processId, l]));
    const changed = active.some((l) => {
      const n = byId.get(l.processId)!;
      return l.x !== n.x || l.y !== n.y || l.width !== n.width || l.height !== n.height;
    });
    if (changed) {
      updateWorkspace((prev) => ({
        ...prev,
        lanes: prev.lanes.map((l) => byId.get(l.processId) ?? l),
      }));
    }
  }, [
    booted,
    workspace.autoFit,
    workspace.columns,
    activeTabId,
    visibleLanes.length,
    canvasSize.width,
    canvasSize.height,
    maximizedId,
    updateWorkspace,
  ]);

  // Global keyboard shortcuts (carefully avoiding single-Ctrl terminal readline bindings!)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();

      // Ctrl+Alt pane navigation & maximize (works both inside and outside terminals)
      if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
        const ws = workspaceRef.current;
        const curTab = ws.tabs?.some((t) => t.id === ws.activeTabId)
          ? ws.activeTabId
          : ws.tabs?.[0]?.id ?? 'main';
        const onTab = ws.lanes.filter((l) => (l.tabId || 'main') === curTab);
        if (!onTab.length) return;

        if (key === 'm') {
          e.preventDefault();
          const targetId = activeLaneRef.current ?? onTab[0].processId;
          setMaximizedId((m) => (m === targetId ? null : targetId));
          requestAnimationFrame(() => focusLane(targetId));
          return;
        }
        if (/^[1-9]$/.test(key)) {
          const target = onTab[Number(key) - 1];
          if (target) {
            e.preventDefault();
            setMaximizedId(null);
            activeLaneRef.current = target.processId;
            requestAnimationFrame(() => {
              document
                .querySelector(`[data-lane-id="${target.processId}"]`)
                ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              focusLane(target.processId);
            });
          }
          return;
        }
        if (
          key === 'arrowleft' ||
          key === 'arrowright' ||
          key === 'arrowup' ||
          key === 'arrowdown'
        ) {
          e.preventDefault();
          const cur = onTab.find((l) => l.processId === activeLaneRef.current) ?? onTab[0];
          const cx = cur.x + cur.width / 2;
          const cy = cur.y + cur.height / 2;
          let best: Lane | null = null;
          let bestScore = Infinity;
          for (const cand of onTab) {
            if (cand.processId === cur.processId) continue;
            const dx = cand.x + cand.width / 2 - cx;
            const dy = cand.y + cand.height / 2 - cy;
            const inDir =
              (key === 'arrowright' && dx > 12) ||
              (key === 'arrowleft' && dx < -12) ||
              (key === 'arrowdown' && dy > 12) ||
              (key === 'arrowup' && dy < -12);
            if (!inDir) continue;
            const primary = key === 'arrowleft' || key === 'arrowright' ? Math.abs(dx) : Math.abs(dy);
            const secondary = key === 'arrowleft' || key === 'arrowright' ? Math.abs(dy) : Math.abs(dx);
            const score = primary + secondary * 2.4;
            if (score < bestScore) {
              bestScore = score;
              best = cand;
            }
          }
          if (best) {
            setMaximizedId(null);
            activeLaneRef.current = best.processId;
            const nextId = best.processId;
            requestAnimationFrame(() => {
              document
                .querySelector(`[data-lane-id="${nextId}"]`)
                ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              focusLane(nextId);
            });
          }
          return;
        }
      }

      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
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
  }, [updateWorkspace, focusLane]);

  const openFilePreview = useCallback(
    (
      path: string,
      cwd?: string,
      line?: number,
      column?: number,
      sourceLaneId?: number,
      fallbackRoots?: string[],
    ) => {
      const requestId = ++nextPreviewRequestId;
      const roots = fallbackRoots ?? workspaceRef.current.folders;
      const request: PreviewRequest = {
        requestId,
        path,
        cwd,
        fallbackRoots: roots,
        line,
        column,
        sourceLaneId,
      };
      setPreview({ request });
      void api
        .previewFile(path, cwd, roots, line, column)
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
      const liveCwd = laneGit.get(laneId)?.liveCwd;
      const baseCwd = liveCwd || lane?.cwd;
      const fallbacks = [
        ...(lane?.projectDir ? [lane.projectDir] : []),
        ...(lane?.cwd && lane.cwd !== baseCwd ? [lane.cwd] : []),
        ...workspaceRef.current.folders,
      ];
      if (/^https?:\/\//i.test(target) || mode === 'external') {
        void api.openExternal(target, baseCwd).catch((err) => showToast(String(err)));
      } else {
        openFilePreview(target, baseCwd, undefined, undefined, laneId, fallbacks);
      }
    },
    [openFilePreview, showToast, laneGit],
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

  const handleStartAll = async (runCommands = false) => {
    const stopped = workspaceRef.current.lanes.filter((l) => !remotes.get(l.processId)?.running);
    if (!stopped.length) return;
    try {
      await Promise.all(
        stopped.map((lane) => api.terminalStart(lane.processId, lane.cwd).catch(() => {})),
      );
      const list = await api.daemonList();
      const next = new Map<number, RemoteTerminal>();
      for (const t of list) next.set(t.id, t);
      setRemotes(next);
      if (runCommands) {
        await new Promise((r) => setTimeout(r, 180));
        await Promise.all(
          stopped
            .filter((l) => l.command.trim())
            .map((l) => api.terminalWrite(l.processId, l.command + '\r').catch(() => {})),
        );
      }
      showToast(
        runCommands
          ? `Started ${stopped.length} lane${stopped.length === 1 ? '' : 's'} and launched saved commands.`
          : `Started ${stopped.length} shell${stopped.length === 1 ? '' : 's'}.`,
      );
    } catch (err) {
      showToast(String(err));
    }
  };

  const handleLaneFontSize = useCallback(
    (id: number, fontSize: number | undefined) => {
      updateWorkspace(
        (prev) => ({
          ...prev,
          lanes: prev.lanes.map((l) =>
            l.processId === id ? { ...l, fontSize } : l,
          ),
        }),
        true,
      );
    },
    [updateWorkspace],
  );

  const markAttention = useCallback((id: number) => {
    setAttentionIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const clearAttention = useCallback((id: number) => {
    setAttentionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

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
    projectDir?: string;
    tabId: string;
  }) => {
    const existing = workspaceRef.current.lanes;
    const onTab = existing.filter((l) => (l.tabId || 'main') === data.tabId);
    const processId = Math.max(0, ...existing.map((l) => l.processId)) + 1;
    const bottom = Math.max(10, ...onTab.map((l) => l.y + l.height));
    const created: Lane = {
      processId,
      name: data.name,
      kind: data.kind,
      command: data.command,
      cwd: data.cwd,
      projectDir: data.projectDir,
      tabId: data.tabId,
      x: 10,
      y: bottom + 8,
      width: 560,
      height: 380,
    };
    const nextLanes = [...existing, created];
    updateWorkspace(
      (prev) => ({ ...prev, activeTabId: data.tabId, lanes: nextLanes }),
      true,
    );
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

  const handleDuplicateLane = useCallback(
    async (lane: Lane) => {
      try {
        await handleCreateLane({
          name: `${lane.name} (2)`,
          kind: lane.kind,
          command: lane.command,
          cwd: lane.cwd,
          projectDir: lane.projectDir,
          tabId: lane.tabId || activeTabId,
        });
      } catch (err) {
        showToast(String(err));
      }
    },
    [activeTabId, showToast],
  );

  const handleEditLane = async (
    id: number,
    data: {
      name: string;
      kind: 'terminal' | 'agent';
      command: string;
      cwd: string;
      projectDir?: string;
      tabId: string;
    },
  ) => {
    updateWorkspace(
      (prev) => ({
        ...prev,
        activeTabId: data.tabId,
        lanes: prev.lanes.map((l) =>
          l.processId === id
            ? {
                ...l,
                name: data.name,
                kind: data.kind,
                command: data.command,
                cwd: data.cwd,
                projectDir: data.projectDir,
                tabId: data.tabId,
              }
            : l,
        ),
      }),
      true,
    );
    requestAnimationFrame(() => focusLane(id));
  };

  const handleAddTab = () => {
    const id = `tab-${Date.now().toString(36)}`;
    const name = `Canvas ${tabs.length + 1}`;
    setMaximizedId(null);
    updateWorkspace(
      (prev) => ({
        ...prev,
        tabs: [...(prev.tabs?.length ? prev.tabs : [{ id: 'main', name: 'Main' }]), { id, name }],
        activeTabId: id,
      }),
      true,
    );
    setRenamingTabId(id);
    setTabRenameDraft(name);
  };

  const handleRenameTab = (id: string, nextName: string) => {
    const clean = nextName.trim();
    setRenamingTabId(null);
    if (!clean) return;
    updateWorkspace(
      (prev) => ({
        ...prev,
        tabs: (prev.tabs?.length ? prev.tabs : [{ id: 'main', name: 'Main' }]).map((t) =>
          t.id === id ? { ...t, name: clean } : t,
        ),
      }),
      true,
    );
  };

  const handleRemoveTab = (id: string) => {
    if (tabs.length <= 1) return;
    const remaining = tabs.filter((t) => t.id !== id);
    const fallbackId = remaining[0].id;
    const movedCount = workspaceRef.current.lanes.filter((l) => (l.tabId || 'main') === id).length;
    setMaximizedId(null);
    updateWorkspace(
      (prev) => ({
        ...prev,
        tabs: remaining,
        activeTabId: prev.activeTabId === id ? fallbackId : prev.activeTabId,
        lanes: prev.lanes.map((l) =>
          (l.tabId || 'main') === id ? { ...l, tabId: fallbackId } : l,
        ),
      }),
      true,
    );
    if (movedCount > 0) {
      showToast(`Moved ${movedCount} lane${movedCount === 1 ? '' : 's'} to ${remaining[0].name}.`);
    }
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

    const laneTab = lane.tabId || 'main';
    const otherTabs = workspaceRef.current.lanes
      .filter((l) => (l.tabId || 'main') !== laneTab)
      .map((l) => ({ ...l }));
    const original = workspaceRef.current.lanes
      .filter((l) => (l.tabId || 'main') === laneTab)
      .map((l) => ({ ...l }));
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
      const nextOnTab = original.map((l) => (l.processId === lane.processId ? changed : l));
      workspaceRef.current = { ...workspaceRef.current, lanes: [...otherTabs, ...nextOnTab] };
      setWorkspace(workspaceRef.current);
    };

    const finish = (e?: Event) => {
      const currentTabLanes = workspaceRef.current.lanes.filter(
        (l) => (l.tabId || 'main') === laneTab,
      );
      const current = currentTabLanes.find((l) => l.processId === lane.processId)!;
      let result =
        e?.type === 'pointerup'
          ? resize
            ? currentTabLanes
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
      updateWorkspace((prev) => ({ ...prev, lanes: [...otherTabs, ...result] }), true);
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
    const active = workspaceRef.current.lanes.filter((l) => (l.tabId || 'main') === activeTabId);
    const arranged = arrangeTerminalPanels(
      active,
      viewportRef.current?.clientWidth ?? 1200,
      workspaceRef.current.columns,
    );
    const byId = new Map(arranged.map((l) => [l.processId, l]));
    updateWorkspace(
      (prev) => ({
        ...prev,
        autoFit: false,
        lanes: prev.lanes.map((l) => byId.get(l.processId) ?? l),
      }),
      true,
    );
  };

  const resetSizes = () => {
    setMaximizedId(null);
    const active = workspaceRef.current.lanes.filter((l) => (l.tabId || 'main') === activeTabId);
    const fitted = autoFitPanels(
      active,
      canvasSize.width,
      canvasSize.height,
      workspaceRef.current.columns,
    );
    const byId = new Map(fitted.map((l) => [l.processId, l]));
    updateWorkspace(
      (prev) => ({
        ...prev,
        autoFit: true,
        lanes: prev.lanes.map((l) => byId.get(l.processId) ?? l),
      }),
      true,
    );
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
  const stoppedCount = workspace.lanes.length - runningCount;
  const stoppedWithCommandsCount = useMemo(
    () =>
      workspace.lanes.filter(
        (l) => !remotes.get(l.processId)?.running && l.command.trim().length > 0,
      ).length,
    [workspace.lanes, remotes],
  );

  const canvasDimensions = useMemo(() => {
    if (maximizedId !== null) return { width: '100%', height: '100%' };
    const maxW = Math.max(0, ...visibleLanes.map((l) => l.x + l.width + 10));
    const maxH = Math.max(0, ...visibleLanes.map((l) => l.y + l.height + 10));
    return { width: maxW, height: maxH };
  }, [visibleLanes, maximizedId]);

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
          folderBranches={folderBranches}
          tabs={tabs}
          lanes={workspace.lanes}
          remotes={remotes}
          attentionIds={attentionIds}
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
            clearAttention(id);
            setMaximizedId(null);
            const target = workspaceRef.current.lanes.find((l) => l.processId === id);
            const targetTab = target?.tabId || 'main';
            if (targetTab !== activeTabId) {
              updateWorkspace((prev) => ({ ...prev, activeTabId: targetTab }), true);
            }
            requestAnimationFrame(() => {
              document
                .querySelector(`[data-lane-id="${id}"]`)
                ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              focusLane(id);
            });
          }}
          onAddLane={(kind) => setLaneModal({ mode: 'create', kind })}
          onEditLane={(lane) => setLaneModal({ mode: 'edit', lane })}
          onDuplicateLane={(lane) => void handleDuplicateLane(lane)}
          onStartLane={(id) => void handleStartLane(id)}
          onStartAll={() => void handleStartAll(false)}
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

            {stoppedCount > 0 && (
              <button
                className="topbar-btn accent-outline"
                title={`Start all ${stoppedCount} stopped shell${stoppedCount === 1 ? '' : 's'}`}
                onClick={() => void handleStartAll(false)}
              >
                <Icon name="play" size={13} />
                <span>Start all ({stoppedCount})</span>
              </button>
            )}

            {stoppedWithCommandsCount > 0 && (
              <button
                className="topbar-btn"
                title="Start stopped lanes and run their saved launch commands"
                onClick={() => void handleStartAll(true)}
              >
                <Icon name="terminal" size={13} />
                <span>Run all</span>
              </button>
            )}

            <div className="tab-strip" role="tablist" aria-label="Canvas pages">
              {tabs.map((t) => {
                const isActive = t.id === activeTabId;
                const hasBgAttention =
                  !isActive &&
                  workspace.lanes.some(
                    (l) => (l.tabId || 'main') === t.id && attentionIds.has(l.processId),
                  );
                if (renamingTabId === t.id) {
                  return (
                    <input
                      key={t.id}
                      className="canvas-tab-input"
                      autoFocus
                      value={tabRenameDraft}
                      onChange={(e) => setTabRenameDraft(e.target.value)}
                      onBlur={() => handleRenameTab(t.id, tabRenameDraft)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameTab(t.id, tabRenameDraft);
                        if (e.key === 'Escape') setRenamingTabId(null);
                      }}
                    />
                  );
                }
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={isActive}
                    className={`canvas-tab${isActive ? ' active' : ''}`}
                    title="Click to switch · Double-click to rename"
                    onClick={() => {
                      setMaximizedId(null);
                      updateWorkspace((prev) => ({ ...prev, activeTabId: t.id }), true);
                    }}
                    onDoubleClick={() => {
                      setRenamingTabId(t.id);
                      setTabRenameDraft(t.name);
                    }}
                  >
                    {hasBgAttention && <span className="dot attention" />}
                    <span>{t.name}</span>
                    {tabs.length > 1 && (
                      <span
                        className="canvas-tab-close"
                        role="button"
                        title={`Remove ${t.name} tab (lanes move to first tab)`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveTab(t.id);
                        }}
                      >
                        <Icon name="close" size={10} />
                      </span>
                    )}
                  </button>
                );
              })}
              <button
                className="tab-add-btn"
                title="Add canvas tab"
                aria-label="Add canvas tab"
                onClick={handleAddTab}
              >
                <Icon name="plus" size={12} />
              </button>
            </div>

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
            {booted && !visibleLanes.length && (
              <div className="empty-state">
                <div className="empty-emblem">
                  <RoninMark size={40} />
                </div>
                <h1>
                  {workspace.lanes.length
                    ? `No panels on ${tabs.find((t) => t.id === activeTabId)?.name ?? 'this tab'} yet.`
                    : 'Your terminals, without the IDE weight.'}
                </h1>
                <p>
                  Add terminal or agent panels above. Drag headers to reorder, use{' '}
                  <kbd>Ctrl+Alt+Arrows</kbd> or <kbd>Ctrl+Alt+1–9</kbd> to jump panes, and{' '}
                  <kbd>Ctrl+Alt+M</kbd> to maximize.
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

            {visibleLanes.map((lane) => {
              const remote = remotes.get(lane.processId);
              const isRunning = Boolean(remote?.running);
              const isMax = maximizedId === lane.processId;
              const needsAttention = attentionIds.has(lane.processId);
              const effectiveFontSize = lane.fontSize ?? workspace.settings.fontSize;
              const git = laneGit.get(lane.processId);
              const branchLabel = git?.branch
                ? git.repoName && git.repoName !== baseName(lane.cwd)
                  ? `${git.repoName} · ${git.branch}`
                  : git.branch
                : null;
              return (
                <article
                  key={lane.processId}
                  data-lane-id={lane.processId}
                  className={`lane-card${isMax ? ' maximized' : ''}${
                    needsAttention ? ' attention' : ''
                  }`}
                  onMouseDownCapture={() => {
                    if (needsAttention) clearAttention(lane.processId);
                  }}
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
                    <span
                      className={`dot${isRunning ? ' running' : ''}${
                        needsAttention ? ' attention' : ''
                      }`}
                    />
                    <strong
                      className="lane-title"
                      title={`${lane.cwd}${lane.command ? '\n' + lane.command : ''}`}
                    >
                      {lane.name}
                    </strong>
                    <span className={`lane-kind${remote?.agent ? ' agent-live' : ''}`}>
                      {remote?.agent ? remote.agent : lane.kind}
                    </span>
                    {needsAttention && (
                      <span className="lane-ready-pill" title="New output settled while unfocused">
                        Ready
                      </span>
                    )}
                    {lane.fontSize !== undefined && (
                      <button
                        className="lane-font-pill"
                        title={`Custom pane font size (${lane.fontSize}px) — click to reset to ${workspace.settings.fontSize}px`}
                        onClick={() => handleLaneFontSize(lane.processId, undefined)}
                      >
                        {lane.fontSize}px
                      </button>
                    )}
                    <span className="spacer" />
                    <button
                      className="icon-btn xs"
                      title="Find in scrollback (Ctrl+Alt+F)"
                      aria-label={`Search ${lane.name} scrollback`}
                      onClick={() =>
                        setSearchTriggers((curr) => ({
                          ...curr,
                          [lane.processId]: (curr[lane.processId] ?? 0) + 1,
                        }))
                      }
                    >
                      <Icon name="search" size={13} />
                    </button>
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
                    fontSize={effectiveFontSize}
                    defaultFontSize={workspace.settings.fontSize}
                    fontFamily={workspace.settings.fontFamily}
                    theme={theme}
                    selectionStyle={workspace.settings.selectionStyle}
                    reconnectCounter={reconnectCounter}
                    searchTrigger={searchTriggers[lane.processId] ?? 0}
                    registerOutput={registerOutput}
                    onOpenLink={handleOpenLink}
                    onRefreshDisplay={(id) => void handleRefreshDisplay(id)}
                    onFocusChange={(id, focused) => {
                      terminalFocusedRef.current = focused;
                      if (focused) {
                        activeLaneRef.current = id;
                        clearAttention(id);
                      }
                    }}
                    onAttention={markAttention}
                    onChangeFontSize={handleLaneFontSize}
                    onDuplicate={(l) => void handleDuplicateLane(l)}
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
                    <span className="lane-cwd" title={git?.liveCwd || lane.cwd}>
                      {shortenHome(git?.liveCwd || lane.cwd, homeDir)}
                    </span>
                    {branchLabel && (
                      <span
                        className="git-branch-pill"
                        title={
                          lane.projectDir
                            ? `Linked project repo: ${lane.projectDir} (${git?.branch})`
                            : `Git branch: ${git?.branch}`
                        }
                      >
                        <Icon name="branch" size={10} />
                        {branchLabel}
                      </span>
                    )}
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
          onSaved={(savedPath, nextContent) => {
            setPreview((curr) =>
              curr && curr.data?.path === savedPath
                ? { ...curr, data: { ...curr.data, content: nextContent } }
                : curr,
            );
            showToast(`Saved ${baseName(savedPath)}`);
          }}
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
          initialTabId={
            laneModal.mode === 'create' ? activeTabId : laneModal.lane.tabId || activeTabId
          }
          tabs={tabs}
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
