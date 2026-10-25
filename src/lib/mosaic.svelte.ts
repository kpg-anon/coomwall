// Mosaic: a fixed number of tiles in a slicing-tree layout that changes only
// where it must. The layout math lives in Rust (crates/engine/src/layout.rs);
// this side owns the tiles, their timers and the order things happen in.
//
// Every change runs through one serial chain, so a resize, a count change and
// a tile ending can never interleave, and changes are spaced so the wall never
// does two re-layouts on top of each other.
//
// Dynamic mode is the same wall run the other way round: on a clock, the tile
// that has been up longest takes the next item and the whole wall is laid out
// again for the new set of shapes. Its tiles loop instead of ending.
import { api, type MediaMap, type Params, type Plan, type Rect, type Tree } from "./api";
import type { Media, MediaQueue } from "./queue.svelte";
import { LIMITS, type Settings } from "./settings.svelte";

export interface TileState {
  id: number;
  media: Media;
  rect: Rect;
  pinned: boolean;
  /** performance.now() when its current media arrived */
  since: number;
  /** performance.now() when its rectangle last changed */
  movedAt: number;
  leaving: boolean;
}

/** minimum time between two changes that move tiles (one transition) */
const SETTLE_MS = 820;
/** a tile that changed or moved this recently costs 3x to move again */
const FRESH_MS = 5000;
/** after the wall moves, motion costs 4x for this long */
const CALM_MS = 3000;
/** a whole-wall re-layout as a crop fallback, at most this often */
const GLOBAL_MS = 60000;
/** Dynamic: motion weight. Low, so every change re-lays out the wall, and
 * among equally good layouts tiles still travel the shortest way. */
const DYNAMIC_STILLNESS = 0.15;
const CLOCK_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rectMap(plan: { rects: { id: number; rect: Rect }[] }): Map<number, Rect> {
  return new Map(plan.rects.map((p) => [p.id, p.rect]));
}

function same(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}

export class MosaicController {
  tiles = $state<TileState[]>([]);
  hovered = $state<number | null>(null);
  /** the block the last change re-laid out, for the debug overlay */
  region = $state<{ rect: Rect; kind: Plan["kind"]; seq: number } | null>(null);
  last = $state<{ kind: Plan["kind"]; moved: number; crop: number; ms: number } | null>(null);
  status = $state("");
  /** set by MosaicView */
  paused = false;
  pointerActive = false;

