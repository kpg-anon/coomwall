<script lang="ts">
  // One item in a Ribbon/Cascade lane. Videos play only while on screen: an
  // IntersectionObserver (which sees the lane's transform) starts and stops
  // them. A second, wider one mounts the media only once the item is within
  // half a screen of the edge; items queued further ahead hold no decoder.
  import MediaView from "./MediaView.svelte";
  import type { FeedItem } from "$lib/feed.svelte";
  import type { Media } from "$lib/queue.svelte";

  interface Props {
    item: FeedItem;
    axis: "x" | "y";
    cross: number;
    gap: number;
    paused: boolean;
    unmuted: boolean;
    volume: number;
    rate: number;
    ring: boolean;
    onenter: (m: Media) => void;
    onleave: (m: Media) => void;
    onopen: (m: Media) => void;
  }

  let { item, axis, cross, paused, unmuted, volume, rate, ring, onenter, onleave, onopen }: Props = $props();

  let el = $state<HTMLDivElement>();
  let inView = $state(false);
  /** latched: once mounted the media stays until the lane drops the item */
  let near = $state(false);
  let shown = $state(false);

  $effect(() => {
    if (!el) return;
    const io = new IntersectionObserver((entries) => (inView = entries[entries.length - 1].isIntersecting), {
      rootMargin: "60px",
    });
    const nearIo = new IntersectionObserver(
      (entries) => {
        if (!entries[entries.length - 1].isIntersecting) return;
        near = true;
        nearIo.disconnect();
      },
      { rootMargin: "50%" },
    );
    io.observe(el);
    nearIo.observe(el);
    return () => {
      io.disconnect();
      nearIo.disconnect();
    };
  });
</script>

<div
  bind:this={el}
  class="item"
  class:ring
  class:shown
  style:left={axis === "x" ? `${item.place}px` : "0"}
  style:top={axis === "y" ? `${item.place}px` : "0"}
  style:width="{axis === 'x' ? item.len : cross}px"
  style:height="{axis === 'y' ? item.len : cross}px"
  onpointerenter={() => onenter(item.media)}
  onpointerleave={() => onleave(item.media)}
  ondblclick={() => onopen(item.media)}
  role="presentation"
>
  {#if near}
    <MediaView
      media={item.media}
      muted={!unmuted}
      {volume}
      {rate}
      paused={paused || !inView}
      loop
      onready={() => (shown = true)}
    />
  {/if}
</div>

<style>
  .item {
    position: absolute;
    overflow: hidden;
    border-radius: 3px;
    background: var(--bg-panel);
    opacity: 0;
    transition: opacity 300ms ease;
  }
  .item.shown {
    opacity: 1;
  }
  .item::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
  }
  .item.ring::after {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--purple) 70%, transparent);
  }
</style>
