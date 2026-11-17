<script lang="ts">
  // One item, whole and uncropped, over the wall (F, double-click). The wheel
  // zooms toward the pointer, a drag pans, a double-click zooms in and back.
  // A video gets a bar: play, seek, time, sound. It starts where the tile
  // was. The wall pauses underneath unless pauseBehindViewer is off.
  //
  // Zoom, pan and turn are written straight to style.transform, so a drag
  // does not re-render anything.
  import { onMount } from "svelte";
  import type { Media } from "$lib/queue.svelte";
  import { I } from "$lib/icons";
  import { followVideo } from "$lib/audiosync";

  interface Props {
    media: Media;
    /** seconds into the video to start at (where the tile was) */
    time: number;
    muted: boolean;
    /** 0-100 */
    volume: number;
    rate: number;
    /** the controls are shown (the pointer moved a moment ago) */
    chrome: boolean;
    /** the top bar and the key list never show (Preferences); the keys still work */
    noBars?: boolean;
    /** a video's controls never show (Preferences) */
    noControls?: boolean;
    onclose: () => void;
    onsound: () => void;
    onvolume: (v: number) => void;
  }

  let { media, time, muted, volume, rate, chrome, noBars = false, noControls = false, onclose, onsound, onvolume }: Props = $props();

  const MAX_ZOOM = 16;
  const MARGIN = 28;

  let stage = $state<HTMLDivElement>();
  let xf = $state<HTMLDivElement>();
  let video = $state<HTMLVideoElement>();
  /** a streamed link's separate sound, following the video */
  let audio = $state<HTMLAudioElement>();
  let sw = $state(0);
  let sh = $state(0);
  let shown = $state(false);
  let playing = $state(true);
  let now = $state(0);
  let length = $state(0);
  let scrubbing = $state(false);
  /** quarter turns clockwise, counted without wrapping: the CSS transition
   * runs from the old angle to the new one, so 270° to 0° would spin back
   * three quarters. Counting on (270° to 360°) keeps every turn one quarter
   * forward. */
  let turns = $state(0);
  let flipped = $state(false);
  /** shown in the bar; the live value is `z` */
  let zoomShown = $state(1);

  let z = 1;
  let pan = { x: 0, y: 0 };
  let dragging = false;
  let dragged = false;
  let last = { x: 0, y: 0 };
  let frame = 1 / 30;
  let clickTimer: ReturnType<typeof setTimeout> | undefined;

  const isVideo = $derived(media.kind === "video");
  /** the video's controls are drawn at all */
  const controls = $derived(isVideo && !noControls);
  /** the bars are up; a paused or scrubbed video keeps them up. With every
   * part hidden they never are, so the pointer hides on the wall's timer. */
  const bars = $derived((!noBars || controls) && (chrome || scrubbing || !playing));
  const sideways = $derived(turns % 2 !== 0);
  // the size at which the whole item fits the stage, turned or not
  const fit = $derived.by(() => {
    const [w, h] = sideways ? [media.h, media.w] : [media.w, media.h];
    const k = Math.min(Math.max(1, sw - MARGIN * 2) / w, Math.max(1, sh - MARGIN * 2) / h);
    return { w: media.w * k, h: media.h * k, k };
  });

  function apply(animate = false) {
    if (!xf) return;
    xf.style.transition = animate ? "transform 160ms ease-out" : "none";
    xf.style.transform = `scale(${z}) translate(${pan.x}px, ${pan.y}px)`;
    zoomShown = z;
  }

  /** zoom to `next`, keeping the point under (cx, cy) where it is */
  function zoomAt(next: number, cx: number, cy: number, animate = false) {
    next = Math.max(1, Math.min(MAX_ZOOM, next));
    if (next <= 1.001) {
      z = 1;
      pan = { x: 0, y: 0 };
      return apply(animate);
    }
    const r = stage!.getBoundingClientRect();
    const dx = cx - (r.left + r.width / 2);
    const dy = cy - (r.top + r.height / 2);
    pan = { x: pan.x + dx * (1 / next - 1 / z), y: pan.y + dy * (1 / next - 1 / z) };
    z = next;
    clamp();
    apply(animate);
  }

  /** keep at least a third of the stage covered: the item cannot be lost off screen */
  function clamp() {
    const [w, h] = sideways ? [fit.h, fit.w] : [fit.w, fit.h];
    const mx = Math.max(0, (w * z) / 2 - sw / 6) / z;
    const my = Math.max(0, (h * z) / 2 - sh / 6) / z;
    pan = { x: Math.max(-mx, Math.min(mx, pan.x)), y: Math.max(-my, Math.min(my, pan.y)) };
  }

  function reset(animate = true) {
    z = 1;
    pan = { x: 0, y: 0 };
    apply(animate);
  }

  function middle(): [number, number] {
    const r = stage!.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  }

  /** the zoom at which one media pixel is one screen pixel */
  function actual(): number {
    return Math.max(1, Math.min(MAX_ZOOM, 1 / (fit.k * devicePixelRatio)));
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    zoomAt(z * Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY);
  }

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    dragged = false;
    last = { x: e.clientX, y: e.clientY };
    xf?.setPointerCapture(e.pointerId);
    if (xf) xf.style.cursor = "grabbing";
  }

  function move(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
    last = { x: e.clientX, y: e.clientY };
    if (z <= 1) return;
    pan = { x: pan.x + dx / z, y: pan.y + dy / z };
    clamp();
    apply();
  }

  function up() {
    if (!dragging) return;
    dragging = false;
    if (xf) xf.style.cursor = "";
    // A click that was not a drag plays or pauses the video. It waits for
    // the double-click time first, so zooming does not also pause.
    if (!dragged && isVideo) {
      clearTimeout(clickTimer);
      clickTimer = setTimeout(toggle, 230);
    }
  }

  function dbl(e: MouseEvent) {
    e.stopPropagation();
    clearTimeout(clickTimer);
    if (z > 1.001) reset();
    else zoomAt(Math.max(2.5, actual()), e.clientX, e.clientY, true);
  }

  function toggle() {
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function seekBy(seconds: number) {
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(video.duration - 0.05, video.currentTime + seconds));
    now = video.currentTime;
  }

  function turn() {
    turns += 1;
    reset(false);
  }

  /** Keys while the viewer is open. Returns true when the key was used here. */
  export function key(e: KeyboardEvent): boolean {
    const k = e.key;
    const lower = k.toLowerCase();
    if (k === "Escape" || lower === "f") onclose();
    else if (k === " ") toggle();
    else if (k === "ArrowLeft") seekBy(e.shiftKey ? -1 : -5);
    else if (k === "ArrowRight") seekBy(e.shiftKey ? 1 : 5);
    else if (k === "ArrowUp") onvolume(Math.min(100, volume + 5));
    else if (k === "ArrowDown") onvolume(Math.max(0, volume - 5));
    else if (k === "," || k === "<") {
      if (video?.paused) seekBy(-frame);
    } else if (k === "." || k === ">") {
      if (video?.paused) seekBy(frame);
    } else if (k === "+" || k === "=") zoomAt(z * 1.25, ...middle(), true);
    else if (k === "-" || k === "_") zoomAt(z / 1.25, ...middle(), true);
    else if (k === "0") reset();
    else if (lower === "z") {
      if (z > 1.001) reset();
      else zoomAt(actual(), ...middle(), true);
    } else if (lower === "r") turn();
    else if (lower === "x") flipped = !flipped;
    else return false;
    e.preventDefault();
    return true;
  }

  function clock(t: number): string {
    if (!Number.isFinite(t)) return "0:00";
    const s = Math.floor(t);
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  $effect(() => {
    if (!video) return;
    video.muted = muted || !!audio;
    video.volume = Math.max(0, Math.min(1, volume / 100));
    if (audio) {
      audio.muted = muted;
      audio.volume = Math.max(0, Math.min(1, volume / 100));
    }
  });

  $effect(() => {
    if (!video || !audio) return;
    const a = audio;
    const stop = followVideo(video, a);
    return () => {
      stop();
      a.removeAttribute("src");
      a.load();
    };
  });

  $effect(() => {
    if (!video) return;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
  });

  // the seek bar follows playback every frame; the real frame length is
  // measured for the , and . keys
  $effect(() => {
    const v = video;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      if (!scrubbing) now = v.currentTime;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    let id = 0;
    let before = -1;
    const onFrame = (_: number, meta: VideoFrameCallbackMetadata) => {
      const d = meta.mediaTime - before;
      if (before >= 0 && d > 0 && d < 0.2) frame = d;
      before = meta.mediaTime;
      id = v.requestVideoFrameCallback(onFrame);
    };
    if ("requestVideoFrameCallback" in v) id = v.requestVideoFrameCallback(onFrame);
    return () => {
      cancelAnimationFrame(raf);
      if (id) v.cancelVideoFrameCallback(id);
      // release the decoder
      v.pause();
      v.removeAttribute("src");
      v.load();
    };
  });

  // a new stage size (the window moved to another display) keeps the item fitted
  $effect(() => {
    sw;
    sh;
    clamp();
    apply();
  });

  onMount(() => {
    // non-passive, so the wheel never scrolls anything behind
    const el = stage!;
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", wheel);
      clearTimeout(clickTimer);
    };
  });

  function meta() {
    if (!video) return;
    length = video.duration;
    if (time > 0 && Number.isFinite(video.duration) && time < video.duration - 0.25) video.currentTime = time;
  }
