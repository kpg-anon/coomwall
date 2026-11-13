// Stack: one item shown several times side by side (a row) or one above the
// next (a column), like `coomplexer stack`. Every pane is the same item at
// the same moment: StackView decodes it once and draws each pane from that
// one decoder.
//
// The item comes from the sources, one after another (a video plays to its
// end, an image stays for the image time), or is one file or link that loops
// (stackSource "one"). A link to a page is downloaded with yt-dlp first
// (links.ts). Of the next few queued items, the one that fills the screen
// best is taken, as Grid and Mosaic do.
import { api, type Rect } from "./api";
import { library } from "./library.svelte";
import { fetchLink, heightFor, needsDownload, resolveLink } from "./links";
import { measureEntry, remoteMedia, type Media, type MediaQueue } from "./queue.svelte";
import type { Pan } from "./session";
import type { Settings, StackDir } from "./settings.svelte";

export interface StackGeometry {
  dir: "row" | "column";
  panes: Rect[];
}

/** the item's shape after turning it `turn` degrees */
export function turnedAspect(aspect: number, turn: number): number {
  return turn % 180 === 90 ? 1 / aspect : aspect;
}

/** Where the panes go on a `view` of w x h. Shown whole, each pane has the
 * item's (turned) shape and the stack is as large as fits, in the middle;
 * filled, the panes share the screen and crop. Auto takes the direction
 * that shows the item larger (whole) or crops it less (filled). */
export function stackLayout(view: { w: number; h: number }, n: number, aspect: number, dir: StackDir, fill: boolean, gap: number): StackGeometry & { score: number } {
  const W = view.w;
  const H = view.h;
  const make = (d: "row" | "column") => {
    const panes: Rect[] = [];
    let pw: number;
    let ph: number;
    if (fill) {
      pw = d === "row" ? (W - (n - 1) * gap) / n : W;
      ph = d === "row" ? H : (H - (n - 1) * gap) / n;
    } else if (d === "row") {
      ph = Math.min(H, (W - (n - 1) * gap) / (n * aspect));
      pw = ph * aspect;
    } else {
      pw = Math.min(W, ((H - (n - 1) * gap) * aspect) / n);
      ph = pw / aspect;
    }
    const total = d === "row" ? n * pw + (n - 1) * gap : n * ph + (n - 1) * gap;
    for (let i = 0; i < n; i++) {
      const along = (d === "row" ? (W - total) / 2 : (H - total) / 2) + i * ((d === "row" ? pw : ph) + gap);
      panes.push(d === "row" ? { x: along, y: (H - ph) / 2, w: pw, h: ph } : { x: (W - pw) / 2, y: along, w: pw, h: ph });
    }
    // larger is better: the share of the screen shown, or minus the crop
    const score = fill ? -Math.abs(Math.log(pw / ph / aspect)) : (n * pw * ph) / (W * H);
    return { dir: d, panes, score };
  };
  if (dir !== "auto") return make(dir);
  const row = make("row");
  const col = make("column");
  return col.score > row.score + 1e-6 ? col : row;
}

/** what a resumed or right-clicked stack starts with */
export interface StackSeed {
  media?: Media;
  path?: string;
  time?: number;
  pan?: Pan;
  pinned?: boolean;
}

const HISTORY = 20;
/** a new item that has not shown its first frame by then counts as failed */
export const LOAD_LIMIT_MS = 20000;

export class StackController {
  /** what the panes show */
  item = $state.raw<Media | null>(null);
  pan = $state<Pan | undefined>(undefined);
  /** the zoom and pan of the item before, kept while it fades out */
  outgoingPan: Pan | undefined = undefined;
  /** it loops and N, the end of a video and the image time do not replace it */
  pinned = $state(false);
  status = $state("");
  /** a link being fetched: what yt-dlp is doing */
  progress = $state("");
  hovered = false;
  /** the wall shows one file or link (stackSource "one"), looping */
  readonly one: boolean;

