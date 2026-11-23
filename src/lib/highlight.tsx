import React from 'react';

export interface CodeToken {
  type: 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'type' | 'attr';
  text: string;
}

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'crate', 'default',
  'defer', 'def', 'del', 'do', 'dyn', 'elif', 'else', 'enum', 'export', 'extends', 'extern',
  'false', 'finally', 'fn', 'for', 'from', 'func', 'function', 'if', 'impl', 'import', 'in',
  'interface', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'new', 'nil', 'None', 'null', 'pub',
  'raise', 'ref', 'return', 'Self', 'self', 'static', 'struct', 'super', 'switch', 'throw',
  'trait', 'true', 'try', 'type', 'typeof', 'undefined', 'unsafe', 'use', 'var', 'void', 'where',
  'while', 'with', 'yield',
]);

const CODE_EXTS = new Set([
  'rs', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'c', 'h', 'cpp', 'hpp', 'java',
  'sh', 'bash', 'zsh', 'toml', 'yaml', 'yml', 'json', 'css', 'scss', 'html', 'htm', 'xml',
  'sql', 'lua', 'zig', 'rb', 'kt', 'swift',
]);

export function tokenizeCodeLine(line: string, ext?: string): CodeToken[] {
  if (!ext || !CODE_EXTS.has(ext.toLowerCase())) {
    return [{ type: 'plain', text: line }];
  }
  const hashComments = ['py', 'sh', 'bash', 'zsh', 'toml', 'yaml', 'yml', 'rb'].includes(
    ext.toLowerCase(),
  );
  const tokens: CodeToken[] = [];
  let i = 0;

  const push = (type: CodeToken['type'], text: string) => {
    if (!text) return;
    const prev = tokens[tokens.length - 1];
    if (prev && prev.type === type) prev.text += text;
    else tokens.push({ type, text });
  };

  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];

    // Comments
    if ((ch === '/' && next === '/') || (hashComments && ch === '#')) {
      push('comment', line.slice(i));
      break;
    }

    // Strings
    if (ch === '"' || ch === '\'' || ch === '`') {
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === ch) {
          j++;
          break;
        }
        j++;
      }
      push('string', line.slice(i, j));
      i = j;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(line[i - 1]))) {
      let j = i;
      while (j < line.length && /[0-9a-fA-FxXoObB._]/.test(line[j])) j++;
      push('number', line.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers / keywords / types
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_-]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (KEYWORDS.has(word)) push('keyword', word);
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(word)) push('type', word);
      else push('plain', word);
      i = j;
      continue;
    }

    push('plain', ch);
    i++;
  }
  return tokens;
}

function renderInlineMarkdown(text: string, onOpenLink: (href: string) => void): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(pattern)) {
    const idx = match.index ?? 0;
    if (idx > last) parts.push(text.slice(last, idx));
    const full = match[0];
    if (full.startsWith('`')) {
      parts.push(
        <code key={key++} className="md-inline-code">
          {full.slice(1, -1)}
        </code>,
      );
    } else if (full.startsWith('**')) {
      parts.push(<strong key={key++}>{full.slice(2, -2)}</strong>);
    } else if (full.startsWith('*')) {
      parts.push(<em key={key++}>{full.slice(1, -1)}</em>);
    } else if (match[2] && match[3]) {
      const href = match[3];
      parts.push(
        <a
          key={key++}
          href={href}
          className="md-link"
          onClick={(e) => {
            e.preventDefault();
            onOpenLink(href);
          }}
        >
          {match[2]}
        </a>,
      );
    }
    last = idx + full.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function renderMarkdownDocument(
  source: string,
  onOpenLink: (href: string) => void,
): React.ReactNode {
  const lines = source.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre key={key++} className="md-pre">
          {lang && <span className="md-pre-lang">{lang}</span>}
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2], onOpenLink);
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(
        <Tag key={key++} className={`md-h md-h${level}`}>
          {content}
        </Tag>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {renderInlineMarkdown(quoteLines.join(' '), onOpenLink)}
        </blockquote>,
      );
      continue;
    }

    // Table
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(lines[i + 1])
    ) {
      const parseRow = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const headers = parseRow(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        bodyRows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((h, idx) => (
                  <th key={idx}>{renderInlineMarkdown(h, onOpenLink)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rIdx) => (
                <tr key={rIdx}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx}>{renderInlineMarkdown(cell, onOpenLink)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*[-*+]\s+/, '');
        const check = /^\[([ xX])\]\s+(.*)$/.exec(raw);
        if (check) {
          const checked = check[1].toLowerCase() === 'x';
          items.push(
            <li key={i} className="md-task-item">
              <input type="checkbox" checked={checked} readOnly />
              <span>{renderInlineMarkdown(check[2], onOpenLink)}</span>
            </li>,
          );
        } else {
          items.push(<li key={i}>{renderInlineMarkdown(raw, onOpenLink)}</li>);
        }
        i++;
      }
      blocks.push(
        <ul key={key++} className="md-list">
          {items}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*\d+\.\s+/, '');
        items.push(<li key={i}>{renderInlineMarkdown(raw, onOpenLink)}</li>);
        i++;
      }
      blocks.push(
        <ol key={key++} className="md-list md-olist">
          {items}
        </ol>,
      );
      continue;
    }

    // Paragraph
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(?:```|#{1,6}\s|>\s?|[-*+]\s+|\d+\.\s+|---+|___+|\*\*\*+)/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={key++} className="md-p">
        {renderInlineMarkdown(para.join(' '), onOpenLink)}
      </p>,
    );
  }

  return <div className="md-doc">{blocks}</div>;
}
