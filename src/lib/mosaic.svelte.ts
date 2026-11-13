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
// again for the new set of shapes. Its tiles loop instead of ending, and they
// are not all one size: the newest item is the largest and tiles shrink as
// they age (`dynamicFocus`), so the eye has one place to go after each change.
//
// With the center on, Mosaic and Dynamic are laid out around one fixed tile:
// a chosen item plays in the middle at its own shape and never moves. In
// Mosaic the strips around it are blocks of the same tree and change the way
// Mosaic's blocks do; in Dynamic every change lays the strips out again.
import { api, type MediaMap, type Params, type Plan, type Rect, type Tree } from "./api";
import type { Media, MediaQueue } from "./queue.svelte";
import type { Pan } from "./session";
import { resizeLeaf } from "./tree";
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
  /** the center tile: loops, is never replaced and never moves */
  fixed?: boolean;
  /** the visible part of the item, as object-position in percent (0 to 100
   * on each axis) and a zoom; centered and not zoomed when absent. Cleared
   * when the media changes. */
  pan?: Pan;
  /** what it showed before `media`, most recent last (at most HISTORY) */
  back?: Media[];
  /** what it stepped back from (B), the next to show again last */
  fwd?: Media[];
}

/** What MosaicView and Wall need from a wall made of tiles (Mosaic, Dynamic
 * and Grid). */
export interface TileWall {
  tiles: TileState[];
  hovered: number | null;
  region: { rect: Rect; kind: Plan["kind"]; seq: number } | null;
  last: { kind: Plan["kind"]; moved: number; crop: number; ms: number } | null;
  status: string;
  paused: boolean;
  pointerActive: boolean;
  readonly dynamic: boolean;
  /** how media sits in a tile; cover unless said otherwise */
  readonly fit?: "cover" | "contain";
  done(id: number, urgent?: boolean): void;
  next(id: number): void;
  /** B: the item the tile showed before. False when it has none. */
  prev(id: number): boolean;
  /** a file left the wall: out of every tile's history as well */
  forget(path: string): void;
  togglePin(id: number): void;
  /** Shift+drag on a pinned or center tile; undefined centers it again */
  setPan(id: number, pan: TileState["pan"]): void;
  /** Shift+↑↓ on a pinned tile: one step larger or smaller. Null when it
   * changed, else why not, in words for the HUD. */
  resizeTile(id: number, grow: boolean): Promise<string | null>;
  retile(): unknown;
  resize(bounds: Rect): unknown;
  destroy(): void;
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

/** how many earlier items a tile keeps */
const HISTORY = 20;

/** A tile of a resumed session (session.ts): its item, or null when the
 * file is no longer available, and what it had. */
export interface TileSeed {
  id: number;
  media: Media | null;
  pinned: boolean;
  pan?: Pan;
  /** ms since its item arrived */
  age?: number;
}

/** What a resumed wall starts from instead of the queue. */
export interface WallSeed {
  tiles: TileSeed[];
  /** Mosaic, Dynamic: the saved arrangement, and the area it was laid out in */
  tree: Tree | null;
  bounds: Rect | null;
  /** the center tile's id in `tree` */
  centerId: number | null;
  centerPan?: Pan;
}

/** the tile ids in a layout tree; null when it is not one */
function leafIds(t: Tree, out: number[] = []): number[] | null {
  if (!t || typeof t !== "object") return null;
  if (t.k === "leaf") {
    if (typeof t.id !== "number") return null;
    out.push(t.id);
    return out;
  }
  if ((t.k !== "row" && t.k !== "col") || !(t.f > 0 && t.f < 1)) return null;
  return leafIds(t.a, out) && leafIds(t.b, out);
}

/** The item a tile's history gives next: on a step back (B) the last one it
 * showed, otherwise the last one it stepped back from. Null: none, and the
 * queue gives the next item. It stays in the history until `advance`. */
export function fromHistory(tile: TileState, back: boolean): Media | null {
  const list = back ? tile.back : tile.fwd;
  return list?.length ? list[list.length - 1] : null;
}

/** Put the next item in `tile` and keep its history. `taken`: an item just
 * taken from the queue; null: the one fromHistory(tile, back) gives, shown
 * under a new key. What the tile showed goes on `fwd` for a step back and on
 * `back` otherwise, unless `keepOut` says it may not come back (the center
 * item, a file removed from the wall). */
export function advance(tile: TileState, queue: MediaQueue, back: boolean, taken: Media | null, keepOut: (path: string) => boolean) {
  let m = taken;
  if (!m) {
    const h = (back ? tile.back : tile.fwd)?.pop();
    if (!h) return;
    m = queue.again(h);
  }
  const was = tile.media;
  if (!keepOut(was.path)) {
    // pushed through `tile`, not through the array just assigned: `tile` is
    // $state, which wraps that array, and a push to the unwrapped one is not seen
    if (back) {
      if (!tile.fwd) tile.fwd = [];
      tile.fwd.push(was);
    } else {
      if (!tile.back) tile.back = [];
      tile.back.push(was);
      if (tile.back.length > HISTORY) tile.back.splice(0, tile.back.length - HISTORY);
    }
  }
  tile.media = m;
  tile.since = performance.now();
}

/** Take `path` out of every tile's history. */
export function forgetIn(tiles: TileState[], path: string) {
  for (const t of tiles) {
    if (t.back) t.back = t.back.filter((m) => m.path !== path);
    if (t.fwd) t.fwd = t.fwd.filter((m) => m.path !== path);
  }
}

export class MosaicController implements TileWall {
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
  /** steps back asked for (B) and not finished yet, by tile */
  private backs = new Map<number, number>();
  /** files removed from the wall, kept out of the tiles' histories */
  private gone = new Set<string>();
  private keepOut = (path: string) => path === this.center?.path || this.gone.has(path);

