// Every choice on the setup screen, persisted by Rust as settings.json in the
// app config dir. Anything missing from the file takes its default, so adding
// a setting never breaks an existing install.
import { api } from "./api";

export type Mode = "mosaic" | "ribbon" | "cascade" | "dynamic" | "grid" | "stack";
/** Stack: the panes side by side (row) or one above the next (column); auto
 * takes whichever shows the item larger */
export type StackDir = "auto" | "row" | "column";
/** Stack: items from the sources one after another, or one file or link looping */
export type StackSource = "queue" | "one";
/** Stack, a page link: play its streams straight from the site, or download it first */
export type LinkMode = "stream" | "download";
/** yt-dlp reads this browser's cookies for links that need a login; "" none */
export type Cookies = "" | "firefox" | "chrome" | "edge" | "brave";
/** what [ ] do to the playback speed: step through rateList, or move by 0.05 */
export type RateKeys = "list" | "fine";
/** how closely an item must fit a Grid cell with "only media that fits":
 * exact shape, up to 12% cut off, or automatic (exact on a 16:9 screen,
 * where 16:9 media fits a 3×3 grid exactly; up to 12% on other screens) */
export type GridFitCrop = "auto" | "exact" | "loose";
export type TypeFilter = "mixed" | "videos" | "images";
export type ShapeFilter = "any" | "portrait" | "landscape";
/** the order files play in: random, newest first (by file date), or as the folders list them */
export type Order = "shuffle" | "newest" | "folder";
/** which videos on the wall play with sound: the ones picked with M; those
 * and the one under the pointer; every video; only the video that appeared
 * last (on any wall) */
export type SoundMode = "picked" | "pointer" | "all" | "newest";
/** auto: Windows decides (the power-saving GPU for WebView2) */
export type GpuChoice = "auto" | "high" | "low";
/** direct: color values go to the display as they are in the file, as mpv
 * and most viewers do. managed: converted to the display's color profile. */
export type ColorChoice = "direct" | "managed";
/** Grid: cells merged into one tile, in cell units from the top left */
export interface GridSpan {
  c: number;
  r: number;
  w: number;
  h: number;
}

