<script lang="ts">
  // Stack mode's panes. The item is decoded once, by a MediaView under the
  // first pane, and every pane is a canvas drawn from it on each new video
  // frame, so the copies always show the same frame (coomplexer's mpv
  // `split` filter does the same). Turning, zoom and pan are applied in the
  // drawing. A new item cross-fades in once its first frame is drawn.
  //
  // Shift+wheel zooms toward the pointer and Shift+drag moves the picture,
  // in every pane at once; Shift+double-click puts it back.
  import { untrack } from "svelte";
  import MediaView from "./MediaView.svelte";
  import type { Rect } from "$lib/api";
  import type { Media } from "$lib/queue.svelte";
  import type { Pan } from "$lib/session";
  import type { Settings } from "$lib/settings.svelte";
  import { LOAD_LIMIT_MS, type StackController } from "$lib/stack.svelte";
  import { I } from "$lib/icons";

  interface Props {
    ctl: StackController;
    s: Settings;
    w: number;
    h: number;
    paused: boolean;
    unmuted: boolean;
    hudVisible: boolean;
    onhover: (m: Media | null) => void;
    onopen: (m: Media) => void;
  }

  let { ctl, s, w, h, paused, unmuted, hudVisible, onhover, onopen }: Props = $props();

  interface Layer {
    key: number;
    media: Media;
    shown: boolean;
    pan?: Pan;
  }

  const ZOOM_MAX = 8;
  let layers = $state<Layer[]>([]);
  const views: Record<number, MediaView> = {};
  /** each layer's pane canvases */
  const canvases = new Map<number, HTMLCanvasElement[]>();
  let hovered = $state(false);
  let elapsed = 0;

  $effect(() => {
    const m = ctl.item;
    untrack(() => {
      if (!m) return;
      const top = layers[layers.length - 1];
      if (top?.key === m.key) return;
      // the pan belongs to the item: the old one keeps its own while it fades
      if (top) top.pan = ctl.outgoingPan;
      const layer: Layer = { key: m.key, media: m, shown: false };
      layers.push(layer);
      elapsed = 0;
      // a stream that stalls without an error event would leave the old item up for ever
      setTimeout(() => {
        const live = layers.find((l) => l.key === layer.key);
        if (live && !live.shown && ctl.item?.key === m.key) ctl.failed(m, `it did not start within ${LOAD_LIMIT_MS / 1000} s`);
      }, LOAD_LIMIT_MS);
    });
  });

  const top = $derived(layers[layers.length - 1]);

  function geom(m: Media) {
    return ctl.geometry(m, { w, h });
  }

  /** draw the item into one pane: turned, zoomed and moved as set */
  function paint(cv: HTMLCanvasElement, src: CanvasImageSource, sw: number, sh: number, r: Rect, pan: Pan | undefined) {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.w * dpr));
    const H = Math.max(1, Math.round(r.h * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const turn = s.stackTurn;
    const q = turn % 180 === 90;
    // the pane in the item's own frame (before turning)
    const bw = q ? r.h : r.w;
    const bh = q ? r.w : r.h;
    const a = sw / sh;
    const wide = a > bw / bh;
    const mw = wide ? bh * a : bw;
    const mh = wide ? bh : bw / a;
    const z = pan?.z ?? 1;
    const px = (pan?.x ?? 50) / 100;
    const py = (pan?.y ?? 50) / 100;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.w, r.h);
    ctx.translate(r.w / 2, r.h / 2);
    ctx.rotate((turn * Math.PI) / 180);
    ctx.translate(-bw / 2, -bh / 2);
    ctx.drawImage(src, px * (bw - z * mw), py * (bh - z * mh), z * mw, z * mh);
  }

  function draw(layer: Layer): boolean {
    const el = views[layer.key]?.element();
    const cvs = canvases.get(layer.key);
    const g = geom(layer.media);
    if (!el || !cvs?.length || !g) return false;
    const sw = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const sh = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    if (!sw || !sh) return false;
    const pan = layer === top ? ctl.pan : layer.pan;
    cvs.forEach((cv, i) => g.panes[i] && paint(cv, el, sw, sh, g.panes[i], pan));
    return true;
  }

  /** the first frame is up: draw, fade in, and follow every new frame */
  function ready(layer: Layer) {
    const el = views[layer.key]?.element();
    if (el instanceof HTMLVideoElement && "requestVideoFrameCallback" in el) {
      const frame = () => {
        if (!layers.includes(layer)) return;
        draw(layer);
        el.requestVideoFrameCallback(frame);
      };
      el.requestVideoFrameCallback(frame);
    }
    draw(layer);
    layer.shown = true;
    setTimeout(() => {
      const i = layers.findIndex((l) => l.key === layer.key);
      if (i > 0) {
        for (const l of layers.slice(0, i)) canvases.delete(l.key);
        layers.splice(0, i);
      }
    }, 360);
  }

  // anything that changes the drawing without a new frame (a paused video,
  // an image): pan and zoom, turning, the panes, the window
  $effect(() => {
    void [ctl.pan?.x, ctl.pan?.y, ctl.pan?.z, s.stackTurn, s.stackPanes, s.stackDir, s.stackFill, s.gap, w, h];
    untrack(() => {
      // after the DOM has the canvases for a new pane count
      requestAnimationFrame(() => layers.forEach((l) => l.shown && draw(l)));
    });
  });

  // an image's time, counted while unpaused
  $effect(() => {
    const iv = setInterval(() => {
      if (paused || !top?.shown || top.media.kind !== "image") return;
      elapsed += 0.25;
      if (elapsed >= s.imageSeconds) {
        elapsed = 0;
        ctl.done();
      }
    }, 250);
    return () => clearInterval(iv);
  });

  function register(cv: HTMLCanvasElement, at: { key: number; i: number }) {
    const list = canvases.get(at.key) ?? [];
    list[at.i] = cv;
    canvases.set(at.key, list);
    return {
      destroy() {
        const l = canvases.get(at.key);
        if (l && l[at.i] === cv) l.length = Math.min(l.length, at.i);
      },
    };
  }

  // ---- Shift+wheel, Shift+drag
  /** the pointer in the item's own frame, for pane element `el` */
  function frame(e: { clientX: number; clientY: number }, el: Element) {
    const r = el.getBoundingClientRect();
    const t = (s.stackTurn * Math.PI) / 180;
    const q = s.stackTurn % 180 === 90;
    const bw = q ? r.height : r.width;
    const bh = q ? r.width : r.height;
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    return { x: Math.cos(t) * dx + Math.sin(t) * dy + bw / 2, y: -Math.sin(t) * dx + Math.cos(t) * dy + bh / 2, bw, bh };
  }

  function cover(bw: number, bh: number) {
    const a = ctl.item?.aspect ?? 1;
    const wide = a > bw / bh;
    return { w: wide ? bh * a : bw, h: wide ? bh : bw / a };
  }

  function wheel(e: WheelEvent) {
    if (!e.shiftKey || !ctl.item) return;
    e.preventDefault();
    const d = e.deltaY || e.deltaX;
    const pane = (e.target as Element).closest("canvas");
    if (!d || !pane) return;
    const f = frame(e, pane);
    const m = cover(f.bw, f.bh);
    const z = ctl.pan?.z ?? 1;
    const z2 = Math.max(1, Math.min(ZOOM_MAX, z * Math.pow(1.2, -d / 100)));
    if (Math.abs(z2 - z) < 1e-3) return;
    const from = ctl.pan ?? { x: 50, y: 50 };
    const axis = (T: number, M: number, p: number, c: number) => {
      const u = (c - p * (T - z * M)) / z;
      const s2 = T - z2 * M;
      return s2 < -0.5 ? Math.max(0, Math.min(1, (c - z2 * u) / s2)) : p;
    };
    const x = Math.round(axis(f.bw, m.w, from.x / 100, f.x) * 10000) / 100;
    const y = Math.round(axis(f.bh, m.h, from.y / 100, f.y) * 10000) / 100;
    ctl.setPan(z2 > 1.001 ? { x, y, z: Math.round(z2 * 1000) / 1000 } : x === 50 && y === 50 ? undefined : { x, y });
  }

  let drag = $state.raw<{ id: number; x: number; y: number; from: Pan; pane: Element } | null>(null);
  let dragged = false;

  function down(e: PointerEvent) {
    dragged = false;
    const pane = (e.target as Element).closest("canvas");
    if (!e.shiftKey || e.button !== 0 || !pane) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, from: { ...(ctl.pan ?? { x: 50, y: 50 }) }, pane };
  }

  function move(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.id) return;
    const t = (s.stackTurn * Math.PI) / 180;
    const sx = e.clientX - drag.x;
    const sy = e.clientY - drag.y;
    if (Math.abs(sx) + Math.abs(sy) > 3) dragged = true;
    // the movement in the item's own frame
    const dx = Math.cos(t) * sx + Math.sin(t) * sy;
    const dy = -Math.sin(t) * sx + Math.cos(t) * sy;
    const r = drag.pane.getBoundingClientRect();
    const q = s.stackTurn % 180 === 90;
    const bw = q ? r.height : r.width;
    const bh = q ? r.width : r.height;
    const m = cover(bw, bh);
    const z = drag.from.z ?? 1;
    const along = (from: number, d: number, slack: number) => (slack < -0.5 ? Math.max(0, Math.min(100, from + (100 * d) / slack)) : from);
    ctl.setPan({ x: along(drag.from.x, dx, bw - z * m.w), y: along(drag.from.y, dy, bh - z * m.h), ...(drag.from.z ? { z: drag.from.z } : {}) });
  }

  function up(e: PointerEvent) {
    if (drag && e.pointerId === drag.id) drag = null;
  }

  function dblclick(e: MouseEvent) {
    if (dragged || !ctl.item) return;
    if (e.shiftKey) return ctl.setPan(undefined);
    onopen(ctl.item);
  }

  function enter() {
    hovered = true;
    ctl.hovered = true;
    onhover(ctl.item);
  }
  function leave() {
    hovered = false;
    ctl.hovered = false;
    onhover(null);
  }

  // the HUD's hovered item follows a new item under a resting pointer
  $effect(() => {
    const m = ctl.item;
    if (untrack(() => hovered)) onhover(m);
  });
