<script lang="ts">
  // The running wall: fullscreen on the chosen monitor, one of the five modes,
  // the HUD and every key. Switching mode (1-5) keeps the queue, so the
  // shuffle carries on where it was. With a wall on each display (multi),
  // this is one of several windows, already fullscreen on its display, and
  // walls.ts keeps pausing, Shift+M (all sound off), focus and removed files
  // in step with the others.
  // Ctrl+Shift+arrow moves the wall to the next display (walls.rs).
  // The wall saves itself into the `last` session every 10 s and as it
  // closes; Ctrl+S saves it under a name (session.ts). A wall started from a
  // saved session builds from its snapshot instead of from the queue.
  import { onMount } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { getCurrentWindow, availableMonitors } from "@tauri-apps/api/window";
  import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
  import { listen } from "@tauri-apps/api/event";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { api, isUrl, type GpuInfo, type Rect } from "$lib/api";
  import { settings, LIMITS, MODE_NAMES, cycleRate, layoutOf, type Layout, type Mode } from "$lib/settings.svelte";
  import { library } from "$lib/library.svelte";
  import { MediaQueue, measureEntry, type LinkResolver, type Media } from "$lib/queue.svelte";
  import { heightFor, resolveLink } from "$lib/links";
  import { MosaicController, type WallSeed } from "$lib/mosaic.svelte";
  import { stamp, type SavedItem, type Thumb, type WallSnapshot } from "$lib/session";
  import { I } from "$lib/icons";
  import { GridController } from "$lib/grid.svelte";
  import { gridLabel, validSpans } from "$lib/grid";
  import { FeedController } from "$lib/feed.svelte";
  import { StackController, type StackSeed } from "$lib/stack.svelte";
  import StackView from "./StackView.svelte";
  import MosaicView from "./MosaicView.svelte";
  import FeedView from "./FeedView.svelte";
  import Hud from "./Hud.svelte";
  import Viewer from "./Viewer.svelte";
  import CenterItem from "./CenterItem.svelte";
  import ContextMenu, { type MenuAction } from "./ContextMenu.svelte";
  import { linkWalls, wallMonitor, wallRun } from "$lib/walls";

  let { onexit, multi = false }: { onexit: () => void; multi?: boolean } = $props();

  const s = settings.s;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isFeed = (m: Mode) => m === "ribbon" || m === "cascade";
  /** keys that still reach the wall while one item is open in the viewer */
  const VIEWER_PASS = new Set(["m", "o", "[", "]", "{", "}", "?", "h", "t"]);

  // page links in playlists play through yt-dlp, two at a time at most
  let resolving = 0;
  const linkSlots: (() => void)[] = [];
  const resolveForQueue: LinkResolver = async (url) => {
    while (resolving >= 2) await new Promise<void>((r) => linkSlots.push(r));
    resolving++;
    try {
      const r = await resolveLink(url, heightFor(Math.min(window.innerWidth, window.innerHeight) / 2), s.ytdlCookies);
      return r.width && r.height ? { video: r.video, audio: r.audio, w: r.width, h: r.height, dur: r.duration, title: r.title } : null;
    } finally {
      resolving--;
      linkSlots.shift()?.();
    }
  };
  const queue = new MediaQueue(library.items, s.type, s.shape, s.order, s.maxVideoSeconds, s.minSide, resolveForQueue);
  let w = $state(0);
  let h = $state(0);
  let mode = $state<Mode>(s.mode);
  /** Mosaic and Dynamic (MosaicController) or Grid */
  let tiled = $state.raw<MosaicController | GridController | null>(null);
  let feed = $state.raw<FeedController | null>(null);
  let feedGen = $state(0);
  let stack = $state.raw<StackController | null>(null);
  /** Space: this wall. Shift+Space: every wall. */
  let paused = $state(false);
  let focused = $state(true);
  /** multi: whether any of the walls has focus */
  let focusedAny = $state(true);
  let hover = $state.raw<Media | null>(null);
  /** the items with sound (M toggles one, Shift+M clears all): Media.key to its path */
  const sounding = new SvelteMap<number, string>();
  /** the item open in the viewer, and where its tile's video was */
  let lightbox = $state.raw<{ media: Media; time: number } | null>(null);
  let viewer = $state<Viewer>();
  /** the center item, measured from `s.center`. Shown while `s.centered`. */
  let centerMedia = $state.raw<Media | null>(null);
  /** right-click menu, for the item under the pointer when it opened */
  let menu = $state.raw<{ media: Media; x: number; y: number } | null>(null);
  let hudVisible = $state(true);
  let help = $state(false);
  let debug = $state(false);
  let toast = $state("");
  let dropped = $state("0% dropped");
  /** set while many visible videos are stuck waiting for decoded frames */
  let stall = $state("");
  let gpu: GpuInfo | null = null;
  let hudTimer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ctrl+S: the name in the field over the wall, while it is open */
  let naming = $state<string | null>(null);
  /** the controller whose first build (or resume) has finished. The wall
   * saves into `last` only then: an empty or half-built wall must not
   * replace a good save. */
  let settledFor: object | null = null;
  /** this start of the wall; its saves into `last` replace the session
   * before it (sessions.rs). Every wall of one multi start shares it. */
  const run = wallRun ?? Date.now();
  let unmounted = false;

  const win = getCurrentWindow();
  // a window is a wall window for its whole life, so reading the prop once is right
  // svelte-ignore state_referenced_locally
  const link = multi
    ? linkWalls({
        pause: (p) => (paused = p),
        silence: () => sounding.clear(),
        focusAny: (f) => (focusedAny = f),
        remove: (path) => dropHere(path),
        onTop: (on) => {
          s.alwaysOnTop = on;
          applyOnTop();
        },
        save: (name, token) => saveNamedHere(name, token),
      })
    : null;
  /** the key this wall's snapshot is saved under: its display, "" for the single wall */
  // svelte-ignore state_referenced_locally
  let here = multi ? (wallMonitor ?? "") : "";

  function bounds(): Rect {
    const g = s.gap;
    return { x: g / 2, y: g / 2, w: Math.round(w - g), h: Math.round(h - g) };
  }

  /** the center is on and has an item */
  const centered = $derived(s.centered && centerMedia !== null);
  // modes it is drawn on top

  /** A new wall in the current mode, from the queue or from a resumed
   * session (`seed` for the tiled modes, `lanes` for the feeds). Resolves
   * once its first tiles are up. */
  function build(seed?: WallSeed, lanes?: { into: number; items: (Media | null)[] }[], stackSeed?: StackSeed): Promise<void> {
    tiled?.destroy();
    feed?.destroy();
    stack?.destroy();
    tiled = null;
    feed = null;
    stack = null;
    settledFor = null;
    // Stack has no centered media
    const c = centered && mode !== "stack" ? centerMedia : null;
    queue.hold(c?.path ?? null);
    let ctl: object;
    let first: Promise<unknown> = Promise.resolve();
    if (mode === "stack") {
      // "Stack it" (a seed with its item) goes on with the sources afterwards
      const st = new StackController(queue, s, { w, h }, stackSeed?.media ? false : undefined);
      stack = ctl = st;
      first = st.start(stackSeed);
    } else if (mode === "grid") {
      const g = new GridController(queue, s, bounds(), c);
      tiled = ctl = g;
      first = g.start(seed);
    } else if (!isFeed(mode)) {
      const m = new MosaicController(queue, s, bounds(), mode === "dynamic", c);
      tiled = ctl = m;
      first = m.start(s.tiles, seed);
    } else {
      const f = new FeedController(queue, s, mode as "ribbon" | "cascade", mode === "ribbon" ? s.rows : s.columns, { w, h }, c);
      f.build(lanes);
      feed = ctl = f;
      feedGen++;
    }
    return first.then(
      () => {
        if (tiled === ctl || feed === ctl || stack === ctl) settledFor = ctl;
      },
      () => {},
    );
  }

  function say(msg: string, ms = 1500) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), ms);
  }

  function poke(ms = s.hudSeconds * 1000) {
    hudVisible = true;
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hudVisible = false), ms);
  }

  function setMode(m: Mode) {
    if (m === mode) return;
    mode = m;
    s.mode = m;
    hover = null;
    build();
    say(MODE_NAMES[m]);
  }

  function changeCount(delta: number) {
    const key = settings.countKey(mode);
    const [lo, hi] = LIMITS[key];
    const n = Math.max(lo, Math.min(hi, s[key] + delta));
    if (n === s[key]) return;
    s[key] = n;
    if (tiled instanceof GridController) regrid();
    else if (tiled) tiled.setCount(n);
    // Stack lays its panes out from the setting as it changes
    else if (!stack) build();
    const one = n === 1;
    const noun = { tiles: one ? "tile" : "tiles", rows: one ? "row" : "rows", columns: one ? "column" : "columns", gridCols: "", gridRows: "", stackPanes: one ? "pane" : "panes" }[key];
    say(key === "gridCols" ? `grid ${s.gridCols}×${s.gridRows}` : `${n} ${noun}${key === "tiles" && centered ? " around the center" : ""}`);
  }

  /** Grid: the columns or rows changed. Merged tiles that no longer fit are dropped. */
  function regrid() {
    s.gridSpans = validSpans(s.gridCols, s.gridRows, s.gridSpans);
    if (tiled instanceof GridController) tiled.relayout();
  }

  /** Take a file off this wall: out of the queue, and replaced wherever it shows. */
  function dropHere(path: string) {
    queue.exclude(path);
    if (lightbox?.media.path === path) lightbox = null;
    if (hover?.path === path) hover = null;
    if (menu?.media.path === path) menu = null;
    if (centerMedia?.path === path) {
      // the center item itself: the center goes, the mode carries on
      const was = centered;
      centerMedia = null;
      s.center = "";
      s.centered = false;
      if (was) centerGone();
    }
    // out of the tiles' histories first, so B and N cannot bring it back
    tiled?.forget(path);
    if (tiled) for (const t of tiled.tiles) if (t.media.path === path && !t.leaving) tiled.next(t.id);
    feed?.remove(path);
    if (stack && !stack.forget(path)) say("this is the file or link Stack is set to show; choose another in setup", 3000);
  }

  /** "Remove from wall" (this session) or "Never show again" (saved; scans skip it) */
  async function drop(m: Media, forGood: boolean) {
    if (forGood) {
      try {
        await api.hideItem(m.path);
      } catch (e) {
        return say(String(e));
      }
    }
    // every wall, this one included, hears it and drops the file
    if (link) link.remove(m.path);
    else dropHere(m.path);
    say(forGood ? "hidden for good · undo in setup" : "removed from the wall");
  }

  /** C, or "Play in the center": this item goes in the center, in any mode. */
  function center(m: Media) {
    if (mode === "stack") return say("Stack has no centered media", 2200);
    if (centered && centerMedia?.path === m.path) return;
    // its own key: the tile that showed it is replaced, and the two must not
    // be taken for one item
    putInCenter({ ...m, key: -m.key - 1000, skips: 0, start: undefined });
  }

  function putInCenter(c: Media) {
    centerMedia = c;
    s.center = c.path;
    s.centered = true;
    queue.hold(c.path);
    lightbox = null;
    if (tiled instanceof MosaicController) tiled.setCenter(c);
    else if (tiled instanceof GridController) tiled.setCenter(c);
    // a feed is split around it: laid out again
    else if (feed) build();
    say("centered");
  }

  /** the center was turned off or its item went */
  function centerGone() {
    queue.hold(null);
    if (tiled instanceof MosaicController) tiled.clearCenter();
    else if (tiled instanceof GridController) tiled.setCenter(null);
    else if (feed) build();
  }

  /** C with nothing under the pointer: the center on or off */
  async function toggleCenter() {
    if (mode === "stack") return say("Stack has no centered media", 2200);
    if (centered) {
      s.centered = false;
      centerGone();
      return say("centering off");
    }
    if (!centerMedia || centerMedia.path !== s.center) centerMedia = await loadCenter();
    if (!centerMedia) return say("No centered media yet: hover an item and press C, or choose a file in setup", 3200);
    putInCenter(centerMedia);
  }

  /** the center item's size changed */
  function resizeCenter(up: boolean) {
    if (tiled instanceof GridController) return say("In Grid the center takes the middle cells nearest its shape", 2600);
    const step = (v: number) => Math.round(Math.max(0.3, Math.min(1, v + (up ? 0.05 : -0.05))) * 100) / 100;
    const size = step(s.centerSize);
    if (size === s.centerSize) return;
    if (tiled instanceof MosaicController) {
      // The size is the largest the layout may use, and the tiles around can
      // make a larger setting come out smaller. Step on until the center
      // really moves the way the key asked, or the setting runs out.
      const ctl = tiled;
      const was = s.centerSize;
      (async () => {
        for (let next = size; ; ) {
          s.centerSize = next;
          if (await ctl.resizeCenter(up)) return say(`center ${Math.round(next * 100)}%`);
          const after = step(next);
          if (after === next || tiled !== ctl) break;
          next = after;
        }
        s.centerSize = was;
        say(up ? "the center is as large as the tiles around it allow" : "the center is as small as it gets here", 2600);
      })();
      return;
    }
    s.centerSize = size;
    if (feed) build();
    say(`center ${Math.round(size * 100)}%`);
  }

  function act(a: MenuAction, m: Media) {
    if (a === "reveal") revealItemInDir(m.path).catch((e) => say(String(e)));
    else if (a === "open") api.openMedia(m.path).catch((e) => say(String(e)));
    else if (a === "center") center(m);
    else if (a === "uncenter") toggleCenter();
    else if (a === "prev" || a === "next") stepTile(m, a === "prev");
    else if (a === "stack") stackIt(m);
    else drop(m, a === "hide");
  }

  /** "Stack it": this item, pinned, in copies side by side, from where
   * its video was. N goes on from there with the sources. */
  function stackIt(m: Media) {
    lightbox = null;
    hover = null;
    const seed: StackSeed = { media: { ...m, key: -m.key - 2000, skips: 0, start: videoTime(m) || undefined }, pinned: true };
    mode = "stack";
    s.mode = "stack";
    build(undefined, undefined, seed);
    say("stacked · N for the next item", 2200);
  }

  /** the tile of Mosaic, Dynamic or Grid that shows `m` now, not the center */
  function tileOf(m: Media) {
    return tiled?.tiles.find((t) => t.media.key === m.key && !t.leaving && !t.fixed) ?? null;
  }

  /** "Previous item" and "Next item" in the right-click menu: on the tile
   * that showed the item when the menu opened. Nothing if it has left that
   * tile since. */
  function stepTile(m: Media, back: boolean) {
    const t = tileOf(m);
    if (!t || !tiled) return;
    if (!back) tiled.next(t.id);
    else if (!tiled.prev(t.id)) say("no earlier item on this tile");
  }

  function contextmenu(e: MouseEvent) {
    // the name field (Ctrl+S) keeps its cut, copy and paste menu
    if (e.target instanceof HTMLInputElement) return;
    e.preventDefault();
    const target = lightbox?.media ?? hover;
    menu = target ? { media: target, x: e.clientX, y: e.clientY } : null;
    poke();
  }

  /** F, double-click: the item whole. A video carries on from where its tile was. */
  function open(m: Media) {
    const el = document.querySelector<HTMLVideoElement>(`video[data-key="${m.key}"]`);
    lightbox = { media: m, time: el && Number.isFinite(el.currentTime) ? el.currentTime : 0 };
  }

  function applyOnTop() {
    win.setAlwaysOnTop(s.alwaysOnTop).catch((e) => console.warn("always on top:", e));
  }

  const DISPLAY_NAME = /^\\\\\.\\/;

  /** Ctrl+Shift+arrow: this wall to the display on that side, swapping with a wall there */
  function moveWall(dir: "left" | "right" | "up" | "down") {
    api.moveWall(dir).catch((e) => say(String(e)));
  }

  function key(e: KeyboardEvent) {
    const k = e.key;
    // the name field (Ctrl+S) takes the keys typed into it; with the focus
    // somewhere else, Esc still closes it and nothing else acts
    if (naming !== null) {
      if (k === "Escape") naming = null;
      return;
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && k.toLowerCase() === "s") {
      e.preventDefault();
      poke();
      menu = null;
      naming = stamp();
      return;
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && k.startsWith("Arrow")) {
      e.preventDefault();
      poke();
      return moveWall(k.slice(5).toLowerCase() as "left" | "right" | "up" | "down");
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    poke();
    const lower = k.toLowerCase();
    if (k === "Escape" && menu) {
      menu = null;
      return;
    }
    // one item is open: its keys first (zoom, seek, Space plays or pauses
    // it); of the wall's keys only those about that item or about the app
    if (lightbox) {
      if (viewer?.key(e)) return;
      if (!VIEWER_PASS.has(lower)) return;
    }
    if (k === "Escape") {
      if (help) help = false;
      else exit();
      return;
    }
    if (k === " ") {
      e.preventDefault();
      paused = !paused;
      // with Shift, every wall follows this one
      if (e.shiftKey && link) {
        link.pause(paused);
        say(paused ? "all walls paused" : "all walls playing");
      }
      return;
    }
    if (k === "1") return setMode("mosaic");
    if (k === "2") return setMode("ribbon");
    if (k === "3") return setMode("cascade");
    if (k === "4") return setMode("dynamic");
    if (k === "5") return setMode("grid");
    if (k === "6") return setMode("stack");
    if (k === "+" || k === "=") return changeCount(1);
    if (k === "-" || k === "_") return changeCount(-1);
    if (k === "ArrowUp" || k === "ArrowDown") {
      e.preventDefault();
      const up = k === "ArrowUp";
      // the size of the pinned tile under the pointer, else of the center
      // item: with Shift in any mode, and plainly in Mosaic, where the
      // arrows do nothing else
      if (mode === "stack") return;
      if (e.shiftKey || mode === "mosaic") {
        const pinned = tiled?.tiles.find((t) => t.id === tiled?.hovered && t.pinned && !t.leaving);
        if (pinned && tiled) {
          tiled.resizeTile(pinned.id, up).then((why) => say(why ?? (up ? "larger" : "smaller"), why ? 2600 : 900));
          return;
        }
        if (centered) return resizeCenter(up);
        if (e.shiftKey) return say("pin a tile (P) to change its size, or turn on centered media (C)", 2600);
      }
      if (mode === "dynamic") {
        // up = faster = less time between changes
        s.dynamicSeconds = Math.max(1.5, Math.min(15, s.dynamicSeconds + (up ? -0.5 : 0.5)));
        return say(`a change every ${s.dynamicSeconds} s`);
      }
      if (mode === "grid") {
        const [lo, hi] = LIMITS.gridRows;
        const n = Math.max(lo, Math.min(hi, s.gridRows + (up ? 1 : -1)));
        if (n === s.gridRows) return;
        s.gridRows = n;
        regrid();
        return say(`grid ${s.gridCols}×${s.gridRows}`);
      }
      if (!isFeed(mode)) return;
      s.speed = Math.round(Math.max(10, Math.min(1200, s.speed * (up ? 1.2 : 1 / 1.2))));
      return say(`${s.speed} px/s`);
    }
    // Playback speed. "list": [ ] step through rateList (round past either
    // end), { } (with Shift) by 0.05. "fine": [ ] by 0.05, { } by 0.25.
    if (k === "[" || k === "]" || k === "{" || k === "}") {
      const up = k === "]" || k === "}";
      const shift = k === "{" || k === "}";
      if (s.rateKeys === "list" && !shift && s.rateList.length) s.rate = cycleRate(s.rate, s.rateList, up ? 1 : -1);
      else {
        const step = (up ? 1 : -1) * (s.rateKeys === "fine" && shift ? 0.25 : 0.05);
        s.rate = Math.max(0.1, Math.min(4, Math.round((s.rate + step) * 100) / 100));
      }
      return say(`playback ${s.rate.toFixed(2)}×`);
    }
    if (lower === "d" && stack) {
      const now = stack.geometry()?.dir ?? (s.stackDir === "column" ? "column" : "row");
      s.stackDir = now === "row" ? "column" : "row";
      return say(s.stackDir === "row" ? "side by side" : "one above the next");
    }
    if (lower === "r" && stack) {
      const turns = [0, 90, 270];
      s.stackTurn = turns[(turns.indexOf(s.stackTurn) + 1) % turns.length] ?? 0;
      return say(s.stackTurn ? `turned ${s.stackTurn}°` : "not turned");
    }
    if (lower === "d" && isFeed(mode)) {
      if (mode === "ribbon") s.ribbonDir = s.ribbonDir === "left" ? "right" : "left";
      else s.cascadeDir = s.cascadeDir === "up" ? "down" : "up";
      build();
      return say(`moving ${mode === "ribbon" ? s.ribbonDir : s.cascadeDir}`);
    }
    if (lower === "r") {
      if (tiled) {
        tiled.retile();
        return say(mode === "grid" ? "new items" : "retile");
      }
      build();
      return say("refill");
    }
    if (lower === "g") {
      debug = !debug;
      return say(debug ? "showing changes" : "hiding changes");
    }
    if (lower === "t") {
      s.alwaysOnTop = !s.alwaysOnTop;
      applyOnTop();
      link?.onTop(s.alwaysOnTop);
      return say(s.alwaysOnTop ? "on top of other windows" : "not kept on top");
    }
    if (k === "?" || lower === "h") {
      help = !help;
      return;
    }
    if (lower === "n" && stack) {
      if (stack.one) return say("showing one file or link · choose From the sources in setup to go through them", 2600);
      stack.next().then((ok) => ok || say("no next item yet"));
      return;
    }
    if (lower === "b" && stack) {
      if (!stack.prev()) say("no earlier item");
      return;
    }
    if (lower === "p" && stack) {
      stack.togglePin();
      return say(stack.pinned ? "pinned: it loops" : "unpinned");
    }
    if (lower === "n") {
      if (tiled?.hovered != null) tiled.next(tiled.hovered);
      else if (!tiled) say("N works in Mosaic, Dynamic and Grid");
      return;
    }
    if (lower === "b") {
      if (tiled?.hovered != null) {
        const id = tiled.hovered;
        // the center tile has no history, and says nothing, as with N
        if (!tiled.tiles.find((t) => t.id === id)?.fixed && !tiled.prev(id)) say("no earlier item on this tile");
      } else if (!tiled) say("B works in Mosaic, Dynamic and Grid");
      return;
    }
    if (lower === "p") {
      if (tiled?.hovered != null) {
        const id = tiled.hovered;
        tiled.togglePin(id);
        const t = tiled.tiles.find((t) => t.id === id);
        if (!t?.fixed) say(t?.pinned ? "pinned" : "unpinned");
      }
      return;
    }
    const target = lightbox?.media ?? hover;
    if (lower === "c") return target && !(centered && target.path === centerMedia?.path) ? center(target) : toggleCenter();
    if (lower === "m" && e.shiftKey) return silenceAll();
    if (lower === "m" && target) return sound(target);
    if (lower === "f" && target) return open(target);
    if (lower === "o" && target && !isUrl(target.path)) {
      revealItemInDir(target.path).catch((err) => say(String(err)));
      return;
    }
  }

  /** M: sound on for this item, or off if it has it. Other items keep theirs. */
  function sound(target: Media) {
    if (target.kind === "image") return say("an image has no sound");
    prune();
    const on = !sounding.has(target.key);
    if (on) sounding.set(target.key, target.path);
    else sounding.delete(target.key);
    const n = sounding.size;
    // the count only when other items have sound as well
    say(`sound ${on ? "on" : "off"}${n > (on ? 1 : 0) ? ` · ${n} playing` : ""}`);
  }

  /** Shift+M: sound off for every item, on every wall */
  function silenceAll() {
    sounding.clear();
    link?.silence();
    say("all sound off");
  }

  /** Forget items that have left the wall: no video of theirs is in the page
   * and they are not open in the viewer. Their keys are never reused, so this
   * only keeps the count right and the map small. */
  function prune() {
    for (const k of [...sounding.keys()]) {
      if (k !== lightbox?.media.key && !document.querySelector(`video[data-key="${k}"]`)) sounding.delete(k);
    }
  }

  /** the files that have sound (one file can show in two places) */
  function soundPaths(): string[] {
    return [...new Set(sounding.values())];
  }

  /** where the item's video is now, in seconds; 0 for an image or a video not loaded */
  function videoTime(m: Media): number {
    if (m.kind !== "video") return 0;
    const v = document.querySelector<HTMLVideoElement>(`.wall video[data-key="${m.key}"]`);
    return v && Number.isFinite(v.currentTime) ? Math.round(v.currentTime * 100) / 100 : 0;
  }

  function savedItem(m: Media): SavedItem {
    return { path: m.path, time: videoTime(m), sound: sounding.has(m.key) };
  }

  /** a drawing of the wall now, for the saved walls list */
  function thumb(): Thumb {
    const items: Thumb["items"] = [];
    const r = (n: number) => Math.round(n);
    const flag = (m: Media, pinned = false, mid = false) => (m.kind === "image" ? 1 : 0) | (pinned ? 2 : 0) | (mid ? 4 : 0);
    if (tiled) for (const t of tiled.tiles) if (!t.leaving) items.push([r(t.rect.x), r(t.rect.y), r(t.rect.w), r(t.rect.h), flag(t.media, t.pinned, !!t.fixed)]);
    if (feed) {
      for (const l of feed.lanes)
        for (const i of l.items) {
          // the part of each item that is on screen
          const a = Math.max(0, i.pos - l.offset);
          const b = Math.min(l.span, i.pos + i.len - l.offset);
          if (b - a < 2) continue;
          const along = feed.axis === "x" ? [l.from + a, l.start, b - a, l.cross] : [l.start, l.from + a, l.cross, b - a];
          items.push([r(along[0]), r(along[1]), r(along[2]), r(along[3]), flag(i.media)]);
        }
      if (feed.center && centerMedia) items.push([r(feed.center.x), r(feed.center.y), r(feed.center.w), r(feed.center.h), flag(centerMedia, false, true)]);
    }
    if (stack?.item) for (const p of stack.geometry()?.panes ?? []) items.push([r(p.x), r(p.y), r(p.w), r(p.h), flag(stack.item, stack.pinned)]);
    return { w: r(w), h: r(h), items };
  }

  /** What is on this wall now, for a saved session. Null while it has no items. */
  function snapshot(): WallSnapshot | null {
    const base = {
      mode,
      monitor: multi ? here : s.monitor,
      layout: layoutOf($state.snapshot(s) as Layout),
      sources: [...s.sources],
      own: settings.ownSources,
      bounds: bounds(),
      thumb: thumb(),
    };
    const fixed = tiled?.tiles.find((t) => t.fixed && !t.leaving);
    const center = centered && centerMedia ? { ...savedItem(centerMedia), pan: fixed?.pan ? { ...fixed.pan } : undefined } : null;
    if (tiled) {
      const live = tiled.tiles.filter((t) => !t.leaving && !t.fixed);
      if (!live.length) return null;
      // Grid resumes saved tile i into cell i: save them in cell (reading) order
      if (tiled instanceof GridController) live.sort((a, b) => Math.round(a.rect.y) - Math.round(b.rect.y) || Math.round(a.rect.x) - Math.round(b.rect.x));
      const now = performance.now();
      const tiles = live.map((t) => ({ ...savedItem(t.media), id: t.id, pinned: t.pinned, pan: t.pan ? { ...t.pan } : undefined, age: Math.round(now - t.since) }));
      const tree = tiled instanceof MosaicController ? tiled.layoutTree : null;
      return { ...base, count: tiles.length, tiles, tree, centerId: fixed?.id ?? null, center };
    }
    if (stack) {
      const m = stack.item;
      return m ? { ...base, count: 1, stack: { ...savedItem(m), pan: stack.pan ? { ...stack.pan } : undefined, pinned: stack.pinned }, center: null } : null;
    }
    if (feed) {
      const lanes = feed.lanes.map((l) => {
        // what is on screen or still to come; items already gone by are not kept
        const items = l.items.filter((i) => i.pos + i.len > l.offset);
        const first = items[0];
        return { into: first ? Math.round(((l.offset - first.pos) / first.len) * 1000) / 1000 : 0, items: items.map((i) => savedItem(i.media)) };
      });
      const count = lanes.reduce((n, l) => n + l.items.length, 0);
      return count ? { ...base, count, lanes, center } : null;
    }
    return null;
  }

  /** This wall into session `name` (null: `last`). False when it has nothing to save. */
  async function saveTo(name: string | null, token: number): Promise<boolean> {
    const wall = snapshot();
    if (!wall) return false;
    await api.putSessionWall({ name, run: token, header: { multi, sources: settings.sharedSources(), recursive: s.recursive }, monitor: here, wall });
    return true;
  }

  /** The automatic save into `last`: every 10 s and as the wall closes, once
   * the wall's own build (or resume) has finished. */
  function autosave(): Promise<unknown> {
    const ctl = tiled ?? feed ?? stack;
    if (!ctl || settledFor !== ctl) return Promise.resolve();
    return saveTo(null, run).catch((e) => console.warn("session:", e));
  }

  /** at most this long to wait for a save before closing anyway */
  const SAVE_WAIT = 1500;
  let exiting = false;

  /** Esc, the HUD's back button. A single wall saves first; wall windows
   * save as they are asked to close (onCloseRequested below). */
  async function exit() {
    if (exiting) return;
    exiting = true;
    if (!multi) await Promise.race([autosave(), sleep(SAVE_WAIT)]);
    onexit();
    // a wall window that stays (closeWalls failed) can be left again
    exiting = false;
  }

  /** Enter in the name field (Ctrl+S): with a wall on each display, every wall saves into it */
  function saveNamed() {
    const name = (naming ?? "").trim();
    naming = null;
    if (!name) return;
    const token = Date.now();
    if (link) link.save(name, token);
    else saveNamedHere(name, token);
  }

  async function saveNamedHere(name: string, token: number) {
    try {
      say((await saveTo(name, token)) ? `saved "${name}"` : "nothing on the wall to save yet", 2200);
    } catch (e) {
      say(`could not save: ${e}`, 3000);
    }
  }

  /** the name field: its keys stay out of the wall's (Enter submits the form) */
  function nameKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") naming = null;
  }

  function selectAll(el: HTMLInputElement) {
    el.focus();
    el.select();
  }

  /** Build from a resumed session's snapshot instead of from the queue: its
   * files, where they are still available, in their places, with their
   * pins, pans, video times and sound. */
  async function resume(snap: WallSnapshot) {
    try {
      if (mode === "stack") {
        const st = snap.stack;
        await build(undefined, undefined, st ? { path: st.path, time: st.time, pan: st.pan, pinned: st.pinned } : undefined);
        if (st?.sound && stack?.item?.path === st.path && stack.item.kind === "video") sounding.set(stack.item.key, stack.item.path);
        if (snap.note) say(snap.note, 5000);
        return;
      }
      const feedMode = isFeed(mode);
      const lanes = feedMode ? (snap.lanes ?? []) : [];
      const tiles = feedMode ? [] : (snap.tiles ?? []);
      const flat: SavedItem[] = feedMode ? lanes.flatMap((l) => l.items) : tiles;
      const found = await queue.claim(flat.map((t) => t.path));
      if (unmounted) return;
      // each video carries on from where it was (MediaView seeks once)
      found.forEach((m, i) => {
        if (m && m.kind === "video" && flat[i].time > 0) m.start = flat[i].time;
      });
      if (centerMedia && snap.center && centerMedia.path === snap.center.path && snap.center.time > 0) centerMedia = { ...centerMedia, start: snap.center.time };
      let n = 0;
      if (feedMode) await build(undefined, lanes.map((l) => ({ into: l.into, items: l.items.map(() => found[n++]) })));
      else {
        const seed: WallSeed = {
          tiles: tiles.map((t, i) => ({ id: t.id, media: found[i], pinned: !!t.pinned, pan: t.pan, age: t.age })),
          tree: snap.tree ?? null,
          bounds: snap.bounds ?? null,
          centerId: snap.centerId ?? null,
          centerPan: snap.center?.pan,
        };
        await build(seed);
        // the saved count and the setting differ only if the save was made mid-change
        if (tiled instanceof MosaicController && tiled.tiles.filter((t) => !t.fixed && !t.leaving).length !== s.tiles) tiled.setCount(s.tiles);
      }
      if (unmounted) return;
      found.forEach((m, i) => {
        if (m && m.kind === "video" && flat[i].sound) sounding.set(m.key, m.path);
      });
      if (centerMedia && snap.center?.sound && centerMedia.kind === "video") sounding.set(centerMedia.key, centerMedia.path);
      const missing = found.filter((m) => !m).length;
      const notes = [snap.note ?? "", missing ? `${missing} saved ${missing === 1 ? "file is" : "files are"} no longer available; other files took ${missing === 1 ? "its place" : "their places"}` : ""].filter(Boolean);
      if (notes.length) say(notes.join(" · "), 5000);
    } catch (e) {
      console.warn("resume:", e);
      if (!unmounted) build();
    }
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  function resized() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.abs(window.innerWidth - w) < 2 && Math.abs(window.innerHeight - h) < 2) return;
      w = window.innerWidth;
      h = window.innerHeight;
      if (tiled) tiled.resize(bounds());
      else if (stack) stack.resize({ w, h });
      else if (feed) build();
    }, 220);
  }

  function sampleFrames() {
    let total = 0;
    let lost = 0;
    for (const v of document.querySelectorAll("video")) {
      const q = v.getVideoPlaybackQuality?.();
      if (!q) continue;
      total += q.totalVideoFrames;
      lost += q.droppedVideoFrames;
    }
    dropped = total ? `${((lost / total) * 100).toFixed(1)}% dropped` : "0% dropped";
    checkStall();
  }

  // A video that should be playing but has had no new frame for 4 s, with its
  // data already loaded (readyState below HAVE_FUTURE_DATA). Chromium logs
  // this as DECODER_UNDERFLOW and raises no error, so the wall checks for it:
  // on a laptop it is what a discrete GPU does when its frames must be copied
  // to the integrated GPU that drives the built-in panel.
  const lastFrame = new WeakMap<HTMLVideoElement, { t: number; at: number }>();
  let stallSamples = 0;
  let clearSamples = 0;

  function checkStall() {
    if (wallPaused) return;
    const now = performance.now();
    let live = 0;
    let stuck = 0;
    for (const v of document.querySelectorAll("video")) {
      if (v.paused || v.ended) continue;
      const r = v.getBoundingClientRect();
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
      live++;
      const last = lastFrame.get(v);
      if (!last || last.t !== v.currentTime) lastFrame.set(v, { t: v.currentTime, at: now });
      else if (now - last.at >= 4000 && v.readyState < 3) stuck++;
    }
    if (stuck >= 3 && stuck >= live * 0.2) {
      clearSamples = 0;
      if (++stallSamples < 2) return;
      const first = !stall;
      stall = stallMessage(stuck, live);
      // keep the HUD up long enough to read it the first time
      if (first) poke(8000);
    } else if (stall && ++clearSamples >= 2) {
      stall = "";
      stallSamples = 0;
    } else if (!stall) stallSamples = 0;
  }

  function stallMessage(stuck: number, live: number): string {
    const head = `${stuck} of ${live} videos are stuck on one frame, waiting for the GPU.`;
    const chosen = gpu?.chosen?.name.replace(/\((R|TM)\)/g, "").replace(/\s+/g, " ").trim();
    if (chosen && gpu?.high && gpu?.low && gpu.high.luid !== gpu.low.luid)
      return `${head} Graphics is set to ${chosen}; when this display is wired to the other GPU, every frame is copied across. Try Graphics: Windows default (setup, under System), then restart.`;
    return `${head} Fewer rows or tiles lowers the load.`;
  }

  // multi: keys go to the wall under the pointer. Rust takes focus only from
  // another wall, never from another program: with Explorer or a terminal in
  // front, moving the pointer over a wall must not bring the wall back up.
  let focusAsked = 0;
  function moved() {
    poke();
    if (!multi || focused) return;
    const now = performance.now();
    if (now - focusAsked < 250) return;
    focusAsked = now;
    api.focusWall().catch(() => {});
  }

  /** `s.center` as a Media: from the scan if the file is in the sources, else scanned alone */
  async function loadCenter(): Promise<Media | null> {
    if (!s.center) return null;
    try {
      const entry = library.items.find((e) => e.path === s.center) ?? (await api.scan([s.center], false)).items[0];
      return entry ? await measureEntry(entry) : null;
    } catch (e) {
      console.warn("center:", e);
      return null;
    }
  }

  onMount(() => {
    let alive = true;
    let restore: { pos: PhysicalPosition; size: PhysicalSize } | null = null;
    // dev: window.__CW_WINDOWED__ runs the wall inside the window as it is
    const windowed = import.meta.env.DEV && (window as any).__CW_WINDOWED__;
    (async () => {
      const centerLoad = s.centered ? loadCenter() : null;
      try {
        // a wall window was placed on its display by walls.rs
        if (s.monitor && !multi && !windowed) {
          const target = (await availableMonitors()).find((m) => m.name === s.monitor);
          if (target) {
            restore = { pos: await win.outerPosition(), size: await win.outerSize() };
            // Shrink first: on a 250% laptop panel the setup window is ~2950 px
            // wide, more than a 1920 px monitor, and Windows fullscreens a
            // window on whichever monitor holds most of it.
            await win.setSize(new PhysicalSize(640, 400));
            await win.setPosition(new PhysicalPosition(target.position.x + 60, target.position.y + 60));
          }
        }
        if (!windowed) await win.setFullscreen(true);
        if (s.alwaysOnTop) applyOnTop();
      } catch (e) {
        console.warn("fullscreen:", e);
      }
      await sleep(300);
      if (centerLoad) {
        centerMedia = await centerLoad;
        if (!centerMedia) say(s.center ? "The centered media could not be played." : "No centered media yet: hover an item and press C", 4000);
      }
      // a resumed session: this wall's snapshot, taken once (a later rebuild
      // starts from the queue)
      let snap: WallSnapshot | null = null;
      try {
        snap = await api.takeResume(here);
      } catch (e) {
        console.warn("resume:", e);
      }
      if (!alive) return;
      w = window.innerWidth;
      h = window.innerHeight;
      if (snap) resume(snap);
      else build();
    })();
    const saving = setInterval(autosave, 10000);
    // closing the window (Esc on a wall window via close_walls, Alt+F4, the
    // taskbar) asks first: the last session is saved, then the window goes
    let unclose: (() => void) | undefined;
    win
      .onCloseRequested(async () => {
        await Promise.race([autosave(), sleep(SAVE_WAIT)]);
      })
      .then((f) => (alive ? (unclose = f) : f()))
      .catch(() => {});
    let unfocus: (() => void) | undefined;
    win
      .onFocusChanged(({ payload }) => {
        focused = payload;
        link?.focused(payload);
      })
      .then((f) => (alive ? (unfocus = f) : f()))
      .catch(() => {});
    window.addEventListener("keydown", key);
    window.addEventListener("resize", resized);
    // walls.rs names each window a Ctrl+Shift+arrow moved; every window hears it
    let unmoved: (() => void) | undefined;
    listen<{ label: string; monitor: string }>("wall-moved", (e) => {
      if (e.payload.label !== win.label) return;
      settings.movedTo(e.payload.monitor);
      // later saves go under the new display (walls.rs moved the saved snapshot too)
      if (multi) here = e.payload.monitor;
      say(`moved to ${e.payload.monitor.replace(DISPLAY_NAME, "")}`);
    })
      .then((f) => (alive ? (unmoved = f) : f()))
      .catch(() => {});
    const frames = setInterval(sampleFrames, 2000);
    api.gpuInfo().then((g) => (gpu = g)).catch(() => {});
    poke();
    if (import.meta.env.DEV) (window as any).__cwWall = { tiled: () => tiled, mosaic: () => tiled, feed: () => feed, stack: () => stack, queue, setMode, open, center, snapshot, autosave, settled: () => settledFor !== null && settledFor === (tiled ?? feed ?? stack), state: () => ({ mode, paused, wallPaused, lightbox: lightbox?.media.path ?? null, center: centerMedia?.path ?? null, centered, feedCenter: feed?.center ?? null, sound: [...sounding.keys()], soundPaths: soundPaths() }) };
    return () => {
      alive = false;
      unmounted = true;
      clearInterval(saving);
      unclose?.();
      unfocus?.();
      unmoved?.();
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", resized);
      clearInterval(frames);
      clearTimeout(hudTimer);
      tiled?.destroy();
      feed?.destroy();
      stack?.destroy();
      queue.destroy();
      link?.destroy();
      // a wall window is closing; nothing to restore
      if (multi) return;
      win.setAlwaysOnTop(false).catch(() => {});
      if (windowed) return;
      win
        .setFullscreen(false)
        .then(async () => {
          if (!restore) return win.center();
          await win.setPosition(restore.pos);
          await win.setSize(restore.size);
        })
        .catch(() => {});
    };
  });

  // what the wall itself plays by: Space, plus the optional automatic pauses.
  // The open item in the viewer has its own play and pause.
  const wallPaused = $derived(paused || (s.pauseBehindViewer && lightbox !== null) || (s.pauseUnfocused && !(multi ? focusedAny : focused)));

  const count = $derived(s[settings.countKey(mode)]);
  const countLabel = $derived.by(() => {
    if (mode === "grid") return "";
    if (mode === "stack") return count === 1 ? "pane" : "panes";
    if (centered && (mode === "mosaic" || mode === "dynamic")) return "around";
    if (mode === "ribbon") return count === 1 ? "row" : "rows";
    if (mode === "cascade") return count === 1 ? "column" : "columns";
    return count === 1 ? "tile" : "tiles";
  });
  const direction = $derived(mode === "ribbon" ? (s.ribbonDir === "left" ? "← left" : "→ right") : s.cascadeDir === "up" ? "↑ up" : "↓ down");
  /** the chip after the mode's name */
  const detail = $derived.by(() => {
    if (mode === "grid") return `${gridLabel(s.gridCols, s.gridRows, s.gridSpans)}${s.gridFit === "contain" ? " · whole" : ""}`;
    if (isFeed(mode)) return `${direction} · ${Math.round(s.speed)} px/s`;
    if (mode === "dynamic") return `every ${s.dynamicSeconds} s`;
    if (mode === "stack") {
      const dir = stack?.geometry()?.dir ?? s.stackDir;
      return `${dir === "column" ? "column" : "row"}${s.stackTurn ? ` · ${s.stackTurn}°` : ""}${s.stackFill ? " · filled" : ""}${stack?.pinned ? " · pinned" : ""}`;
    }
    return "";
  });
  /** the HUD's center chip */
  const centerChip = $derived(centered && centerMedia && mode !== "stack" ? `${Math.round(s.centerSize * 100)}% · ${centerMedia.name}` : "");
  const centerKey = $derived(centered ? centerMedia?.key ?? null : null);
  /** the tile the right-click menu's item is in, for Previous and Next item; not in the viewer */
  const menuTile = $derived(menu && !lightbox ? tileOf(menu.media) : null);
