// The shuffled supply of media for a wall.
//
// Every item is measured before it is offered (aspect ratio is what the
// layouts work from), and measuring doubles as the playability check: a file
// the webview cannot decode fails here and never reaches the wall. Items whose
// size was cached by an earlier run skip the measurement.
import { api, mediaUrl, type DimRecord, type Kind, type MediaEntry } from "./api";
import type { Order, ShapeFilter, TypeFilter } from "./settings.svelte";
import { needsDownload } from "./links";

/** A page link in a playlist (reddit, YouTube...), as yt-dlp resolves it to
 * streams the page can play; null when it has none. */
export type LinkResolver = (url: string) => Promise<{ video: string; audio: string | null; w: number; h: number; dur: number | null; title: string } | null>;

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
  /** a video from a resumed session: seconds to start at (MediaView seeks once) */
  start?: number;
  /** a streamed link whose sound is a separate stream (YouTube above 360p) */
  audioUrl?: string;
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

/** One file as a Media outside any queue (Center mode's middle item):
 * measured if its size is not known yet. Its key is negative, so it can
 * never collide with a queue's keys. Null when it cannot be played. */
export async function measureEntry(entry: MediaEntry): Promise<Media | null> {
  const url = mediaUrl(entry.path);
  const dims: Dims | null = entry.w && entry.h ? { w: entry.w, h: entry.h, dur: entry.dur } : await probe(entry, url);
  if (!dims) return null;
  // a stream URL (a link played from the site) changes every time: not worth remembering
  if ((!entry.w || !entry.h) && !/^https?:/i.test(entry.path)) api.rememberDims([{ path: entry.path, size: entry.size, mtime: entry.mtime, w: dims.w, h: dims.h, dur: dims.dur }]).catch(() => {});
  return { key: extraKey--, path: entry.path, name: baseName(entry.path), kind: entry.kind, url, w: dims.w, h: dims.h, aspect: dims.w / dims.h, dur: dims.dur, skips: 0 };
}

/** A link played straight from the site's streams (links.ts resolveLink).
 * `path` stays the page link, so a saved wall resolves it again. */
export function remoteMedia(path: string, name: string, video: string, audio: string | null, w: number, h: number, dur: number | null): Media {
  return { key: extraKey--, path, name, kind: "video", url: video, audioUrl: audio ?? undefined, w, h, aspect: w / h, dur, skips: 0 };
}

export class MediaQueue {
  /** measured and ready, in play order */
  ready: Media[] = [];
  unplayable = $state(0);
  readyCount = $state(0);
  /** set when every item has been tried and none could be played */
  empty = $state(false);
  /** set when two passes of the folder found nothing `accept` takes, and
   * nothing was taken since it was set: no file fits at all */
  noneFit = $state(false);
  /** files of the wrong shape or too long, taken out of the pool */
  leftOut = $state(0);
  readonly total: number;

  private pool: MediaEntry[];
  private order: number[] = [];
  private cursor = 0;
  private inflight = 0;
  private target = 18;
  private keySeq = 1;
  private failStreak = 0;
  /** entries in a row that gave nothing: already on the wall, or not
   * taken by `accept` */
  private dry = 0;
  /** pumping stopped after two dry passes; a take or a new filter starts it */
  private starved = false;
  /** `accept` has taken something since it was set */
  private fitAny = false;
  private waiters: (() => void)[] = [];
  private learned: DimRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval>;
  /** paths currently on the wall, so small libraries avoid showing one file twice */
  onScreen: () => Set<string> = () => new Set();
  /** a path that is not offered while it is set (Center's middle item) */
  private held: string | null = null;
  /** only items of these shapes are offered (Grid's "only media that fits") */
  private accept: ((aspect: number) => boolean) | null = null;

  constructor(
    entries: MediaEntry[],
    private type: TypeFilter,
    private shape: ShapeFilter,
    private ordering: Order,
    /** videos longer than this many seconds are never offered; 0 = no limit */
    private maxVideo = 0,
    /** files whose shorter side is smaller than this are never offered; 0 = any */
    private minSide = 0,
    /** page links in playlists play through this (yt-dlp); without it they are skipped as unplayable */
    private links: LinkResolver | null = null,
  ) {
    this.pool = entries.filter((e) => type === "mixed" || (type === "images" ? e.kind === "image" : e.kind === "video"));
    const typed = this.pool.length;
    // with cached dimensions the shape and size filters apply before anything loads
    if (shape !== "any" || minSide > 0) this.pool = this.pool.filter((e) => !e.w || !e.h || this.shapeOk(e.w, e.h));
    // and so does the length limit, with a cached duration
    if (maxVideo > 0) this.pool = this.pool.filter((e) => this.lengthOk(e.kind, e.dur));
    this.leftOut = typed - this.pool.length;
    this.total = this.pool.length;
    this.reorder();
    this.flushTimer = setInterval(() => this.flush(), 4000);
    this.pump();
  }