export interface Settings {
  sources: string[];
  recursive: boolean;
  mode: Mode;
  /** Mosaic and Dynamic: tiles on screen */
  tiles: number;
  /** Dynamic: seconds between new items (each one re-lays out the wall) */
  dynamicSeconds: number;
  /** Dynamic: how much larger the newest items are than the rest. 0 = all
   * tiles alike, 1 = the newest is about 4.5 times an old one. */
  dynamicFocus: number;
  /** Grid: columns and rows of equal cells */
  gridCols: number;
  gridRows: number;
  /** Grid: cells merged into larger tiles */
  gridSpans: GridSpan[];
  /** Grid: fill each cell (cropping what does not fit) or show items whole */
  gridFit: "cover" | "contain";
  /** Grid: only items whose shape fits the cells (see gridFitCrop) */
  gridOnlyFits: boolean;
  /** how close "only media that fits" must be (a preference, shared) */
  gridFitCrop: GridFitCrop;
  /** one item plays in the middle of the wall, in any mode. Mosaic and
   * Dynamic lay their tiles out around it; Ribbon, Cascade and Grid run
   * behind it. */
  centered: boolean;
  /** the file in the middle; "" until one is chosen */
  center: string;
  /** its size, as a share of the largest size that fits the wall */
  centerSize: number;
  /** Stack: how many copies of the item, side by side */
  stackPanes: number;
  stackDir: StackDir;
  /** Stack: each pane turned this many degrees clockwise (0, 90, 270) */
  stackTurn: number;
  /** Stack: each pane filled (cropping), else the item whole */
  stackFill: boolean;
  stackSource: StackSource;
  /** Stack, "one": a file path or a link (yt-dlp) */
  stackItem: string;
  stackLinkMode: LinkMode;
  /** yt-dlp: the browser whose cookies it may read */
  ytdlCookies: Cookies;
  /** look for a newer release on GitHub when the app starts */
  autoUpdateCheck: boolean;
  /** Ribbon: rows */
  rows: number;
  /** Cascade: columns */
  columns: number;
  /** Ribbon: the direction media travels */
  ribbonDir: "left" | "right";
  /** Cascade: the direction media travels */
  cascadeDir: "up" | "down";
  /** feed travel speed, px per second */
  speed: number;
  /** feed lanes run at slightly different speeds so edges never line up */
  stagger: boolean;
  /** a feed lane eases to a stop under the pointer */
  hoverPause: boolean;
  /** Mosaic: the tile under the pointer never moves and holds its item */
  hoverHold: boolean;
  /** the wall pauses while one item is open whole (F, double-click) */
  pauseBehindViewer: boolean;
  /** the wall pauses while another window has focus */
  pauseUnfocused: boolean;
  type: TypeFilter;
  shape: ShapeFilter;
  /** files whose shorter side is smaller than this many pixels are skipped; 0 = any */
  minSide: number;
  order: Order;
  /** seconds an image stays up (Mosaic) */
  imageSeconds: number;
  /** videos longer than this many seconds are skipped, in every mode; 0 = no limit */
  maxVideoSeconds: number;
  /** clips shorter than this loop until it has passed (Mosaic) */
  minVideoSeconds: number;
  rate: number;
  /** [ ] step through rateList (list) or by 0.05 (fine) */
  rateKeys: RateKeys;
  /** the speeds [ ] step through, fastest first */
  rateList: number[];
  /** 0-100 */
  volume: number;
  /** px between tiles */
  gap: number;
  /** seconds the HUD and pointer stay up after the pointer stops */
  hudSeconds: number;
  /** the wall never shows its top and bottom bars; messages, ? and the pointer still do */
  hideBars: boolean;
  /** the viewer (F) never shows its top bar (name, tools) or its key list */
  hideViewerBars: boolean;
  /** the viewer (F) never shows a video's controls (play, seek, time, sound) */
  hideViewerControls: boolean;
  /** Mosaic: weight of motion against crop. Higher = calmer. */
  stillness: number;
  /** Mosaic: largest share of any media that may be cropped */
  maxCrop: number;
  sound: SoundMode;
  /** monitor name to go fullscreen on; "" = the one the window is on */
  monitor: string;
  /** read by Rust at launch (src-tauri/src/gpu.rs); a change needs a restart */
  gpu: GpuChoice;
  /** read by Rust at launch (src-tauri/src/lib.rs); a change needs a restart */
  color: ColorChoice;
  /** the wall stays above every other window */
  alwaysOnTop: boolean;
  /** the wall starts in a normal window instead of fullscreen; F11 switches a running wall */
  windowed: boolean;
  theme: string;
  /** a wall on each display that is on in `walls`, instead of one wall */
  multiWall: boolean;
  /** per display (keyed by monitor name), for multiWall */
  walls: Record<string, WallLayout>;
}

/** What each display's wall chooses for itself; everything else is shared. */
export const LAYOUT_KEYS = [
  "mode",
  "tiles",
  "rows",
  "columns",
  "ribbonDir",
  "cascadeDir",
  "speed",
  "stillness",
  "dynamicSeconds",
  "dynamicFocus",
  "gridCols",
  "gridRows",
  "gridSpans",
  "gridFit",
  "gridOnlyFits",
  "centered",
  "center",
  "centerSize",
  "stackPanes",
  "stackDir",
  "stackTurn",
  "stackFill",
  "stackSource",
  "stackItem",
  "stackLinkMode",
  "type",
  "shape",
  "minSide",
] as const;
export type Layout = Pick<Settings, (typeof LAYOUT_KEYS)[number]>;
/** `sources`: this display's own folders and playlists. Missing or empty,
 * the display plays the shared sources. */
export type WallLayout = Layout & { on: boolean; sources?: string[] };

/** A copy of the layout keys of `from` (arrays copied, not shared). */
export function layoutOf(from: Layout): Layout {
  return Object.fromEntries(LAYOUT_KEYS.map((k) => [k, Array.isArray(from[k]) ? JSON.parse(JSON.stringify(from[k])) : from[k]])) as unknown as Layout;
}

