<script lang="ts">
  import Tile from "./Tile.svelte";
  import type { TileState, TileWall } from "$lib/mosaic.svelte";
  import type { Media } from "$lib/queue.svelte";
  import type { Settings } from "$lib/settings.svelte";

  interface Props {
    ctl: TileWall;
    s: Settings;
    paused: boolean;
    /** keys of the items with sound */
    sounding: ReadonlyMap<number, string>;
    hudVisible: boolean;
    debug: boolean;
    onhover: (m: Media | null) => void;
    onopen: (m: Media) => void;
  }

  let { ctl, s, paused, sounding, hudVisible, debug, onhover, onopen }: Props = $props();

  function enter(t: TileState) {
    ctl.hovered = t.id;
    onhover(t.media);
  }
  function leave(t: TileState) {
    if (ctl.hovered === t.id) ctl.hovered = null;
    onhover(null);
  }

  $effect(() => {
    ctl.paused = paused;
    ctl.pointerActive = hudVisible;
  });

  // keep the HUD's hovered-item info current when the hovered tile changes content
  $effect(() => {
    const id = ctl.hovered;
    if (id === null) return;
    const t = ctl.tiles.find((x) => x.id === id);
    if (t) onhover(t.media);
  });
</script>

<div class="mosaic">
  {#each ctl.tiles as tile (tile.id)}
    <Tile
      {tile}
      gap={s.gap}
      {paused}
      unmuted={sounding.has(tile.media.key) || (s.audioFollowsMouse && ctl.hovered === tile.id)}
      volume={s.volume / 100}
      rate={s.rate}
      imageSeconds={s.imageSeconds}
      minVideo={s.minVideoSeconds}
      ring={hudVisible && ctl.hovered === tile.id}
      watched={s.hoverHold && ctl.hovered === tile.id}
      endless={ctl.dynamic}
      fit={ctl.fit ?? "cover"}
      ondone={(id) => ctl.done(id)}
      onenter={enter}
      onleave={leave}
      onopen={(t) => onopen(t.media)}
      onpan={(id, pan) => ctl.setPan(id, pan)}
    />
  {/each}

  {#if debug && ctl.region}
    {#key ctl.region.seq}
      <div
        class="region {ctl.region.kind}"
        style:left="{ctl.region.rect.x}px"
        style:top="{ctl.region.rect.y}px"
        style:width="{ctl.region.rect.w}px"
        style:height="{ctl.region.rect.h}px"
      ></div>
    {/key}
  {/if}

  {#if ctl.status}<div class="status">{ctl.status}</div>{/if}
</div>

<style>
  .mosaic {
    position: absolute;
    inset: 0;
  }
  .region {
    position: absolute;
    border: 2px solid var(--purple);
    border-radius: 4px;
    pointer-events: none;
    animation: flash 1400ms ease-out forwards;
  }
  .region.global {
    border-color: var(--orange);
  }
  @keyframes flash {
    0% { opacity: 0; }
    15% { opacity: 0.9; }
    100% { opacity: 0; }
  }
  .status {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text-muted);
    font-family: var(--mono);
    font-size: 13px;
  }
</style>
