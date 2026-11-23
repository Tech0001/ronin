import type { IBuffer, IBufferCellPosition, ILink } from '@xterm/xterm';

export function terminalLinkMode(
  event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
): 'preview' | 'external' | undefined {
  if (event.button !== 0 || !event.ctrlKey || event.altKey || event.metaKey) return;
  return event.shiftKey ? 'external' : 'preview';
}

type TerminalLink = Pick<ILink, 'text' | 'range'>;

// Map UTF-16 offsets back to cells so wide/combined characters do not shift links.
function readRows(buffer: IBuffer, cols: number, first: number, last: number, hardBreaks = false) {
  let text = '';
  const starts: IBufferCellPosition[] = [];
  const ends: IBufferCellPosition[] = [];
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y)!;
    const wraps = buffer.getLine(y + 1)?.isWrapped;
    let length = Math.min(cols, line.length);
    if (hardBreaks && !wraps) {
      while (length && !line.getCell(length - 1)?.getChars().trim()) length--;
    }
    for (let x = 0; x < length; x++) {
      const cell = line.getCell(x)!;
      const width = cell.getWidth();
      if (!width) continue;
      if (
        x === cols - 1 &&
        !cell.getChars() &&
        wraps &&
        y < last &&
        buffer.getLine(y + 1)?.getCell(0)?.getWidth() === 2
      ) {
        continue;
      }
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) {
        starts.push({ x: x + 1, y: y + 1 });
        ends.push({ x: Math.min(cols, x + width), y: y + 1 });
      }
    }
    if (hardBreaks && !wraps && y < last) {
      text += '\n';
      starts.push({ x: cols, y: y + 1 });
      ends.push({ x: cols, y: y + 1 });
    }
  }
  return { text, starts, ends };
}

const looksLikePath = (text: string) =>
  /^(?:https?:\/\/|file:\/\/|~?\/|\.{1,2}\/)|^[^\s]+\/|\.[\w]+(?::\d+(?::\d+)?)?$/.test(text);
const cellOffset = (cell: IBufferCellPosition, cols: number) => (cell.y - 1) * cols + cell.x - 1;

// TUIs also wrap paths themselves with CRLF and indentation. Quoted paths can
// wrap anywhere; for bare paths require a nearly full line and an indented
// continuation that completes a filename, so adjacent prose stays separate.
function hardWrappedLinks(buffer: IBuffer, cols: number, row: number): TerminalLink[] {
  const { text, starts, ends } = readRows(
    buffer,
    cols,
    Math.max(0, row - 13),
    Math.min(buffer.length - 1, row + 11),
    true,
  );
  const links: TerminalLink[] = [];
  const enclosed = /(["'`])([^"'`]*?\n[^"'`]*?)\1|\(([^()]*?\n[^()]*?)\)/gu;
  for (const match of text.matchAll(enclosed)) {
    const content = match[2] ?? match[3];
    if (/\n[ \t]*\n/.test(content)) continue;
    const target = content.replace(/\n[ \t]*/g, '');
    if (!looksLikePath(target) || (!match[1] && /\s/.test(target))) continue;
    const start = match.index! + 1;
    const range = { start: starts[start], end: ends[start + content.length - 1] };
    if (range.start.y <= row && range.end.y >= row) links.push({ text: target, range });
  }
  const bareHead = /(?:~?\/|\.{1,2}\/|[\p{L}\p{N}\p{M}_.@+-]+\/)[\p{L}\p{N}\p{M}_.@+\/-]*$/u;
  const continuation = /^[ \t]+([\p{L}\p{N}\p{M}_.@+\/-]+)/u;
  const completedFile = /\.[\p{L}\p{N}]{1,12}(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?$/u;
  for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', newline + 1)) {
    if (ends[newline - 1]?.x < cols - 1) continue;
    const lineStart = text.lastIndexOf('\n', newline - 1) + 1;
    const head = bareHead.exec(text.slice(lineStart, newline));
    if (!head) continue;
    const start = lineStart + head.index;
    if (text[start - 1] === ':') continue;
    if (completedFile.test(head[0])) continue;
    let target = head[0];
    let next = newline + 1;
    while (next < text.length) {
      const end = text.indexOf('\n', next);
      const lineEnd = end === -1 ? text.length : end;
      const tail = continuation.exec(text.slice(next, lineEnd));
      if (!tail) break;
      target += tail[1];
      const last = next + tail[0].length - 1;
      if (completedFile.test(target)) {
        const range = { start: starts[start], end: ends[last] };
        if (range.start.y <= row && range.end.y >= row) links.push({ text: target, range });
        break;
      }
      if (end === -1 || ends[last].x < cols - 1) break;
      next = end + 1;
    }
  }
  return links;
}

export function terminalLinks(buffer: IBuffer, cols: number, row: number): TerminalLink[] {
  let first = row - 1;
  let last = row - 1;
  if (!buffer.getLine(first)) return [];
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
  while (buffer.getLine(last + 1)?.isWrapped) last++;
  const { text, starts, ends } = readRows(buffer, cols, first, last);
  const pattern =
    /(["'`])([^\r\n]*?)\1|(?:https?|file):\/\/[^\s<>"'`]+|(?:~?\/[\p{L}\p{N}\p{M}_.@+-]+(?:\/[\p{L}\p{N}\p{M}_.@+-]+)*|(?:\.{1,2}\/)?(?:[\p{L}\p{N}\p{M}_.@+-]+\/)*[\p{L}\p{N}\p{M}_.@+-]+\.\w{1,12})(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?/gu;
  const links = hardWrappedLinks(buffer, cols, row);
  for (const match of text.matchAll(pattern)) {
    const quoted = Boolean(match[1]);
    let target = quoted ? match[2] : match[0];
    if (quoted && !looksLikePath(target)) continue;
    if (!quoted) {
      target = target.replace(/[.,;!?]+$/, '');
      for (const [open, close] of [
        ['(', ')'],
        ['[', ']'],
      ]) {
        while (target.endsWith(close) && target.split(close).length > target.split(open).length) {
          target = target.slice(0, -1);
        }
      }
    }
    if (!target) continue;
    const start = match.index! + (quoted ? 1 : 0);
    const range = { start: starts[start], end: ends[start + target.length - 1] };
    if (
      links.some(
        (link) =>
          cellOffset(range.start, cols) <= cellOffset(link.range.end, cols) &&
          cellOffset(range.end, cols) >= cellOffset(link.range.start, cols),
      )
    ) {
      continue;
    }
    if (range.start.y <= row && range.end.y >= row) links.push({ text: target, range });
  }
  return links.sort((a, b) => cellOffset(a.range.start, cols) - cellOffset(b.range.start, cols));
}
