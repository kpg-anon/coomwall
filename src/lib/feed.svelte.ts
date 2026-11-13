// Ribbon and Cascade: lanes of media that travel across the screen at a
// constant speed. Ribbon lanes are rows moving left or right; Cascade lanes
// are columns moving up or down. Every item keeps its own aspect ratio along
// the lane, so nothing is cropped except panoramas longer than the screen.
//
// Per frame only one transform per lane changes (translate3d on the strip
// that holds its items), so the compositor moves the whole lane without
// layout or paint. Items are appended ahead of the visible edge and dropped
// once they have left it.
//
// With the center on, the center item is part of the wall (feedLanes): it
// sits in the middle at its own shape, `centerSize` of the largest size that
// fits, and the lanes are laid out around it. Lanes beside it run the whole
// length; the lanes in its band are split into a part before it and a part
// after it, ending at its edges. Nothing moves behind it and nothing is left
// empty.
import type { Rect } from "./api";
import type { Media, MediaQueue } from "./queue.svelte";
import type { Settings } from "./settings.svelte";

export interface FeedItem {
  key: number;
  media: Media;
  /** distance from the lane's start, along the direction of travel */
  pos: number;
  len: number;
  /** left (Ribbon) or top (Cascade) inside the strip */
  place: number;
}

export class Lane {
  items = $state.raw<FeedItem[]>([]);
  /** distance traveled */
  offset = 0;
  /** where the next item starts */
  tail = 0;
  /** eased speed multiplier: 1 = full speed, 0 = stopped */
  mul = 1;
  hover = false;
  strip = $state.raw<HTMLElement | null>(null);

  constructor(
    public index: number,
    /** cross-axis start (top of a row, left of a column) */
    public start: number,
    /** cross-axis thickness */
    public cross: number,
    public factor: number,
    /** along-axis start (left of a row, top of a column) */
    public from: number,
    /** along-axis length: the whole screen, or the part beside the center item */
    public span: number,
  ) {}
}

/** each part of a lane split by the center item is at least this share of
 * the screen's length; with less room the center takes the whole length */
const MIN_PART = 0.1;

/** One lane: `start`/`cross` across the lanes, `from`/`span` along them. */
export interface LaneBox {
  start: number;
  cross: number;
  from: number;
  span: number;
}

/** Lanes for a wall `across` × `along` (Ribbon: height × width, Cascade:
 * width × height) with `n` lanes and `gap` px between them and at the
 * edges across. With `ratio` (the center item's along ÷ across length) the
 * center item is placed too:
 *
 * - its size is `size` of the largest that fits at its own shape;
 * - when the parts of the lanes before and after it would be thinner than
 *   MIN_PART of the length, it takes the whole length (at its own shape if
 *   that fits across, else cropped);
 * - lanes beside it are at least half a normal lane thick: a little less room
 *   than that and it grows to the edges, more and it shrinks to leave it;
 * - the lanes beside it and the lanes in its band are as close to the normal
 *   thickness as their room allows.
 *
 * Every point of the wall is in one lane or the center, apart from the gaps. */
export function feedLanes(across: number, along: number, n: number, gap: number, ratio: number | null, size: number): { lanes: LaneBox[]; center: { start: number; thick: number; at: number; len: number } | null } {
  const g = gap;
  n = Math.max(1, n);
  const t = Math.max(40, (across - g * (n + 1)) / n);
  if (!ratio) return { lanes: Array.from({ length: n }, (_, i) => ({ start: g + i * (t + g), cross: t, from: 0, span: along })), center: null };
  const inner = across - 2 * g;
  // the largest at its own shape, then the size asked for
  let thick = Math.min(inner, along / ratio) * size;
  let len = thick * ratio;
  if ((along - len) / 2 - g < MIN_PART * along) {
    len = along;
    thick = Math.min(inner, along / ratio);
  }
  let side = (inner - thick) / 2 - g;
  if (side < 0.15 * t) thick = inner;
  else if (side < 0.5 * t) {
    thick = inner - 2 * (0.5 * t + g);
    if (len < along) len = thick * ratio;
  }
  // never the whole wall
  if (thick >= inner && len >= along) thick = inner - 2 * (0.5 * t + g);
  side = thick >= inner ? 0 : (inner - thick) / 2 - g;
  const cStart = (across - thick) / 2;
  const at = (along - len) / 2;
  const lanes: LaneBox[] = [];
  const split = (from: number, room: number, each: (start: number, cross: number) => void) => {
    if (room <= 0) return;
    const k = Math.max(1, Math.round((room + g) / (t + g)));
    const c = (room - g * (k - 1)) / k;
    for (let j = 0; j < k; j++) each(from + j * (c + g), c);
  };
  split(g, side, (start, cross) => lanes.push({ start, cross, from: 0, span: along }));
  if (len < along)
    split(cStart, thick, (start, cross) => {
      lanes.push({ start, cross, from: 0, span: at - g });
      lanes.push({ start, cross, from: at + len + g, span: along - at - len - g });
    });
  split(cStart + thick + g, side, (start, cross) => lanes.push({ start, cross, from: 0, span: along }));
  return { lanes, center: { start: cStart, thick, at, len } };
}

export class FeedController {
  lanes = $state.raw<Lane[]>([]);
  paused = false;
  readonly axis: "x" | "y";
  readonly reverse: boolean;
  /** where the center item is, when there is one */
  center: Rect | null = null;
  private raf = 0;
  private last = 0;
  private keySeq = 1;
  private alive = true;

