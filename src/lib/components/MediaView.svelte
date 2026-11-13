<script lang="ts">
  // One image or video, filling its box. Reports `onready` once its first
  // frame is decoded (so a tile can fade it in without showing an empty
  // frame) and `onended` when a video ends for good.
  import type { Media } from "$lib/queue.svelte";

  interface Props {
    media: Media;
    fit?: "cover" | "contain";
    /** object-position in percent; centered when absent */
    position?: { x: number; y: number };
    /** zoomed in this far (1: not zoomed), about the same point as `position` */
    zoom?: number;
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
    position,
    zoom = 1,
    muted = true,
    volume = 0.6,
    rate = 1,
    paused = false,
    loop = false,
    loopUntil = 0,
    onready,
    onended,
  }: Props = $props();

  const objectPosition = $derived(position ? `${position.x}% ${position.y}%` : undefined);
  // Scaling about the point object-position lines up (x% of the item on x%
  // of the box) keeps that point still, so the zoomed item still covers the
  // box for any position from 0 to 100%: the item's edge moves to
  // (T - z*M) * x%, which is <= 0 whenever z*M >= T.
  const transform = $derived(zoom > 1.001 ? `scale(${zoom})` : undefined);
  const origin = $derived(zoom > 1.001 ? (objectPosition ?? "50% 50%") : undefined);

  let video = $state<HTMLVideoElement>();
  let image = $state<HTMLImageElement>();
  /** a streamed link's separate sound (media.audioUrl), kept in step with the video */
  let audio = $state<HTMLAudioElement>();

  /** the <video> or <img>, for Stack to draw its panes from */
  export function element(): HTMLVideoElement | HTMLImageElement | undefined {
    return video ?? image;
  }
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
    // with a separate sound stream the video itself stays silent
    video.muted = muted || !!audio;
    video.volume = Math.max(0, Math.min(1, volume));
    if (audio) {
      audio.muted = muted;
      audio.volume = Math.max(0, Math.min(1, volume));
    }
  });

  $effect(() => {
    if (!video) return;
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
    if (audio) {
      audio.defaultPlaybackRate = rate;
      audio.playbackRate = rate;
    }
  });

  $effect(() => {
    if (!video) return;
    if (paused) video.pause();
    else video.play().catch(() => {});
  });

  /** the sound follows the picture: playing, paused, and within 0.3 s */
  function follow() {
    if (!audio || !video) return;
    if (Math.abs(audio.currentTime - video.currentTime) > 0.3) audio.currentTime = video.currentTime;
    if (video.paused || video.readyState < 3) {
      if (!audio.paused) audio.pause();
    } else if (audio.paused) audio.play().catch(() => {});
  }

  $effect(() => {
    const a = audio;
    return () => {
      if (!a) return;
      a.pause();
      a.removeAttribute("src");
      a.load();
    };
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

  /** a resumed video carries on where it was saved (not at its very end) */
  function meta() {
    const v = video!;
    const at = media.start ?? 0;
    if (at > 0 && Number.isFinite(v.duration) && at < v.duration - 0.25) {
      v.currentTime = at;
      lastTime = at;
    }
  }

  function time() {
    follow();
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
  <img bind:this={image} src={media.url} alt="" draggable="false" decoding="async" data-key={media.key} style:object-fit={fit} style:object-position={objectPosition} style:transform={transform} style:transform-origin={origin} onload={ready} onerror={failed} />
{:else}
  <video
    bind:this={video}
    src={media.url}
    data-key={media.key}
    muted
    autoplay={!paused}
    playsinline
    disablepictureinpicture
    preload="auto"
    {loop}
    style:object-fit={fit}
    style:object-position={objectPosition}
    style:transform={transform}
    style:transform-origin={origin}
    onloadedmetadata={meta}
    onloadeddata={loaded}
    ontimeupdate={time}
    onended={ended}
    onerror={failed}
    onplay={follow}
    onpause={follow}
    onseeked={follow}
    onwaiting={follow}
    onplaying={follow}
  ></video>
  {#if media.audioUrl}
    <audio bind:this={audio} src={media.audioUrl} preload="auto" {loop}></audio>
  {/if}
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
