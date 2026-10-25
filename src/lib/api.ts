// Typed wrappers over the Rust commands in src-tauri/src/commands.rs.
import { invoke, convertFileSrc } from "@tauri-apps/api/core";

export type Kind = "image" | "video";

export interface MediaEntry {
  path: string;
  kind: Kind;
  size: number;
  mtime: number;
  w: number | null;
  h: number | null;
  dur: number | null;
}

export interface ScanReport {
  items: MediaEntry[];
  images: number;
  videos: number;
  known: number;
  /** left out because they are on the "never show again" list */
  hidden: number;
  errors: string[];
  millis: number;
}

export interface DimRecord {
  path: string;
  size: number;
  mtime: number;
  w: number;
  h: number;
  dur: number | null;
}

export interface Adapter {
  name: string;
  vendorId: number;
  luid: string;
}

export interface GpuInfo {
  preference: string;
  /** the adapter this launch renders on; null when Windows picked */
  chosen: Adapter | null;
  high: Adapter | null;
  low: Adapter | null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Tree =
  | { k: "leaf"; id: number }
  | { k: "row"; f: number; a: Tree; b: Tree }
  | { k: "col"; f: number; a: Tree; b: Tree };

export interface Placed {
  id: number;
  rect: Rect;
}

export interface Plan {
  tree: Tree;
  rects: Placed[];
  kind: "swap" | "region" | "global";
  choice: number;
  region: Rect | null;
  cost: number;
  moved: number;
  worstCrop: number;
}

export interface Params {
  stillness: number;
  maxCrop: number;
  frozen: number[];
  fresh: number[];
  inPlaceOnly: boolean;
  allowGlobal: boolean;
  skipCost: number;
}

/** tile id -> aspect ratio of what it is showing */
export type MediaMap = Record<number, number>;

export function isUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

/** URL for an <img>/<video>: our Range-capable `cw` scheme for local files. */
export function mediaUrl(path: string): string {
  return isUrl(path) ? path : convertFileSrc(path, "cw");
}

export const api = {
  scan: (sources: string[], recursive: boolean) =>
    invoke<ScanReport>("scan_sources", { sources, recursive }),
  rememberDims: (records: DimRecord[]) => invoke<number>("remember_dims", { records }),

  planInitial: (items: { id: number; aspect: number }[], bounds: Rect, params: Params) =>
    invoke<Plan | null>("plan_initial", { items, bounds, params }),
  planReplace: (a: { tree: Tree; bounds: Rect; leaf: number; media: MediaMap; candidates: number[]; params: Params }) =>
    invoke<Plan | null>("plan_replace", a),
  planInsert: (a: { tree: Tree | null; bounds: Rect; newId: number; aspect: number; media: MediaMap; params: Params }) =>
    invoke<Plan | null>("plan_insert", a),
  planRemove: (a: { tree: Tree; bounds: Rect; leaf: number | null; media: MediaMap; params: Params }) =>
    invoke<Plan | null>("plan_remove", a),
  planRetile: (a: { tree: Tree; bounds: Rect; media: MediaMap; params: Params }) =>
    invoke<Plan | null>("plan_retile", a),
  planReflow: (a: { tree: Tree; bounds: Rect; leaf: number; aspect: number; media: MediaMap; params: Params }) =>
    invoke<Plan | null>("plan_reflow", a),
  planLayout: (tree: Tree, bounds: Rect) => invoke<Placed[]>("plan_layout", { tree, bounds }),

  getSettings: () => invoke<unknown>("get_settings"),
  setSettings: (value: unknown) => invoke<void>("set_settings", { value }),
  /** merge part of the settings into the file (RFC 7396) */
  patchSettings: (patch: unknown) => invoke<void>("patch_settings", { patch }),
  /** one fullscreen wall per named display; hides the setup window */
  openWalls: (monitors: string[]) => invoke<number>("open_walls", { monitors }),
  closeWalls: () => invoke<void>("close_walls"),
  /** move the calling window's wall to the display on that side (swapping with a wall there) */
  moveWall: (dir: "left" | "right" | "up" | "down") => invoke<{ label: string; monitor: string }[]>("move_wall", { dir }),

  getHidden: () => invoke<string[]>("get_hidden"),
  /** "never show again"; returns how many are hidden */
  hideItem: (path: string) => invoke<number>("hide_item", { path }),
  unhideItems: (paths: string[]) => invoke<number>("unhide_items", { paths }),
  gpuInfo: () => invoke<GpuInfo>("gpu_info"),
  restart: () => invoke<void>("restart"),
};