  constructor(
    private queue: MediaQueue,
    private s: Settings,
    mode: "ribbon" | "cascade",
    private count: number,
    private view: { w: number; h: number },
    /** the center item, when the center is on */
    private centerMedia: Media | null = null,
  ) {
    this.axis = mode === "ribbon" ? "x" : "y";
    // Ribbon "left" and Cascade "up" are the natural directions (items enter
    // at the right / bottom edge); the others mirror placement
    this.reverse = mode === "ribbon" ? s.ribbonDir === "right" : s.cascadeDir === "down";
    queue.onScreen = () => new Set(this.lanes.flatMap((l) => l.items.map((i) => i.media.path)));
  }

  private get along(): number {
    return this.axis === "x" ? this.view.w : this.view.h;
  }

  private get across(): number {
    return this.axis === "x" ? this.view.h : this.view.w;
  }

  /** `seed`: a resumed session's lanes, by lane index. Each lane starts with
   * its saved items in saved order (files that are gone left out), as far
   * into the first one as it was, and fills on from the queue. */
  build(seed?: { into: number; items: (Media | null)[] }[]) {
    const n = Math.max(1, this.count);
    const factorOf = (i: number) => (this.s.stagger && n > 1 ? 1 + (i % 2 === 0 ? -0.06 : 0.06) * (1 + (i % 3) * 0.3) : 1);
    const aspect = this.centerMedia?.aspect;
    // the center's length along the lanes for one pixel across them
    const ratio = aspect ? (this.axis === "x" ? aspect : 1 / aspect) : null;
    const { lanes, center } = feedLanes(this.across, this.along, n, this.s.gap, ratio, this.s.centerSize);
    this.center = center
      ? this.axis === "x"
        ? { x: center.at, y: center.start, w: center.len, h: center.thick }
        : { x: center.start, y: center.at, w: center.thick, h: center.len }
      : null;
    this.lanes = lanes.map((l, i) => new Lane(i, l.start, l.cross, factorOf(i), l.from, l.span));
    for (const lane of this.lanes) {
      const saved = seed?.[lane.index];
      const items = saved?.items.filter((m): m is Media => !!m) ?? [];
      if (items.length) {
        for (const m of items) this.push(lane, m);
        lane.offset = lane.items[0].len * Math.max(0, Math.min(0.95, saved!.into || 0));
        this.fill(lane);
        continue;
      }
      this.fill(lane);
      // start each lane part-way into its first item so edges are staggered
      const first = lane.items[0];
      if (first && this.lanes.length > 1) lane.offset = first.len * ((lane.index * 0.37) % 1);
      this.fill(lane);
    }
  }

  private length(m: Media, cross: number): number {
    const raw = this.axis === "x" ? cross * m.aspect : cross / m.aspect;
    return Math.max(cross * 0.35, Math.min(raw, this.along * 0.92));
  }

  private append(lane: Lane): boolean {
    const m = this.queue.take(0);
    if (!m) return false;
    this.push(lane, m);
    return true;
  }

  /** `m` at the end of the lane */
  private push(lane: Lane, m: Media) {
    const len = this.length(m, lane.cross);
    const pos = lane.tail;
    const place = this.reverse ? lane.span - pos - len : pos;
    lane.items = [...lane.items, { key: this.keySeq++, media: m, pos, len, place }];
    lane.tail = pos + len + this.s.gap;
  }

  /** keep the lane filled to its length and a half ahead */
  private fill(lane: Lane) {
    let guard = 0;
    while (lane.tail - lane.offset < lane.span * 1.5 && guard++ < 24) {
      if (!this.append(lane)) {
        this.queue.pump();
        break;
      }
    }
  }

  private place(lane: Lane) {
    if (!lane.strip) return;
    const d = this.reverse ? lane.offset : -lane.offset;
    lane.strip.style.transform = this.axis === "x" ? `translate3d(${d}px,0,0)` : `translate3d(0,${d}px,0)`;
  }

  start() {
    this.last = performance.now();
    const frame = (t: number) => {
      if (!this.alive) return;
      const dt = Math.min(0.1, (t - this.last) / 1000);
      this.last = t;
      this.tick(dt);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private tick(dt: number) {
    const ease = 1 - Math.exp(-dt / 0.28);
    for (const lane of this.lanes) {
      const target = this.paused || (lane.hover && this.s.hoverPause) ? 0 : 1;
      lane.mul += (target - lane.mul) * ease;
      if (Math.abs(target - lane.mul) < 0.001) lane.mul = target;
      lane.offset += this.s.speed * lane.factor * lane.mul * dt;
      this.place(lane);
      if (lane.tail - lane.offset < lane.span * 1.5) this.fill(lane);
      const gone = lane.items.findIndex((i) => i.pos + i.len >= lane.offset - 80);
      if (gone > 0) lane.items = lane.items.slice(gone);
    }
  }

  /** Take every item showing `path` out of the lanes. The items behind it
   * slide back to close the gap (FeedTile animates `left`/`top`). */
  remove(path: string) {
    for (const lane of this.lanes) {
      if (!lane.items.some((i) => i.media.path === path)) continue;
      let shift = 0;
      const kept: FeedItem[] = [];
      for (const it of lane.items) {
        if (it.media.path === path) {
          shift += it.len + this.s.gap;
          continue;
        }
        if (!shift) {
          kept.push(it);
          continue;
        }
        const pos = it.pos - shift;
        kept.push({ ...it, pos, place: this.reverse ? lane.span - pos - it.len : pos });
      }
      lane.items = kept;
      lane.tail -= shift;
      this.fill(lane);
    }
  }

  /** the item keys currently in view, for playing only what can be seen */
  visible(lane: Lane, item: FeedItem): boolean {
    return item.pos < lane.offset + lane.span + 40 && item.pos + item.len > lane.offset - 40;
  }

  destroy() {
    this.alive = false;
    cancelAnimationFrame(this.raf);
  }
}
