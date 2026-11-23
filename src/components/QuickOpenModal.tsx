import React, { useEffect, useRef, useState } from 'react';
import type { QuickFileItem } from '../types';
import { api } from '../lib/api';
import { Icon } from './Icon';

export function QuickOpenModal({
  roots,
  onSelect,
  onClose,
}: {
  roots: string[];
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<QuickFileItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const id = ++reqId.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void api
        .quickOpen(roots, query)
        .then((res) => {
          if (reqId.current === id) {
            setItems(res);
            setSelectedIdx(0);
          }
        })
        .catch(() => {
          if (reqId.current === id) setItems([]);
        })
        .finally(() => {
          if (reqId.current === id) setLoading(false);
        });
    }, 60);
    return () => clearTimeout(timer);
  }, [roots, query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && items[selectedIdx]) {
      e.preventDefault();
      onSelect(items[selectedIdx].path);
    }
  };

  return (
    <div
      className="modal-backdrop top"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="quick-open" role="dialog" aria-modal="true" aria-label="Quick open file" onKeyDown={onKeyDown}>
        <div className="quick-open-input">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder={
              roots.length
                ? 'Jump to file across loaded repos…'
                : 'Add a folder in Explorer first to search files'
            }
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading && <span className="pill subtle">…</span>}
        </div>
        <div className="quick-open-list">
          {!roots.length ? (
            <div className="quick-open-empty">No workspace folders loaded yet.</div>
          ) : !items.length && !loading ? (
            <div className="quick-open-empty">No matching files.</div>
          ) : (
            items.map((item, idx) => (
              <button
                key={item.path}
                className={`quick-open-row${idx === selectedIdx ? ' active' : ''}`}
                onMouseEnter={() => setSelectedIdx(idx)}
                onClick={() => onSelect(item.path)}
              >
                <Icon name="file" size={13} />
                <span className="qo-name">{item.name}</span>
                <span className="qo-path">{item.relPath}</span>
                {roots.length > 1 && <span className="pill subtle">{item.rootName}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
