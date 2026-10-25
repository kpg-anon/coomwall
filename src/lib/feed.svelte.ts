// Ribbon and Cascade: lanes of media that travel across the screen at a
// constant speed. Ribbon lanes are rows moving left or right; Cascade lanes
// are columns moving up or down. Every item keeps its own aspect ratio along
// the lane, so nothing is cropped except panoramas longer than the screen.
//
// Per frame only one transform per lane changes (translate3d on the strip
// that holds its items), so the compositor moves the whole lane without
// layout or paint. Items are appended ahead of the visible edge and dropped
// once they have left it.
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
  /** distance travelled */
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
  ) {}
}

export class FeedController {
  lanes = $state.raw<Lane[]>([]);
  paused = false;
  readonly axis: "x" | "y";
  readonly reverse: boolean;
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

  build() {
    const g = this.s.gap;
    const n = Math.max(1, this.count);
    const cross = Math.max(40, (this.across - g * (n + 1)) / n);
    this.lanes = Array.from({ length: n }, (_, i) => {
      // alternate slightly faster and slower lanes so seams never line up
      const factor = this.s.stagger && n > 1 ? 1 + (i % 2 === 0 ? -0.06 : 0.06) * (1 + (i % 3) * 0.3) : 1;
      return new Lane(i, g + i * (cross + g), cross, factor);
    });
    for (const lane of this.lanes) {
      this.fill(lane);
      // start each lane part-way into its first item so edges are staggered
      const first = lane.items[0];
      if (first && n > 1) lane.offset = first.len * ((lane.index * 0.37) % 1);
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
    const len = this.length(m, lane.cross);
    const pos = lane.tail;
    const place = this.reverse ? this.along - pos - len : pos;
    lane.items = [...lane.items, { key: this.keySeq++, media: m, pos, len, place }];
    lane.tail = pos + len + this.s.gap;
    return true;
  }

  /** keep the lane filled to one screen and a half ahead */
  private fill(lane: Lane) {
    let guard = 0;
    while (lane.tail - lane.offset < this.along * 1.5 && guard++ < 24) {
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
      if (lane.tail - lane.offset < this.along * 1.5) this.fill(lane);
      const gone = lane.items.findIndex((i) => i.pos + i.len >= lane.offset - 80);
      if (gone > 0) lane.items = lane.items.slice(gone);
    }
  }

  /** the item keys currently in view, for playing only what can be seen */
  visible(lane: Lane, item: FeedItem): boolean {
    return item.pos < lane.offset + this.along + 40 && item.pos + item.len > lane.offset - 40;
  }

  destroy() {
    this.alive = false;
    cancelAnimationFrame(this.raf);
  }
}
