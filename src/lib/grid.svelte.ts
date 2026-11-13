// Grid: a fixed layout of equal cells (some merged into larger tiles), like
// `coomplexer grid -g 3x1`. Tiles never move. When a tile's item ends, the
// next one takes its place; of the next few queued items the one whose shape
// fits the tile best is used, as in Mosaic.
//
// It has the same surface as MosaicController (TileWall), so MosaicView and
// Tile draw it.
//
// With "only media that fits" (gridOnlyFits, with the cells filled), the
// queue offers only items whose shape fits one of the tiles within
// fitTolerance, and each tile takes one that fits it. A tile with no fitting
// item keeps or takes the closest one: a tile is never left empty.
//
// With the center on, the center item is a tile of the grid: a block of cells
// in the middle (gridWithCenter), never replaced. The other tiles fill the rest.
import type { Rect } from "./api";
import { centerBlock, cropIn, fitTolerance, gridRects, gridWithCenter, overlaps, validSpans } from "./grid";
import { advance, forgetIn, fromHistory, type TileState, type TileWall, type WallSeed } from "./mosaic.svelte";
import type { Media, MediaQueue } from "./queue.svelte";
import type { GridSpan, Settings } from "./settings.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const GRID_CENTER_SIZE = 0.5;

/** how much of `aspect` a tile of shape `rect` cuts off (cover) or leaves empty (contain) */
function misfit(rect: Rect, aspect: number): number {
  return Math.abs(Math.log(rect.w / rect.h / aspect));
}

/** area two rectangles share */
function shared(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}


export class GridController implements TileWall {
  tiles = $state<TileState[]>([]);
  hovered = $state<number | null>(null);
  region = null;
  last = null;
  status = $state("");
  paused = false;
  pointerActive = false;
  readonly dynamic = false;
  readonly kind = "grid";

  private pending: number[] = [];
  private busy = false;
  private nextId = 1;
  private alive = true;
  /** files removed from the wall, kept out of the tiles' histories */
  private gone = new Set<string>();
  private keepOut = (path: string) => path === this.center?.path || this.gone.has(path);
  /** a resumed session's tiles, in cell order, for the first fill */
  private seed: WallSeed | null = null;

  constructor(
    private queue: MediaQueue,
    private s: Settings,
    private bounds: Rect,
    /** the center item, when the center is on */
    private center: Media | null = null,
  ) {
    queue.onScreen = () => new Set(this.tiles.map((t) => t.media.path));
  }

  get fit(): "cover" | "contain" {
    return this.s.gridFit;
  }

  /** the most an item may lose in a tile, with "only media that fits" on; null when off */
  private tolerance(): number | null {
    if (!this.s.gridOnlyFits || this.s.gridFit !== "cover") return null;
    return fitTolerance(this.s.gridFitCrop, this.bounds.w / Math.max(1, this.bounds.h));
  }

  /** what the queue offers: items that fit some tile of this layout */
  private filter(rects: Rect[]) {
    const tol = this.tolerance();
    if (tol === null) return this.queue.setAccept(null);
    const shapes = [...new Set(rects.map((r) => Math.round((r.w / r.h) * 1000) / 1000))];
    this.queue.setAccept((a) => shapes.some((s) => cropIn(s, a) <= tol));
  }

  /** the tiles that take items, and the center item's block */
  private layout(): { rects: Rect[]; center: Rect | null } {
    const { gridCols, gridRows, gridSpans } = this.s;
    if (!this.center) return { rects: gridRects(gridCols, gridRows, gridSpans, this.bounds), center: null };
    // by shape first; among blocks of one shape, about half of each side.
    // The size setting does not apply: there are only a few blocks to choose from
    return gridWithCenter(gridCols, gridRows, gridSpans, GRID_CENTER_SIZE, this.center.aspect, this.bounds);
  }

  /** The queued item that fits `rect` best. Passing over an item costs a
   * little, so the queue's order still mostly holds. */
  private pick(rect: Rect, fair = true): Media | null {
    const tol = this.tolerance();
    if (tol !== null) {
      // the first queued item that fits this tile; tiles of other shapes
      // (merged cells) may need ones further back
      const all = this.queue.peek(60, false);
      const i = all.findIndex((c) => cropIn(rect.w / rect.h, c.aspect) <= tol);
      if (i >= 0) return this.queue.take(i);
    }
    const cands = this.queue.peek(10, fair);
    if (!cands.length) return null;
    let best = 0;
    let bestCost = Infinity;
    cands.forEach((c, i) => {
      const cost = misfit(rect, c.aspect) + 0.06 * i;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    });
    return this.queue.take(best);
  }

