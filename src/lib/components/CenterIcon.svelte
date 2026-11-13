<!-- Centered media: one large tile in the middle of a ring of small ones, as
     on the wall. Drawn in the current text color, 1em square. -->
<svg class="center-icon" viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
  {#each [0, 4.25, 8.5, 12.75] as y}
    {#each [0, 4.25, 8.5, 12.75] as x}
      {#if !(x > 0 && x < 12 && y > 0 && y < 12)}
        <rect {x} {y} width="3.25" height="3.25" rx="0.7" fill="currentColor" opacity="0.45" />
      {/if}
    {/each}
  {/each}
  <rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1" fill="currentColor" />
</svg>

<style>
  .center-icon {
    display: inline-block;
    vertical-align: -0.125em;
    flex: none;
  }
</style>
