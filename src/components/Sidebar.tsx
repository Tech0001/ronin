import React, { useEffect, useRef, useState } from 'react';
import type {
  DirEntryItem,
  Lane,
  RemoteTerminal,
  SearchResponse,
  SidebarTab,
  TaskItem,
} from '../types';
import { api } from '../lib/api';
import { baseName, shortenHome, TERMINAL_PATHS_MIME } from '../lib/terminalFiles';
import { Icon } from './Icon';

function fileBadgeColor(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  switch (ext) {
    case 'rs':
      return 'var(--ansi-yellow)';
    case 'ts':
    case 'tsx':
      return 'var(--ansi-blue)';
    case 'js':
    case 'jsx':
    case 'mjs':
      return 'var(--ansi-yellow)';
    case 'html':
    case 'htm':
      return 'var(--accent)';
    case 'md':
    case 'markdown':
      return 'var(--ansi-cyan)';
    case 'json':
    case 'toml':
    case 'yaml':
    case 'yml':
      return 'var(--ansi-green)';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'webp':
    case 'svg':
    case 'gif':
      return 'var(--ansi-magenta)';
    default:
      return 'var(--fg-muted)';
  }
}

function ExplorerNode({
  entry,
  depth,
  showHidden,
  refreshTick,
  onOpenFile,
  onOpenExternal,
  onNewTerminalInDir,
}: {
  entry: DirEntryItem;
  depth: number;
  showHidden: boolean;
  refreshTick: number;
  onOpenFile: (path: string) => void;
  onOpenExternal: (path: string) => void;
  onNewTerminalInDir: (dir: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntryItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadChildren = async () => {
    setLoading(true);
    try {
      const items = await api.listDir(entry.path, showHidden);
      setChildren(items);
    } catch {
      setChildren([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded) void loadChildren();
  }, [showHidden, refreshTick]);

  const toggle = () => {
    if (!entry.isDir) {
      onOpenFile(entry.path);
      return;
    }
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) {
      void loadChildren();
    }
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(TERMINAL_PATHS_MIME, JSON.stringify([entry.path]));
    e.dataTransfer.setData('text/plain', entry.path);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <>
      <div
        className={`tree-row${entry.isDir ? ' is-dir' : ''}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        draggable
        onDragStart={handleDragStart}
        onClick={toggle}
        title={entry.path}
      >
        <span className="tree-chevron">
          {entry.isDir ? <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} /> : null}
        </span>
        <span
          className="tree-icon"
          style={{ color: entry.isDir ? 'var(--accent)' : fileBadgeColor(entry.name) }}
        >
          <Icon name={entry.isDir ? (expanded ? 'folderOpen' : 'explorer') : 'file'} size={13} />
        </span>
        <span className="tree-name">{entry.name}</span>
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          {entry.isDir && (
            <button
              className="icon-btn xs"
              title="New terminal in this folder"
              onClick={() => onNewTerminalInDir(entry.path)}
            >
              <Icon name="terminal" size={12} />
            </button>
          )}
          <button
            className="icon-btn xs"
            title="Copy path"
            onClick={() => void api.clipboardWrite(entry.path).catch(() => {})}
          >
            <Icon name="copy" size={12} />
          </button>
          {!entry.isDir && (
            <button
              className="icon-btn xs"
              title="Open externally"
              onClick={() => onOpenExternal(entry.path)}
            >
              <Icon name="external" size={12} />
            </button>
          )}
        </span>
      </div>
      {expanded && loading && (
        <div className="tree-loading" style={{ paddingLeft: 26 + depth * 14 }}>
          Loading…
        </div>
      )}
      {expanded &&
        children &&
        children.map((child) => (
          <ExplorerNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            showHidden={showHidden}
            refreshTick={refreshTick}
            onOpenFile={onOpenFile}
            onOpenExternal={onOpenExternal}
            onNewTerminalInDir={onNewTerminalInDir}
          />
        ))}
    </>
  );
}

function ExplorerRoot({
  rootPath,
  homeDir,
  showHidden,
  refreshTick,
  onRemoveFolder,
  onOpenFile,
  onOpenExternal,
  onNewTerminalInDir,
}: {
  rootPath: string;
  homeDir: string;
  showHidden: boolean;
  refreshTick: number;
  onRemoveFolder: (path: string) => void;
  onOpenFile: (path: string) => void;
  onOpenExternal: (path: string) => void;
  onNewTerminalInDir: (dir: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [children, setChildren] = useState<DirEntryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    void api
      .listDir(rootPath, showHidden)
      .then((items) => {
        if (!cancelled) {
          setChildren(items);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, expanded, showHidden, refreshTick]);

  return (
    <div className="explorer-root">
      <div
        className="root-header"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(TERMINAL_PATHS_MIME, JSON.stringify([rootPath]));
          e.dataTransfer.setData('text/plain', rootPath);
        }}
        onClick={() => setExpanded((v) => !v)}
        title={shortenHome(rootPath, homeDir)}
      >
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
        <strong className="root-name">{baseName(rootPath)}</strong>
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="icon-btn xs"
            title="New terminal here"
            onClick={() => onNewTerminalInDir(rootPath)}
          >
            <Icon name="terminal" size={12} />
          </button>
          <button
            className="icon-btn xs"
            title="Remove folder from workspace (files stay on disk)"
            onClick={() => onRemoveFolder(rootPath)}
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      </div>
      {expanded && error && <div className="sidebar-empty">{error}</div>}
      {expanded &&
        children &&
        children.map((entry) => (
          <ExplorerNode
            key={entry.path}
            entry={entry}
            depth={0}
            showHidden={showHidden}
            refreshTick={refreshTick}
            onOpenFile={onOpenFile}
            onOpenExternal={onOpenExternal}
            onNewTerminalInDir={onNewTerminalInDir}
          />
        ))}
    </div>
  );
}

export function Sidebar({
  tab,
  width,
  folders,
  lanes,
  remotes,
  notes,
  tasks,
  homeDir,
  showHidden,
  onToggleHidden,
  onAddFolder,
  onRemoveFolder,
  onOpenFile,
  onOpenExternal,
  onNewTerminalInDir,
  onSelectLane,
  onAddLane,
  onEditLane,
  onStartLane,
  onRunCommand,
  onChangeNotes,
  onChangeTasks,
  onResizeWidth,
  searchInputRef,
}: {
  tab: SidebarTab;
  width: number;
  folders: string[];
  lanes: Lane[];
  remotes: Map<number, RemoteTerminal>;
  notes: string;
  tasks: TaskItem[];
  homeDir: string;
  showHidden: boolean;
  onToggleHidden: () => void;
  onAddFolder: () => void;
  onRemoveFolder: (path: string) => void;
  onOpenFile: (path: string, line?: number, column?: number) => void;
  onOpenExternal: (path: string) => void;
  onNewTerminalInDir: (dir: string) => void;
  onSelectLane: (id: number) => void;
  onAddLane: (kind: 'terminal' | 'agent') => void;
  onEditLane: (lane: Lane) => void;
  onStartLane: (id: number) => void;
  onRunCommand: (id: number) => void;
  onChangeNotes: (notes: string) => void;
  onChangeTasks: (tasks: TaskItem[]) => void;
  onResizeWidth: (width: number) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [refreshTick, setRefreshTick] = useState(0);

  // Search state
  const [query, setQuery] = useState('');
  const [includeGlob, setIncludeGlob] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const searchSeq = useRef(0);

  // Lanes filter & new task state
  const [laneFilter, setLaneFilter] = useState('');
  const [newTask, setNewTask] = useState('');

  useEffect(() => {
    if (tab !== 'search') return;
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResult(null);
      setSearchError(null);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      setSearching(true);
      void api
        .searchFiles(folders, trimmed, caseSensitive, useRegex, includeGlob)
        .then((res) => {
          if (searchSeq.current === seq) {
            setSearchResult(res);
            setSearchError(null);
          }
        })
        .catch((err) => {
          if (searchSeq.current === seq) {
            setSearchError(String(err));
            setSearchResult(null);
          }
        })
        .finally(() => {
          if (searchSeq.current === seq) setSearching(false);
        });
    }, 180);
    return () => clearTimeout(timer);
  }, [tab, query, includeGlob, caseSensitive, useRegex, folders]);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(210, Math.min(520, startWidth + (ev.clientX - startX)));
      onResizeWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <aside className="sidebar" style={{ width }} aria-label="Workspace sidebar">
      {tab === 'explorer' && (
        <div className="sidebar-pane">
          <div className="sidebar-head">
            <span>Explorer</span>
            <div className="sidebar-head-actions">
              <button className="icon-btn sm" title="Add repo folder" onClick={onAddFolder}>
                <Icon name="folderPlus" size={14} />
              </button>
              <button
                className={`icon-btn sm${showHidden ? ' active' : ''}`}
                title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
                onClick={onToggleHidden}
              >
                <Icon name="eye" size={14} />
              </button>
              <button
                className="icon-btn sm"
                title="Refresh folders"
                onClick={() => setRefreshTick((t) => t + 1)}
              >
                <Icon name="refresh" size={13} />
              </button>
            </div>
          </div>
          <div className="sidebar-scroll">
            {!folders.length ? (
              <div className="sidebar-empty-card">
                <p>Load one or more repo folders to browse files, search with ripgrep, or drag file paths straight into terminals.</p>
                <button className="btn-accent" onClick={onAddFolder}>
                  <Icon name="folderPlus" size={14} />
                  Add Folder
                </button>
              </div>
            ) : (
              folders.map((folder) => (
                <ExplorerRoot
                  key={folder}
                  rootPath={folder}
                  homeDir={homeDir}
                  showHidden={showHidden}
                  refreshTick={refreshTick}
                  onRemoveFolder={onRemoveFolder}
                  onOpenFile={(p) => onOpenFile(p)}
                  onOpenExternal={onOpenExternal}
                  onNewTerminalInDir={onNewTerminalInDir}
                />
              ))
            )}
          </div>
        </div>
      )}

      {tab === 'search' && (
        <div className="sidebar-pane">
          <div className="sidebar-head">
            <span>Search</span>
            {searching && <span className="pill subtle">Searching…</span>}
          </div>
          <div className="search-controls">
            <div className="input-group">
              <input
                ref={searchInputRef}
                value={query}
                placeholder={folders.length ? 'Search across repos…' : 'Add a folder first…'}
                disabled={!folders.length}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button
                className={`mini-toggle${caseSensitive ? ' active' : ''}`}
                title="Match Case"
                onClick={() => setCaseSensitive((v) => !v)}
              >
                Aa
              </button>
              <button
                className={`mini-toggle${useRegex ? ' active' : ''}`}
                title="Use Regular Expression"
                onClick={() => setUseRegex((v) => !v)}
              >
                .*
              </button>
            </div>
            <input
              className="glob-input"
              value={includeGlob}
              placeholder="Files to include (e.g. *.rs, *.ts)"
              disabled={!folders.length}
              onChange={(e) => setIncludeGlob(e.target.value)}
            />
          </div>
          <div className="sidebar-scroll">
            {!folders.length && (
              <div className="sidebar-empty-card">
                <p>No workspace folders loaded yet.</p>
                <button className="btn-accent" onClick={onAddFolder}>
                  <Icon name="folderPlus" size={14} />
                  Add Folder
                </button>
              </div>
            )}
            {searchError && <div className="sidebar-empty error">{searchError}</div>}
            {searchResult && (
              <div className="search-summary">
                {searchResult.totalMatches} match{searchResult.totalMatches === 1 ? '' : 'es'} in{' '}
                {searchResult.files.length} file{searchResult.files.length === 1 ? '' : 's'}
                {searchResult.truncated ? ' (capped at 300)' : ''}
              </div>
            )}
            {searchResult?.files.map((file) => (
              <div key={file.path} className="search-file-group">
                <div
                  className="search-file-head"
                  title={file.path}
                  onClick={() => onOpenFile(file.path, file.matches[0]?.line)}
                >
                  <span className="search-file-name">{baseName(file.relPath)}</span>
                  <span className="search-file-dir">
                    {file.relPath.includes('/')
                      ? file.relPath.slice(0, file.relPath.lastIndexOf('/'))
                      : baseName(file.root)}
                  </span>
                  <span className="count-badge">{file.matches.length}</span>
                </div>
                {file.matches.map((m, i) => {
                  const before = m.text.slice(0, m.start);
                  const hit = m.text.slice(m.start, m.end);
                  const after = m.text.slice(m.end);
                  return (
                    <button
                      key={`${m.line}-${i}`}
                      className="search-match-row"
                      onClick={() => onOpenFile(file.path, m.line, m.column)}
                    >
                      <span className="match-ln">{m.line}</span>
                      <span className="match-preview">
                        {before.trimStart()}
                        <mark>{hit}</mark>
                        {after}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'lanes' && (
        <div className="sidebar-pane">
          <div className="sidebar-head">
            <span>Lanes</span>
            <div className="sidebar-head-actions">
              <button
                className="icon-btn sm"
                title="New terminal lane"
                onClick={() => onAddLane('terminal')}
              >
                <Icon name="plus" size={14} />
              </button>
              <button
                className="icon-btn sm"
                title="New agent lane"
                onClick={() => onAddLane('agent')}
              >
                <Icon name="agent" size={14} />
              </button>
            </div>
          </div>
          <div className="sidebar-scroll lanes-scroll">
            <div className="lanes-filter-box">
              <Icon name="search" size={13} />
              <input
                value={laneFilter}
                placeholder="Filter terminals…"
                onChange={(e) => setLaneFilter(e.target.value)}
              />
            </div>

            <details open className="side-section">
              <summary>
                <Icon name="terminal" size={13} />
                <span>Terminals & Agents</span>
                <span className="count-badge">{lanes.length}</span>
              </summary>
              {!lanes.length ? (
                <p className="sidebar-empty">No lanes yet. Add a terminal or agent lane.</p>
              ) : (
                lanes
                  .filter((l) => l.name.toLowerCase().includes(laneFilter.toLowerCase()))
                  .map((lane) => {
                    const remote = remotes.get(lane.processId);
                    const isRunning = Boolean(remote?.running);
                    return (
                      <div key={lane.processId} className="lane-list-row">
                        <button
                          className="lane-list-btn"
                          onClick={() => onSelectLane(lane.processId)}
                          title={lane.cwd}
                        >
                          <span className={`dot${isRunning ? ' running' : ''}`} />
                          <span className="lane-list-name">{lane.name}</span>
                          {remote?.agent && <span className="pill subtle">{remote.agent}</span>}
                        </button>
                        <span className="row-actions">
                          <button
                            className="icon-btn xs"
                            title="Edit lane"
                            onClick={() => onEditLane(lane)}
                          >
                            <Icon name="edit" size={12} />
                          </button>
                          {!isRunning && (
                            <button
                              className="icon-btn xs"
                              title="Start shell"
                              onClick={() => onStartLane(lane.processId)}
                            >
                              <Icon name="play" size={12} />
                            </button>
                          )}
                          {lane.command && (
                            <button
                              className="icon-btn xs"
                              title={`Run: ${lane.command}`}
                              onClick={() => onRunCommand(lane.processId)}
                            >
                              <Icon name="terminal" size={12} />
                            </button>
                          )}
                        </span>
                      </div>
                    );
                  })
              )}
            </details>

            <details className="side-section">
              <summary>
                <Icon name="tasks" size={13} />
                <span>Tasks</span>
                <span className="count-badge">{tasks.filter((t) => !t.done).length}</span>
              </summary>
              <form
                className="task-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed = newTask.trim();
                  if (!trimmed) return;
                  onChangeTasks([
                    ...tasks,
                    { id: crypto.randomUUID(), text: trimmed, done: false },
                  ]);
                  setNewTask('');
                }}
              >
                <input
                  value={newTask}
                  placeholder="Add a quick step…"
                  maxLength={1000}
                  onChange={(e) => setNewTask(e.target.value)}
                />
                <button className="icon-btn sm" type="submit" disabled={!newTask.trim()}>
                  <Icon name="plus" size={13} />
                </button>
              </form>
              {tasks.map((t) => (
                <div key={t.id} className="task-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={t.done}
                      onChange={() =>
                        onChangeTasks(
                          tasks.map((item) =>
                            item.id === t.id ? { ...item, done: !item.done } : item,
                          ),
                        )
                      }
                    />
                    <span className={t.done ? 'done' : ''}>{t.text}</span>
                  </label>
                  <button
                    className="icon-btn xs row-actions"
                    onClick={() => onChangeTasks(tasks.filter((item) => item.id !== t.id))}
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              ))}
            </details>

            <details className="side-section">
              <summary>
                <Icon name="note" size={13} />
                <span>Notes</span>
              </summary>
              <textarea
                className="notes-box"
                value={notes}
                placeholder="Scratchpad notes (saved automatically)…"
                onChange={(e) => onChangeNotes(e.target.value)}
              />
            </details>
          </div>
        </div>
      )}

      <div className="sidebar-resizer" onPointerDown={startResize} />
    </aside>
  );
}
