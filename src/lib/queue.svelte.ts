// The shuffled supply of media for a wall.
//
// Every item is measured before it is offered (aspect ratio is what the
// layouts work from), and measuring doubles as the playability check: a file
// the webview cannot decode fails here and never reaches the wall. Items whose
// size was cached by an earlier run skip the measurement.
import { api, mediaUrl, type DimRecord, type Kind, type MediaEntry } from "./api";
import type { ShapeFilter, TypeFilter } from "./settings.svelte";

export interface Media {
  key: number;
  path: string;
  name: string;
  kind: Kind;
  url: string;
  w: number;
  h: number;
  aspect: number;
  dur: number | null;
  /** times passed over for a better-fitting item */
  skips: number;
}

/** A queued item passed over this often is placed next, fit or not. */
const MAX_SKIPS = 6;
const PROBE_TIMEOUT = 12000;

function baseName(path: string): string {
  const clean = path.split(/[?#]/)[0];
  return decodeURIComponent(clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1));
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Dims = { w: number; h: number; dur: number | null };

function probe(entry: MediaEntry, url: string): Promise<Dims | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (d: Dims | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(d);
    };
    const timer = setTimeout(() => done(null), PROBE_TIMEOUT);
    if (entry.kind === "image") {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      img.decode().then(
        () => done(img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight, dur: null } : null),
        () => done(null),
      );
    } else {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      const release = () => {
        v.removeAttribute("src");
        v.load();
      };
      v.onloadedmetadata = () => {
        const d = v.videoWidth > 0 ? { w: v.videoWidth, h: v.videoHeight, dur: Number.isFinite(v.duration) ? v.duration : null } : null;
        release();
        done(d);
      };
      v.onerror = () => {
        release();
        done(null);
      };
      v.src = url;
    }
  });
}

let extraKey = -1;

/** One file as a Media outside any queue (Centre mode's middle item):
 * measured if its size is not known yet. Its key is negative, so it can
 * never collide with a queue's keys. Null when it cannot be played. */
export async function measureEntry(entry: MediaEntry): Promise<Media | null> {
  const url = mediaUrl(entry.path);
  const dims: Dims | null = entry.w && entry.h ? { w: entry.w, h: entry.h, dur: entry.dur } : await probe(entry, url);
  if (!dims) return null;
  if (!entry.w || !entry.h) api.rememberDims([{ path: entry.path, size: entry.size, mtime: entry.mtime, w: dims.w, h: dims.h, dur: dims.dur }]).catch(() => {});
  return { key: extraKey--, path: entry.path, name: baseName(entry.path), kind: entry.kind, url, w: dims.w, h: dims.h, aspect: dims.w / dims.h, dur: dims.dur, skips: 0 };
}

export class MediaQueue {
  /** measured and ready, in play order */
  ready: Media[] = [];
  unplayable = $state(0);
  readyCount = $state(0);
  /** set when every item has been tried and none could be played */
  empty = $state(false);
  readonly total: number;

  private pool: MediaEntry[];
  private order: number[] = [];
  private cursor = 0;
  private inflight = 0;
  private target = 18;
  private keySeq = 1;
  private failStreak = 0;
  /** entries passed over in a row because they were already on the wall */
  private screenSkips = 0;
  private waiters: (() => void)[] = [];
  private learned: DimRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval>;
  /** paths currently on the wall, so small libraries avoid showing one file twice */
  onScreen: () => Set<string> = () => new Set();
  /** a path that is not offered while it is set (Centre's middle item) */
  private held: string | null = null;

  constructor(
    entries: MediaEntry[],
    private type: TypeFilter,
    private shape: ShapeFilter,
    private doShuffle: boolean,
  ) {
    this.pool = entries.filter((e) => type === "mixed" || (type === "images" ? e.kind === "image" : e.kind === "video"));
    // with cached dimensions the shape filter applies before anything loads
    if (shape !== "any") this.pool = this.pool.filter((e) => !e.w || !e.h || this.shapeOk(e.w, e.h));
    this.total = this.pool.length;
    this.reorder();
    this.flushTimer = setInterval(() => this.flush(), 4000);
    this.pump();
  }

  private shapeOk(w: number, h: number): boolean {
    return this.shape === "any" || (this.shape === "portrait" ? h > w : w >= h);
  }

  private reorder() {
    this.order = this.pool.map((_, i) => i);
    if (this.doShuffle) shuffle(this.order);
    this.cursor = 0;
  }