  constructor(
    private queue: MediaQueue,
    private s: Settings,
    private bounds: Rect,
    readonly dynamic = false,
    /** the center item, when the center is on */
    private center: Media | null = null,
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
      .filter((t) => !t.pinned && !t.fixed && t.id !== held)
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

  /** the tiles that take items from the queue: all but the center tile */
  private around(): TileState[] {
    return this.tiles.filter((t) => !t.leaving && !t.fixed);
  }

  private media(): MediaMap {
    const m: MediaMap = {};
    for (const t of this.live()) m[t.id] = t.media.aspect;
    return m;
  }

  /** Dynamic: target relative areas by age, newest first in `ids`. The
   * newest is the largest, the next few are in between, the rest are 1. */
  private ageWeights(ids: number[]): Record<number, number> | undefined {
    const focus = this.dynamic ? this.s.dynamicFocus : 0;
    if (focus <= 0 || ids.length < 3) return undefined;
    const out: Record<number, number> = { [ids[0]]: 1 + 3.5 * focus };
    const second = Math.max(1, Math.round((ids.length - 1) / 4));
    for (const id of ids.slice(1, 1 + second)) out[id] = 1 + 1.3 * focus;
    return out;
  }

  /** Target relative areas.
   *
   * Dynamic: by age (`ageWeights`). The tile `newest`, or the one that
   * arrived last, counts as the newest.
   *
   * The center tile is meant to be large, so it is given the weight that
   * makes it count as one average tile when sizes are compared. */
  private weights(newest: number | null = null): Record<number, number> | undefined {
    const rest = this.around();
    const byAge = [...rest].sort((a, b) => (b.id === newest ? Infinity : b.since) - (a.id === newest ? Infinity : a.since));
    const out: Record<number, number> = { ...this.ageWeights(byAge.map((t) => t.id)) };
    const fixed = this.live().find((t) => t.fixed);
    if (fixed && rest.length) {
      const mean = rest.reduce((sum, t) => sum + t.rect.w * t.rect.h, 0) / rest.length;
      out[fixed.id] = Math.max(0.2, (fixed.rect.w * fixed.rect.h) / Math.max(1, mean));
    }
    return Object.keys(out).length ? out : undefined;
  }

  private params(inPlaceOnly = false, newest: number | null = null): Params {
    const now = performance.now();
    const frozen = this.live()
      .filter((t) => t.pinned || t.fixed)
      .map((t) => t.id);
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
      weights: this.weights(newest),
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

  /** The first tiles: `count` items from the queue, or a resumed session's
   * (`seed`). A seed whose files are all still there and whose tree fits
   * comes back in its saved arrangement; otherwise its items are laid out
   * afresh, with queue items in place of the missing ones. */
  start(count: number, seed?: WallSeed) {
    return this.serial(async () => {
      this.status = "Loading…";
      if (seed && (await this.restore(seed))) return;
      const kept = seed?.tiles.filter((t) => t.media) ?? [];
      if (seed) count = seed.tiles.length;
      await this.queue.wait(count - kept.length, 10000);
      const picked: Media[] = kept.map((t) => t.media!);
      while (picked.length < count) {
        const m = this.queue.take(0);
        if (!m) break;
        picked.push(m);
      }
      if (!picked.length && !this.center) {
        // an empty queue: the wall says why (nothing plays, or the filters left nothing)
        this.status = this.queue.empty ? "" : "Still loading…";
        if (!this.queue.empty && this.alive) setTimeout(() => this.alive && this.start(count), 1500);
        return;
      }
      const items = picked.map((m) => ({ id: this.nextId++, aspect: m.aspect }));
      const t0 = performance.now();
      const now = performance.now();
      // Dynamic: ages one interval apart, so the first tile picked is the
      // newest (and largest) and the clock retires the last one first
      const age = (i: number) => (this.dynamic ? i * this.s.dynamicSeconds * 1000 : 0);
      const fresh = (id: number, media: Media, i: number, fixed = false): TileState => {
        // a resumed tile keeps its pin and pan (set here, at creation:
        // Tile clears the pan when an existing tile's item changes)
        const k = fixed ? undefined : kept[i];
        return {
          id,
          media,
          rect: { x: 0, y: 0, w: 0, h: 0 },
          pinned: k?.pinned ?? false,
          pan: fixed ? seed?.centerPan : k?.pan,
          since: k?.age !== undefined ? now - k.age : now - FRESH_MS - age(i),
          movedAt: now - FRESH_MS,
          leaving: false,
          fixed,
        };
      };
      let plan: Plan | null;
      let staged: TileState[];
      const params = { ...this.params(), weights: this.ageWeights(items.map((it) => it.id)) };
      if (this.center) {
        const cid = this.nextId++;
        staged = [fresh(cid, this.center, 0, true), ...items.map((it, i) => fresh(it.id, picked[i], i))];
        plan = await api.planCenter({ center: { id: cid, aspect: this.center.aspect }, share: this.s.centerSize, items, bounds: this.bounds, prev: null, params });
      } else {
        staged = items.map((it, i) => fresh(it.id, picked[i], i));
        plan = await api.planInitial(items, this.bounds, params);
      }
      if (!plan || !this.alive) return;
      const rects = rectMap(plan);
      for (const t of staged) t.rect = rects.get(t.id)!;
      this.tiles = staged;
      this.apply(plan, t0);
      this.status = "";
    });
  }

  /** A resumed session in its saved arrangement: the saved tree, laid out
   * for this screen. False (nothing changed) when a file is missing or the
   * tree does not hold exactly the saved tiles; start() then lays the items
   * out afresh. */
  private async restore(seed: WallSeed): Promise<boolean> {
    const { tiles, tree, centerId } = seed;
    if (!tree || !tiles.length || tiles.some((t) => !t.media)) return false;
    // the center tile is in the tree when the center is on, and only then
    if (!!this.center !== (centerId != null)) return false;
    const ids = new Set(tiles.map((t) => t.id));
    if (centerId != null) ids.add(centerId);
    const leaves = leafIds(tree);
    if (!leaves || leaves.length !== ids.size || ids.size !== tiles.length + (centerId != null ? 1 : 0) || leaves.some((id) => !ids.has(id))) return false;
    let placed: Map<number, Rect>;
    try {
      placed = new Map((await api.planLayout(tree, this.bounds)).map((p) => [p.id, p.rect]));
    } catch (e) {
      console.warn("mosaic: saved layout not usable", e);
      return false;
    }
    if (!this.alive) return true;
    const now = performance.now();
    const staged: TileState[] = tiles.map((t) => ({
      id: t.id,
      media: t.media!,
      rect: placed.get(t.id)!,
      pinned: t.pinned,
      pan: t.pan,
      since: now - (t.age ?? FRESH_MS),
      movedAt: now - FRESH_MS,
      leaving: false,
    }));
    if (this.center && centerId != null) staged.unshift({ id: centerId, media: this.center, rect: placed.get(centerId)!, pinned: false, pan: seed.centerPan, since: now, movedAt: now - FRESH_MS, leaving: false, fixed: true });
    this.tree = tree;
    this.nextId = Math.max(...ids) + 1;
    this.tiles = staged;
    this.status = "";
    // On a screen of another shape the tree is scaled to fit, as on a
    // resize; the center item would be stretched, so it is laid out again
    const b = seed.bounds;
    if (this.center && b && (Math.abs(b.w - this.bounds.w) > 1 || Math.abs(b.h - this.bounds.h) > 1)) await this.recenter();
    return true;
  }

  /** the layout tree now, for a saved session */
  get layoutTree(): Tree | null {
    return this.tree;
  }

  /** A tile finished its image time or its video. */
  done(id: number, urgent = false) {
    if (!this.alive || this.pending.includes(id)) return;
    if (this.tiles.find((t) => t.id === id)?.fixed) return;
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
    const back = this.backs.has(id);
    try {
      return await this.change(id, back);
    } finally {
      if (back) {
        // B was pressed again while this step was waiting or being made:
        // the next step back goes first, while the tile has one to make
        const t = this.tiles.find((x) => x.id === id && !x.leaving);
        const left = t && !t.pinned && fromHistory(t, true) ? (this.backs.get(id) ?? 1) - 1 : 0;
        if (left > 0) {
          this.backs.set(id, left);
          if (!this.pending.includes(id)) this.pending.unshift(id);
        } else this.backs.delete(id);
      }
    }
  }

  /** The next item into tile `id`, laid out for its shape: on a step back
   * (B) the item it showed before, else the one it stepped back from, else
   * the best fit of what the queue offers. */
  private async change(id: number, back: boolean): Promise<boolean> {
    const tile = this.tiles.find((t) => t.id === id && !t.leaving);
    if (!tile || !this.tree || tile.pinned || tile.fixed) return false;
    // from the tile's history: the only candidate, placed whatever its fit
    const chosen = fromHistory(tile, back);
    if (back && !chosen) return false;
    const watched = this.held === id;
    // with a tile pinned or held, Dynamic changes stay local like Mosaic's,
    // so that tile keeps its place
    if (this.dynamic && this.held === null && !this.live().some((t) => t.pinned)) return this.center ? this.reflowCenter(tile, back, chosen) : this.reflow(tile, back, chosen);
    let candidates = chosen ? [chosen] : this.queue.peek(10, !watched);
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
        params: this.params(watched, this.dynamic ? id : null),
      });
    let plan = await ask(candidates);
    // A long-skipped item is placed even when it fits badly, but not when
    // the only place for it would crop it past the limit (its neighbors are
    // frozen, say). Then the best fit from the queue goes there instead.
    // An item from the history was asked for by name and is placed as it is.
    if (!chosen && plan && candidates.length === 1 && this.cropOf(plan, id, candidates[0]) > this.s.maxCrop) {
      const open = this.queue.peek(10, false);
      if (open.length > 1) {
        const second = await ask(open);
        if (second && this.cropOf(second, id, open[second.choice]) < this.cropOf(plan, id, candidates[0])) plan = second;
      }
    }
    if (!plan || !this.alive || !this.put(tile, back, chosen, plan.choice)) return false;
    this.apply(plan, t0);
    return plan.kind !== "swap";
  }