  /** `seed`: a resumed session; its items go into the cells in saved order,
   * and a cell whose file is gone takes a queue item as usual. */
  async start(seed?: WallSeed) {
    this.status = "Loading…";
    const { rects } = this.layout();
    this.filter(rects);
    if (seed) this.seed = seed;
    const restored = seed?.tiles.slice(0, rects.length).filter((t) => t.media).length ?? 0;
    await this.queue.wait(Math.min(rects.length - restored, 6), 10000);
    if (!this.alive) return;
    await this.fill();
    this.seed = null;
    // an empty queue: the wall says why (nothing plays, or the filters left nothing)
    this.status = this.tiles.length || this.queue.empty
      ? ""
      : this.queue.noneFit
          ? "No file fits these cells. Turn off \"Only media that fits\" in setup, or allow up to 12% in Preferences."
          : "Still loading…";
    if (!this.tiles.length && !this.queue.empty && !this.queue.noneFit) setTimeout(() => this.alive && this.start(), 1500);
  }

  /** Make the tiles match the grid: existing tiles keep their items and take
   * the new rectangles in order, new cells get items, surplus tiles leave. */
  private async fill() {
    const { rects, center } = this.layout();
    this.filter(rects);
    const now = performance.now();
    const fixed = this.tiles.find((t) => t.fixed && !t.leaving);
    if (center && this.center) {
      if (fixed) {
        fixed.rect = center;
        if (fixed.media.key !== this.center.key) {
          fixed.media = this.center;
          fixed.since = now;
        }
      } else this.tiles.push({ id: this.nextId++, media: this.center, rect: center, pinned: false, pan: this.seed?.centerPan, since: now, movedAt: now, leaving: false, fixed: true });
    } else if (fixed) {
      fixed.leaving = true;
      const gone = fixed.id;
      setTimeout(() => (this.tiles = this.tiles.filter((x) => x.id !== gone)), 450);
    }
    // Tiles keep their items and take the new rectangle they overlap most,
    // pinned tiles first, so a tile that grew or a merge next to it does not
    // send any item to another cell. Tiles left over take the rectangles left
    // over in reading order; surplus tiles leave.
    const live = this.tiles.filter((t) => !t.leaving && !t.fixed);
    const owner: (TileState | null)[] = rects.map(() => null);
    const placed = new Set<TileState>();
    for (const t of [...live].sort((a, b) => Number(b.pinned) - Number(a.pinned))) {
      let best = -1;
      let most = 0;
      rects.forEach((r, i) => {
        const a = owner[i] ? 0 : shared(t.rect, r);
        if (a > most) {
          most = a;
          best = i;
        }
      });
      if (best >= 0) {
        owner[best] = t;
        placed.add(t);
      }
    }
    const rest = live.filter((t) => !placed.has(t));
    owner.forEach((o, i) => {
      if (!o && rest.length) owner[i] = rest.shift()!;
    });
    owner.forEach((t, i) => {
      if (t && (t.rect.x !== rects[i].x || t.rect.y !== rects[i].y || t.rect.w !== rects[i].w || t.rect.h !== rects[i].h)) {
        t.rect = rects[i];
        t.movedAt = now;
      }
    });
    for (const t of rest) {
      t.leaving = true;
      const gone = t.id;
      setTimeout(() => (this.tiles = this.tiles.filter((x) => x.id !== gone)), 450);
    }
    for (let i = 0; i < rects.length && this.alive; i++) {
      if (owner[i]) continue;
      // a resumed tile, with its pin and pan (set at creation: Tile clears
      // the pan when an existing tile's item changes)
      const saved = this.seed?.tiles[i];
      if (saved?.media) {
        this.tiles.push({ id: this.nextId++, media: saved.media, rect: rects[i], pinned: saved.pinned, pan: saved.pan, since: now - (saved.age ?? 0), movedAt: now, leaving: false });
        continue;
      }
      let m = this.pick(rects[i]);
      if (!m) {
        await this.queue.wait(1, 6000);
        m = this.pick(rects[i]);
      }
      if (!m || !this.alive) break;
      this.tiles.push({ id: this.nextId++, media: m, rect: rects[i], pinned: false, since: now, movedAt: now, leaving: false });
    }
  }

  /** the grid's columns, rows, merges or the screen size changed */
  relayout(bounds: Rect = this.bounds) {
    this.bounds = bounds;
    return this.fill();
  }

  resize(bounds: Rect) {
    return this.relayout(bounds);
  }

  /** another center item, or none (null) */
  setCenter(m: Media | null) {
    this.center = m;
    // the center item does not come back into a tile by B or N either
    if (m) forgetIn(this.tiles, m.path);
    return this.fill();
  }

