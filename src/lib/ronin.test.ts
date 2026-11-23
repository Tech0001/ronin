import { describe, expect, it } from 'vitest';
import type { IBuffer } from '@xterm/xterm';
import { arrangeTerminalPanels, autoFitPanels, dropTerminalPanel } from './terminalLayout';
import { terminalLinkMode, terminalLinks } from './terminalLinks';
import { quoteTerminalPaths, shortenHome, terminalDropPaths, TERMINAL_PATHS_MIME } from './terminalFiles';
import { terminalShortcut } from './terminalShortcuts';
import { tokenizeCodeLine } from './highlight';

function mockBuffer(rows: { text: string; wrapped?: boolean }[], cols: number): IBuffer {
  return {
    length: rows.length,
    getLine(y: number) {
      const row = rows[y];
      if (!row) return undefined;
      return {
        isWrapped: Boolean(row.wrapped),
        length: cols,
        getCell(x: number) {
          const ch = row.text[x] ?? '';
          return {
            getChars: () => ch,
            getWidth: () => 1,
          };
        },
      } as ReturnType<IBuffer['getLine']>;
    },
  } as unknown as IBuffer;
}

describe('terminalLayout', () => {
  it('autoFits panels into columns inside viewport', () => {
    const panels = [
      { processId: 1, x: 0, y: 0, width: 300, height: 220 },
      { processId: 2, x: 0, y: 0, width: 300, height: 220 },
      { processId: 3, x: 0, y: 0, width: 300, height: 220 },
      { processId: 4, x: 0, y: 0, width: 300, height: 220 },
    ];
    const fitted = autoFitPanels(panels, 1200, 800, 2);
    expect(fitted[0].x).toBe(10);
    expect(fitted[1].x).toBeGreaterThan(fitted[0].x + fitted[0].width);
    expect(fitted[2].y).toBeGreaterThan(fitted[0].y + fitted[0].height);
    expect(fitted[0].width).toBe(fitted[1].width);
  });

  it('reorders panels when dropped substantially onto another pane', () => {
    const before = [
      { processId: 1, x: 10, y: 10, width: 400, height: 300 },
      { processId: 2, x: 418, y: 10, width: 400, height: 300 },
    ];
    const dropped = { ...before[0], x: 410, y: 12 };
    const after = dropTerminalPanel(before, dropped);
    expect(after.map((p) => p.processId)).toEqual([2, 1]);
    expect(after[0].x).toBe(10);
    expect(after[1].x).toBe(418);
  });

  it('packs rows with arrangeTerminalPanels', () => {
    const panels = [
      { processId: 1, x: 500, y: 300, width: 400, height: 250 },
      { processId: 2, x: 100, y: 600, width: 400, height: 250 },
    ];
    const arranged = arrangeTerminalPanels(panels, 1000, 2);
    expect(arranged[0].x).toBe(10);
    expect(arranged[1].x).toBe(418);
    expect(arranged[0].y).toBe(10);
    expect(arranged[1].y).toBe(10);
  });
});

describe('terminalLinks', () => {
  it('requires Ctrl+click for preview and Ctrl+Shift+click for external', () => {
    expect(
      terminalLinkMode({ button: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }),
    ).toBeUndefined();
    expect(
      terminalLinkMode({ button: 0, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false }),
    ).toBe('preview');
    expect(
      terminalLinkMode({ button: 0, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }),
    ).toBe('external');
  });

  it('detects bare indented wrapped paths across two rows (RUNBOOK.md case)', () => {
    const line1 = '  ~/Documents/GitHub/agent-Mizar/specs/orrery/cutover/RUNBO';
    const line2 = '  OK.md';
    const cols = line1.length;
    const buf = mockBuffer([{ text: line1 }, { text: line2 }], cols);
    const links1 = terminalLinks(buf, cols, 1);
    const links2 = terminalLinks(buf, cols, 2);
    expect(links1[0]?.text).toBe('~/Documents/GitHub/agent-Mizar/specs/orrery/cutover/RUNBOOK.md');
    expect(links2[0]?.text).toBe('~/Documents/GitHub/agent-Mizar/specs/orrery/cutover/RUNBOOK.md');
  });
});

describe('terminalFiles & shortcuts', () => {
  it('quotes shell paths safely and rejects control chars', () => {
    expect(quoteTerminalPaths(["/tmp/it's ok.txt"])).toBe("'/tmp/it'\\''s ok.txt' ");
    expect(() => quoteTerminalPaths(['/tmp/bad\nfile'])).toThrow();
  });

  it('reads dropped paths from custom MIME or uri-list', () => {
    const paths = terminalDropPaths({
      types: [TERMINAL_PATHS_MIME],
      getData: (t) => (t === TERMINAL_PATHS_MIME ? JSON.stringify(['/a/b.rs']) : ''),
    });
    expect(paths).toEqual(['/a/b.rs']);
    expect(shortenHome('/home/pc/Documents/GitHub/ronin', '/home/pc')).toBe(
      '~/Documents/GitHub/ronin',
    );
  });

  it('maps terminal shortcuts without capturing Alt combinations', () => {
    expect(
      terminalShortcut(
        { key: 'Enter', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false },
        false,
      ),
    ).toBe('shiftEnter');
    expect(
      terminalShortcut(
        { key: 'c', shiftKey: true, ctrlKey: true, metaKey: false, altKey: false },
        false,
      ),
    ).toBe('copy');
    expect(
      terminalShortcut(
        { key: 'Escape', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false },
        false,
      ),
    ).toBe('escape');
    expect(
      terminalShortcut(
        { key: '=', shiftKey: false, ctrlKey: true, metaKey: false, altKey: false },
        false,
      ),
    ).toBe('zoomIn');
    expect(
      terminalShortcut(
        { key: '-', shiftKey: false, ctrlKey: true, metaKey: false, altKey: false },
        false,
      ),
    ).toBe('zoomOut');
    expect(
      terminalShortcut(
        { key: '0', shiftKey: false, ctrlKey: true, metaKey: false, altKey: false },
        false,
      ),
    ).toBe('zoomReset');
    expect(
      terminalShortcut(
        { key: 'f', shiftKey: false, ctrlKey: true, metaKey: false, altKey: true },
        false,
      ),
    ).toBe('find');
  });

  it('tokenizes rust keywords and comments', () => {
    const tokens = tokenizeCodeLine('pub fn main() // hi', 'rs');
    expect(tokens.some((t) => t.type === 'keyword' && t.text === 'pub')).toBe(true);
    expect(tokens.some((t) => t.type === 'comment' && t.text === '// hi')).toBe(true);
  });
});
