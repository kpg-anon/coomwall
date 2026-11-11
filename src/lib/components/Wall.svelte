<script lang="ts">
  // The running wall: fullscreen on the chosen monitor, one of the six modes,
  // the HUD and every key. Switching mode (1-6) keeps the queue, so the
  // shuffle carries on where it was. With a wall on each display (multi),
  // this is one of several windows, already fullscreen on its display, and
  // walls.ts keeps sound, focus and removed files in step with the others.
  // Ctrl+Shift+arrow moves the wall to the next display (walls.rs).
  import { onMount } from "svelte";
  import { getCurrentWindow, availableMonitors } from "@tauri-apps/api/window";
  import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
  import { listen } from "@tauri-apps/api/event";
  import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
  import { api, isUrl, type GpuInfo, type Rect } from "$lib/api";
  import { settings, LIMITS, MODE_NAMES, type Mode } from "$lib/settings.svelte";
  import { library } from "$lib/library.svelte";
  import { MediaQueue, measureEntry, type Media } from "$lib/queue.svelte";
  import { MosaicController } from "$lib/mosaic.svelte";
  import { GridController } from "$lib/grid.svelte";
  import { gridLabel, validSpans } from "$lib/grid";
  import { FeedController } from "$lib/feed.svelte";
  import MosaicView from "./MosaicView.svelte";
  import FeedView from "./FeedView.svelte";
  import Hud from "./Hud.svelte";
  import Viewer from "./Viewer.svelte";
  import ContextMenu, { type MenuAction } from "./ContextMenu.svelte";
  import { linkWalls } from "$lib/walls";

  let { onexit, multi = false }: { onexit: () => void; multi?: boolean } = $props();

  const s = settings.s;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isFeed = (m: Mode) => m === "ribbon" || m === "cascade";
  /** keys that still reach the wall while one item is open in the viewer */
  const VIEWER_PASS = new Set(["m", "o", "[", "]", "{", "}", "?", "h", "t"]);

  const queue = new MediaQueue(library.items, s.type, s.shape, s.shuffle);
  let w = $state(0);
  let h = $state(0);
  let mode = $state<Mode>(s.mode);
  /** Mosaic, Dynamic and Centre (MosaicController) or Grid */
  let tiled = $state.raw<MosaicController | GridController | null>(null);
  let feed = $state.raw<FeedController | null>(null);
  let feedGen = $state(0);
  /** Space: this wall. Shift+Space: every wall. */
  let paused = $state(false);
  let focused = $state(true);
  /** multi: whether any of the walls has focus */
  let focusedAny = $state(true);
  let hover = $state.raw<Media | null>(null);
  let audioKey = $state<number | null>(null);
  /** the item open in the viewer, and where its tile's video was */
  let lightbox = $state.raw<{ media: Media; time: number } | null>(null);
  let viewer = $state<Viewer>();
  /** Centre mode's middle item, measured from `s.center` */
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

  const win = getCurrentWindow();
  // a window is a wall window for its whole life, so reading the prop once is right
  // svelte-ignore state_referenced_locally
  const link = multi
    ? linkWalls({
        pause: (p) => (paused = p),
        soundElsewhere: () => (audioKey = null),
        focusAny: (f) => (focusedAny = f),
        remove: (path) => dropHere(path),
        onTop: (on) => {
          s.alwaysOnTop = on;
          applyOnTop();
        },
      })
    : null;

  function bounds(): Rect {
    const g = s.gap;
    return { x: g / 2, y: g / 2, w: Math.round(w - g), h: Math.round(h - g) };
  }

  function build() {
    tiled?.destroy();
    feed?.destroy();
    tiled = null;
    feed = null;
    queue.hold(null);
    if (mode === "grid") {
      const g = new GridController(queue, s, bounds());
      tiled = g;
      g.start();
    } else if (!isFeed(mode)) {
      const c = mode === "center" ? centerMedia : null;
      queue.hold(c?.path ?? null);
      const m = new MosaicController(queue, s, bounds(), mode === "dynamic", c);
      tiled = m;
      m.start(c ? s.centerTiles : s.tiles);
    } else {
      const f = new FeedController(queue, s, mode as "ribbon" | "cascade", mode === "ribbon" ? s.rows : s.columns, { w, h });
      f.build();
      feed = f;
      feedGen++;
    }
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
    if (m === "center" && !centerMedia) return say("Centre: hover an item and press C, or choose a file in setup", 3200);
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
    else build();
    const one = n === 1;
    const noun = { tiles: one ? "tile" : "tiles", rows: one ? "row" : "rows", columns: one ? "column" : "columns", gridCols: "", gridRows: "", centerTiles: "around the centre" }[key];
    say(key === "gridCols" ? `grid ${s.gridCols}×${s.gridRows}` : `${n} ${noun}`);
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
      // the middle item itself: Centre has nothing to show, so back to Mosaic
      centerMedia = null;
      s.center = "";
      if (mode === "center") setMode("mosaic");
      return;
    }
    if (tiled) for (const t of tiled.tiles) if (t.media.path === path && !t.leaving) tiled.next(t.id);
    feed?.remove(path);
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

  /** C, or "Play in the centre": this item becomes Centre mode's middle item. */
  function center(m: Media) {
    if (centerMedia?.path === m.path && mode === "center") return;
    // its own key: the tile that showed it is replaced, and the two must not
    // be taken for one item
    const c = { ...m, key: -m.key - 1000, skips: 0 };
    centerMedia = c;
    s.center = m.path;
    queue.hold(m.path);
    if (mode === "center" && tiled instanceof MosaicController) {
      if (lightbox) lightbox = null;
      tiled.setCenter(c);
      return say("in the centre");
    }
    lightbox = null;
    setMode("center");
  }

  function act(a: MenuAction, m: Media) {
    if (a === "reveal") revealItemInDir(m.path).catch((e) => say(String(e)));
    else if (a === "open") (isUrl(m.path) ? openUrl(m.path) : openPath(m.path)).catch((e) => say(String(e)));
    else if (a === "center") center(m);
    else drop(m, a === "hide");
  }

  function contextmenu(e: MouseEvent) {
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
      else onexit();
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
    if (k === "6") {
      if (!centerMedia && hover) return center(hover);
      return setMode("center");
    }
    if (k === "+" || k === "=") return changeCount(1);
    if (k === "-" || k === "_") return changeCount(-1);
    if (k === "ArrowUp" || k === "ArrowDown") {
      e.preventDefault();
      const up = k === "ArrowUp";
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
      if (mode === "center") {
        const size = Math.round(Math.max(0.3, Math.min(1, s.centerSize + (up ? 0.05 : -0.05))) * 100) / 100;
        if (size === s.centerSize) return;
        s.centerSize = size;
        tiled?.retile();
        return say(`centre ${Math.round(size * 100)}%`);
      }
      if (!isFeed(mode)) return;
      s.speed = Math.round(Math.max(10, Math.min(1200, s.speed * (up ? 1.2 : 1 / 1.2))));
      return say(`${s.speed} px/s`);
    }
    // [ ] by 5%, { } (with Shift) by 25%
    if (k === "[" || k === "]" || k === "{" || k === "}") {
      const step = (k === "]" || k === "}" ? 1 : -1) * (k === "{" || k === "}" ? 0.25 : 0.05);
      s.rate = Math.max(0.25, Math.min(3, Math.round((s.rate + step) * 100) / 100));
      return say(`playback ${s.rate.toFixed(2)}×`);
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
    if (lower === "n") {
      if (tiled?.hovered != null) tiled.next(tiled.hovered);
      else if (!tiled) say("N works in Mosaic, Dynamic, Grid and Centre");
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
    if (lower === "c" && target) return center(target);
    if (lower === "m" && target) return sound(target);
    if (lower === "f" && target) return open(target);
    if (lower === "o" && target && !isUrl(target.path)) {
      revealItemInDir(target.path).catch((err) => say(String(err)));
      return;
    }
  }

  /** M: sound on for this item, or off if it is the one that has it */
  function sound(target: Media) {
    audioKey = audioKey === target.key ? null : target.key;
    if (audioKey !== null) link?.sound();
    say(audioKey === null ? "sound off" : "sound on");
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  function resized() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.abs(window.innerWidth - w) < 2 && Math.abs(window.innerHeight - h) < 2) return;
      w = window.innerWidth;
      h = window.innerHeight;
      if (tiled) tiled.resize(bounds());
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
  // on this laptop it is what the RTX 4070 does when its frames must be copied
  // to the Iris Xe that drives the built-in panel.
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
      return `${head} Graphics is set to ${chosen}; when this display is wired to the other GPU, every frame is copied across. Try Graphics: Windows default (setup → More options), then restart.`;
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
      console.warn("centre:", e);
      return null;
    }
  }

  onMount(() => {
    let alive = true;
    let restore: { pos: PhysicalPosition; size: PhysicalSize } | null = null;
    // dev: window.__CW_WINDOWED__ runs the wall inside the window as it is
    const windowed = import.meta.env.DEV && (window as any).__CW_WINDOWED__;
    (async () => {
      const centre = mode === "center" ? loadCenter() : null;
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
      if (centre) {
        centerMedia = await centre;
        if (!centerMedia) {
          mode = "mosaic";
          say(s.center ? "The centre file could not be played. Showing Mosaic." : "Centre has no file yet: hover an item and press C", 4000);
        }
      }
      if (!alive) return;
      w = window.innerWidth;
      h = window.innerHeight;
      build();
    })();
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
      say(`moved to ${e.payload.monitor.replace(DISPLAY_NAME, "")}`);
    })
      .then((f) => (alive ? (unmoved = f) : f()))
      .catch(() => {});
    const frames = setInterval(sampleFrames, 2000);
    api.gpuInfo().then((g) => (gpu = g)).catch(() => {});
    poke();
    if (import.meta.env.DEV) (window as any).__cwWall = { tiled: () => tiled, mosaic: () => tiled, feed: () => feed, queue, setMode, open, center, state: () => ({ mode, paused, wallPaused, lightbox: lightbox?.media.path ?? null, center: centerMedia?.path ?? null }) };
    return () => {
      alive = false;
      unfocus?.();
      unmoved?.();
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", resized);
      clearInterval(frames);
      clearTimeout(hudTimer);
      tiled?.destroy();
      feed?.destroy();
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
    if (mode === "center") return "around";
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
    if (mode === "center") return centerMedia ? `${Math.round(s.centerSize * 100)}% · ${centerMedia.name}` : "";
    return "";
  });
</script>

<div class="wall" class:hide-cursor={!hudVisible && !help && !menu} onpointermove={moved} oncontextmenu={contextmenu} role="presentation">
  {#if tiled}
    <MosaicView ctl={tiled} {s} paused={wallPaused} {audioKey} {hudVisible} {debug} onhover={(m) => (hover = m)} onopen={open} />
  {:else if feed}
    {#key feedGen}
      <FeedView ctl={feed} {s} paused={wallPaused} {audioKey} {hudVisible} onhover={(m) => (hover = m)} onopen={open} />
    {/key}
  {/if}

  {#if queue.empty && queue.readyCount === 0}
    <div class="empty">
      <p>Nothing in these sources could be played.</p>
      <p class="sub">{queue.unplayable} files were tried. Press <kbd>Esc</kbd> to change sources or filters.</p>
    </div>
  {/if}

  {#if lightbox}
    {#key lightbox.media.key}
      <Viewer
        bind:this={viewer}
        media={lightbox.media}
        time={lightbox.time}
        muted={audioKey !== lightbox.media.key}
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
      centered={mode === "center" && centerMedia?.path === menu.media.path}
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
    {onexit}
  />
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
</style>