/** A layout from a saved wall, over `base`: a key the save does not have
 * (it was made before that setting existed) keeps base's value instead of
 * becoming undefined. */
export function savedLayout(saved: Partial<Layout> | null | undefined, base: Layout): Layout {
  const out = layoutOf(base);
  for (const k of LAYOUT_KEYS) {
    const v = saved?.[k];
    if (v !== undefined && v !== null) (out as any)[k] = Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v;
  }
  return out;
}

export const DEFAULTS: Settings = {
  sources: [],
  recursive: true,
  mode: "mosaic",
  tiles: 7,
  dynamicSeconds: 3,
  dynamicFocus: 0.6,
  gridCols: 3,
  gridRows: 1,
  gridSpans: [],
  gridFit: "cover",
  gridOnlyFits: false,
  gridFitCrop: "auto",
  centered: false,
  center: "",
  centerSize: 0.7,
  stackPanes: 3,
  stackDir: "auto",
  stackTurn: 0,
  stackFill: true,
  stackSource: "one",
  stackItem: "",
  stackLinkMode: "stream",
  ytdlCookies: "",
  autoUpdateCheck: true,
  rows: 2,
  columns: 4,
  ribbonDir: "left",
  cascadeDir: "up",
  speed: 70,
  stagger: true,
  hoverPause: true,
  hoverHold: true,
  pauseBehindViewer: true,
  pauseUnfocused: false,
  type: "mixed",
  shape: "any",
  minSide: 0,
  order: "shuffle",
  imageSeconds: 7,
  maxVideoSeconds: 0,
  minVideoSeconds: 6,
  rate: 1,
  rateKeys: "list",
  rateList: [1, 0.8, 0.5, 0.4],
  volume: 60,
  gap: 4,
  hudSeconds: 2.2,
  hideBars: false,
  hideViewerBars: false,
  hideViewerControls: false,
  stillness: 1.2,
  maxCrop: 0.3,
  sound: "picked",
  monitor: "",
  gpu: "auto",
  color: "direct",
  alwaysOnTop: false,
  windowed: false,
  theme: "comfy-dark",
  multiWall: false,
  walls: {},
};

export const LIMITS = {
  tiles: [1, 16],
  rows: [1, 6],
  columns: [1, 10],
  gridCols: [1, 8],
  gridRows: [1, 6],
  stackPanes: [1, 6],
} as const;

export type CountKey = keyof typeof LIMITS;

export const MODE_NAMES: Record<Mode, string> = {
  mosaic: "Mosaic",
  ribbon: "Ribbon",
  cascade: "Cascade",
  dynamic: "Dynamic",
  grid: "Grid",
  stack: "Stack",
};

/** Before 1.0 Center was a mode of its own, with its own tile count. It is
 * now Mosaic with the center on. */
function migrate(o: any) {
  if (!o || typeof o !== "object") return;
  if (o.mode === "center") {
    o.mode = "mosaic";
    o.centered = true;
    if (typeof o.centerTiles === "number") o.tiles = o.centerTiles;
  }
  delete o.centerTiles;
  // before 1.0 the order was a Shuffle checkbox
  if (o.order === undefined && typeof o.shuffle === "boolean") o.order = o.shuffle ? "shuffle" : "folder";
  delete o.shuffle;
  // before 1.0.4 sound was two checkboxes; "every video" won over the pointer
  if (o.sound === undefined && (typeof o.audioAll === "boolean" || typeof o.audioFollowsMouse === "boolean")) {
    o.sound = o.audioAll ? "all" : o.audioFollowsMouse ? "pointer" : "picked";
  }
  delete o.audioAll;
  delete o.audioFollowsMouse;
  // in 1.0.2 hideViewerBars also hid the video controls
  if (o.hideViewerBars === true && o.hideViewerControls === undefined) o.hideViewerControls = true;
}

/** A speed list as typed in setup: positive numbers, fastest first, no repeats. */
export function parseRates(text: string): number[] {
  const out = text
    .split(/[\s,;]+/)
    .map((p) => Number(p.replace(/x$/i, "")))
    .filter((n) => Number.isFinite(n) && n >= 0.1 && n <= 4)
    .map((n) => Math.round(n * 100) / 100);
  return [...new Set(out)].sort((a, b) => b - a);
}

