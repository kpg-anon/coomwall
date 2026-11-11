<script lang="ts">
  // Grid mode's layout editor: columns and rows as numbers, presets or typed
  // ("3x2"), and a drawing of the grid where dragging across cells merges
  // them into one tile and clicking a merged tile splits it again.
  import { GRID_PRESETS, gridTiles, mergeCells, parseGrid, validSpans } from "$lib/grid";
  import { LIMITS, type GridSpan } from "$lib/settings.svelte";
  import Range from "./Range.svelte";
  import Segmented from "./Segmented.svelte";

  interface Props {
    cols: number;
    rows: number;
    spans: GridSpan[];
    fit: "cover" | "contain";
    /** width / height of the display the grid is for */
    aspect?: number;
  }

  let { cols = $bindable(), rows = $bindable(), spans = $bindable(), fit = $bindable(), aspect = 16 / 10 }: Props = $props();

  const CANVAS = 280;
  let canvas = $state<HTMLDivElement>();
  let from = $state<[number, number] | null>(null);
  let to = $state<[number, number] | null>(null);
  let typed = $state("");

  const tiles = $derived(gridTiles(cols, rows, spans ?? []));
  const merged = $derived(validSpans(cols, rows, spans ?? []).length);
  const height = $derived(Math.round(Math.min(CANVAS / Math.max(0.4, aspect), 190)));
  const width = $derived(Math.round(Math.min(CANVAS, height * aspect)));
  /** the block being dragged out, in cells */
  const drag = $derived(
    from && to ? { c: Math.min(from[0], to[0]), r: Math.min(from[1], to[1]), w: Math.abs(from[0] - to[0]) + 1, h: Math.abs(from[1] - to[1]) + 1 } : null,
  );

  function cellAt(e: PointerEvent): [number, number] {
    const r = canvas!.getBoundingClientRect();
    const c = Math.max(0, Math.min(cols - 1, Math.floor(((e.clientX - r.left) / r.width) * cols)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor(((e.clientY - r.top) / r.height) * rows)));
    return [c, row];
  }

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    canvas?.setPointerCapture(e.pointerId);
    from = to = cellAt(e);
  }

  function move(e: PointerEvent) {
    if (from) to = cellAt(e);
  }

  function up() {
    if (from && to) spans = mergeCells(cols, rows, spans ?? [], from, to);
    from = to = null;
  }

  function set(c: number, r: number) {
    cols = c;
    rows = r;
    spans = [];
  }

  function commit() {
    const g = parseGrid(typed, LIMITS.gridCols[1], LIMITS.gridRows[1]);
    if (g) set(g[0], g[1]);
    typed = "";
  }

  // merges that no longer fit after a change of columns or rows are dropped
  $effect(() => {
    const ok = validSpans(cols, rows, spans ?? []);
    if (ok.length !== (spans ?? []).length) spans = ok;
  });
</script>

<div class="builder">
  <div class="draw">
    <div
      class="canvas"
      bind:this={canvas}
      style:width="{width}px"
      style:height="{height}px"
      style:grid-template-columns="repeat({cols}, 1fr)"
      style:grid-template-rows="repeat({rows}, 1fr)"
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={() => (from = to = null)}
      role="application"
      aria-label="Grid layout: drag across cells to merge them"
    >
      {#each tiles as t, i (`${t.c}-${t.r}-${t.w}-${t.h}`)}
        <span class="cell" class:span={t.w * t.h > 1} style:grid-column="{t.c + 1} / span {t.w}" style:grid-row="{t.r + 1} / span {t.h}">{i + 1}</span>
      {/each}
      {#if drag && drag.w * drag.h > 1}
        <span class="sel" style:grid-column="{drag.c + 1} / span {drag.w}" style:grid-row="{drag.r + 1} / span {drag.h}"></span>
      {/if}
    </div>
    <span class="hint">
      Drag across cells to merge them into one tile. Click a merged tile to split it.
      {#if merged}<button class="link" onclick={() => (spans = [])}>Clear merges</button>{/if}
    </span>
  </div>

  <div class="side">
    <div class="presets">
      {#each GRID_PRESETS as [c, r] (`${c}x${r}`)}
        <button class="preset" class:on={cols === c && rows === r && !merged} onclick={() => set(c, r)}>{c}×{r}</button>
      {/each}
      <input
        class="typed"
        placeholder="5x2"
        bind:value={typed}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.stopPropagation();
            commit();
          }
        }}
        onblur={commit}
        aria-label="Columns x rows"
      />
    </div>
    <div class="nums">
      <Range label="Columns" bind:value={cols} min={LIMITS.gridCols[0]} max={LIMITS.gridCols[1]} />
      <Range label="Rows" bind:value={rows} min={LIMITS.gridRows[0]} max={LIMITS.gridRows[1]} />
    </div>
    <Segmented
      label="Each item"
      bind:value={fit}
      options={[
        { value: "cover", label: "Fills its tile" },
        { value: "contain", label: "Shown whole" },
      ]}
    />
  </div>
</div>

<style>
  .builder {
    grid-column: 1 / -1;
    display: flex;
    gap: 22px;
    align-items: flex-start;
  }
  .draw {
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: none;
    width: 280px;
  }
  .canvas {
    display: grid;
    gap: 3px;
    padding: 3px;
    border-radius: 6px;
    background: var(--bg-app);
    border: 1px solid var(--border);
    cursor: crosshair;
    touch-action: none;
  }
  .cell {
    display: grid;
    place-items: center;
    min-width: 0;
    min-height: 0;
    border-radius: 3px;
    background: color-mix(in srgb, var(--purple) 26%, var(--bg-panel-alt));
    color: var(--text-secondary);
    font-family: var(--mono);
    font-size: 11px;
    pointer-events: none;
  }
  .cell.span {
    background: color-mix(in srgb, var(--cyan) 30%, var(--bg-panel-alt));
    color: var(--text-primary);
  }
  .sel {
    border-radius: 3px;
    border: 2px solid var(--green);
    background: color-mix(in srgb, var(--green) 18%, transparent);
    pointer-events: none;
    z-index: 1;
  }
  .hint {
    color: var(--text-muted);
    font-size: 11.5px;
    line-height: 1.4;
  }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--purple);
    font: inherit;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .side {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .preset,
  .typed {
    padding: 4px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-secondary);
    font-family: var(--mono);
    font-size: 12px;
  }
  .preset {
    cursor: pointer;
  }
  .preset:hover {
    border-color: color-mix(in srgb, var(--purple) 50%, var(--border));
    color: var(--text-primary);
  }
  .preset.on {
    border-color: var(--purple);
    color: var(--text-primary);
    background: color-mix(in srgb, var(--purple) 12%, var(--bg-chip));
  }
  .typed {
    width: 62px;
    color: var(--text-primary);
  }
  .typed::placeholder {
    color: var(--text-muted);
  }
  .nums {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 18px;
  }
</style>