  /** Put the item a plan was made for into `tile`: `chosen` from its
   * history, or else item `i` of the queue's last peek. False when it is no
   * longer there; the history then keeps what it has. */
  private put(tile: TileState, back: boolean, chosen: Media | null, i: number): boolean {
    if (chosen) {
      // forget() may have taken it out while the plan was being made
      if (fromHistory(tile, back) !== chosen) return false;
      advance(tile, this.queue, back, null, this.keepOut);
      return true;
    }
    const next = this.queue.take(i);
    if (!next) return false;
    advance(tile, this.queue, false, next, this.keepOut);
    return true;
  }

  /** Dynamic: the next item into `tile` (`chosen`, from its history, or the
   * queue's next), and the whole wall laid out again. */
  private async reflow(tile: TileState, back: boolean, chosen: Media | null): Promise<boolean> {
    if (!chosen && !this.queue.peek(1).length) await this.queue.wait(1, 6000);
    const c = chosen ?? this.queue.peek(1)[0];
    if (!c || !this.tree) return false;
    const t0 = performance.now();
    const plan = await api.planReflow({
      tree: this.tree,
      bounds: this.bounds,
      leaf: tile.id,
      aspect: c.aspect,
      media: this.media(),
      // the tile taking the new item counts as the newest: it is laid out
      // as the largest
      params: this.params(false, tile.id),
    });
    if (!plan || !this.alive || !this.put(tile, back, chosen, 0)) return false;
    this.apply(plan, t0);
    return plan.moved > 0;
  }

