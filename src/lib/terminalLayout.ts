export interface TerminalPanel {
  processId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const GAP = 8;
const PADDING = 10;

/** Fit all panels cleanly inside the visible viewport. */
export function autoFitPanels<T extends TerminalPanel>(
  panels: T[],
  width: number,
  height: number,
  columns = 0,
): T[] {
  if (!panels.length) return panels;
  const count = Math.min(
    panels.length,
    columns || Math.max(1, Math.floor((width - PADDING * 2 + GAP) / 560)),
  );
  const rows = Math.ceil(panels.length / count);
  const paneWidth = Math.max(300, Math.floor((width - PADDING * 2 - (count - 1) * GAP) / count));
  const paneHeight = Math.max(220, Math.floor((height - PADDING * 2 - (rows - 1) * GAP) / rows));
  return panels.map((panel, index) => ({
    ...panel,
    x: PADDING + (index % count) * (paneWidth + GAP),
    y: PADDING + Math.floor(index / count) * (paneHeight + GAP),
    width: paneWidth,
    height: paneHeight,
  }));
}

/** Pack rows without changing pane sizes or their current order. */
export function arrangeTerminalPanels<T extends TerminalPanel>(
  panels: T[],
  availableWidth: number,
  columns = 0,
): T[] {
  let x = PADDING;
  let y = PADDING;
  let rowHeight = 0;
  let rowCount = 0;
  return panels.map((panel) => {
    if (
      rowCount > 0 &&
      (columns > 0 ? rowCount >= columns : x + panel.width > availableWidth - PADDING)
    ) {
      x = PADDING;
      y += rowHeight + GAP;
      rowHeight = 0;
      rowCount = 0;
    }
    const placed = { ...panel, x, y };
    x += panel.width + GAP;
    rowHeight = Math.max(rowHeight, panel.height);
    rowCount++;
    return placed;
  });
}

function overlaps(a: TerminalPanel, b: TerminalPanel) {
  return (
    a.x < b.x + b.width + GAP &&
    b.x < a.x + a.width + GAP &&
    a.y < b.y + b.height + GAP &&
    b.y < a.y + a.height + GAP
  );
}

/** Insert into the destination slot, shifting neighbors toward the vacated slot. */
export function dropTerminalPanel<T extends TerminalPanel>(before: T[], dropped: T): T[] {
  const ordered = [...before].sort((a, b) => a.y - b.y || a.x - b.x);
  const source = ordered.findIndex((panel) => panel.processId === dropped.processId);
  if (source < 0) return before;
  const others = ordered.filter((panel) => panel.processId !== dropped.processId);

  const targets = others.filter((panel) => {
    const width =
      Math.min(panel.x + panel.width, dropped.x + dropped.width) - Math.max(panel.x, dropped.x);
    const height =
      Math.min(panel.y + panel.height, dropped.y + dropped.height) - Math.max(panel.y, dropped.y);
    return (
      width >= Math.min(panel.width, dropped.width) * 0.35 &&
      height >= Math.min(panel.height, dropped.height) * 0.35
    );
  });
  const area = (panel: T) =>
    Math.max(
      0,
      Math.min(panel.x + panel.width, dropped.x + dropped.width) - Math.max(panel.x, dropped.x),
    ) *
    Math.max(
      0,
      Math.min(panel.y + panel.height, dropped.y + dropped.height) - Math.max(panel.y, dropped.y),
    );
  targets.sort((a, b) => area(b) - area(a));
  const target = targets[0];

  if (!target) {
    const xs = [
      dropped.x,
      ordered[source].x,
      PADDING,
      ...others.flatMap((p) => [p.x - dropped.width - GAP, p.x + p.width + GAP]),
    ];
    const ys = [
      dropped.y,
      ordered[source].y,
      PADDING,
      ...others.flatMap((p) => [p.y - dropped.height - GAP, p.y + p.height + GAP]),
    ];
    let placed = ordered[source];
    let distance = Infinity;
    for (const x of xs) {
      for (const y of ys) {
        if (x < PADDING || y < PADDING) continue;
        const candidate = { ...dropped, x, y };
        const delta = (x - dropped.x) ** 2 + (y - dropped.y) ** 2;
        if (delta < distance && !others.some((p) => overlaps(p, candidate))) {
          placed = candidate;
          distance = delta;
        }
      }
    }
    return before.map((panel) => (panel.processId === dropped.processId ? placed : panel));
  }

  const destination = ordered.findIndex((panel) => panel.processId === target.processId);
  const slots = ordered.map(({ x, y }) => ({ x, y }));
  const [moving] = ordered.splice(source, 1);
  ordered.splice(destination, 0, moving);
  const proposed = ordered.map((panel, index) => ({ ...panel, ...slots[index] }));
  const anchor = proposed.find((panel) => panel.processId === moving.processId)!;
  const placed: T[] = [anchor];
  for (const panel of proposed) {
    if (panel.processId === moving.processId) continue;
    const next = { ...panel };
    for (let attempts = 0; attempts < placed.length; attempts++) {
      const collisions = placed.filter((other) => overlaps(next, other));
      if (!collisions.length) break;
      next.y = Math.max(...collisions.map((other) => other.y + other.height + GAP));
    }
    placed.push(next);
  }
  return proposed.map((panel) => placed.find((item) => item.processId === panel.processId)!);
}
