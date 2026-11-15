<script lang="ts">
  // One Mosaic tile. Its rectangle comes from the solver and animates with a
  // CSS transition; its content cross-fades: the next item loads in a layer
  // on top and only fades in once its first frame is ready.
  import { untrack } from "svelte";
  import MediaView from "./MediaView.svelte";
  import type { TileState } from "$lib/mosaic.svelte";
  import type { Media } from "$lib/queue.svelte";
  import type { Pan } from "$lib/session";
  import { I } from "$lib/icons";

  interface Props {
    tile: TileState;
    gap: number;
    paused: boolean;
    unmuted: boolean;
    volume: number;
    rate: number;
    imageSeconds: number;
    minVideo: number;
    ring: boolean;
    /** under the pointer: an ended item plays again (twice) before it is replaced */
    watched: boolean;
    /** Dynamic: videos loop and images stay; the controller's clock replaces them */
    endless: boolean;
    /** cover fills the tile and crops; contain shows the item whole (Grid) */
    fit?: "cover" | "contain";
    ondone: (id: number) => void;
    onenter: (tile: TileState) => void;
    onleave: (tile: TileState) => void;
    onopen: (tile: TileState) => void;
    /** Shift+drag moved the visible part of the item; undefined centers it */
    onpan: (id: number, pan: Pan | undefined) => void;
  }


  let { tile, gap, paused, unmuted, volume, rate, imageSeconds, minVideo, ring, watched, endless, fit = "cover", ondone, onenter, onleave, onopen, onpan }: Props = $props();

  interface Layer {
    key: number;
    media: Media;
    shown: boolean;
    /** the pan it had when a new item replaced it, kept while it fades out */
    pan?: Pan;
  }

  const HOLDS = 2;

  let layers = $state<Layer[]>([]);
  let views: Record<number, MediaView> = {};
  let elapsed = 0;
  let fired = false;
  let holds = 0;

  $effect(() => {
    const m = tile.media;
    untrack(() => {
      const top = layers[layers.length - 1];
      if (!top || top.key !== m.key) {
        // the pan belongs to the item: the old one keeps it while it fades
        // out, the new one starts centered. A tile's first item keeps any pan
        // it was created with.
        if (top) {
          top.pan = tile.pan && { ...tile.pan };
          if (tile.pan) onpan(tile.id, undefined);
          drag = null;
        }
        layers.push({ key: m.key, media: m, shown: false });
        elapsed = 0;
        fired = false;
        holds = 0;
      }
    });
  });

  function shown(layer: Layer) {
    layer.shown = true;
    // drop the layers underneath once the fade has finished
    setTimeout(() => {
      const i = layers.findIndex((l) => l.key === layer.key);
      if (i > 0) layers.splice(0, i);
    }, 340);
  }

  function fire() {
    if (fired) return;
    const top = layers[layers.length - 1];
    if (tile.pinned || tile.fixed || (watched && holds < HOLDS)) {
      if (!tile.pinned && !tile.fixed) holds++;
      elapsed = 0;
      if (top?.media.kind === "video") views[top.key]?.replay();
      return;
    }
    fired = true;
    ondone(tile.id);
  }

  // image timer; counts only while unpaused and while the current item is
  // actually visible. A video ends by itself (onended).
  $effect(() => {
    if (endless || tile.fixed) return;
    const iv = setInterval(() => {
      if (paused || fired) return;
      const top = layers[layers.length - 1];
      if (top?.media.kind !== "image" || !top.shown) return;
      elapsed += 0.25;
      if (elapsed >= imageSeconds) fire();
    }, 250);
    return () => clearInterval(iv);
  });

  const top = $derived(layers[layers.length - 1]);

  // On a pinned or center tile, Shift+drag moves the visible part of the
  // item and Shift+wheel zooms into it, toward the pointer.
  const ZOOM_MAX = 8;
  const zoom = $derived(tile.pan?.z ?? 1);

  /** The item's size in the tile at zoom 1 (cover: it fills the tile and
   * overflows on one axis), for a box of w x h. */
  function coverSize(w: number, h: number, a: number) {
    const wide = a > w / h;
    return { w: wide ? h * a : w, h: wide ? h : w / a };
  }

  /** T − z·M on each axis, in px: the tile's size minus the item's rendered
   * size. Negative on an axis that is cropped (both, once zoomed in), 0 on
   * the other. Null when nothing is cropped. */
  const slack = $derived.by(() => {
    if (fit !== "cover") return null;
    const w = Math.max(0, tile.rect.w - gap);
    const h = Math.max(0, tile.rect.h - gap);
    const a = tile.media.aspect;
    if (!w || !h || !(a > 0)) return null;
    const m = coverSize(w, h, a);
    const x = w - zoom * m.w;
    const y = h - zoom * m.h;
    return x < -0.5 || y < -0.5 ? { x, y } : null;
  });
  const adjustable = $derived(fit === "cover" && (tile.pinned || !!tile.fixed));
  const pannable = $derived(adjustable && !!slack);

  /** Shift+wheel: zoom in or out by 1.2× a notch, keeping the point under
   * the pointer where it is. Back at 1× the zoom is dropped. */
  function wheel(e: WheelEvent) {
    if (!e.shiftKey || !adjustable) return;
    e.preventDefault();
    // with Shift, Chromium on Windows reports the wheel as horizontal
    const d = e.deltaY || e.deltaX;
    const a = tile.media.aspect;
    if (!d || !(a > 0)) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (!box.width || !box.height) return;
    const z = zoom;
    const z2 = Math.max(1, Math.min(ZOOM_MAX, z * Math.pow(1.2, -d / 100)));
    if (Math.abs(z2 - z) < 1e-3) return;
    const m = coverSize(box.width, box.height, a);
    const from = tile.pan ?? { x: 50, y: 50 };
    // A point u of the item (in its zoom-1 px) is drawn at p·(T − z·M) + z·u.
    // Solve for the p that draws the same u under the pointer at z2.
    const axis = (T: number, M: number, p: number, c: number) => {
      const u = (c - p * (T - z * M)) / z;
      const s2 = T - z2 * M;
      return s2 < -0.5 ? Math.max(0, Math.min(1, (c - z2 * u) / s2)) : p;
    };
    const x = Math.round(axis(box.width, m.w, from.x / 100, e.clientX - box.left) * 10000) / 100;
    const y = Math.round(axis(box.height, m.h, from.y / 100, e.clientY - box.top) * 10000) / 100;
    const zoomed = z2 > 1.001;
    onpan(tile.id, zoomed ? { x, y, z: Math.round(z2 * 1000) / 1000 } : x === 50 && y === 50 ? undefined : { x, y });
  }

  let shift = $state(false);
  let drag = $state.raw<{ pointer: number; x: number; y: number; from: Pan } | null>(null);
  /** a press in this run of quick presses moved the pointer: its double-click is not one */
  let dragged = false;
  let lastDown = -Infinity;

  function down(e: PointerEvent) {
    shift = e.shiftKey;
    // 700 ms: longer than the system double-click time
    if (e.timeStamp - lastDown > 700) dragged = false;
    lastDown = e.timeStamp;
    if (!e.shiftKey || e.button !== 0 || !pannable) return;
    // no text selection, no compatibility mousedown
    e.preventDefault();
    // the drag goes on outside the tile; until release the tile also keeps the hover
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from: { ...(tile.pan ?? { x: 50, y: 50 }) } };
  }

  function move(e: PointerEvent) {
    shift = e.shiftKey;
    if (!drag || e.pointerId !== drag.pointer || !slack) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
    // object-position p puts the item at (T − M)·p/100, so moving it by d
    // changes p by 100·d/(T − M); an axis that is not cropped stays put
    const along = (from: number, d: number, s: number) => (s < -0.5 ? Math.max(0, Math.min(100, from + (100 * d) / s)) : from);
    onpan(tile.id, { x: along(drag.from.x, dx, slack.x), y: along(drag.from.y, dy, slack.y), ...(drag.from.z ? { z: drag.from.z } : {}) });
  }

  function up(e: PointerEvent) {
    if (drag && e.pointerId === drag.pointer) drag = null;
  }

  function dblclick(e: MouseEvent) {
    if (dragged) return;
    if (e.shiftKey && pannable) {
      // centered and not zoomed again
      if (tile.pan) onpan(tile.id, undefined);
      return;
    }
    onopen(tile);
  }

  function shiftKey(e: KeyboardEvent) {
    if (e.key === "Shift") shift = e.type === "keydown";
  }