</script>

<div class="wall" class:hide-cursor={!hudVisible && !help && !menu && naming === null} onpointermove={moved} oncontextmenu={contextmenu} role="presentation">
  {#if tiled}
    <MosaicView ctl={tiled} {s} paused={wallPaused} {sounding} {hudVisible} {debug} onhover={(m) => (hover = m)} onopen={open} />
  {:else if stack}
    <StackView
      ctl={stack}
      {s}
      {w}
      {h}
      paused={wallPaused}
      unmuted={(!!stack.item && sounding.has(stack.item.key)) || (s.audioFollowsMouse && hover !== null && hover.key === stack.item?.key)}
      {hudVisible}
      onhover={(m) => (hover = m)}
      onopen={open}
    />
  {:else if feed}
    {#key feedGen}
      <FeedView ctl={feed} {s} paused={wallPaused} {sounding} {hudVisible} onhover={(m) => (hover = m)} onopen={open} />
    {/key}
  {/if}

  {#if feed?.center && centerMedia && centered}
    <CenterItem
      media={centerMedia}
      rect={feed.center}
      paused={wallPaused}
      unmuted={(centerKey !== null && sounding.has(centerKey)) || (s.audioFollowsMouse && hover?.key === centerKey)}
      volume={s.volume / 100}
      rate={s.rate}
      ring={hudVisible && hover?.key === centerKey}
      onenter={(m) => (hover = m)}
      onleave={(m) => {
        if (hover?.key === m.key) hover = null;
      }}
      onopen={open}
    />
  {/if}

  {#if queue.empty && queue.readyCount === 0 && !stack?.one}
    <div class="empty">
      <p>{queue.unplayable ? "Nothing in these sources could be played." : "Nothing in these sources passes the filters."}</p>
      <p class="sub">
        {#if queue.unplayable}{queue.unplayable} files could not be played.{/if}
        {#if queue.leftOut}{queue.leftOut} were left out by the shape or video length filter.{/if}
        Press <kbd>Esc</kbd> to change sources or filters.
      </p>
    </div>
  {/if}

  {#if lightbox}
    {#key lightbox.media.key}
      <Viewer
        bind:this={viewer}
        media={lightbox.media}
        time={lightbox.time}
        muted={!sounding.has(lightbox.media.key)}
        volume={s.volume}
        rate={s.rate}
        chrome={hudVisible}
        onclose={() => (lightbox = null)}
        onsound={() => lightbox && sound(lightbox.media)}
        onvolume={(v) => (s.volume = v)}
      />
    {/key}
  {/if}

  {#if menu}
    <ContextMenu
      media={menu.media}
      x={menu.x}
      y={menu.y}
      centered={centered && centerMedia?.path === menu.media.path}
      steps={menuTile ? { back: !!menuTile.back?.length } : null}
      onaction={(a) => menu && act(a, menu.media)}
      onclose={() => (menu = null)}
    />
  {/if}

  <Hud
    visible={hudVisible}
    bare={lightbox !== null}
    {help}
    {mode}
    {count}
    {countLabel}
    {detail}
    center={centerChip}
    {paused}
    onTop={s.alwaysOnTop}
    rate={s.rate}
    {hover}
    total={queue.total}
    unplayable={queue.unplayable}
    {dropped}
    {stall}
    last={tiled?.last ?? null}
    {debug}
    {toast}
    onexit={exit}
  />

  {#if naming !== null}
    <!-- Ctrl+S: a name for this wall (every wall, with a wall on each display) -->
    <form
      class="save"
      onsubmit={(e) => {
        e.preventDefault();
        saveNamed();
      }}
    >
      <span class="nf">{I.save}</span>
      <span class="save-label">Save this wall as</span>
      <input type="text" bind:value={naming} onkeydown={nameKey} use:selectAll maxlength="80" />
      <span class="save-keys"><kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel</span>
    </form>
  {/if}
</div>

<style>
  .wall {
    position: fixed;
    inset: 0;
    background: var(--bg-app);
    overflow: hidden;
  }
  .wall.hide-cursor {
    cursor: none;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    text-align: center;
    color: var(--text-secondary);
  }
  .empty p {
    margin: 4px 0;
  }
  .empty .sub {
    color: var(--text-muted);
    font-size: 12px;
  }
  /* the name field for Ctrl+S, above the HUD (20) and the viewer (30) */
  .save {
    position: absolute;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 45;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--bg-panel) 96%, transparent);
    border: 1px solid var(--border);
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
    font-size: 12.5px;
    color: var(--text-secondary);
    cursor: auto;
  }
  .save .nf {
    color: var(--purple);
  }
  .save input {
    width: 240px;
    padding: 5px 8px;
    border-radius: var(--radius);
    border: 1px solid var(--purple);
    background: var(--bg-chip);
    color: var(--text-primary);
    font-family: var(--mono);
    font-size: 12px;
  }
  .save-keys {
    color: var(--text-muted);
    font-size: 11.5px;
    white-space: nowrap;
  }
  .save-keys kbd {
    font-size: 10px;
  }
</style>
