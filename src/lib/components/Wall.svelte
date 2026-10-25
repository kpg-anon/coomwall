<script lang="ts">
  // The running wall: fullscreen on the chosen monitor, one of the three
  // modes, the HUD and every key. Switching mode (1/2/3) keeps the queue, so
  // the shuffle carries on where it was. With a wall on each display (multi),
  // this is one of several windows, already fullscreen on its display, and
  // walls.ts keeps pause, sound and focus in step with the others.
  import { onMount } from "svelte";
  import { getCurrentWindow, availableMonitors } from "@tauri-apps/api/window";
  import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { isUrl, type Rect } from "$lib/api";
  import { settings, LIMITS, type Mode } from "$lib/settings.svelte";
  import { library } from "$lib/library.svelte";
  import { MediaQueue, type Media } from "$lib/queue.svelte";
  import { MosaicController } from "$lib/mosaic.svelte";
  import { FeedController } from "$lib/feed.svelte";
  import MosaicView from "./MosaicView.svelte";
  import FeedView from "./FeedView.svelte";
  import Hud from "./Hud.svelte";
  import Lightbox from "./Lightbox.svelte";
  import { linkWalls } from "$lib/walls";

  let { onexit, multi = false }: { onexit: () => void; multi?: boolean } = $props();

  const s = settings.s;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const MODE_NAMES: Record<Mode, string> = { mosaic: "Mosaic", ribbon: "Ribbon", cascade: "Cascade", dynamic: "Dynamic" };
  const isFeed = (m: Mode) => m === "ribbon" || m === "cascade";

  const queue = new MediaQueue(library.items, s.type, s.shape, s.shuffle);
  let w = $state(0);
  let h = $state(0);
  let mode = $state<Mode>(s.mode);
  let mosaic = $state.raw<MosaicController | null>(null);
  let feed = $state.raw<FeedController | null>(null);
  let feedGen = $state(0);
  /** Space */
  let paused = $state(false);
  let focused = $state(true);
  /** multi: whether any of the walls has focus */
  let focusedAny = $state(true);
  let hover = $state.raw<Media | null>(null);
  let audioKey = $state<number | null>(null);
  let lightbox = $state.raw<Media | null>(null);
  let hudVisible = $state(true);
  let help = $state(false);
  let debug = $state(false);
  let toast = $state("");
  let dropped = $state("0% dropped");
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
      })
    : null;

  function bounds(): Rect {
    const g = s.gap;
    return { x: g / 2, y: g / 2, w: Math.round(w - g), h: Math.round(h - g) };
  }

  function build() {
    mosaic?.destroy();
    feed?.destroy();
    mosaic = null;
    feed = null;
    if (mode === "mosaic" || mode === "dynamic") {
      const m = new MosaicController(queue, s, bounds(), mode === "dynamic");
      mosaic = m;
      m.start(s.tiles);
    } else {
      const f = new FeedController(queue, s, mode, mode === "ribbon" ? s.rows : s.columns, { w, h });
      f.build();
      feed = f;
      feedGen++;
    }
  }

  function say(msg: string) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 1500);
  }

  function poke() {
    hudVisible = true;
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => (hudVisible = false), 2200);
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
    if (mosaic) mosaic.setCount(n);
    else build();
    say(`${n} ${key === "tiles" ? (n === 1 ? "tile" : "tiles") : key === "rows" ? (n === 1 ? "row" : "rows") : n === 1 ? "column" : "columns"}`);
  }

  function key(e: KeyboardEvent) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const k = e.key;
    poke();
    if (k === "Escape") {
      if (lightbox) lightbox = null;
      else if (help) help = false;
      else onexit();
      return;
    }
    if (k === " ") {
      e.preventDefault();
      paused = !paused;
      link?.pause(paused);
      return;
    }
    if (k === "1") return setMode("mosaic");
    if (k === "2") return setMode("ribbon");
    if (k === "3") return setMode("cascade");
    if (k === "4") return setMode("dynamic");
    if (k === "+" || k === "=") return changeCount(1);
    if (k === "-" || k === "_") return changeCount(-1);
    if (k === "ArrowUp" || k === "ArrowDown") {
      e.preventDefault();
      if (mode === "dynamic") {
        // up = faster = less time between changes
        const step = k === "ArrowUp" ? -0.5 : 0.5;
        s.dynamicSeconds = Math.max(1.5, Math.min(15, s.dynamicSeconds + step));
        return say(`a change every ${s.dynamicSeconds} s`);
      }
      if (!isFeed(mode)) return;
      s.speed = Math.round(Math.max(10, Math.min(1200, s.speed * (k === "ArrowUp" ? 1.2 : 1 / 1.2))));
      return say(`${s.speed} px/s`);
    }
    if (k === "[" || k === "]") {
      s.rate = Math.max(0.25, Math.min(3, Math.round((s.rate + (k === "]" ? 0.25 : -0.25)) * 100) / 100));
      return say(`playback ${s.rate.toFixed(2)}×`);
    }
    const lower = k.toLowerCase();
    if (lower === "d" && isFeed(mode)) {
      if (mode === "ribbon") s.ribbonDir = s.ribbonDir === "left" ? "right" : "left";
      else s.cascadeDir = s.cascadeDir === "up" ? "down" : "up";
      build();
      return say(`moving ${mode === "ribbon" ? s.ribbonDir : s.cascadeDir}`);
    }
    if (lower === "r") {
      if (mosaic) {
        mosaic.retile();
        return say("retile");
      }
      build();
      return say("refill");
    }
    if (lower === "g") {
      debug = !debug;
      return say(debug ? "showing changes" : "hiding changes");
    }
    if (k === "?" || lower === "h") {
      help = !help;
      return;
    }
    if (lower === "n") {
      if (mosaic?.hovered != null) mosaic.next(mosaic.hovered);
      else if (!mosaic) say("N works in Mosaic and Dynamic");
      return;
    }
    if (lower === "p") {
      if (mosaic?.hovered != null) {
        const id = mosaic.hovered;
        mosaic.togglePin(id);
        return say(mosaic.tiles.find((t) => t.id === id)?.pinned ? "pinned" : "unpinned");
      }
      return;
    }
    const target = lightbox ?? hover;
    if (lower === "m" && target) {
      audioKey = audioKey === target.key ? null : target.key;
      if (audioKey !== null) link?.sound();
      return say(audioKey === null ? "sound off" : "sound on");
    }
    if (lower === "f" && target) {
      lightbox = lightbox ? null : target;
      return;
    }
    if (lower === "o" && target && !isUrl(target.path)) {
      revealItemInDir(target.path).catch((err) => say(String(err)));
      return;
    }
  }

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  function resized() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (Math.abs(window.innerWidth - w) < 2 && Math.abs(window.innerHeight - h) < 2) return;
      w = window.innerWidth;
      h = window.innerHeight;
      if (mosaic) mosaic.resize(bounds());
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
  }

  /** multi: keys go to the wall under the pointer */
  function moved() {
    poke();
    if (multi && !focused) win.setFocus().catch(() => {});
  }

  onMount(() => {
    let alive = true;
    let restore: { pos: PhysicalPosition; size: PhysicalSize } | null = null;
    (async () => {
      try {
        // a wall window was placed on its display by walls.rs
        if (s.monitor && !multi) {
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
        await win.setFullscreen(true);
      } catch (e) {
        console.warn("fullscreen:", e);
      }
      await sleep(300);
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
    const frames = setInterval(sampleFrames, 2000);
    poke();
    if (import.meta.env.DEV) (window as any).__cwWall = { mosaic: () => mosaic, feed: () => feed, queue, setMode };
    return () => {
      alive = false;
      unfocus?.();
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", resized);
      clearInterval(frames);
      clearTimeout(hudTimer);
      mosaic?.destroy();
      feed?.destroy();
      queue.destroy();
      link?.destroy();
      // a wall window is closing; nothing to restore
      if (multi) return;
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
  // The open item in the lightbox follows Space only.
  const wallPaused = $derived(paused || (s.pauseBehindViewer && lightbox !== null) || (s.pauseUnfocused && !(multi ? focusedAny : focused)));

  const count = $derived(s[settings.countKey(mode)]);
  const countLabel = $derived(!isFeed(mode) ? (count === 1 ? "tile" : "tiles") : mode === "ribbon" ? (count === 1 ? "row" : "rows") : count === 1 ? "column" : "columns");
  const direction = $derived(mode === "ribbon" ? (s.ribbonDir === "left" ? "← left" : "→ right") : s.cascadeDir === "up" ? "↑ up" : "↓ down");
</script>

<div class="wall" class:hide-cursor={!hudVisible && !help} onpointermove={moved} role="presentation">
  {#if mosaic}
    <MosaicView ctl={mosaic} {s} paused={wallPaused} {audioKey} {hudVisible} {debug} onhover={(m) => (hover = m)} onopen={(m) => (lightbox = m)} />
  {:else if feed}
    {#key feedGen}
      <FeedView ctl={feed} {s} paused={wallPaused} {audioKey} {hudVisible} onhover={(m) => (hover = m)} onopen={(m) => (lightbox = m)} />
    {/key}
  {/if}

  {#if queue.empty && queue.readyCount === 0}
    <div class="empty">
      <p>Nothing in these sources could be played.</p>
      <p class="sub">{queue.unplayable} files were tried. Press <kbd>Esc</kbd> to change sources or filters.</p>
    </div>
  {/if}

  {#if lightbox}
    <Lightbox
      media={lightbox}
      muted={audioKey !== lightbox.key}
      volume={s.volume / 100}
      rate={s.rate}
      {paused}
      onclose={() => (lightbox = null)}
    />
  {/if}

  <Hud
    visible={hudVisible}
    {help}
    {mode}
    {count}
    {countLabel}
    {paused}
    rate={s.rate}
    speed={s.speed}
    dynamicSeconds={s.dynamicSeconds}
    {direction}
    {hover}
    queued={queue.readyCount}
    total={queue.total}
    unplayable={queue.unplayable}
    {dropped}
    last={mosaic?.last ?? null}
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
