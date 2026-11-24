<script lang="ts">
  // The center item in a Ribbon or Cascade wall: it spans the middle lanes,
  // which are split to end at its edges (FeedController.build), so it sits in
  // the wall like any tile. In Mosaic, Dynamic and Grid it is one of their
  // tiles and Tile draws it.
  import MediaView from "./MediaView.svelte";
  import type { Rect } from "$lib/api";
  import type { Media } from "$lib/queue.svelte";
  import { I } from "$lib/icons";

  interface Props {
    media: Media;
    rect: Rect;
    paused: boolean;
    unmuted: boolean;
    volume: number;
    rate: number;
    ring: boolean;
    seekbar?: boolean;
    onenter: (m: Media) => void;
    onleave: (m: Media) => void;
    onopen: (m: Media) => void;
  }

  let { media, rect, paused, unmuted, volume, rate, ring, seekbar = false, onenter, onleave, onopen }: Props = $props();

  let shown = $state(false);
</script>

<div
  class="center"
  class:ring
  class:shown
  style:left="{rect.x}px"
  style:top="{rect.y}px"
  style:width="{rect.w}px"
  style:height="{rect.h}px"
  onpointerenter={() => onenter(media)}
  onpointerleave={() => onleave(media)}
  ondblclick={() => onopen(media)}
  role="presentation"
>
  {#key media.key}
    <MediaView {media} muted={!unmuted} {volume} {rate} {paused} loop onready={() => (shown = true)} {seekbar} />
  {/key}
  {#if unmuted && media.kind === "video"}<span class="badge sound-mark nf">{I.volume}</span>{/if}
</div>

<style>
  .center {
    position: absolute;
    overflow: hidden;
    border-radius: 3px;
    background: var(--bg-panel);
    opacity: 0;
    transition:
      opacity 420ms ease,
      left var(--move) var(--ease),
      top var(--move) var(--ease),
      width var(--move) var(--ease),
      height var(--move) var(--ease);
  }
  .center.shown {
    opacity: 1;
  }
  .center::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 0 0 1px transparent;
    transition: box-shadow 160ms ease;
  }
  .center.ring::after {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--purple) 70%, transparent);
  }
  .badge {
    position: absolute;
    top: 8px;
    left: 8px;
    font-size: 12px;
    color: var(--cyan);
    background: color-mix(in srgb, var(--bg-app) 70%, transparent);
    border-radius: var(--radius-sm);
    padding: 4px 5px;
    pointer-events: none;
  }
</style>
