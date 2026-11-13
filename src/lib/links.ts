// Links for Stack mode. A link straight to a media file plays as it is; any
// other page goes through yt-dlp (src-tauri/src/ytdl.rs), which downloads it
// once into the app's cache, and plays from there.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isUrl } from "./api";
import type { Cookies } from "./settings.svelte";

const DIRECT = /\.(mp4|m4v|webm|mov|mkv|ogv|jpe?g|jfif|png|webp|gif|avif|bmp)([?#].*)?$/i;

/** a page that needs yt-dlp, not a link to a media file */
export function needsDownload(path: string): boolean {
  return isUrl(path) && !DIRECT.test(path);
}

export interface LinkProgress {
  part: number;
  downloaded: number | null;
  total: number | null;
  speed: number | null;
}

interface LinkEvent extends Partial<LinkProgress> {
  url: string;
  kind: "progress" | "done" | "error";
  path?: string;
  error?: string;
}

/** The resolution worth fetching for panes whose smaller side is `side` CSS
 * px: the next common one at or above it in device pixels. yt-dlp's `res`
 * is a video's smaller side too, so a portrait video is matched by width. */
export function heightFor(side: number): number {
  const px = side * (window.devicePixelRatio || 1);
  return [480, 720, 1080, 1440, 2160].find((h) => h >= px * 0.9) ?? 2160;
}

/** The local file for `url`, downloading it first if it is not cached.
 * `onprogress` follows the download. */
export async function fetchLink(url: string, height: number, cookies: Cookies, onprogress?: (p: LinkProgress) => void): Promise<string> {
  let settle: { ok: (p: string) => void; fail: (e: Error) => void } | null = null;
  const result = new Promise<string>((ok, fail) => (settle = { ok, fail: (e) => fail(e) }));
  // listening before asking: a download that finishes quickly is not missed
  const off = await listen<LinkEvent>("link", (e) => {
    const d = e.payload;
    if (d.url !== url) return;
    if (d.kind === "progress") onprogress?.({ part: d.part ?? 1, downloaded: d.downloaded ?? null, total: d.total ?? null, speed: d.speed ?? null });
    else if (d.kind === "done" && d.path) settle?.ok(d.path);
    else if (d.kind === "error") settle?.fail(new Error(d.error ?? "the download failed"));
  });
  try {
    const cached = await invoke<string | null>("fetch_link", { url, height, cookies });
    if (cached) return cached;
    return await result;
  } finally {
    off();
  }
}

export interface Resolved {
  video: string;
  audio: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  title: string;
  live: boolean;
}

/** a link's stream URLs, from yt-dlp, without downloading anything */
export function resolveLink(url: string, height: number, cookies: Cookies): Promise<Resolved> {
  return invoke<Resolved>("resolve_link", { url, height, cookies });
}

const MB = 1024 * 1024;

/** "video 34% · 12.3 of 36.0 MB · 4.1 MB/s" */
export function progressText(p: LinkProgress | null): string {
  if (!p) return "asking yt-dlp…";
  const what = p.part > 1 ? "audio" : "video";
  const pct = p.downloaded != null && p.total ? ` ${Math.round((p.downloaded / p.total) * 100)}%` : "";
  const size = p.downloaded != null ? ` · ${(p.downloaded / MB).toFixed(1)}${p.total ? ` of ${(p.total / MB).toFixed(1)}` : ""} MB` : "";
  const speed = p.speed ? ` · ${(p.speed / MB).toFixed(1)} MB/s` : "";
  return `${what}${pct}${size}${speed}`;
}
