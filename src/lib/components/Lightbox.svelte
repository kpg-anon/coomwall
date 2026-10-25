<script lang="ts">
  // One item, whole and uncropped, over the wall. The wall pauses underneath
  // (unless the pauseBehindViewer setting is off); closing returns to it
  // unchanged.
  import MediaView from "./MediaView.svelte";
  import type { Media } from "$lib/queue.svelte";

  interface Props {
    media: Media;
    muted: boolean;
    volume: number;
    rate: number;
    paused: boolean;
    onclose: () => void;
  }

  let { media, muted, volume, rate, paused, onclose }: Props = $props();
  let shown = $state(false);
</script>

<div class="box" onclick={onclose} ondblclick={onclose} role="presentation">
  <div class="stage" class:shown>
    <MediaView {media} fit="contain" {muted} {volume} {rate} {paused} loop onready={() => (shown = true)} />
  </div>
  <div class="caption">
    <span class="name">{media.name}</span>
    <span class="dim">{media.w}×{media.h}</span>
  </div>
</div>

<style>
  .box {
    position: absolute;
    inset: 0;
    z-index: 30;
    background: color-mix(in srgb, var(--bg-app) 88%, transparent);
    backdrop-filter: blur(6px);
    animation: in 220ms ease both;
  }
  @keyframes in {
    from { opacity: 0; }
  }
  .stage {
    position: absolute;
    inset: 28px 28px 56px;
    opacity: 0;
    transform: scale(0.985);
    transition: opacity 240ms ease, transform 320ms var(--ease);
  }
  .stage.shown {
    opacity: 1;
    transform: none;
  }
  .caption {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 18px;
    display: flex;
    justify-content: center;
    gap: 12px;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-secondary);
  }
  .dim {
    color: var(--text-muted);
  }
</style>
