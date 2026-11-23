export interface CanvasTab {
  id: string;
  name: string;
}

export interface Lane {
  processId: number;
  name: string;
  kind: 'terminal' | 'agent';
  command: string;
  cwd: string;
  projectDir?: string;
  tabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize?: number;
}

export interface LaneGitInfo {
  id: number;
  branch?: string;
  repoName?: string;
  liveCwd?: string;
}

export interface RemoteTerminal {
  id: number;
  pid: number;
  running: boolean;
  agent?: string;
  generation: string;
  cols: number;
  rows: number;
}

export interface TerminalSnapshot extends RemoteTerminal {
  seq: number;
  data: string;
}

export interface TaskItem {
  id: string;
  text: string;
  done: boolean;
}

export type TerminalSelectionStyle = 'solid' | 'theme';
export type SidebarTab = 'explorer' | 'search' | 'lanes';

export interface AppSettings {
  fontSize: number;
  fontFamily: string;
  shell: string;
  selectionStyle: TerminalSelectionStyle;
  autoStartLanes: boolean;
  showHiddenFiles: boolean;
}

export interface WorkspaceState {
  folders: string[];
  tabs: CanvasTab[];
  activeTabId: string;
  lanes: Lane[];
  columns: number;
  autoFit: boolean;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  notes: string;
  tasks: TaskItem[];
  settings: AppSettings;
}

export interface ThemePalette {
  source: string;
  mode: string;
  background: string;
  darkBg: string;
  surface: string;
  elevated: string;
  border: string;
  foreground: string;
  softFg: string;
  muted: string;
  brightFg: string;
  accent: string;
  cursor: string;
  selectionBackground: string;
  selectionForeground: string;
  ansi: string[];
}

export interface BootstrapPayload {
  version: string;
  homeDir: string;
  defaultShell: string;
  workspace: WorkspaceState;
  theme: ThemePalette;
  connected: boolean;
  daemonPid?: number | null;
  runtimeDir: string;
  terminals: RemoteTerminal[];
}

export interface DaemonStatus {
  connected: boolean;
  pid?: number | null;
  runtimeDir: string;
}

export interface DirEntryItem {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
}

export interface SearchMatchLine {
  line: number;
  column: number;
  text: string;
  start: number;
  end: number;
}

export interface SearchFileResult {
  path: string;
  relPath: string;
  root: string;
  matches: SearchMatchLine[];
}

export interface SearchResponse {
  files: SearchFileResult[];
  totalMatches: number;
  truncated: boolean;
}

export interface QuickFileItem {
  name: string;
  path: string;
  relPath: string;
  root: string;
  rootName: string;
}

export interface FilePreviewResult {
  path: string;
  kind: 'text' | 'html' | 'markdown' | 'image' | 'binary' | 'error';
  ext?: string;
  line?: number;
  column?: number;
  content?: string;
  image?: string;
  startLine?: number;
  totalLines?: number;
  editable?: boolean;
  note?: string;
  error?: string;
}

export interface PreviewRequest {
  requestId: number;
  path: string;
  cwd?: string;
  fallbackRoots?: string[];
  line?: number;
  column?: number;
  sourceLaneId?: number;
}