</script>

<div class="viewer" class:bare={!bars} role="presentation">
  <div class="stage" bind:this={stage} bind:clientWidth={sw} bind:clientHeight={sh} onclick={(e) => e.target === stage && onclose()} role="presentation">
    <div
      class="xf"
      class:zoomed={zoomShown > 1.001}
      bind:this={xf}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      ondblclick={dbl}
      role="presentation"
    >
      <div class="turn" class:shown style:width="{fit.w}px" style:height="{fit.h}px" style:transform="rotate({turns * 90}deg) scaleX({flipped ? -1 : 1})">
        {#if isVideo}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video
            bind:this={video}
            src={media.url}
            autoplay
            loop
            playsinline
            disablepictureinpicture
            onloadedmetadata={meta}
            onloadeddata={() => (shown = true)}
            onerror={() => (shown = true)}
            onplay={() => (playing = true)}
            onpause={() => (playing = false)}
          ></video>
          {#if media.audioUrl}<audio bind:this={audio} src={media.audioUrl} preload="auto" loop></audio>{/if}
        {:else}
          <img src={media.url} alt="" draggable="false" onload={() => (shown = true)} onerror={() => (shown = true)} />
        {/if}
      </div>
    </div>
  </div>

  {#if !noBars || controls}
  <div class="chrome" class:on={bars} class:no-keys={noBars}>
    {#if !noBars}
    <div class="top">
      <span class="name" title={media.path}>{media.name}</span>
      <span class="dim">{media.w}×{media.h}</span>
      {#if zoomShown > 1.001}<span class="dim">{zoomShown.toFixed(zoomShown < 10 ? 1 : 0)}×</span>{/if}
      <span class="spacer"></span>
      <button class="tool nf" title="Turn a quarter (R)" onclick={turn}>{I.rotate}</button>
      <button class="tool nf" title="Mirror (X)" class:lit={flipped} onclick={() => (flipped = !flipped)}>{I.flip}</button>
      <button class="tool nf" title="Fit the screen (0)" disabled={zoomShown <= 1.001} onclick={() => reset()}>{I.compress}</button>
      <button class="tool nf close" title="Close (Esc)" onclick={onclose}>{I.close}</button>
    </div>
    {/if}

    {#if controls}
      <div class="bar">
        <button class="tool nf" title={playing ? "Pause (Space)" : "Play (Space)"} onclick={toggle}>{playing ? I.pause : I.play}</button>
        <span class="time">{clock(now)}</span>
        <input
          class="seek"
          type="range"
          min="0"
          max={Number.isFinite(length) && length > 0 ? length : 1}
          step="0.01"
          value={now}
          style:--pct="{length > 0 ? (now / length) * 100 : 0}%"
          onpointerdown={() => (scrubbing = true)}
          onpointerup={() => (scrubbing = false)}
          oninput={(e) => {
            now = Number(e.currentTarget.value);
            if (video) video.currentTime = now;
          }}
          aria-label="Position"
        />
        <span class="time">{clock(length)}</span>
        <button class="tool nf" class:lit={!muted} title={muted ? "Sound on (M)" : "Sound off (M)"} onclick={onsound}>{muted ? I.mute : I.volume}</button>
        <input
          class="seek vol"
          type="range"
          min="0"
          max="100"
          step="1"
          value={volume}
          style:--pct="{volume}%"
          oninput={(e) => onvolume(Number(e.currentTarget.value))}
          aria-label="Volume"
        />
      </div>
    {/if}

    {#if !noBars}
    <div class="keys">
      <span><kbd>wheel</kbd> zoom</span>
      <span><kbd>drag</kbd> pan</span>
      <span><kbd>Z</kbd> actual size</span>
      <span><kbd>0</kbd> fit</span>
      <span><kbd>R</kbd> turn</span>
      <span><kbd>X</kbd> mirror</span>
      {#if isVideo}
        <span><kbd>Space</kbd> play</span>
        <span><kbd>←</kbd><kbd>→</kbd> 5 s</span>
        <span><kbd>,</kbd><kbd>.</kbd> frame</span>
        <span><kbd>[</kbd><kbd>]</kbd> speed</span>
        <span><kbd>M</kbd> sound</span>
      {/if}
      <span><kbd>Esc</kbd> close</span>
    </div>
    {/if}
  </div>
  {/if}
</div>

<style>
  .viewer {
    position: absolute;
    inset: 0;
    z-index: 30;
    /* neutral black: the item is judged against no color of the theme */
    background: rgba(0, 0, 0, 0.9);
    animation: in 180ms ease both;
    /* shown while the bars are up, even when the wall's own timer has
       hidden it (a paused video keeps the bars up) */
    cursor: default;
  }
  /* Hidden exactly while the bars are, over the item and the background.
     Only while the wall allows hiding (not with help or a menu open).
     !important beats .xf's grab cursor and the inline one set by a drag. */
  :global(.wall.hide-cursor) .viewer.bare,
  :global(.wall.hide-cursor) .viewer.bare * {
    cursor: none !important;
  }
  @keyframes in {
    from { opacity: 0; }
  }
  .stage {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
  }
  .xf {
    will-change: transform;
    cursor: default;
    touch-action: none;
  }
  .xf.zoomed {
    cursor: grab;
  }
  .turn {
    opacity: 0;
    transition: opacity 200ms ease, transform 160ms ease-out;
  }
  .turn.shown {
    opacity: 1;
  }
  img,
  video {
    display: block;
    width: 100%;
    height: 100%;
    pointer-events: none;
    border-radius: 2px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  }
  .chrome {
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0;
    transition: opacity 240ms ease;
  }
  .chrome.on {
    opacity: 1;
  }
  .top,
  .bar,
  .keys {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-secondary);
  }
  /* the three bars look the same: same panel, same opacity, no blur */
  .top,
  .bar,
  .keys {
    padding: 6px 10px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--bg-panel) 88%, transparent);
    border: 1px solid var(--border);
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.4);
  }
  .chrome.on .top,
  .chrome.on .bar {
    pointer-events: auto;
  }
  .top {
    top: 12px;
    left: 12px;
    right: 12px;
  }
  .name {
    color: var(--text-primary);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .dim {
    color: var(--text-muted);
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .bar {
    left: 50%;
    /* above the keys bar */
    bottom: 58px;
    transform: translateX(-50%);
    width: min(760px, calc(100% - 24px));
  }
  /* no key list below it */
  .no-keys .bar {
    bottom: 12px;
  }
  .keys {
    left: 12px;
    right: 12px;
    bottom: 12px;
    justify-content: center;
    gap: 16px;
    font-family: var(--sans);
    color: var(--text-muted);
  }
  .keys span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .keys kbd {
    font-size: 10px;
  }
  .tool {
    display: grid;
    place-items: center;
    flex: none;
    width: 26px;
    height: 24px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }
  .tool:hover:not(:disabled) {
    border-color: var(--purple);
    color: var(--text-primary);
  }
  .tool:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tool.lit {
    color: var(--cyan);
  }
  .tool.close:hover {
    border-color: var(--red);
    color: var(--red);
  }
  .time {
    min-width: 38px;
    text-align: center;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
  .seek {
    flex: 1;
    min-width: 0;
    height: 14px;
    margin: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }
  .seek.vol {
    flex: none;
    width: 84px;
  }
  .seek::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--purple) var(--pct), var(--border) var(--pct));
  }
  .seek.vol::-webkit-slider-runnable-track {
    background: linear-gradient(to right, var(--cyan) var(--pct), var(--border) var(--pct));
  }
  .seek::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--text-primary);
    border: 0;
  }
</style>