  private shapeOk(w: number, h: number): boolean {
    if (this.minSide > 0 && Math.min(w, h) < this.minSide) return false;
    return this.shape === "any" || (this.shape === "portrait" ? h > w : w >= h);
  }

  /** The file's own duration, not adjusted for playback speed. Unknown passes. */
  private lengthOk(kind: Kind, dur: number | null): boolean {
    return this.maxVideo <= 0 || kind !== "video" || dur == null || dur <= this.maxVideo;
  }

  /** Take an entry out of the pool for good, keeping the pass in progress:
   * `order` holds pool indices, so the ones above it shift down. */
  private drop(entry: MediaEntry) {
    const i = this.pool.indexOf(entry);
    // already gone (measured twice at once in a small pool, or excluded)
    if (i < 0) return;
    this.pool.splice(i, 1);
    this.leftOut++;
    const k = this.order.indexOf(i);
    if (k >= 0) {
      this.order.splice(k, 1);
      if (k < this.cursor) this.cursor--;
    }
    for (let j = 0; j < this.order.length; j++) if (this.order[j] > i) this.order[j]--;
    if (!this.pool.length) this.setEmpty();
  }

  /** Nothing left to offer: say so and release everyone waiting. */
  private setEmpty() {
    this.empty = true;
    this.wake();
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  private reorder() {
    this.order = this.pool.map((_, i) => i);
    if (this.ordering === "shuffle") shuffle(this.order);
    // newest first by the file's date; links (no date) after the files
    else if (this.ordering === "newest") this.order.sort((a, b) => (this.pool[b].mtime || 0) - (this.pool[a].mtime || 0));
    this.cursor = 0;
  }

  private nextEntry(): MediaEntry | null {
    if (!this.pool.length) return null;
    if (this.cursor >= this.order.length) this.reorder();
    return this.pool[this.order[this.cursor++]];
  }

  pump() {
    while (!this.empty && !this.starved && this.inflight < 4 && this.ready.length + this.inflight < this.target) {
      const entry = this.nextEntry();
      if (!entry) {
        this.setEmpty();
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
    // Skip files already on the wall, unless a whole pass gave nothing new
    // (a feed can hold more items than the folder has; with a shape filter
    // only a few files may fit, and then they repeat). Without that limit,
    // skip -> finally -> pump is a microtask loop that never yields.
    if (this.pool.length > 24 && this.dry < this.pool.length && this.onScreen().has(entry.path)) {
      this.dry++;
      return;
    }
    let url = mediaUrl(entry.path);
    let audioUrl: string | undefined;
    let title: string | undefined;
    let dims: Dims | null = entry.w && entry.h ? { w: entry.w, h: entry.h, dur: entry.dur } : null;
    if (needsDownload(entry.path)) {
      // a page link: its streams, found by yt-dlp each time (they expire)
      const r = this.links ? await this.links(entry.path).catch(() => null) : null;
      dims = r ? { w: r.w, h: r.h, dur: r.dur } : null;
      if (r) {
        url = r.video;
        audioUrl = r.audio ?? undefined;
        title = r.title || undefined;
      }
    } else if (!dims) {
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
      if (++this.failStreak >= this.pool.length) this.setEmpty();
      return;
    }
    this.failStreak = 0;
    // Wrong shape or too long: never offered, so it leaves the pool. Its
    // dimensions are now on the entry, so leaving it in would reject it again
    // without awaiting anything, and a pool of only such entries would make
    // skip -> finally -> pump a microtask loop that never yields.
    if (!this.shapeOk(dims.w, dims.h) || !this.lengthOk(entry.kind, dims.dur)) {
      this.drop(entry);
      return;
    }
    if (this.accept && !this.accept(dims.w / dims.h)) {
      // two passes with nothing taken (the second one allows repeats): stop,
      // or this would go round for ever
      if (++this.dry >= 2 * this.pool.length) {
        this.starved = true;
        this.noneFit = !this.fitAny;
        this.wake();
      }
      return;
    }
    // Held back (Center's middle item). This also returns without awaiting
    // when the dimensions are cached, so a pool with nothing else in it would
    // loop the same way: two passes of it and pumping stops until hold()
    // changes or something is taken.
    if (entry.path === this.held) {
      if (++this.dry >= 2 * this.pool.length) {
        this.starved = true;
        this.wake();
      }
      return;
    }
    this.dry = 0;
    this.fitAny = true;
    // excluded while it was being measured
    if (!this.pool.includes(entry)) return;
    this.ready.push({
      key: this.keySeq++,
      path: entry.path,
      name: title ?? baseName(entry.path),
      kind: entry.kind,
      url,
      audioUrl,
      w: dims.w,
      h: dims.h,
      aspect: dims.w / dims.h,
      dur: dims.dur,
      skips: 0,
    });
    this.readyCount = this.ready.length;
    this.wake();
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
    // what is on the wall changed: a file that was skipped may be offered now
    this.starved = false;
    this.dry = 0;
    this.pump();
    return m;
  }

  /** `m` again (a tile going back through what it showed), under a new key:
   * the tile may still hold a layer with the old one. */
  again(m: Media): Media {
    return { ...m, key: this.keySeq++, skips: 0, start: undefined };
  }

  /** Items of a resumed session back on the wall, by path, in order: each
   * as a Media under a new key of this queue, or null when the file is not
   * in this wall's supply (gone, hidden, left out by Show, Shape or the
   * video length limit) or cannot be played. Claimed files leave `ready`,
   * so the queue does not offer them again at once. */
  async claim(paths: string[]): Promise<(Media | null)[]> {
    const byPath = new Map(this.pool.map((e) => [e.path, e]));
    const dims = await Promise.all(
      paths.map(async (path): Promise<Dims | null> => {
        const entry = byPath.get(path);
        if (!entry) return null;
        if (entry.w && entry.h) return { w: entry.w, h: entry.h, dur: entry.dur };
        const d = await probe(entry, mediaUrl(path));
        if (d && !entry.w) {
          entry.w = d.w;
          entry.h = d.h;
          entry.dur = d.dur;
          this.learned.push({ path, size: entry.size, mtime: entry.mtime, w: d.w, h: d.h, dur: d.dur });
        }
        return d;
      }),
    );
    const out = paths.map((path, i): Media | null => {
      const entry = byPath.get(path);
      const d = dims[i];
      // excluded while it was measured
      if (!entry || !d || !this.pool.includes(entry)) return null;
      // the shape and length filters apply as in measure(); an uncached
      // file of the wrong shape leaves the pool here
      if (!this.shapeOk(d.w, d.h) || !this.lengthOk(entry.kind, d.dur)) {
        this.drop(entry);
        return null;
      }
      return { key: this.keySeq++, path, name: baseName(path), kind: entry.kind, url: mediaUrl(path), w: d.w, h: d.h, aspect: d.w / d.h, dur: d.dur, skips: 0 };
    });
    const taken = new Set(out.filter((m) => m).map((m) => m!.path));
    this.ready = this.ready.filter((m) => !taken.has(m.path));
    this.readyCount = this.ready.length;
    this.pump();
    return out;
  }

  /** Resolves once `n` items are ready, or after `timeout` ms, or when empty. */
  wait(n = 1, timeout = 8000): Promise<void> {
    if (this.ready.length >= n || this.empty || this.noneFit) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeout);
      const check = () => {
        if (this.ready.length >= n || this.empty || this.noneFit) {
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

  /** Offer only items whose shape `f` takes (Grid's "only media that
   * fits"), or any shape (null). Items already ready that do not fit go. */
  setAccept(f: ((aspect: number) => boolean) | null) {
    this.accept = f;
    this.dry = 0;
    this.starved = false;
    this.fitAny = false;
    this.noneFit = false;
    if (f) {
      this.ready = this.ready.filter((m) => f(m.aspect));
      this.readyCount = this.ready.length;
    }
    this.pump();
  }

  /** Keep one file out of the supply while it is shown some other way
   * (Center's middle item); null lets it back in. */
  hold(path: string | null) {
    this.held = path;
    // a file that was held back may be offered now
    this.starved = false;
    this.dry = 0;
    if (path) {
      this.ready = this.ready.filter((m) => m.path !== path);
      this.readyCount = this.ready.length;
    }
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
