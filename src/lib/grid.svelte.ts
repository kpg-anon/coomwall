// Grid: a fixed layout of equal cells (some merged into larger tiles), like
// `coomplexer grid -g 3x1`. Tiles never move. When a tile's item ends, the
// next one takes its place; of the next few queued items the one whose shape
// fits the tile best is used, as in Mosaic.
//
// It has the same surface as MosaicController (TileWall), so MosaicView and
// Tile draw it.
import type { Rect } from "./api";
import { gridRects } from "./grid";
import type { TileState, TileWall } from "./mosaic.svelte";
import type { Media, MediaQueue } from "./queue.svelte";
import type { Settings } from "./settings.svelte";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** how much of `aspect` a tile of shape `rect` cuts off (cover) or leaves empty (contain) */
function misfit(rect: Rect, aspect: number): number {
  return Math.abs(Math.log(rect.w / rect.h / aspect));
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

  constructor(
    private queue: MediaQueue,
    private s: Settings,
    private bounds: Rect,
  ) {
    queue.onScreen = () => new Set(this.tiles.map((t) => t.media.path));
  }

  get fit(): "cover" | "contain" {
    return this.s.gridFit;
  }

  private rects(): Rect[] {
    return gridRects(this.s.gridCols, this.s.gridRows, this.s.gridSpans, this.bounds);
  }

  /** The queued item that fits `rect` best. Passing over an item costs a
   * little, so the queue's order still mostly holds. */
  private pick(rect: Rect, fair = true): Media | null {
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

  async start() {
    this.status = "Loading…";
    const rects = this.rects();
    await this.queue.wait(Math.min(rects.length, 6), 10000);
    if (!this.alive) return;
    await this.fill();
    this.status = this.tiles.length ? "" : this.queue.empty ? "Nothing here can be played." : "Still loading…";
    if (!this.tiles.length && !this.queue.empty) setTimeout(() => this.alive && this.start(), 1500);
  }

  /** Make the tiles match the grid: existing tiles keep their items and take
   * the new rectangles in order, new cells get items, surplus tiles leave. */
  private async fill() {
    const rects = this.rects();
    const live = this.tiles.filter((t) => !t.leaving);
    const now = performance.now();
    live.forEach((t, i) => {
      if (i < rects.length) {
        t.rect = rects[i];
        t.movedAt = now;
      } else {
        t.leaving = true;
        const gone = t.id;
        setTimeout(() => (this.tiles = this.tiles.filter((x) => x.id !== gone)), 450);
      }
    });
    for (let i = live.length; i < rects.length && this.alive; i++) {
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
        if (!tile || tile.pinned) continue;
        // the tile being watched only ever gets a good fit
        const fair = !(this.s.hoverHold && this.hovered === id);
        let m = this.pick(tile.rect, fair);
        if (!m) {
          await this.queue.wait(1, 6000);
          m = this.pick(tile.rect, fair);
        }
        if (!m) continue;
        tile.media = m;
        tile.since = performance.now();
        await sleep(60);
      }
    } finally {
      this.busy = false;
    }
  }

  /** R: a new item in every tile that is not pinned */
  retile() {
    for (const t of this.tiles) if (!t.leaving && !t.pinned) this.done(t.id);
  }

  togglePin(id: number) {
    const t = this.tiles.find((x) => x.id === id);
    if (t) t.pinned = !t.pinned;
  }

  next(id: number) {
    const t = this.tiles.find((x) => x.id === id);
    if (t) t.pinned = false;
    this.done(id, true);
  }

  destroy() {
    this.alive = false;
    this.pending = [];
  }
}