  private view = $state.raw<{ w: number; h: number }>({ w: 0, h: 0 });
  private back: Media[] = [];
  private fwd: Media[] = [];
  private alive = true;
  private busy = false;
  /** N asked for (or the item removed) while another change was being made */
  private again = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private noteTimer: ReturnType<typeof setTimeout> | undefined;
  /** when a stream was last fetched again after an error, so one that keeps failing is not fetched forever */
  private refetchedAt = -Infinity;

  constructor(
    private queue: MediaQueue,
    private s: Settings,
    view: { w: number; h: number },
    /** false: from the sources even when setup says one file or link ("Stack it") */
    one?: boolean,
  ) {
    this.view = view;
    this.one = one ?? (s.stackSource === "one" && !!s.stackItem.trim());
    queue.onScreen = () => new Set(this.item ? [this.item.path] : []);
  }

  geometry(m: Media | null = this.item, view = this.view): (StackGeometry & { score: number }) | null {
    if (!m) return null;
    return stackLayout(view, this.s.stackPanes, turnedAspect(m.aspect, this.s.stackTurn), this.s.stackDir, this.s.stackFill, this.s.gap);
  }

  resize(view: { w: number; h: number }) {
    this.view = view;
  }

  /** The first item: a seed's, the one file or link, or the queue's. A
   * seed's pan and pin go only with the seed's own item; when that file is
   * gone the wall says so. */
  async start(seed?: StackSeed) {
    try {
      let m: Media | null = seed?.media ?? null;
      if (!m && seed?.path) {
        m = await this.load(seed.path).catch(() => null);
        if (!m && this.alive) this.note("The saved item is no longer available; another took its place.");
      }
      if (m && seed?.time) m = { ...m, start: seed.time };
      const fromSeed = !!m;
      if (!m && this.one) {
        m = await this.load(this.s.stackItem.trim());
        if (!m && this.alive) this.status ||= "This file could not be played.";
      }
      if (!m && !this.one) m = await this.pick();
      if (!this.alive) return;
      if (!m) {
        if (!this.one) this.waitForItems();
        return;
      }
      this.show(m);
      if (fromSeed) {
        this.pan = seed?.pan;
        this.pinned = !!seed?.pinned;
      }
    } catch (e) {
      if (this.alive) {
        this.status = errorText(e);
        this.progress = "";
      }
    }
  }