/** The next speed from `rate`: one step slower (dir -1) or faster (+1) in
 * `list`, round to the other end past the last. */
export function cycleRate(rate: number, list: number[], dir: 1 | -1): number {
  if (!list.length) return rate;
  const asc = [...list].sort((a, b) => a - b);
  if (dir < 0) {
    const below = asc.filter((r) => r < rate - 0.001);
    return below.length ? below[below.length - 1] : asc[asc.length - 1];
  }
  const above = asc.filter((r) => r > rate + 0.001);
  return above.length ? above[0] : asc[0];
}

class SettingsStore {
  s = $state<Settings>({ ...DEFAULTS, gridSpans: [], rateList: [...DEFAULTS.rateList], walls: {} });
  loaded = $state(false);
  /** in a wall window: the display it fills. Its layout is saved under walls[wall]. */
  private wall: string | null = null;
  /** in a wall window with its own folders: the shared sources they replaced in `s` */
  private shared: string[] | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** the shared sources, also in a wall window that plays its own folders */
  sharedSources(): string[] {
    return [...(this.shared ?? this.s.sources)];
  }

  /** this wall plays its display's own folders */
  get ownSources(): boolean {
    return this.shared !== null;
  }

  async load() {
    try {
      const v = await api.getSettings();
      // assign into the existing object: components hold `settings.s` from
      // before the load finished, and must keep seeing the live one
      if (v && typeof v === "object") {
        const o = v as any;
        migrate(o);
        for (const w of Object.values(o.walls ?? {})) migrate(w);
        Object.assign(this.s, { ...DEFAULTS, gridSpans: [], rateList: [...DEFAULTS.rateList], walls: {}, ...(o as Partial<Settings>) });
      }
    } catch (e) {
      console.warn("settings: could not load", e);
    }
    this.applyTheme();
    this.loaded = true;
  }

  /** A wall window: play by this display's layout, and save only that. */
  useWall(monitor: string) {
    this.wall = monitor;
    const l = this.s.walls[monitor];
    if (!l) return;
    // entries saved before a key existed lack it; those keep the shared value
    for (const k of LAYOUT_KEYS) if (l[k] !== undefined) (this.s as any)[k] = l[k];
    // this display's own folders, if it has any. Not saved back from here:
    // a wall window writes only its layout (see write)
    if (l.sources?.length) {
      this.shared = [...this.s.sources];
      this.s.sources = [...l.sources];
    }
  }

  /** The wall moved to another display (walls.rs swapped the saved layouts). */
  movedTo(monitor: string) {
    if (this.wall) this.wall = monitor;
    else this.s.monitor = monitor;
  }

  applyTheme() {
    document.documentElement.dataset.theme = this.s.theme;
    try {
      localStorage.setItem("coomwall-theme", this.s.theme);
    } catch {}
  }

  saveSoon() {
    if (!this.loaded) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.write().catch((e) => console.warn("settings: could not save", e)), 400);
  }

  /** write now, e.g. before wall windows read the file */
  saveNow(): Promise<void> {
    clearTimeout(this.timer);
    return this.write();
  }

  private write(): Promise<void> {
    if (!this.wall) return api.setSettings($state.snapshot(this.s));
    // a wall changes its own layout (1-6, + -, arrows, D, C), the playback
    // rate ([ ]) and whether walls stay on top (T); other walls and setup
    // keep everything else
    const s = $state.snapshot(this.s);
    return api.patchSettings({ rate: s.rate, alwaysOnTop: s.alwaysOnTop, walls: { [this.wall]: { ...layoutOf(s), on: true } } });
  }

  /** the count control for the current mode */
  countKey(mode: Mode = this.s.mode): CountKey {
    if (mode === "ribbon") return "rows";
    if (mode === "cascade") return "columns";
    if (mode === "grid") return "gridCols";
    if (mode === "stack") return "stackPanes";
    return "tiles";
  }
}

export const settings = new SettingsStore();
