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
import { fetchLink, heightFor, needsDownload, progressText, resolveLink } from "./links";
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

export class StackController {
  /** what the panes show */
  item = $state.raw<Media | null>(null);
  pan = $state<Pan | undefined>(undefined);
  /** it loops and N, the end of a video and the image time do not replace it */
  pinned = $state(false);
  status = $state("");
  /** a link being downloaded: what yt-dlp is doing */
  progress = $state("");
  hovered = false;
  /** the wall is showing one file or link (stackSource "one") */
  readonly one: boolean;

  private back: Media[] = [];
  private fwd: Media[] = [];
  private alive = true;
  private busy = false;

  constructor(
    private queue: MediaQueue,
    private s: Settings,
    private view: { w: number; h: number },
  ) {
    this.one = s.stackSource === "one" && !!s.stackItem.trim();
    queue.onScreen = () => new Set(this.item ? [this.item.path] : []);
  }

  geometry(m: Media | null = this.item, view = this.view): (StackGeometry & { score: number }) | null {
    if (!m) return null;
    return stackLayout(view, this.s.stackPanes, turnedAspect(m.aspect, this.s.stackTurn), this.s.stackDir, this.s.stackFill, this.s.gap);
  }

  resize(view: { w: number; h: number }) {
    this.view = view;
  }

  /** the first item: a seed's, the one file or link, or the queue's */
  async start(seed?: StackSeed) {
    try {
      let m: Media | null = seed?.media ?? null;
      if (!m && seed?.path) m = await this.load(seed.path);
      if (m && seed?.time) m = { ...m, start: seed.time };
      if (!m && this.one) {
        m = await this.load(this.s.stackItem.trim());
        if (!m && this.alive) this.status ||= "This file could not be played.";
      }
      if (!m && !this.one) m = await this.pick();
      if (!this.alive || !m) return;
      this.show(m);
      this.pan = seed?.pan;
      this.pinned = !!seed?.pinned;
    } catch (e) {
      if (this.alive) this.status = String(e instanceof Error ? e.message : e);
    }
  }

  /** A file or link as a Media. A link to a page is streamed from the site
   * (yt-dlp finds the stream URLs) or downloaded first, as set. */
  private async load(path: string): Promise<Media | null> {
    let file = path;
    // a pane's smaller side: n panes share the screen's longer side
    const { w, h } = this.view;
    const height = heightFor(Math.min(w, h, Math.max(w, h) / Math.max(1, this.s.stackPanes)));
    if (needsDownload(path) && this.s.stackLinkMode === "stream") {
      this.status = "Finding the streams with yt-dlp";
      const r = await resolveLink(path, height, this.s.ytdlCookies);
      this.status = "";
      if (!r.width || !r.height) {
        // a stream yt-dlp does not know the size of: measured as it loads
        const probe = await measureEntry({ path: r.video, kind: "video", size: 0, mtime: 0, w: null, h: null, dur: null });
        return probe ? remoteMedia(path, r.title || path, r.video, r.audio, probe.w, probe.h, r.duration) : null;
      }
      return remoteMedia(path, r.title || path, r.video, r.audio, r.width, r.height, r.live ? null : r.duration);
    }
    if (needsDownload(path)) {
      this.status = "Downloading with yt-dlp";
      this.progress = progressText(null);
      file = await fetchLink(path, height, this.s.ytdlCookies, (p) => (this.progress = progressText(p)));
      this.progress = "";
      this.status = "";
    }
    const entry = library.items.find((e) => e.path === file) ?? (await api.scan([file], false)).items[0];
    return entry ? measureEntry(entry) : null;
  }

  /** Of the next queued items, the one that fills the screen best; passing
   * over an item costs a little, so the order mostly holds. */
  private async pick(fair = true): Promise<Media | null> {
    let cands = this.queue.peek(10, fair);
    if (!cands.length) {
      await this.queue.wait(1, 8000);
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
    this.item = m;
    this.pan = undefined;
    this.status = "";
  }

  /** the item ended (a video, or an image's time) */
  done() {
    if (!this.alive || this.pinned || this.one) return;
    this.next();
  }

  /** N: the next item (after B, forward again first). False with nothing to go to. */
  async next(): Promise<boolean> {
    if (this.one || this.busy) return false;
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

  /** a file left the wall */
  forget(path: string) {
    this.back = this.back.filter((m) => m.path !== path);
    this.fwd = this.fwd.filter((m) => m.path !== path);
    if (this.item?.path === path) {
      this.pinned = false;
      if (!this.one) this.next();
    }
  }

  destroy() {
    this.alive = false;
  }
}