  private tree: Tree | null = null;
  private pending: number[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private pumping = false;
  private nextId = 1;
  private alive = true;
  private seq = 0;
  private lastMoveAt = -Infinity;
  private lastGlobalAt = -Infinity;
  private clock: ReturnType<typeof setInterval> | undefined;
  private waited = 0;

  constructor(
    private queue: MediaQueue,
    private s: Settings,
    private bounds: Rect,
    readonly dynamic = false,
  ) {
    queue.onScreen = () => new Set(this.tiles.map((t) => t.media.path));
    if (dynamic) this.clock = setInterval(() => this.tick(), CLOCK_MS);
  }

  /** The tile held still for the viewer. In Dynamic only while the pointer is
   * moving: a pointer resting anywhere on the wall would otherwise keep every
   * change local. */
  private get held(): number | null {
    if (!this.s.hoverHold || (this.dynamic && !this.pointerActive)) return null;
    return this.hovered;
  }

  /** Dynamic: every `dynamicSeconds` of unpaused time, the oldest tile that
   * is neither pinned nor held takes the next item. */
  private tick() {
    if (this.paused || !this.tree) return;
    this.waited += CLOCK_MS;
    if (this.waited < this.s.dynamicSeconds * 1000 || this.pumping || this.pending.length) return;
    const held = this.held;
    const oldest = this.live()
      .filter((t) => !t.pinned && t.id !== held)
      .sort((a, b) => a.since - b.since)[0];
    if (!oldest) return;
    this.waited = 0;
    this.done(oldest.id);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch((e) => console.warn("mosaic:", e));
    return run;
  }

  private live(): TileState[] {
    return this.tiles.filter((t) => !t.leaving);
  }

  private media(): MediaMap {
    const m: MediaMap = {};
    for (const t of this.live()) m[t.id] = t.media.aspect;
    return m;
  }

  private params(inPlaceOnly = false): Params {
    const now = performance.now();
    const frozen = this.live().filter((t) => t.pinned).map((t) => t.id);
    const held = this.held;
    if (held !== null) frozen.push(held);
    // right after the wall moved, motion is four times as costly: changes
    // are content swaps unless a swap would crop past the limit
    const calm = now - this.lastMoveAt < CALM_MS ? 4 : 1;
    return {
      stillness: this.dynamic ? DYNAMIC_STILLNESS : this.s.stillness * calm,
      maxCrop: this.s.maxCrop,
      frozen,
      fresh: this.live()
        .filter((t) => now - Math.max(t.since, t.movedAt) < FRESH_MS)
        .map((t) => t.id),
      inPlaceOnly,
      allowGlobal: now - this.lastGlobalAt > GLOBAL_MS,
      skipCost: 0.12,
    };
  }

  private apply(plan: Plan, started: number) {
    this.tree = plan.tree;
    const rects = rectMap(plan);
    const now = performance.now();
    let moved = false;
    for (const t of this.tiles) {
      const r = rects.get(t.id);
      if (r && !same(r, t.rect)) {
        t.rect = r;
        t.movedAt = now;
        moved = true;
      }
    }
    if (moved) this.lastMoveAt = now;
    if (plan.kind === "global") this.lastGlobalAt = now;
    this.last = { kind: plan.kind, moved: plan.moved, crop: plan.worstCrop, ms: Math.round(performance.now() - started) };
    if (plan.region && plan.kind !== "swap") this.region = { rect: plan.region, kind: plan.kind, seq: ++this.seq };
  }

  start(count: number) {
    return this.serial(async () => {
      this.status = "Loading…";
      await this.queue.wait(count, 10000);
      const picked: Media[] = [];
      while (picked.length < count) {
        const m = this.queue.take(0);
        if (!m) break;
        picked.push(m);
      }
      if (!picked.length) {
        this.status = this.queue.empty ? "Nothing here can be played." : "Still loading…";
        if (!this.queue.empty && this.alive) setTimeout(() => this.alive && this.start(count), 1500);
        return;
      }
      const items = picked.map((m) => ({ id: this.nextId++, aspect: m.aspect }));
      const t0 = performance.now();
      const plan = await api.planInitial(items, this.bounds, this.params());
      if (!plan || !this.alive) return;
      const rects = rectMap(plan);
      const now = performance.now();
      this.tiles = items.map((it, i) => ({
        id: it.id,
        media: picked[i],
        rect: rects.get(it.id)!,
        pinned: false,
        since: now - FRESH_MS,
        movedAt: now - FRESH_MS,
        leaving: false,
      }));
      this.apply(plan, t0);
      this.status = "";
    });
  }

  /** A tile finished its image time or its video. */
  done(id: number, urgent = false) {
    if (!this.alive || this.pending.includes(id)) return;
    if (urgent) this.pending.unshift(id);
    else this.pending.push(id);
    this.pump();
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.alive && this.pending.length) {
        const id = this.pending.shift()!;
        const moved = await this.serial(() => this.replace(id));
        // a pure content swap moves nothing, so the next change can follow
        // at once; anything that moves tiles gets its transition to itself
        await sleep(moved ? SETTLE_MS : 120);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async replace(id: number): Promise<boolean> {
    const tile = this.tiles.find((t) => t.id === id && !t.leaving);
    if (!tile || !this.tree || tile.pinned) return false;
    const watched = this.held === id;
    // with a tile pinned or held, Dynamic changes stay local like Mosaic's,
    // so that tile keeps its place
    if (this.dynamic && this.held === null && !this.live().some((t) => t.pinned)) return this.reflow(tile);
    let candidates = this.queue.peek(10, !watched);
    if (!candidates.length) {
      await this.queue.wait(1, 6000);
      candidates = this.queue.peek(10, !watched);
      if (!candidates.length) return false;
    }
    const t0 = performance.now();
    const ask = (cands: Media[]) =>
      api.planReplace({
        tree: this.tree!,
        bounds: this.bounds,
        leaf: id,
        media: this.media(),
        candidates: cands.map((c) => c.aspect),
        // the tile under the pointer changes in place: what you are looking
        // at never jumps
        params: this.params(watched),
      });
    let plan = await ask(candidates);
    // A long-skipped item is placed even when it fits badly, but not when
    // the only place for it would crop it past the limit (its neighbours are
    // frozen, say). Then the best fit from the queue goes there instead.
    if (plan && candidates.length === 1 && this.cropOf(plan, id, candidates[0]) > this.s.maxCrop) {
      const open = this.queue.peek(10, false);
      if (open.length > 1) {
        const second = await ask(open);
        if (second && this.cropOf(second, id, open[second.choice]) < this.cropOf(plan, id, candidates[0])) plan = second;
      }
    }
    if (!plan || !this.alive) return false;
    const next = this.queue.take(plan.choice);
    if (!next) return false;
    tile.media = next;
    tile.since = performance.now();
    this.apply(plan, t0);
    return plan.kind !== "swap";
  }

  /** Dynamic: the next item into `tile`, and the whole wall laid out again. */
  private async reflow(tile: TileState): Promise<boolean> {
    if (!this.queue.peek(1).length) await this.queue.wait(1, 6000);
    const [c] = this.queue.peek(1);
    if (!c || !this.tree) return false;
    const t0 = performance.now();
    const plan = await api.planReflow({
      tree: this.tree,
      bounds: this.bounds,
      leaf: tile.id,
      aspect: c.aspect,
      media: this.media(),
      params: this.params(),
    });
    if (!plan || !this.alive) return false;
    const next = this.queue.take(0);
    if (!next) return false;
    tile.media = next;
    tile.since = performance.now();
    this.apply(plan, t0);
    return plan.moved > 0;
  }

  /** share of `m` that would be cropped away in tile `id` under `plan` */
  private cropOf(plan: Plan, id: number, m: Media): number {
    const r = plan.rects.find((p) => p.id === id)?.rect;
    if (!r) return 0;
    return 1 - Math.exp(-Math.abs(Math.log(r.w / r.h / m.aspect)));
  }

  setCount(n: number) {
    const [lo, hi] = LIMITS.tiles;
    n = Math.max(lo, Math.min(hi, n));
    return this.serial(async () => {
      while (this.alive && this.live().length < n) {
        if (!(await this.insertOne())) break;
        await sleep(SETTLE_MS);
      }
      while (this.alive && this.live().length > n) {
        if (!(await this.removeOne())) break;
        await sleep(SETTLE_MS);
      }
    });
  }

  private async insertOne(): Promise<boolean> {
    await this.queue.wait(1, 6000);
    const [c] = this.queue.peek(1);
    if (!c) return false;
    const id = this.nextId++;
    const t0 = performance.now();
    const plan = await api.planInsert({
      tree: this.tree,
      bounds: this.bounds,
      newId: id,
      aspect: c.aspect,
      media: this.media(),
      params: this.params(),
    });
    if (!plan || !this.alive) return false;
    const m = this.queue.take(0)!;
    const rect = rectMap(plan).get(id)!;
    const now = performance.now();
    this.tiles.push({ id, media: m, rect, pinned: false, since: now, movedAt: now, leaving: false });
    this.apply(plan, t0);
    return true;
  }

  private async removeOne(): Promise<boolean> {
    if (!this.tree || this.live().length <= 1) return false;
    const t0 = performance.now();
    const plan = await api.planRemove({ tree: this.tree, bounds: this.bounds, leaf: null, media: this.media(), params: this.params() });
    if (!plan || !this.alive) return false;
    const keep = new Set(plan.rects.map((p) => p.id));
    for (const t of this.tiles) {
      if (!keep.has(t.id) && !t.leaving) {
        t.leaving = true;
        const gone = t.id;
        setTimeout(() => (this.tiles = this.tiles.filter((x) => x.id !== gone)), 450);
      }
    }
    this.apply(plan, t0);
    return true;
  }

  /** Lay the whole wall out again (R). */
  retile() {
    return this.serial(async () => {
      if (!this.tree) return;
      const t0 = performance.now();
      const plan = await api.planRetile({ tree: this.tree, bounds: this.bounds, media: this.media(), params: this.params() });
      if (plan && this.alive) this.apply(plan, t0);
      await sleep(SETTLE_MS);
    });
  }

  /** Same layout, new screen size: every tile scales, none is reordered. */
  resize(bounds: Rect) {
    this.bounds = bounds;
    return this.serial(async () => {
      if (!this.tree) return;
      const rects = new Map((await api.planLayout(this.tree, bounds)).map((p) => [p.id, p.rect]));
      for (const t of this.tiles) {
        const r = rects.get(t.id);
        if (r) t.rect = r;
      }
    });
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
    clearInterval(this.clock);
  }
}