  /** Dynamic with the center on: the next item into `tile` (as in reflow),
   * and the strips around the center laid out again. The center itself
   * never moves. */
  private async reflowCenter(tile: TileState, back: boolean, chosen: Media | null): Promise<boolean> {
    const fixed = this.live().find((t) => t.fixed);
    if (!fixed) return false;
    if (!chosen && !this.queue.peek(1).length) await this.queue.wait(1, 6000);
    const c = chosen ?? this.queue.peek(1)[0];
    if (!c || !this.alive) return false;
    const t0 = performance.now();
    // the new item's tile counts as new: where it was does not matter
    const prev = Object.fromEntries(this.live().filter((t) => t.id !== tile.id).map((t) => [t.id, $state.snapshot(t.rect)]));
    const rest = this.around();
    const byAge = [tile.id, ...rest.filter((t) => t.id !== tile.id).sort((a, b) => b.since - a.since).map((t) => t.id)];
    const plan = await api.planCenter({
      center: { id: fixed.id, aspect: fixed.media.aspect },
      share: this.s.centerSize,
      items: rest.map((t) => ({ id: t.id, aspect: t.id === tile.id ? c.aspect : t.media.aspect })),
      bounds: this.bounds,
      prev,
      params: { ...this.params(), stillness: DYNAMIC_STILLNESS, frozen: [], weights: this.ageWeights(byAge) },
      // the center stays exactly where it is; only the strips change
      at: $state.snapshot(fixed.rect),
    });
    if (!plan || !this.alive || !this.put(tile, back, chosen, 0)) return false;
    this.apply(plan, t0);
    return plan.moved > 0;
  }

