import React, { useEffect, useRef, useState } from 'react';
import type { AppSettings, CanvasTab, DaemonStatus, Lane, ThemePalette } from '../types';
import { api } from '../lib/api';
import { baseName, shortenHome } from '../lib/terminalFiles';
import { Icon } from './Icon';

export function LaneModal({
  mode,
  initialKind,
  initialCwd,
  initialTabId,
  tabs,
  lane,
  folders,
  homeDir,
  onSave,
  onClose,
}: {
  mode: 'create' | 'edit';
  initialKind: 'terminal' | 'agent';
  initialCwd: string;
  initialTabId: string;
  tabs: CanvasTab[];
  lane?: Lane;
  folders: string[];
  homeDir: string;
  onSave: (data: {
    name: string;
    kind: 'terminal' | 'agent';
    command: string;
    cwd: string;
    projectDir?: string;
    tabId: string;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(
    lane?.name ?? (initialKind === 'agent' ? 'Agent' : baseName(initialCwd) || 'Terminal'),
  );
  const [kind, setKind] = useState<'terminal' | 'agent'>(lane?.kind ?? initialKind);
  const [command, setCommand] = useState(lane?.command ?? '');
  const [cwd, setCwd] = useState(lane?.cwd ?? initialCwd);
  const [projectDir, setProjectDir] = useState(lane?.projectDir ?? '');
  const [tabId, setTabId] = useState(lane?.tabId ?? initialTabId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedCwd = cwd.trim();
    const trimmedProject = projectDir.trim();
    if (!trimmedName) {
      setError('Enter a name for this lane.');
      return;
    }
    const okDir = await api.isDir(trimmedCwd).catch(() => false);
    if (!okDir) {
      setError('Working directory does not exist or is not a folder.');
      return;
    }
    if (trimmedProject) {
      const okProj = await api.isDir(trimmedProject).catch(() => false);
      if (!okProj) {
        setError('Project repo folder does not exist or is not a folder.');
        return;
      }
    }
    setSaving(true);
    try {
      await onSave({
        name: trimmedName,
        kind,
        command: command.trim(),
        cwd: trimmedCwd,
        projectDir: trimmedProject || undefined,
        tabId,
      });
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="dialog-card"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <header className="dialog-head">
          <strong>{mode === 'create' ? `New ${kind} lane` : `Edit ${lane?.name}`}</strong>
          <button type="button" className="icon-btn" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="dialog-body">
          <label className="field">
            <span>Name</span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Vega, Backend, Shell"
            />
          </label>

          <div className="field">
            <span>Type</span>
            <div className="segmented">
              <button
                type="button"
                className={kind === 'terminal' ? 'active' : ''}
                onClick={() => setKind('terminal')}
              >
                <Icon name="terminal" size={13} />
                Terminal
              </button>
              <button
                type="button"
                className={kind === 'agent' ? 'active' : ''}
                onClick={() => setKind('agent')}
              >
                <Icon name="agent" size={13} />
                Agent
              </button>
            </div>
          </div>

          <label className="field">
            <span>Launch command (optional — used by Run command, Start opens a shell)</span>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="claude, codex resume, pi, npm run dev…"
            />
            <div className="chip-row">
              {['claude', 'codex resume', 'pi', 'gemini'].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setCommand(preset);
                    setKind('agent');
                  }}
                >
                  {preset}
                </button>
              ))}
            </div>
          </label>

          <label className="field">
            <span>Working directory</span>
            <div className="input-with-btn">
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
              <button
                type="button"
                onClick={() => {
                  void api.pickFolder(cwd || homeDir).then((picked) => {
                    if (picked) setCwd(picked);
                  });
                }}
              >
                Browse…
              </button>
            </div>
            {folders.length > 0 && (
              <div className="chip-row">
                {folders.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    className={`chip${cwd === folder ? ' active' : ''}`}
                    title={folder}
                    onClick={() => {
                      setCwd(folder);
                      if (mode === 'create' && (name === 'Terminal' || name === 'Agent')) {
                        setName(baseName(folder));
                      }
                    }}
                  >
                    {shortenHome(folder, homeDir)}
                  </button>
                ))}
              </div>
            )}
          </label>

          <label className="field">
            <span>
              Project repo folder (optional — shows git branch &amp; resolves links when agent runs
              from a separate folder)
            </span>
            <div className="input-with-btn">
              <input
                value={projectDir}
                placeholder="Same as working directory"
                onChange={(e) => setProjectDir(e.target.value)}
              />
              {projectDir && (
                <button type="button" onClick={() => setProjectDir('')}>
                  Clear
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  void api.pickFolder(projectDir || folders[0] || homeDir).then((picked) => {
                    if (picked) setProjectDir(picked);
                  });
                }}
              >
                Browse…
              </button>
            </div>
            {folders.length > 0 && (
              <div className="chip-row">
                {folders.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    className={`chip${projectDir === folder ? ' active' : ''}`}
                    title={folder}
                    onClick={() => setProjectDir(projectDir === folder ? '' : folder)}
                  >
                    {baseName(folder)}
                  </button>
                ))}
              </div>
            )}
          </label>

          {tabs.length > 1 && (
            <div className="field">
              <span>Canvas tab</span>
              <div className="segmented">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={tabId === t.id ? 'active' : ''}
                    onClick={() => setTabId(t.id)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <div className="form-error">{error}</div>}
        </div>

        <footer className="dialog-foot">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-accent" disabled={saving}>
            {mode === 'create' ? 'Create lane' : 'Save changes'}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function SettingsModal({
  version,
  settings,
  defaultShell,
  theme,
  daemon,
  runningCount,
  onChangeSettings,
  onStopAll,
  onRestartDaemon,
  onClose,
}: {
  version: string;
  settings: AppSettings;
  defaultShell: string;
  theme: ThemePalette;
  daemon: DaemonStatus;
  runningCount: number;
  onChangeSettings: (next: AppSettings) => void;
  onStopAll: () => void;
  onRestartDaemon: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-card wide" role="dialog" aria-modal="true" onKeyDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <strong>Settings & Background Service</strong>
          <span className="pill subtle">v{version}</span>
          <button className="icon-btn" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="dialog-body settings-grid">
          <section className="settings-section">
            <h3>Terminal Appearance</h3>
            <div className="setting-row">
              <div>
                <strong>Font size</strong>
                <small>Applies to all terminal panes</small>
              </div>
              <div className="stepper">
                <button
                  onClick={() =>
                    onChangeSettings({
                      ...settings,
                      fontSize: Math.max(9, settings.fontSize - 1),
                    })
                  }
                >
                  −
                </button>
                <span>{settings.fontSize}px</span>
                <button
                  onClick={() =>
                    onChangeSettings({
                      ...settings,
                      fontSize: Math.min(24, settings.fontSize + 1),
                    })
                  }
                >
                  +
                </button>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <strong>Selection style</strong>
                <small>Solid matches Ghostty’s crisp high-contrast highlight</small>
              </div>
              <div className="segmented">
                <button
                  className={settings.selectionStyle === 'solid' ? 'active' : ''}
                  onClick={() => onChangeSettings({ ...settings, selectionStyle: 'solid' })}
                >
                  Solid
                </button>
                <button
                  className={settings.selectionStyle === 'theme' ? 'active' : ''}
                  onClick={() => onChangeSettings({ ...settings, selectionStyle: 'theme' })}
                >
                  Translucent
                </button>
              </div>
            </div>

            <label className="field">
              <span>Font family</span>
              <input
                value={settings.fontFamily}
                onChange={(e) => onChangeSettings({ ...settings, fontFamily: e.target.value })}
              />
            </label>

            <label className="field">
              <span>Shell executable (blank uses {defaultShell})</span>
              <input
                value={settings.shell}
                placeholder={defaultShell}
                onChange={(e) => onChangeSettings({ ...settings, shell: e.target.value })}
              />
            </label>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.autoStartLanes}
                onChange={(e) =>
                  onChangeSettings({ ...settings, autoStartLanes: e.target.checked })
                }
              />
              <span>Automatically start stopped shells when Ronin launches</span>
            </label>
          </section>

          <section className="settings-section">
            <h3>Live Theme</h3>
            <div className="theme-card">
              <div className="theme-meta">
                <span>Source</span>
                <code>{theme.source}</code>
              </div>
              <div className="swatch-row">
                {[theme.background, theme.surface, theme.foreground, theme.accent, ...theme.ansi.slice(1, 7)].map(
                  (c, idx) => (
                    <span
                      key={idx}
                      className="swatch"
                      style={{ background: c }}
                      title={c}
                    />
                  ),
                )}
              </div>
            </div>
          </section>

          <section className="settings-section">
            <h3>Persistent Rust Terminal Daemon</h3>
            <p className="settings-desc">
              Terminals run inside a detached pure-Rust daemon in its own systemd scope. Closing
              or reloading Ronin keeps every running agent and its scrollback intact.
            </p>
            <div className="daemon-stats">
              <div>
                <span>Status</span>
                <strong className={daemon.connected ? 'ok-text' : 'warn-text'}>
                  {daemon.connected ? 'Connected' : 'Reconnecting'}
                </strong>
              </div>
              <div>
                <span>Daemon PID</span>
                <code>{daemon.pid ?? '—'}</code>
              </div>
              <div>
                <span>Running shells</span>
                <strong>{runningCount}</strong>
              </div>
            </div>
            <div className="daemon-actions">
              <button onClick={onStopAll} disabled={runningCount === 0}>
                Stop all running terminals
              </button>
              <button className="btn-danger" onClick={onRestartDaemon}>
                Restart background daemon
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-card compact" role="alertdialog" aria-modal="true" onKeyDown={(e) => e.stopPropagation()}>
        <header className="dialog-head">
          <strong>{title}</strong>
          <button className="icon-btn" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="dialog-body">
          <p className="confirm-text">{message}</p>
        </div>
        <footer className="dialog-foot">
          <button onClick={onClose}>Cancel</button>
          <button
            autoFocus
            className={danger ? 'btn-danger' : 'btn-accent'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