  /** a passing message in the status line */
  private note(text: string) {
    this.status = text;
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      if (this.status === text) this.status = "";
    }, 5000);
  }

  /** From the sources and nothing came yet: try again until something does. */
  private waitForItems() {
    clearTimeout(this.retry);
    if (!this.alive) return;
    this.status = this.queue.empty ? "Nothing in these sources could be played." : "Still loading…";
    this.retry = setTimeout(async () => {
      if (!this.alive || this.item) return;
      const m = await this.pick();
      if (!this.alive) return;
      if (m) this.show(m);
      else this.waitForItems();
    }, 1500);
  }

  /** A file or link as a Media. A link to a page is streamed from the site
   * (yt-dlp finds the stream URLs) or downloaded first, as set. */
  private async load(path: string, start?: number): Promise<Media | null> {
    let file = path;
    // a pane's smaller side: n panes share the screen's longer side
    const { w, h } = this.view;
    const height = heightFor(Math.min(w, h, Math.max(w, h) / Math.max(1, this.s.stackPanes)));
    try {
      if (needsDownload(path) && this.s.stackLinkMode === "stream") {
        this.status = "Finding the streams with yt-dlp";
        const r = await resolveLink(path, height, this.s.ytdlCookies);
        this.status = "";
        let m: Media | null;
        if (!r.width || !r.height) {
          // a stream yt-dlp does not know the size of: measured as it loads
          const probe = await measureEntry({ path: r.video, kind: "video", size: 0, mtime: 0, w: null, h: null, dur: null });
          m = probe ? remoteMedia(path, r.title || path, r.video, r.audio, probe.w, probe.h, r.duration) : null;
        } else m = remoteMedia(path, r.title || path, r.video, r.audio, r.width, r.height, r.duration);
        return m && start ? { ...m, start } : m;
      }
      if (needsDownload(path)) {
        this.status = "Downloading with yt-dlp";
        this.progress = "finding the video";
        file = await fetchLink(path, height, this.s.ytdlCookies, (text) => (this.progress = text));
        this.status = "";
      }
    } finally {
      this.progress = "";
    }
    const entry = library.items.find((e) => e.path === file) ?? (await api.scan([file], false)).items[0];
    const m = entry ? await measureEntry(entry) : null;
    return m && start ? { ...m, start } : m;
  }

  /** Of the next queued items, the one that fills the screen best; passing
   * over an item costs a little, so the order mostly holds. */
  private async pick(fair = true): Promise<Media | null> {
    let cands = this.queue.peek(10, fair);
    if (!cands.length) {
      await this.queue.wait(1, 8000);
      if (!this.alive) return null;
      cands = this.queue.peek(10, fair);
    }
    if (!cands.length) return null;
    let best = 0;
    let bestScore = -Infinity;
    cands.forEach((c, i) => {
      const score = (this.geometry(c)?.score ?? 0) - 0.04 * i;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    return this.queue.take(best);
  }

  private show(m: Media) {
    clearTimeout(this.retry);
    this.outgoingPan = this.pan && { ...this.pan };
    this.item = m;
    this.pan = undefined;
    this.status = "";
  }

  /** the item ended (a video, or an image's time) */
  done() {
    if (!this.alive || this.pinned || this.one) return;
    this.next().then((ok) => {
      // the queue had nothing yet: try again rather than stay on the last frame
      if (!ok && this.alive && !this.one && !this.busy) setTimeout(() => this.done(), 2000);
    });
  }

  /** The item could not be played (`why`), or stopped (an expired stream:
   * `at` is where it was). A stream is fetched again, at most once a
   * minute; from the sources the next item comes; otherwise the wall says why. */
  async failed(m: Media, why: string, at = 0) {
    if (!this.alive || m.key !== this.item?.key) return;
    const now = performance.now();
    if (needsDownload(m.path) && this.s.stackLinkMode === "stream" && now - this.refetchedAt > 60000) {
      this.refetchedAt = now;
      try {
        this.status = "The stream stopped; asking yt-dlp for a fresh one";
        const fresh = await this.load(m.path, at || undefined);
        if (fresh && this.alive && this.item?.key === m.key) {
          const pan = this.pan;
          this.show(fresh);
          this.pan = pan;
          return;
        }
      } catch (e) {
        if (this.alive) this.status = errorText(e);
        return;
      }
    }
    if (!this.one && !this.pinned) {
      this.note(`${m.name} could not be played: ${why}`);
      this.next();
      return;
    }
    this.status = `${m.name} could not be played: ${why}`;
  }

  /** N: the next item (after B, forward again first). False with nothing to go to. */
  async next(): Promise<boolean> {
    if (this.one) return false;
    if (this.busy) {
      this.again = true;
      return false;
    }
    this.busy = true;
    try {
      const h = this.fwd.pop();
      const m = h ? this.queue.again(h) : await this.pick();
      if (!m || !this.alive) return false;
      if (this.item) this.back.push(this.item);
      if (this.back.length > HISTORY) this.back.shift();
      this.pinned = false;
      this.show(m);
      return true;
    } finally {
      this.busy = false;
      if (this.again && this.alive) {
        this.again = false;
        this.next();
      }
    }
  }

  /** B: the item before */
  prev(): boolean {
    const h = this.back.pop();
    if (!h) return false;
    if (this.item) this.fwd.push(this.item);
    this.pinned = false;
    this.show(this.queue.again(h));
    return true;
  }

  togglePin() {
    this.pinned = !this.pinned;
  }

  setPan(pan: Pan | undefined) {
    this.pan = pan;
  }

  /** A file left the wall. False when it is the one file or link the wall
   * is set to show, which stays. */
  forget(path: string): boolean {
    this.back = this.back.filter((m) => m.path !== path);
    this.fwd = this.fwd.filter((m) => m.path !== path);
    if (this.item?.path !== path) return true;
    if (this.one) return false;
    this.pinned = false;
    this.next();
    return true;
  }

  destroy() {
    this.alive = false;
    clearTimeout(this.retry);
    clearTimeout(this.noteTimer);
  }
}

function errorText(e: unknown): string {
  return String(e instanceof Error ? e.message : e);
}
