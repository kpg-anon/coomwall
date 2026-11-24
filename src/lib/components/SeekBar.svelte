<script lang="ts">
  // A thin bar along the bottom of a video on the wall, shown while the
  // pointer is over it: how far the video has played, and a click or drag on
  // it jumps there. The viewer (F) has its own controls.
  interface Props {
    video: HTMLVideoElement | undefined;
  }

  let { video }: Props = $props();

  let bar = $state<HTMLDivElement>();
  let now = $state(0);
  let length = $state(0);
  /** the pointer's place along the bar, 0..1; null when it is not over it */
  let at = $state<number | null>(null);
  let dragging = $state(false);
  /** a seek asked for while the video was still busy with the last one */
  let pending: number | null = null;

  // follows playback every frame while shown
  $effect(() => {
    const v = video;
    if (!v) return;
    let raf = 0;
    const tick = () => {
      if (!dragging) now = v.currentTime;
      length = Number.isFinite(v.duration) ? v.duration : 0;
      raf = requestAnimationFrame(tick);
    };
    tick();
    // a drag sends a seek per pointer move; only the latest one waiting is kept
    const seeked = () => {
      if (pending === null) return;
      const t = pending;
      pending = null;
      v.currentTime = t;
    };
    v.addEventListener("seeked", seeked);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("seeked", seeked);
    };
  });

  function place(e: PointerEvent): number {
    const r = bar!.getBoundingClientRect();
    return r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
  }

  function seek(f: number) {
    const v = video;
    if (!v || !length) return;
    // not the very end: an ended video is replaced on most tiles
    const t = Math.min(f * length, Math.max(0, length - 0.25));
    now = t;
    if (v.seeking) pending = t;
    else v.currentTime = t;
  }

  function down(e: PointerEvent) {
    // Shift+drag moves the picture in a pinned or centered tile, also from here
    if (e.button !== 0 || e.shiftKey) return;
    // a plain press is a seek, not the start of anything on the tile
    e.stopPropagation();
    e.preventDefault();
    bar!.setPointerCapture(e.pointerId);
    dragging = true;
    seek(place(e));
  }

  function move(e: PointerEvent) {
    at = place(e);
    if (dragging) seek(at);
  }

  function up() {
    dragging = false;
  }

  function clock(t: number): string {
    if (!Number.isFinite(t)) return "0:00";
    const s = Math.floor(t);
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
  }
</script>

{#if video && length > 0}
  <div
    bind:this={bar}
    class="seekbar"
    class:active={at !== null || dragging}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onlostpointercapture={up}
    onpointerleave={() => (at = null)}
    ondblclick={(e) => e.stopPropagation()}
    role="slider"
    aria-label="Seek"
    aria-valuemin={0}
    aria-valuemax={Math.round(length)}
    aria-valuenow={Math.round(now)}
    tabindex="-1"
  >
    <div class="track"><div class="fill" style:width="{(now / length) * 100}%"></div></div>
    {#if at !== null || dragging}
      <!-- kept inside the tile near either end -->
      <span class="time" style:left="clamp(52px, {(dragging ? now / length : (at ?? 0)) * 100}%, calc(100% - 52px))">{clock(dragging ? now : (at ?? 0) * length)} / {clock(length)}</span>
    {/if}
  </div>
{/if}

<style>
  .seekbar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    /* the strip that takes the pointer is taller than the line it draws */
    height: 22px;
    display: flex;
    align-items: flex-end;
    cursor: pointer;
    z-index: 2;
    touch-action: none;
  }
  .track {
    width: 100%;
    height: 4px;
    background: color-mix(in srgb, var(--bg-app) 55%, transparent);
    transition: height 120ms ease;
  }
  .seekbar.active .track {
    height: 8px;
  }
  .fill {
    height: 100%;
    background: var(--purple);
  }
  .time {
    position: absolute;
    bottom: 12px;
    transform: translateX(-50%);
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-primary);
    background: color-mix(in srgb, var(--bg-app) 80%, transparent);
    border-radius: var(--radius-sm);
    padding: 2px 6px;
    pointer-events: none;
  }
</style>