</script>

<svelte:window onkeydown={shiftKey} onkeyup={shiftKey} onblur={() => (shift = false)} />

<div
  class="tile"
  class:leaving={tile.leaving}
  class:ring
  class:pinned={tile.pinned}
  class:whole={fit === "contain"}
  class:pan-ready={ring && shift && pannable}
  class:panning={ring && drag !== null}
  style:left="{tile.rect.x + gap / 2}px"
  style:top="{tile.rect.y + gap / 2}px"
  style:width="{Math.max(0, tile.rect.w - gap)}px"
  style:height="{Math.max(0, tile.rect.h - gap)}px"
  onpointerenter={() => onenter(tile)}
  onpointerleave={() => onleave(tile)}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={up}
  onlostpointercapture={up}
  ondblclick={dblclick}
  onwheel={wheel}
  role="presentation"
>
  {#each layers as layer (layer.key)}
    <div class="layer" class:shown={layer.shown}>
      <MediaView
        bind:this={views[layer.key]}
        media={layer.media}
        {fit}
        position={fit === "cover" ? (layer === top ? tile.pan : layer.pan) : undefined}
        zoom={fit === "cover" ? ((layer === top ? tile.pan : layer.pan)?.z ?? 1) : 1}
        muted={!unmuted || layer !== top}
        {volume}
        {rate}
        {paused}
        loop={tile.pinned || endless || !!tile.fixed}
        loopUntil={minVideo}
        onready={() => shown(layer)}
        onended={() => layer === top && fire()}
      />
    </div>
  {/each}
  {#if tile.pinned}<span class="badge nf" title="Pinned">{I.pin}</span>{/if}
  {#if unmuted && top?.media.kind === "video"}<span class="badge sound sound-mark nf">{I.volume}</span>{/if}
</div>

<style>
  .tile {
    position: absolute;
    overflow: hidden;
    border-radius: 3px;
    background: var(--bg-panel);
    transition:
      left var(--move) var(--ease),
      top var(--move) var(--ease),
      width var(--move) var(--ease),
      height var(--move) var(--ease),
      opacity 420ms ease;
    animation: arrive 520ms ease both;
    contain: strict;
  }
  @keyframes arrive {
    from { opacity: 0; }
  }
  .tile.leaving {
    opacity: 0;
    pointer-events: none;
  }
  /* an item shown whole sits on black, not on a panel color */
  .tile.whole {
    background: #000;
  }
  .tile::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 0 0 1px transparent;
    transition: box-shadow 160ms ease;
  }
  /* only with `ring` (hovered while the HUD is up), so the wall's hidden
     cursor stays hidden when the HUD fades */
  .tile.pan-ready {
    cursor: grab;
  }
  .tile.panning {
    cursor: grabbing;
  }
  .tile.ring::after {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--purple) 70%, transparent);
  }
  .tile.pinned::after {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--yellow) 70%, transparent);
  }
  .layer {
    position: absolute;
    inset: 0;
    opacity: 0;
    transition: opacity var(--fade) ease;
  }
  .layer.shown {
    opacity: 1;
  }
  .badge {
    position: absolute;
    top: 8px;
    right: 8px;
    font-size: 12px;
    color: var(--yellow);
    background: color-mix(in srgb, var(--bg-app) 70%, transparent);
    border-radius: var(--radius-sm);
    padding: 4px 5px;
    pointer-events: none;
  }
  .badge.sound {
    right: auto;
    left: 8px;
    color: var(--cyan);
  }
</style>