</script>

<div
  class="stack"
  class:grab={drag !== null}
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
    {@const g = geom(layer.media)}
    {#if g}
      <div class="layer" class:shown={layer.shown}>
        <!-- the one decoder, under the first pane's canvas -->
        <div class="src" style:left="{g.panes[0].x}px" style:top="{g.panes[0].y}px" style:width="{g.panes[0].w}px" style:height="{g.panes[0].h}px">
          <MediaView
            bind:this={views[layer.key]}
            media={layer.media}
            fit="contain"
            muted={!unmuted || layer !== top}
            volume={s.volume / 100}
            rate={s.rate}
            {paused}
            loop={ctl.pinned || ctl.one}
            loopUntil={s.minVideoSeconds}
            onready={() => ready(layer)}
            onended={() => layer === top && ctl.done()}
            onerror={(why) => {
              const el = views[layer.key]?.element();
              ctl.failed(layer.media, why, el instanceof HTMLVideoElement && Number.isFinite(el.currentTime) ? el.currentTime : 0);
            }}
          />
        </div>
        {#each g.panes as r, i (i)}
          <canvas
            use:register={{ key: layer.key, i }}
            class="pane"
            class:ring={hudVisible && hovered && layer === top}
            class:pinned={ctl.pinned && layer === top}
            style:left="{r.x}px"
            style:top="{r.y}px"
            style:width="{r.w}px"
            style:height="{r.h}px"
            onpointerenter={enter}
            onpointerleave={leave}
          ></canvas>
        {/each}
        {#if layer === top && ctl.pinned}<span class="badge nf" style:left="{g.panes[g.panes.length - 1].x + g.panes[g.panes.length - 1].w - 30}px" style:top="{g.panes[g.panes.length - 1].y + 8}px">{I.pin}</span>{/if}
        {#if layer === top && unmuted && layer.media.kind === "video"}<span class="badge sound sound-mark nf" style:left="{g.panes[0].x + 8}px" style:top="{g.panes[0].y + 8}px">{I.volume}</span>{/if}
      </div>
    {/if}
  {/each}

  {#if ctl.status}
    <div class="status">
      <span class="nf" class:spin={!!ctl.progress}>{ctl.progress ? I.refresh : I.layers}</span>
      <span class="s-main">{ctl.status}</span>
      {#if ctl.progress}<span class="s-sub">{ctl.progress}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .stack {
    position: absolute;
    inset: 0;
  }
  .stack.grab {
    cursor: grabbing;
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
  .src {
    position: absolute;
    overflow: hidden;
  }
  .pane {
    position: absolute;
    display: block;
    border-radius: 3px;
    background: #000;
    transition:
      left var(--move) var(--ease),
      top var(--move) var(--ease),
      width var(--move) var(--ease),
      height var(--move) var(--ease),
      box-shadow 160ms ease;
  }
  .pane.ring {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--purple) 70%, transparent), 0 0 0 1px color-mix(in srgb, var(--purple) 70%, transparent);
  }
  .pane.pinned {
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--yellow) 70%, transparent);
  }
  .badge {
    position: absolute;
    font-size: 12px;
    color: var(--yellow);
    background: color-mix(in srgb, var(--bg-app) 70%, transparent);
    border-radius: var(--radius-sm);
    padding: 4px 5px;
    pointer-events: none;
  }
  .badge.sound {
    color: var(--cyan);
  }
  .status {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-secondary);
    pointer-events: none;
  }
  .status .nf {
    font-size: 20px;
    color: var(--purple);
  }
  .spin {
    animation: spin 1.4s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .s-main {
    font-size: 14px;
    max-width: 70vw;
    text-align: center;
  }
  .s-sub {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-muted);
  }
</style>
