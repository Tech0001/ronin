import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FilePreviewResult, PreviewRequest } from '../types';
import { api } from '../lib/api';
import { baseName, shortenHome } from '../lib/terminalFiles';
import { renderMarkdownDocument, tokenizeCodeLine } from '../lib/highlight';
import { Icon } from './Icon';
import { ImagePreview } from './ImagePreview';

export function FilePreviewModal({
  request,
  data,
  homeDir,
  onClose,
  onOpenExternal,
  onOpenRelated,
  onSaved,
}: {
  request: PreviewRequest;
  data?: FilePreviewResult;
  homeDir: string;
  onClose: () => void;
  onOpenExternal: (target: string, cwd?: string) => void;
  onOpenRelated: (path: string, cwd?: string) => void;
  onSaved: (path: string, nextContent: string) => void;
}) {
  const selectedLineRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [imageError, setImageError] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [viewMode, setViewMode] = useState<'rendered' | 'source'>('rendered');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);

  const isRich = data?.kind === 'html' || data?.kind === 'markdown';
  const canEdit = Boolean(data?.editable && data.content !== undefined);
  const isDirty = editing && draft !== (data?.content ?? '');

  useEffect(() => {
    setImageError(false);
    setFindQuery('');
    setActiveMatchIdx(0);
    setEditing(false);
    setSaveError(null);
    if (data?.kind === 'html' || data?.kind === 'markdown') {
      setViewMode(data.line ? 'source' : 'rendered');
    } else {
      setViewMode('source');
    }
  }, [request.requestId, data?.kind, data?.line]);

  const handleSave = async () => {
    if (!data?.path || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.writeFile(data.path, draft);
      onSaved(data.path, draft);
      setEditing(false);
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!editing && viewMode === 'source' && selectedLineRef.current) {
      selectedLineRef.current.scrollIntoView({ block: 'center' });
    }
  }, [data, viewMode, editing]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (findOpen) {
          setFindOpen(false);
          setFindQuery('');
        } else if (editing) {
          setEditing(false);
          setSaveError(null);
        } else {
          onClose();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && editing) {
        e.preventDefault();
        e.stopPropagation();
        void handleSave();
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'f' &&
        data?.content !== undefined &&
        !editing
      ) {
        e.preventDefault();
        e.stopPropagation();
        setViewMode('source');
        setFindOpen(true);
        requestAnimationFrame(() => searchInputRef.current?.select());
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [findOpen, editing, draft, saving, onClose, data?.content, data?.path]);

  const lines = useMemo(
    () => (data?.content !== undefined ? data.content.split(/\r?\n/) : []),
    [data?.content],
  );

  const matchLineIndices = useMemo(() => {
    const q = findQuery.trim().toLowerCase();
    if (!q) return [];
    const indices: number[] = [];
    lines.forEach((line, idx) => {
      if (line.toLowerCase().includes(q)) indices.push(idx);
    });
    return indices;
  }, [lines, findQuery]);

  const highlightedMatchLine =
    matchLineIndices.length > 0
      ? matchLineIndices[activeMatchIdx % matchLineIndices.length]
      : undefined;

  useEffect(() => {
    if (highlightedMatchLine === undefined) return;
    const el = document.querySelector(`[data-preview-line-idx="${highlightedMatchLine}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [highlightedMatchLine, activeMatchIdx]);

  const displayPath = data?.path ?? request.path;
  const title = baseName(displayPath);
  const parentDir = displayPath.includes('/')
    ? displayPath.slice(0, displayPath.lastIndexOf('/'))
    : undefined;

  const copyPath = async () => {
    const full = data?.line ? `${displayPath}:${data.line}` : displayPath;
    await api.clipboardWrite(full).catch(() => {});
    setCopiedPath(true);
    setTimeout(() => setCopiedPath(false), 1400);
  };

  const handleMarkdownLink = (href: string) => {
    if (/^https?:\/\//i.test(href)) {
      onOpenExternal(href);
    } else {
      onOpenRelated(href, parentDir);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-preview-title"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <header className="preview-header">
          <div className="preview-heading">
            <div className="preview-title-row">
              <Icon name="file" size={14} />
              <strong id="file-preview-title">{title}</strong>
              {data?.ext && <span className="pill subtle">{data.ext.toUpperCase()}</span>}
              {data?.line && (
                <span className="pill accent-soft">
                  L{data.line}
                  {data.column ? `:${data.column}` : ''}
                </span>
              )}
            </div>
            <span className="preview-path" title={displayPath}>
              {shortenHome(displayPath, homeDir)}
            </span>
          </div>

          <div className="preview-actions">
            {editing ? (
              <>
                <button
                  className="btn-accent"
                  disabled={saving || !isDirty}
                  onClick={() => void handleSave()}
                  title="Save file (Ctrl+S)"
                >
                  <Icon name="save" size={13} />
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setSaveError(null);
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                {isRich && (
                  <div className="segmented" role="group" aria-label="View mode">
                    <button
                      className={viewMode === 'rendered' ? 'active' : ''}
                      onClick={() => setViewMode('rendered')}
                      title="Rendered preview"
                    >
                      <Icon name="eye" size={13} />
                      Preview
                    </button>
                    <button
                      className={viewMode === 'source' ? 'active' : ''}
                      onClick={() => setViewMode('source')}
                      title="View source with line numbers"
                    >
                      <Icon name="code" size={13} />
                      Source
                    </button>
                  </div>
                )}
                {canEdit && (
                  <button
                    onClick={() => {
                      setDraft(data?.content ?? '');
                      setFindOpen(false);
                      setEditing(true);
                      requestAnimationFrame(() => editorRef.current?.focus());
                    }}
                    title="Quick-edit this file (Ctrl+S to save)"
                  >
                    <Icon name="edit" size={13} />
                    Edit
                  </button>
                )}
                {data?.content !== undefined && (
                  <button
                    className={`icon-btn${findOpen ? ' active' : ''}`}
                    title="Find in file (Ctrl+F)"
                    aria-label="Find in file"
                    onClick={() => {
                      setViewMode('source');
                      setFindOpen((v) => !v);
                      requestAnimationFrame(() => searchInputRef.current?.focus());
                    }}
                  >
                    <Icon name="search" size={14} />
                  </button>
                )}
                <button onClick={copyPath} title="Copy file path">
                  <Icon name="copy" size={13} />
                  {copiedPath ? 'Copied' : 'Copy path'}
                </button>
                <button
                  onClick={() => onOpenExternal(displayPath, request.cwd)}
                  title={
                    data?.kind === 'html'
                      ? 'Open in default browser'
                      : 'Open with default external application'
                  }
                >
                  <Icon name="external" size={13} />
                  {data?.kind === 'html' ? 'Open in Browser' : 'Open externally'}
                </button>
              </>
            )}
            <button
              autoFocus
              className="icon-btn"
              aria-label="Close preview"
              title="Close (Escape)"
              onClick={onClose}
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        </header>

        {saveError && (
          <div className="preview-banner error" role="alert">
            {saveError}
          </div>
        )}

        {findOpen && data?.content !== undefined && (
          <div className="preview-findbar">
            <Icon name="search" size={13} />
            <input
              ref={searchInputRef}
              value={findQuery}
              placeholder="Find in file…"
              onChange={(e) => {
                setFindQuery(e.target.value);
                setActiveMatchIdx(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matchLineIndices.length) {
                  e.preventDefault();
                  setActiveMatchIdx((idx) =>
                    e.shiftKey
                      ? (idx - 1 + matchLineIndices.length) % matchLineIndices.length
                      : (idx + 1) % matchLineIndices.length,
                  );
                }
              }}
            />
            <span className="preview-find-count">
              {findQuery.trim()
                ? matchLineIndices.length
                  ? `${(activeMatchIdx % matchLineIndices.length) + 1}/${matchLineIndices.length}`
                  : '0 matches'
                : ''}
            </span>
            <button
              disabled={!matchLineIndices.length}
              onClick={() =>
                setActiveMatchIdx(
                  (idx) => (idx - 1 + matchLineIndices.length) % matchLineIndices.length,
                )
              }
            >
              Prev
            </button>
            <button
              disabled={!matchLineIndices.length}
              onClick={() => setActiveMatchIdx((idx) => (idx + 1) % matchLineIndices.length)}
            >
              Next
            </button>
            <button
              className="icon-btn"
              onClick={() => {
                setFindOpen(false);
                setFindQuery('');
              }}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        )}

        {!data && (
          <div className="preview-message" role="status">
            Loading file…
          </div>
        )}
        {data?.error && (
          <div className="preview-message error" role="alert">
            {data.error}
          </div>
        )}
        {data?.note && <div className="preview-banner">{data.note}</div>}

        {data?.kind === 'image' &&
          data.image &&
          (imageError ? (
            <div className="preview-message error" role="alert">
              This image could not be displayed. Use Open externally to inspect it.
            </div>
          ) : (
            <ImagePreview
              image={data.image}
              path={displayPath}
              onError={() => setImageError(true)}
            />
          ))}

        {editing && (
          <div className="preview-editor-wrap">
            <div className="preview-subbar">
              <span className="preview-help">
                {isDirty ? 'Unsaved changes · ' : ''}Ctrl+S to save · Escape to cancel
              </span>
            </div>
            <textarea
              ref={editorRef}
              className="preview-editor"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab') {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const start = el.selectionStart;
                  const end = el.selectionEnd;
                  const next = draft.slice(0, start) + '  ' + draft.slice(end);
                  setDraft(next);
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = start + 2;
                  });
                }
              }}
            />
          </div>
        )}

        {!editing && data?.kind === 'html' && data.content !== undefined && viewMode === 'rendered' && (
          <div className="preview-html-wrap">
            <div className="preview-subbar">
              <span className="preview-help">
                Sandboxed HTML preview (scripts disabled) — click Open in Browser for full
                interactive pages.
              </span>
            </div>
            <iframe
              className="preview-html-frame"
              title={title}
              sandbox=""
              srcDoc={data.content}
            />
          </div>
        )}

        {!editing && data?.kind === 'markdown' && data.content !== undefined && viewMode === 'rendered' && (
          <div className="preview-markdown" tabIndex={0}>
            {renderMarkdownDocument(data.content, handleMarkdownLink)}
          </div>
        )}

        {!editing && data?.content !== undefined && (!isRich || viewMode === 'source') && (
          <div className="preview-code" tabIndex={0} aria-label="File contents">
            {lines.map((lineText, idx) => {
              const lineNum = (data.startLine ?? 1) + idx;
              const isTarget = lineNum === data.line;
              const isMatch = findQuery.trim() && matchLineIndices.includes(idx);
              const isActiveMatch = idx === highlightedMatchLine;
              const tokens = tokenizeCodeLine(lineText, data.ext);
              return (
                <div
                  key={lineNum}
                  data-preview-line-idx={idx}
                  ref={isTarget ? selectedLineRef : undefined}
                  className={`code-line${isTarget ? ' selected' : ''}${
                    isActiveMatch ? ' find-active' : isMatch ? ' find-hit' : ''
                  }`}
                >
                  <span className="code-gutter" aria-hidden="true">
                    {lineNum}
                  </span>
                  <span className="code-text">
                    {tokens.length
                      ? tokens.map((tok, tIdx) =>
                          tok.type === 'plain' ? (
                            <React.Fragment key={tIdx}>{tok.text}</React.Fragment>
                          ) : (
                            <span key={tIdx} className={`tok-${tok.type}`}>
                              {tok.text}
                            </span>
                          ),
                        )
                      : '\u00a0'}
                    {lineText === '' ? '\u00a0' : null}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