  private nextEntry(): MediaEntry | null {
    if (!this.pool.length) return null;
    if (this.cursor >= this.order.length) this.reorder();
    return this.pool[this.order[this.cursor++]];
  }

  pump() {
    while (!this.empty && this.inflight < 4 && this.ready.length + this.inflight < this.target) {
      const entry = this.nextEntry();
      if (!entry) {
        this.empty = true;
        return;
      }
      this.inflight++;
      this.measure(entry).finally(() => {
        this.inflight--;
        this.pump();
      });
    }
  }

  private async measure(entry: MediaEntry) {
    // Skip files already on the wall, unless a whole pass found every one
    // there (a feed can hold more items than the folder has). Without that
    // limit, skip -> finally -> pump is a microtask loop that never yields.
    if (this.pool.length > 24 && this.screenSkips < this.pool.length && this.onScreen().has(entry.path)) {
      this.screenSkips++;
      return;
    }
    this.screenSkips = 0;
    const url = mediaUrl(entry.path);
    let dims: Dims | null = entry.w && entry.h ? { w: entry.w, h: entry.h, dur: entry.dur } : null;
    if (!dims) {
      dims = await probe(entry, url);
      if (dims) {
        entry.w = dims.w;
        entry.h = dims.h;
        entry.dur = dims.dur;
        this.learned.push({ path: entry.path, size: entry.size, mtime: entry.mtime, w: dims.w, h: dims.h, dur: dims.dur });
      }
    }
    if (!dims) {
      this.unplayable++;
      // every item in the pool failed in a row: nothing here can play
      if (++this.failStreak >= this.pool.length) this.empty = true;
      return;
    }
    this.failStreak = 0;
    if (!this.shapeOk(dims.w, dims.h)) return;
    // excluded while it was being measured, or held back
    if (!this.pool.includes(entry) || entry.path === this.held) return;
    this.ready.push({
      key: this.keySeq++,
      path: entry.path,
      name: baseName(entry.path),
      kind: entry.kind,
      url,
      w: dims.w,
      h: dims.h,
      aspect: dims.w / dims.h,
      dur: dims.dur,
      skips: 0,
    });
    this.readyCount = this.ready.length;
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  /** Up to `k` ready items, in order, to choose from. An item passed over
   * too often comes back alone, so it is placed whatever its shape, unless
   * `fair` is false (the tile being watched only ever gets a good fit). */
  peek(k: number, fair = true): Media[] {
    if (fair && this.ready[0] && this.ready[0].skips >= MAX_SKIPS) return [this.ready[0]];
    return this.ready.slice(0, k);
  }

  /** Remove the item at `i` of the last peek; the ones before it count a skip. */
  take(i: number): Media | null {
    const m = this.ready.splice(i, 1)[0] ?? null;
    for (let j = 0; j < Math.min(i, this.ready.length); j++) this.ready[j].skips++;
    this.readyCount = this.ready.length;
    this.pump();
    return m;
  }

  /** Resolves once `n` items are ready, or after `timeout` ms, or when empty. */
  wait(n = 1, timeout = 8000): Promise<void> {
    if (this.ready.length >= n || this.empty) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeout);
      const check = () => {
        if (this.ready.length >= n || this.empty) {
          clearTimeout(t);
          resolve();
        } else this.waiters.push(check);
      };
      this.waiters.push(check);
      this.pump();
    });
  }

  /** Take a file out of this wall's supply ("remove from wall", "never show
   * again"). What is on screen is the wall's to replace. */
  exclude(path: string) {
    const i = this.pool.findIndex((e) => e.path === path);
    if (i < 0) return;
    this.pool.splice(i, 1);
    this.ready = this.ready.filter((m) => m.path !== path);
    this.readyCount = this.ready.length;
    this.reorder();
    this.pump();
  }

  /** Keep one file out of the supply while it is shown some other way
   * (Centre's middle item); null lets it back in. */
  hold(path: string | null) {
    this.held = path;
    if (!path) return;
    this.ready = this.ready.filter((m) => m.path !== path);
    this.readyCount = this.ready.length;
    this.pump();
  }

  /** Report measurements to Rust so the next run starts with them known. */
  flush() {
    if (!this.learned.length) return;
    const batch = this.learned;
    this.learned = [];
    api.rememberDims(batch).catch(() => {});
  }

  destroy() {
    clearInterval(this.flushTimer);
    this.flush();
    this.waiters.forEach((f) => f());
    this.waiters = [];
  }
}
