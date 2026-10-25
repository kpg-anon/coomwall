<script lang="ts">
  // One image or video, filling its box. Reports `onready` once its first
  // frame is decoded (so a tile can fade it in without showing an empty
  // frame) and `onended` when a video ends for good.
  import type { Media } from "$lib/queue.svelte";

  interface Props {
    media: Media;
    fit?: "cover" | "contain";
    muted?: boolean;
    volume?: number;
    rate?: number;
    paused?: boolean;
    /** native loop, no end event (feeds, pinned tiles) */
    loop?: boolean;
    /** keep replaying a short clip until it has played this many seconds */
    loopUntil?: number;
    onready?: () => void;
    onended?: () => void;
  }

  let {
    media,
    fit = "cover",
    muted = true,
    volume = 0.6,
    rate = 1,
    paused = false,
    loop = false,
    loopUntil = 0,
    onready,
    onended,
  }: Props = $props();

  let video = $state<HTMLVideoElement>();
  let played = 0;
  let lastTime = 0;
  let readyFired = false;

  function ready() {
    if (readyFired) return;
    readyFired = true;
    onready?.();
  }

  /** play a video again from the start (the watched tile holding its item) */
  export function replay() {
    if (!video) return;
    lastTime = 0;
    video.currentTime = 0;
    video.play().catch(() => {});
  }

  $effect(() => {
    if (!video) return;
    video.muted = muted;
    video.volume = Math.max(0, Math.min(1, volume));
  });

  $effect(() => {
    if (!video) return;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
  });

  $effect(() => {
    if (!video) return;
    if (paused) video.pause();
    else video.play().catch(() => {});
  });

  // Release the decoder when the element goes away. Without this, a long
  // session leaks one decoder per video it has ever shown.
  $effect(() => {
    const v = video;
    return () => {
      if (!v) return;
      v.pause();
      v.removeAttribute("src");
      v.load();
    };
  });

  function loaded() {
    const v = video!;
    if ("requestVideoFrameCallback" in v) v.requestVideoFrameCallback(() => ready());
    else ready();
    // a paused or hidden video may never present a frame
    setTimeout(ready, 1200);
  }

  function time() {
    const t = video!.currentTime;
    const d = t - lastTime;
    if (d > 0 && d < 2) played += d;
    lastTime = t;
  }

  function ended() {
    if (played < loopUntil) {
      lastTime = 0;
      video!.currentTime = 0;
      video!.play().catch(() => {});
      return;
    }
    onended?.();
  }

  function failed() {
    ready();
    onended?.();
  }
</script>

{#if media.kind === "image"}
  <img src={media.url} alt="" draggable="false" decoding="async" style:object-fit={fit} onload={ready} onerror={failed} />
{:else}
  <video
    bind:this={video}
    src={media.url}
    muted
    autoplay={!paused}
    playsinline
    disablepictureinpicture
    preload="auto"
    {loop}
    style:object-fit={fit}
    onloadeddata={loaded}
    ontimeupdate={time}
    onended={ended}
    onerror={failed}
  ></video>
{/if}

<style>
  img,
  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    pointer-events: none;
  }
</style>
