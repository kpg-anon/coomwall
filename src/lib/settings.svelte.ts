// Every choice on the setup screen, persisted by Rust as settings.json in the
// app config dir. Anything missing from the file takes its default, so adding
// a setting never breaks an existing install.
import { api } from "./api";

export type Mode = "mosaic" | "ribbon" | "cascade" | "dynamic";
export type TypeFilter = "mixed" | "videos" | "images";
export type ShapeFilter = "any" | "portrait" | "landscape";
/** auto: Windows decides (the power-saving GPU for WebView2) */
export type GpuChoice = "auto" | "high" | "low";

export interface Settings {
  sources: string[];
  recursive: boolean;
  mode: Mode;
  /** Mosaic and Dynamic: tiles on screen */
  tiles: number;
  /** Dynamic: seconds between new items (each one re-lays out the wall) */
  dynamicSeconds: number;
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
  shuffle: boolean;
  /** seconds an image stays up (Mosaic) */
  imageSeconds: number;
  /** cut videos after this many seconds; 0 plays them to the end (Mosaic) */
  maxVideoSeconds: number;
  /** clips shorter than this loop until it has passed (Mosaic) */
  minVideoSeconds: number;
  rate: number;
  /** 0-100 */
  volume: number;
  /** px between tiles */
  gap: number;
  /** seconds the HUD and pointer stay up after the pointer stops */
  hudSeconds: number;
  /** Mosaic: weight of motion against crop. Higher = calmer. */
  stillness: number;
  /** Mosaic: largest share of any media that may be cropped */
  maxCrop: number;
  /** the hovered video plays with sound */
  audioFollowsMouse: boolean;
  /** monitor name to go fullscreen on; "" = the one the window is on */
  monitor: string;
  /** read by Rust at launch (src-tauri/src/gpu.rs); a change needs a restart */
  gpu: GpuChoice;
  theme: string;
  /** a wall on each display that is on in `walls`, instead of one wall */
  multiWall: boolean;
  /** per display (keyed by monitor name), for multiWall */
  walls: Record<string, WallLayout>;
}

/** What each display's wall chooses for itself; everything else is shared. */
export const LAYOUT_KEYS = ["mode", "tiles", "rows", "columns", "ribbonDir", "cascadeDir", "speed", "stillness", "dynamicSeconds", "type", "shape"] as const;
export type Layout = Pick<Settings, (typeof LAYOUT_KEYS)[number]>;
export type WallLayout = Layout & { on: boolean };

export function layoutOf(from: Layout): Layout {
  return Object.fromEntries(LAYOUT_KEYS.map((k) => [k, from[k]])) as unknown as Layout;
}

export const DEFAULTS: Settings = {
  sources: [],
  recursive: true,
  mode: "mosaic",
  tiles: 7,
  dynamicSeconds: 3,
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
  shuffle: true,
  imageSeconds: 7,
  maxVideoSeconds: 0,
  minVideoSeconds: 6,
  rate: 1,
  volume: 60,
  gap: 4,
  hudSeconds: 2.2,
  stillness: 1.2,
  maxCrop: 0.3,
  audioFollowsMouse: false,
  monitor: "",
  gpu: "auto",
  theme: "comfy-dark",
  multiWall: false,
  walls: {},
};

export const LIMITS = {
  tiles: [1, 16],
  rows: [1, 6],
  columns: [1, 10],
} as const;

class SettingsStore {
  s = $state<Settings>({ ...DEFAULTS, walls: {} });
  loaded = $state(false);
  /** in a wall window: the display it fills. Its layout is saved under walls[wall]. */
  private wall: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  async load() {
    try {
      const v = await api.getSettings();
      // assign into the existing object: components hold `settings.s` from
      // before the load finished, and must keep seeing the live one
      if (v && typeof v === "object") Object.assign(this.s, { ...DEFAULTS, walls: {}, ...(v as Partial<Settings>) });
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
    // entries saved before a key existed lack it; those keep the shared value
    if (l) for (const k of LAYOUT_KEYS) if (l[k] !== undefined) (this.s as any)[k] = l[k];
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
    // a wall changes its own layout (1-4, + -, arrows, D) and the playback
    // rate ([ ]); other walls and setup keep everything else
    const s = $state.snapshot(this.s);
    return api.patchSettings({ rate: s.rate, walls: { [this.wall]: { ...layoutOf(s), on: true } } });
  }

  /** the count control for the current mode */
  countKey(mode: Mode = this.s.mode): "tiles" | "rows" | "columns" {
    return mode === "mosaic" || mode === "dynamic" ? "tiles" : mode === "ribbon" ? "rows" : "columns";
  }
}

export const settings = new SettingsStore();
