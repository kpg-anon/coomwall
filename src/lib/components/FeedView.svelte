<script lang="ts">
  import FeedTile from "./FeedTile.svelte";
  import type { FeedController, Lane } from "$lib/feed.svelte";
  import type { Media } from "$lib/queue.svelte";
  import type { Settings } from "$lib/settings.svelte";

  interface Props {
    ctl: FeedController;
    s: Settings;
    paused: boolean;
    /** keys of the items with sound */
    sounding: ReadonlyMap<number, string>;
    hudVisible: boolean;
    onhover: (m: Media | null) => void;
    onopen: (m: Media) => void;
  }

  let { ctl, s, paused, sounding, hudVisible, onhover, onopen }: Props = $props();

  let hoverKey = $state<number | null>(null);

  $effect(() => {
    ctl.paused = paused;
  });

  $effect(() => {
    // hold this controller: by teardown the `ctl` prop already reads the
    // next value (null while Wall rebuilds), and a throw there leaves the
    // new feed half-mounted
    const c = ctl;
    c.start();
    return () => c.destroy();
  });

  function laneStyle(lane: Lane): string {
    return ctl.axis === "x"
      ? `top:${lane.start}px;height:${lane.cross}px;left:${lane.from}px;width:${lane.span}px`
      : `left:${lane.start}px;width:${lane.cross}px;top:${lane.from}px;height:${lane.span}px`;
  }
</script>

<div class="feed">
  {#each ctl.lanes as lane (lane.index)}
    <div
      class="lane"
      style={laneStyle(lane)}
      onpointerenter={() => (lane.hover = true)}
      onpointerleave={() => (lane.hover = false)}
      role="presentation"
    >
      <div class="strip" bind:this={lane.strip}>
        {#each lane.items as item (item.key)}
          <FeedTile
            {item}
            axis={ctl.axis}
            cross={lane.cross}
            gap={s.gap}
            {paused}
            unmuted={sounding.has(item.media.key) || (s.audioFollowsMouse && hoverKey === item.media.key)}
            volume={s.volume / 100}
            rate={s.rate}
            ring={hudVisible && hoverKey === item.media.key}
            onenter={(m) => {
              hoverKey = m.key;
              onhover(m);
            }}
            onleave={(m) => {
              if (hoverKey === m.key) hoverKey = null;
              onhover(null);
            }}
            {onopen}
          />
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .feed {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  /* a lane beside the center item ends at its edge */
  .lane {
    position: absolute;
    overflow: hidden;
  }
  .strip {
    position: absolute;
    inset: 0;
    will-change: transform;
  }
</style>
