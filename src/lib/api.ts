import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type {
  BootstrapPayload,
  DaemonStatus,
  DirEntryItem,
  FilePreviewResult,
  LaneGitInfo,
  QuickFileItem,
  RemoteTerminal,
  SearchResponse,
  TerminalSnapshot,
  ThemePalette,
  WorkspaceState,
} from '../types';

export const api = {
  bootstrap: () => invoke<BootstrapPayload>('app_bootstrap'),
  saveWorkspace: (workspace: WorkspaceState) => invoke<void>('workspace_save', { workspace }),
  getTheme: () => invoke<ThemePalette>('theme_get'),

  daemonStatus: () => invoke<DaemonStatus>('daemon_status'),
  daemonList: () => invoke<RemoteTerminal[]>('daemon_list'),
  daemonStopAll: () => invoke<void>('daemon_stop_all'),
  daemonRestart: () => invoke<DaemonStatus>('daemon_restart'),

  terminalStart: (id: number, cwd: string, cols?: number, rows?: number) =>
    invoke<RemoteTerminal>('terminal_start', { id, cwd, cols, rows }),
  terminalAttach: (id: number) => invoke<TerminalSnapshot>('terminal_attach', { id }),
  terminalDetach: (id: number) => invoke<void>('terminal_detach', { id }),
  terminalWrite: (id: number, data: string) => invoke<void>('terminal_write', { id, data }),
  terminalResize: (id: number, cols: number, rows: number) =>
    invoke<void>('terminal_resize', { id, cols, rows }),
  terminalKill: (id: number) => invoke<void>('terminal_kill', { id }),
  terminalRefreshDisplay: (id: number) => invoke<void>('terminal_refresh_display', { id }),
  terminalCopy: (id: number, selection: string, cwd?: string) =>
    invoke<string>('terminal_copy', { id, selection, cwd }),

  listDir: (path: string, showHidden: boolean) =>
    invoke<DirEntryItem[]>('fs_list_dir', { path, showHidden }),
  searchFiles: (
    roots: string[],
    query: string,
    caseSensitive: boolean,
    useRegex: boolean,
    includeGlob: string,
  ) =>
    invoke<SearchResponse>('fs_search', {
      roots,
      query,
      caseSensitive,
      useRegex,
      includeGlob,
    }),
  quickOpen: (roots: string[], query: string) =>
    invoke<QuickFileItem[]>('fs_quick_open', { roots, query }),
  previewFile: (
    path: string,
    cwd?: string,
    fallbackRoots?: string[],
    line?: number,
    column?: number,
  ) => invoke<FilePreviewResult>('fs_preview_file', { path, cwd, fallbackRoots, line, column }),
  writeFile: (path: string, content: string) => invoke<void>('fs_write_file', { path, content }),
  gitBranches: (paths: string[]) => invoke<Record<string, string>>('fs_git_branches', { paths }),
  laneGitInfo: (lanes: { id: number; cwd: string; projectDir?: string }[]) =>
    invoke<LaneGitInfo[]>('fs_lane_git_info', { lanes }),
  openExternal: (target: string, cwd?: string) =>
    invoke<void>('fs_open_external', { target, cwd }),
  isDir: (path: string) => invoke<boolean>('fs_is_dir', { path }),

  clipboardRead: () => invoke<string>('sys_clipboard_read'),
  clipboardWrite: (text: string) => invoke<void>('sys_clipboard_write', { text }),

  pickFolder: async (defaultPath?: string): Promise<string | null> => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath,
      title: 'Select folder',
    });
    return typeof picked === 'string' ? picked : null;
  },

  onDaemonState: (cb: (terminals: RemoteTerminal[]) => void): Promise<UnlistenFn> =>
    listen<RemoteTerminal[]>('daemon:state', (e) => cb(e.payload)),
  onDaemonOutput: (
    cb: (payload: { id: number; generation: string; seq: number; data: string }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ id: number; generation: string; seq: number; data: string }>('daemon:output', (e) =>
      cb(e.payload),
    ),
  onDaemonConnection: (cb: (status: 'connected' | 'reconnecting') => void): Promise<UnlistenFn> =>
    listen<'connected' | 'reconnecting'>('daemon:connection', (e) => cb(e.payload)),
  onThemeChanged: (cb: (theme: ThemePalette) => void): Promise<UnlistenFn> =>
    listen<ThemePalette>('theme:changed', (e) => cb(e.payload)),
};
