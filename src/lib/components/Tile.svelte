<script lang="ts">
  // One Mosaic tile. Its rectangle comes from the solver and animates with a
  // CSS transition; its content cross-fades: the next item loads in a layer
  // on top and only fades in once its first frame is ready.
  import { untrack } from "svelte";
  import MediaView from "./MediaView.svelte";
  import type { TileState } from "$lib/mosaic.svelte";
  import type { Media } from "$lib/queue.svelte";
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
    maxVideo: number;
    ring: boolean;
    /** under the pointer: an ended item plays again (twice) before it is replaced */
    watched: boolean;
    /** Dynamic: videos loop and images stay; the controller's clock replaces them */
    endless: boolean;
    ondone: (id: number) => void;
    onenter: (tile: TileState) => void;
    onleave: (tile: TileState) => void;
    onopen: (tile: TileState) => void;
  }

  let { tile, gap, paused, unmuted, volume, rate, imageSeconds, minVideo, maxVideo, ring, watched, endless, ondone, onenter, onleave, onopen }: Props = $props();

  interface Layer {
    key: number;
    media: Media;
    shown: boolean;
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
    if (tile.pinned || (watched && holds < HOLDS)) {
      if (!tile.pinned) holds++;
      elapsed = 0;
      if (top?.media.kind === "video") views[top.key]?.replay();
      return;
    }
    fired = true;
    ondone(tile.id);
  }

  // image timer and the video length cap; counts only while unpaused and
  // while the current item is actually visible
  $effect(() => {
    if (endless) return;
    const iv = setInterval(() => {
      if (paused || fired) return;
      const top = layers[layers.length - 1];
      if (!top?.shown) return;
      elapsed += 0.25;
      if (top.media.kind === "image" ? elapsed >= imageSeconds : maxVideo > 0 && elapsed >= maxVideo) fire();
    }, 250);
    return () => clearInterval(iv);
  });

  const top = $derived(layers[layers.length - 1]);
</script>

<div
  class="tile"
  class:leaving={tile.leaving}
  class:ring
  class:pinned={tile.pinned}
  style:left="{tile.rect.x + gap / 2}px"
  style:top="{tile.rect.y + gap / 2}px"
  style:width="{Math.max(0, tile.rect.w - gap)}px"
  style:height="{Math.max(0, tile.rect.h - gap)}px"
  onpointerenter={() => onenter(tile)}
  onpointerleave={() => onleave(tile)}
  ondblclick={() => onopen(tile)}
  role="presentation"
>
  {#each layers as layer (layer.key)}
    <div class="layer" class:shown={layer.shown}>
      <MediaView
        bind:this={views[layer.key]}
        media={layer.media}
        muted={!unmuted || layer !== top}
        {volume}
        {rate}
        {paused}
        loop={tile.pinned || endless}
        loopUntil={minVideo}
        onready={() => shown(layer)}
        onended={() => layer === top && fire()}
      />
    </div>
  {/each}
  {#if tile.pinned}<span class="badge nf" title="Pinned">{I.pin}</span>{/if}
  {#if unmuted && top?.media.kind === "video"}<span class="badge sound nf">{I.volume}</span>{/if}
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
  .tile::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 0 0 1px transparent;
    transition: box-shadow 160ms ease;
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
