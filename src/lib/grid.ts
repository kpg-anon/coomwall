// Grid mode's geometry: columns and rows of equal cells, some merged into
// larger tiles. No solver: every tile's rectangle follows from the numbers.
import type { Rect } from "./api";
import type { GridSpan } from "./settings.svelte";

/** layouts offered as one click in setup, as columns x rows */
export const GRID_PRESETS: [number, number][] = [
  [2, 1],
  [3, 1],
  [4, 1],
  [1, 2],
  [2, 2],
  [3, 2],
  [4, 2],
  [3, 3],
  [4, 3],
];

/** "3x1", "3 x 2", "4×2" -> [columns, rows]; null when it is not a layout */
export function parseGrid(text: string, maxCols: number, maxRows: number): [number, number] | null {
  const m = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i.exec(text);
  if (!m) return null;
  const [c, r] = [Number(m[1]), Number(m[2])];
  return c >= 1 && r >= 1 && c <= maxCols && r <= maxRows ? [c, r] : null;
}

export function overlaps(a: GridSpan, b: GridSpan): boolean {
  return a.c < b.c + b.w && b.c < a.c + a.w && a.r < b.r + b.h && b.r < a.r + a.h;
}

/** The spans that fit a grid of this size and do not overlap an earlier one. */
export function validSpans(cols: number, rows: number, spans: GridSpan[]): GridSpan[] {
  const out: GridSpan[] = [];
  for (const s of spans ?? []) {
    const ok = Number.isInteger(s.c) && Number.isInteger(s.r) && s.w >= 1 && s.h >= 1 && s.w * s.h > 1 && s.c >= 0 && s.r >= 0 && s.c + s.w <= cols && s.r + s.h <= rows;
    if (ok && !out.some((o) => overlaps(o, s))) out.push({ c: s.c, r: s.r, w: s.w, h: s.h });
  }
  return out;
}

/** Every tile of the grid in reading order: merged spans and single cells. */
export function gridTiles(cols: number, rows: number, spans: GridSpan[]): GridSpan[] {
  const merged = validSpans(cols, rows, spans);
  const out: GridSpan[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const span = merged.find((s) => c >= s.c && c < s.c + s.w && r >= s.r && r < s.r + s.h);
      if (!span) out.push({ c, r, w: 1, h: 1 });
      else if (span.c === c && span.r === r) out.push(span);
    }
  }
  return out;
}

/** Merge the block of cells from one corner to the other. Spans the block
 * touches are replaced by it; a block of one cell splits the span under it. */
export function mergeCells(cols: number, rows: number, spans: GridSpan[], from: [number, number], to: [number, number]): GridSpan[] {
  const merged = validSpans(cols, rows, spans);
  let block: GridSpan = {
    c: Math.min(from[0], to[0]),
    r: Math.min(from[1], to[1]),
    w: Math.abs(from[0] - to[0]) + 1,
    h: Math.abs(from[1] - to[1]) + 1,
  };
  if (block.w * block.h === 1) return merged.filter((s) => !overlaps(s, block));
  // grow the block until every span it touches is inside it, so the result
  // is still made of rectangles
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of merged) {
      if (!overlaps(s, block)) continue;
      const c = Math.min(block.c, s.c);
      const r = Math.min(block.r, s.r);
      const w = Math.max(block.c + block.w, s.c + s.w) - c;
      const h = Math.max(block.r + block.h, s.r + s.h) - r;
      if (c !== block.c || r !== block.r || w !== block.w || h !== block.h) {
        block = { c, r, w, h };
        changed = true;
      }
    }
  }
  return [...merged.filter((s) => !overlaps(s, block)), block];
}

/** Tile rectangles in whole pixels: neighbors share their edges exactly. */
export function gridRects(cols: number, rows: number, spans: GridSpan[], bounds: Rect): Rect[] {
  const x = (i: number) => Math.round(bounds.x + (bounds.w * i) / cols);
  const y = (i: number) => Math.round(bounds.y + (bounds.h * i) / rows);
  return gridTiles(cols, rows, spans).map((t) => ({ x: x(t.c), y: y(t.r), w: x(t.c + t.w) - x(t.c), h: y(t.r + t.h) - y(t.r) }));
}

/** The block of cells the center item takes: in the middle of the grid,
 * with as many cells on one side of it as on the other. Of those blocks, the
 * one nearest the item's shape (`aspect`; a cell is `cell` wide for 1
 * high) and then `size` of each side. Without `aspect`, by size alone.
 * null when no block leaves any cell around it (2×2, 2×1, 1×1). */
export function centerBlock(cols: number, rows: number, size: number, aspect?: number, cell = 1): GridSpan | null {
  const sides = (n: number) => Array.from({ length: n }, (_, i) => n - i).filter((k) => (n - k) % 2 === 0);
  let best: GridSpan | null = null;
  let bestCost = Infinity;
  for (const w of sides(cols))
    for (const h of sides(rows)) {
      if (w === cols && h === rows) continue;
      const shape = aspect ? Math.abs(Math.log(((w * cell) / h) / aspect)) : 0;
      const area = Math.abs(Math.log((w * h) / (cols * rows * size * size)));
      const cost = shape + 0.35 * area;
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = { c: (cols - w) / 2, r: (rows - h) / 2, w, h };
      }
    }
  return best;
}

/** The grid with the center item in it: its block merged in the middle, user
 * merges it overlaps dropped. A grid with no middle is split finer (each cell
 * in four) until it has one. `center` is the block's rectangle; `rects` the
 * other tiles in reading order. */
export function gridWithCenter(cols: number, rows: number, spans: GridSpan[], size: number, aspect: number, bounds: Rect): { rects: Rect[]; center: Rect | null } {
  const cell = (c: number, r: number) => bounds.w / c / (bounds.h / r);
  let block = centerBlock(cols, rows, size, aspect, cell(cols, rows));
  for (let i = 0; !block && i < 3; i++) {
    cols *= 2;
    rows *= 2;
    spans = [];
    block = centerBlock(cols, rows, size, aspect, cell(cols, rows));
  }
  if (!block) return { rects: gridRects(cols, rows, spans, bounds), center: null };
  const b = block;
  const all = [...validSpans(cols, rows, spans).filter((s) => !overlaps(s, b)), b];
  const tiles = gridTiles(cols, rows, all);
  const rects = gridRects(cols, rows, all, bounds);
  const i = tiles.findIndex((t) => t.c === b.c && t.r === b.r && t.w === b.w && t.h === b.h);
  const [center] = rects.splice(i, 1);
  return { rects, center };
}

/** share of an item of shape `aspect` cut off when it fills a tile of shape `tile` */
export function cropIn(tile: number, aspect: number): number {
  return 1 - Math.exp(-Math.abs(Math.log(tile / aspect)));
}

/** The most an item may lose and still "fit" a Grid cell, for the
 * preference and the shape of the screen the wall is on. Exact allows 2%,
 * for files a few pixels off their nominal shape. */
export function fitTolerance(pref: "auto" | "exact" | "loose", screenAspect: number): number {
  if (pref === "exact") return 0.02;
  if (pref === "loose") return 0.12;
  return Math.abs(Math.log(screenAspect / (16 / 9))) < 0.03 ? 0.02 : 0.12;
}

export function gridLabel(cols: number, rows: number, spans: GridSpan[]): string {
  const merged = validSpans(cols, rows, spans).length;
  return `${cols}×${rows}${merged ? ` · ${gridTiles(cols, rows, spans).length} tiles` : ""}`;
}