  /** share of `m` that would be cropped away in tile `id` under `plan` */
  private cropOf(plan: Plan, id: number, m: Media): number {
    const r = plan.rects.find((p) => p.id === id)?.rect;
    if (!r) return 0;
    return 1 - Math.exp(-Math.abs(Math.log(r.w / r.h / m.aspect)));
  }

  /** How many tiles take items: all of them, or with the center on, those around it. */
  setCount(n: number) {
    const [lo, hi] = LIMITS.tiles;
    n = Math.max(lo, Math.min(hi, n));
    if (this.center) return this.serial(() => this.recenter(n));
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

  private leave(keep: Set<number>) {
    for (const t of this.tiles) {
      if (!keep.has(t.id) && !t.leaving) {
        t.leaving = true;
        const gone = t.id;
        setTimeout(() => (this.tiles = this.tiles.filter((x) => x.id !== gone)), 450);
      }
    }
  }

  private async removeOne(): Promise<boolean> {
    if (!this.tree || this.live().length <= 1) return false;
    const t0 = performance.now();
    const plan = await api.planRemove({ tree: this.tree, bounds: this.bounds, leaf: null, media: this.media(), params: this.params() });
    if (!plan || !this.alive) return false;
    this.leave(new Set(plan.rects.map((p) => p.id)));
    this.apply(plan, t0);
    return true;
  }

  /** Center on: lay the wall out again around the center tile, with `count`
   * tiles around it (default: as many as now). The center's size depends on
   * how many tiles there are to fill the strips, so a count change is a new
   * layout, not an insert. Tiles on screen stay near where they are.
   *
   * `grow`: the size was changed by a key. The size asked for is only the
   * largest the solver may use, so a larger setting can still come back
   * smaller (a smaller center fits the tiles around it better). A layout that
   * moves the wrong way (or not at all) is not used; returns whether it was. */
  private async recenter(count?: number, grow?: boolean): Promise<boolean> {
    const fixed = this.live().find((t) => t.fixed);
    if (!fixed || !this.center) return false;
    let keep = this.around();
    const n = count ?? keep.length;
    const added: TileState[] = [];
    if (keep.length > n) {
      // the ones that have been up longest go first; pinned ones last
      keep = [...keep].sort((a, b) => Number(a.pinned) - Number(b.pinned) || b.since - a.since).slice(0, n);
    } else if (keep.length < n) {
      await this.queue.wait(Math.min(n - keep.length, 4), 6000);
      const now = performance.now();
      while (keep.length + added.length < n) {
        const m = this.queue.take(0);
        if (!m) break;
        added.push({ id: this.nextId++, media: m, rect: { x: 0, y: 0, w: 0, h: 0 }, pinned: false, since: now, movedAt: now, leaving: false });
      }
    }
    const all = [...keep, ...added];
    const t0 = performance.now();
    const prev = Object.fromEntries(this.live().map((t) => [t.id, $state.snapshot(t.rect)]));
    const plan = await api.planCenter({
      center: { id: fixed.id, aspect: fixed.media.aspect },
      share: this.s.centerSize,
      items: all.map((t) => ({ id: t.id, aspect: t.media.aspect })),
      bounds: this.bounds,
      prev,
      params: { ...this.params(), stillness: 0.15, frozen: [], weights: this.ageWeights([...all].sort((a, b) => b.since - a.since).map((t) => t.id)) },
    });
    if (!plan || !this.alive) return false;
    const rects = rectMap(plan);
    if (grow !== undefined) {
      const before = fixed.rect.w * fixed.rect.h;
      const r = rects.get(fixed.id);
      const after = r ? r.w * r.h : before;
      if (grow ? after <= before * 1.01 : after >= before * 0.99) return false;
    }
    for (const t of added) {
      t.rect = rects.get(t.id)!;
      this.tiles.push(t);
    }
    this.leave(new Set(plan.rects.map((p) => p.id)));
    this.apply(plan, t0);
    await sleep(SETTLE_MS);
    return true;
  }

  /** The center item one step larger or smaller (its size setting was just
   * changed). False when no layout with that setting moves it that way. */
  resizeCenter(grow: boolean): Promise<boolean> {
    return this.serial(() => this.recenter(undefined, grow));
  }

  /** An item in the center, or another one there. The wall is laid out again
   * for its shape; the tiles already up stay on the wall. */
  setCenter(m: Media) {
    return this.serial(async () => {
      let fixed = this.live().find((t) => t.fixed);
      const now = performance.now();
      if (!fixed) {
        // it grows out of the middle of the wall
        const b = this.bounds;
        this.tiles.push({ id: this.nextId++, media: m, rect: { x: b.x + b.w / 2, y: b.y + b.h / 2, w: 0, h: 0 }, pinned: false, since: now, movedAt: now, leaving: false, fixed: true });
        fixed = this.tiles[this.tiles.length - 1];
      }
      this.center = m;
      // the center item does not come back into a tile by B or N either
      forgetIn(this.tiles, m.path);
      fixed.media = m;
      fixed.since = now;
      // it may have been one of the tiles around
      for (const t of this.around()) if (t.media.path === m.path) this.done(t.id, true);
      await this.recenter();
    });
  }

  /** The center off: its tile leaves and the others fill the wall. */
  clearCenter() {
    return this.serial(async () => {
      const fixed = this.live().find((t) => t.fixed);
      this.center = null;
      if (!fixed || !this.tree) return;
      if (!this.around().length) {
        // nothing around it (the queue had only the center's file): there is
        // no tile to fill the hole, so the wall starts again from the queue.
        // Not awaited: start() queues behind this step on the same chain.
        this.leave(new Set());
        this.tree = null;
        this.start(this.s.tiles);
        return;
      }
      const t0 = performance.now();
      const media = { ...this.media(), [fixed.id]: fixed.media.aspect };
      const params = { ...this.params(), frozen: [], weights: undefined };
      const plan = await api.planRemove({ tree: this.tree, bounds: this.bounds, leaf: fixed.id, media, params });
      if (!plan || !this.alive) return;
      this.leave(new Set(plan.rects.map((p) => p.id)));
      this.apply(plan, t0);
      await sleep(SETTLE_MS);
      // what was left is a hole filled by its neighbors; lay the wall out properly
      const again = await api.planRetile({ tree: this.tree!, bounds: this.bounds, media: this.media(), params: this.params() });
      if (again && this.alive) this.apply(again, performance.now());
      await sleep(SETTLE_MS);
    });
  }

  /** Lay the whole wall out again (R). */
  retile() {
    return this.serial(async () => {
      if (!this.tree) return;
      if (this.center) return this.recenter();
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
      // scaling would stretch the middle tile; Center lays out again
      if (this.center) return this.recenter();
      const rects = new Map((await api.planLayout(this.tree, bounds)).map((p) => [p.id, p.rect]));
      for (const t of this.tiles) {
        const r = rects.get(t.id);
        if (r) t.rect = r;
      }
    });
  }

  togglePin(id: number) {
    const t = this.tiles.find((x) => x.id === id);
    if (t && !t.fixed) t.pinned = !t.pinned;
  }

  setPan(id: number, pan: TileState["pan"]) {
    const t = this.tiles.find((x) => x.id === id);
    if (t) t.pan = pan;
  }

  /** A pinned tile one step (1.25× its area) larger or smaller. The cuts of
   * the two splits around it move (tree.ts); the tiles inside those splits
   * get smaller or larger, everything else stays where it is. A split that
   * holds another pinned tile or the center is left alone. */
  resizeTile(id: number, grow: boolean): Promise<string | null> {
    return this.serial(async () => {
      const tile = this.live().find((t) => t.id === id);
      if (!tile?.pinned || !this.tree) return "pin a tile (P) to change its size";
      const keep = new Set(this.live().filter((t) => t.id !== id && (t.pinned || t.fixed)).map((t) => t.id));
      const r = resizeLeaf(this.tree, this.bounds, id, grow ? 1.25 : 0.8, keep);
      if ("reason" in r) {
        if (r.reason === "blocked") return "another pinned tile or the centered media is in the way";
        if (r.reason === "alone") return "it already fills the wall";
        return grow ? "as large as it gets here" : "as small as it gets here";
      }
      const placed = await api.planLayout(r.tree, this.bounds);
      if (!this.alive) return null;
      this.tree = r.tree;
      const now = performance.now();
      for (const p of placed) {
        const t = this.tiles.find((x) => x.id === p.id);
        if (t && !same(t.rect, p.rect)) {
          t.rect = p.rect;
          t.movedAt = now;
        }
      }
      this.lastMoveAt = now;
      return null;
    });
  }

  next(id: number) {
    const t = this.tiles.find((x) => x.id === id);
    if (!t || t.fixed) return;
    t.pinned = false;
    this.done(id, true);
  }

  prev(id: number): boolean {
    const t = this.tiles.find((x) => x.id === id && !x.leaving);
    const asked = this.backs.get(id) ?? 0;
    // steps back already asked for and not made yet use up the history too
    if (!t || t.fixed || (t.back?.length ?? 0) <= asked) return false;
    t.pinned = false;
    this.backs.set(id, asked + 1);
    // to the front, also when it was already waiting (its item ended)
    this.pending = this.pending.filter((p) => p !== id);
    this.done(id, true);
    return true;
  }

  forget(path: string) {
    this.gone.add(path);
    forgetIn(this.tiles, path);
  }

  destroy() {
    this.alive = false;
    this.pending = [];
    this.backs.clear();
    clearInterval(this.clock);
  }
}