  done(id: number, urgent = false) {
    if (!this.alive || this.pending.includes(id)) return;
    if (urgent) this.pending.unshift(id);
    else this.pending.push(id);
    this.pump();
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.alive && this.pending.length) {
        const id = this.pending.shift()!;
        const tile = this.tiles.find((t) => t.id === id && !t.leaving);
        if (!tile || tile.pinned || tile.fixed) continue;
        // after B, forward again through what it stepped back from before
        // anything new; it fit this tile once, so it is not checked again
        if (fromHistory(tile, false)) {
          advance(tile, this.queue, false, null, this.keepOut);
          await sleep(60);
          continue;
        }
        // the tile being watched only ever gets a good fit
        const fair = !(this.s.hoverHold && this.hovered === id);
        let m = this.pick(tile.rect, fair);
        if (!m) {
          await this.queue.wait(1, 6000);
          m = this.pick(tile.rect, fair);
        }
        if (!m) continue;
        advance(tile, this.queue, false, m, this.keepOut);
        await sleep(60);
      }
    } finally {
      this.busy = false;
    }
  }

  /** R: a new item in every tile that is not pinned */
  retile() {
    for (const t of this.tiles) if (!t.leaving && !t.pinned && !t.fixed) this.done(t.id);
  }

  togglePin(id: number) {
    const t = this.tiles.find((x) => x.id === id);
    if (t && !t.fixed) t.pinned = !t.pinned;
  }

  setPan(id: number, pan: TileState["pan"]) {
    const t = this.tiles.find((x) => x.id === id);
    if (t) t.pan = pan;
  }

  /** a tile's block of cells, from its rectangle */
  private spanOf(r: Rect): GridSpan {
    const { gridCols: cols, gridRows: rows } = this.s;
    const b = this.bounds;
    const cx = (x: number) => Math.round(((x - b.x) * cols) / b.w);
    const cy = (y: number) => Math.round(((y - b.y) * rows) / b.h);
    return { c: cx(r.x), r: cy(r.y), w: cx(r.x + r.w) - cx(r.x), h: cy(r.y + r.h) - cy(r.y) };
  }

  /** A pinned tile one column or row of cells larger (or smaller): of the
   * four sides, the one that leaves it nearest its item's shape. Merged
   * tiles it grows into become single cells again; it never grows into
   * another pinned tile or the centered media. The merge is saved in the
   * grid's layout, like one drawn in setup. */
  async resizeTile(id: number, grow: boolean): Promise<string | null> {
    const tile = this.tiles.find((t) => t.id === id && !t.leaving);
    if (!tile?.pinned) return "pin a tile (P) to change its size";
    const { gridCols: cols, gridRows: rows } = this.s;
    const cell = this.bounds.w / cols / (this.bounds.h / rows);
    const span = this.spanOf(tile.rect);
    const keep = this.tiles.filter((t) => t.id !== id && !t.leaving && !t.fixed && t.pinned).map((t) => this.spanOf(t.rect));
    if (this.center) {
      const block = centerBlock(cols, rows, GRID_CENTER_SIZE, this.center.aspect, cell);
      if (!block) return "with centered media this grid is split finer; turn the center off (C) to change tile sizes";
      keep.push(block);
    }
    const { c, r, w, h } = span;
    const sides: GridSpan[] = grow
      ? [{ c, r, w: w + 1, h }, { c, r, w, h: h + 1 }, { c: c - 1, r, w: w + 1, h }, { c, r: r - 1, w, h: h + 1 }]
      : [{ c, r, w: w - 1, h }, { c, r, w, h: h - 1 }, { c: c + 1, r, w: w - 1, h }, { c, r: r + 1, w, h: h - 1 }];
    const inside = sides.filter((s) => s.w >= 1 && s.h >= 1 && s.c >= 0 && s.r >= 0 && s.c + s.w <= cols && s.r + s.h <= rows);
    const open = inside.filter((s) => !keep.some((k) => overlaps(k, s)));
    if (!open.length) return inside.length ? "another pinned tile or the centered media is in the way" : grow ? "as large as it gets in this grid" : "as small as it gets";
    const shape = (s: GridSpan) => Math.abs(Math.log((s.w * cell) / s.h / tile.media.aspect));
    const best = open.reduce((a, s) => (shape(s) < shape(a) - 1e-6 ? s : a));
    const spans = validSpans(cols, rows, this.s.gridSpans).filter((s) => !overlaps(s, best) && !overlaps(s, span));
    if (best.w * best.h > 1) spans.push(best);
    this.s.gridSpans = spans;
    await this.fill();
    return null;
  }

  next(id: number) {
    const t = this.tiles.find((x) => x.id === id);
    if (!t || t.fixed) return;
    t.pinned = false;
    this.done(id, true);
  }

  prev(id: number): boolean {
    const t = this.tiles.find((x) => x.id === id && !x.leaving);
    if (!t || t.fixed || !t.back?.length) return false;
    t.pinned = false;
    // a change still waiting for this tile (its item ended) would undo the step
    this.pending = this.pending.filter((p) => p !== id);
    advance(t, this.queue, true, null, this.keepOut);
    return true;
  }

  forget(path: string) {
    this.gone.add(path);
    forgetIn(this.tiles, path);
  }

  destroy() {
    this.alive = false;
    this.pending = [];
    // the next mode takes any shape again
    this.queue.setAccept(null);
  }
}
