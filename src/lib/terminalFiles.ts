export const TERMINAL_PATHS_MIME = 'application/x-ronin-paths';

export function quoteTerminalPaths(paths: string[]): string {
  if (paths.some((path) => /[\x00-\x1f\x7f]/.test(path))) {
    throw new Error('File paths with control characters cannot be pasted safely.');
  }
  return paths.map((path) => "'" + path.replace(/'/g, "'\\''") + "'").join(' ') + ' ';
}

type Transfer = Pick<DataTransfer, 'types' | 'getData'>;
const FILE_TYPES = [TERMINAL_PATHS_MIME, 'text/uri-list'];

export function hasTerminalFileData(transfer: Transfer): boolean {
  return Array.from(transfer.types).some((t) => FILE_TYPES.includes(t.toLowerCase()));
}

function safePaths(values: unknown[]): string[] {
  if (values.some((v) => typeof v === 'string' && /[\x00-\x1f\x7f]/.test(v))) return [];
  return [
    ...new Set(
      values.filter(
        (v): v is string => typeof v === 'string' && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(v),
      ),
    ),
  ];
}

export function terminalDropPaths(transfer: Transfer): string[] {
  try {
    const raw = transfer.getData(TERMINAL_PATHS_MIME);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return safePaths(parsed);
    }
  } catch {
    /* ignore */
  }
  const uris = transfer
    .getData('text/uri-list')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      try {
        const u = new URL(line);
        if (u.protocol !== 'file:') return undefined;
        return decodeURIComponent(u.pathname);
      } catch {
        return undefined;
      }
    });
  return safePaths(uris);
}

export function shortenHome(path: string, homeDir: string): string {
  if (!homeDir || homeDir === '/') return path;
  const cleanHome = homeDir.replace(/\/$/, '');
  if (path === cleanHome) return '~';
  if (path.startsWith(cleanHome + '/')) return '~' + path.slice(cleanHome.length);
  return path;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').pop() || trimmed || '/';
}
