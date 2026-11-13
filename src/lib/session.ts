// Saved walls, to resume later (stored by src-tauri/src/sessions.rs in
// sessions.json). A session is what every wall of one run showed: `last` is
// written by each running wall every 10 s and as it closes, named ones by
// Ctrl+S. Each wall's snapshot keeps its layout settings and its items by
// path, with the video times, sound, pins and pans; Mosaic and Dynamic also
// keep their layout tree, so the same arrangement comes back.
import type { Rect, Tree } from "./api";
import type { Layout, Mode } from "./settings.svelte";

/** The visible part of an item in a tile: object-position in percent on each
 * axis, and `z`, how far it is zoomed in (1 or absent: not zoomed). */
export type Pan = { x: number; y: number; z?: number };

export interface SavedItem {
  path: string;
  /** seconds into the video; 0 for an image */
  time: number;
  sound: boolean;
}

export interface SavedTile extends SavedItem {
  /** the tile's id in the layout tree (Mosaic, Dynamic) */
  id: number;
  pinned: boolean;
  pan?: Pan;
  /** ms since its item arrived (Dynamic replaces the oldest first) */
  age: number;
}

export interface SavedLane {
  /** how far the lane had moved into its first item, as a share of that item */
  into: number;
  items: SavedItem[];
}

/** A drawing of a wall as it was saved, for the list in setup: the window's
 * size and each piece as [x, y, w, h, flags] in its px. Flags: 1 image
 * (else video), 2 pinned, 4 the centered media. */
export interface Thumb {
  w: number;
  h: number;
  items: [number, number, number, number, number][];
}

export interface WallSnapshot {
  mode: Mode;
  /** items on the wall, for the list in setup */
  count: number;
  /** single wall: the display setting it ran with; multi: its display (set by Rust) */
  monitor: string;
  layout: Layout;
  /** the sources this wall played */
  sources: string[];
  /** multi: the display had its own folders (`sources` are those) */
  own: boolean;
  /** the area the tiles were laid out in */
  bounds: Rect;
  /** Mosaic, Dynamic, Grid: in the controller's order (Grid: cell order), the center left out */
  tiles?: SavedTile[];
  /** Mosaic, Dynamic */
  tree?: Tree | null;
  /** the center tile's id in `tree` */
  centerId?: number | null;
  /** Ribbon, Cascade */
  lanes?: SavedLane[];
  /** the center item (its file is `layout.center`) */
  center?: (SavedItem & { pan?: Pan }) | null;
  /** Stack: its item, zoom and pan, pin */
  stack?: (SavedItem & { pan?: Pan; pinned?: boolean }) | null;
  thumb?: Thumb;
  /** added by Rust on resume: shown on the wall as it starts */
  note?: string;
}

export interface Session {
  name: string;
  savedAt: number;
  run: number;
  multi: boolean;
  /** the shared sources */
  sources: string[];
  recursive: boolean;
  /** by display; "" for the single wall */
  walls: Record<string, WallSnapshot>;
}

/** a session as setup lists it */
export interface SessionInfo {
  name: string;
  savedAt: number;
  multi: boolean;
  walls: { monitor: string; mode: string; count: number; layout: Layout | null; sources: string[] | null; own: boolean; thumb: Thumb | null }[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-12 14:03": the name Ctrl+S suggests, and how setup shows a time */
export function stamp(ms: number = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
