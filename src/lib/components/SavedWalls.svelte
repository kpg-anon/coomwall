<script lang="ts">
  // The saved walls, in a panel that slides in from the right of the setup
  // window: the last wall (Resume) and every wall saved with Ctrl+S. Each
  // shows a drawing of its tiles as they were, per display, with the mode,
  // its numbers, the filters, the centered media and the sources.
  import { onMount } from "svelte";
  import type { Monitor } from "@tauri-apps/api/window";
  import { MODE_NAMES, type Layout, type Mode } from "$lib/settings.svelte";
  import { gridLabel } from "$lib/grid";
  import { I, MODE_ICON } from "$lib/icons";
  import type { SessionInfo, Thumb } from "$lib/session";

  type WallRow = SessionInfo["walls"][number];

  interface Props {
    saved: { last: SessionInfo | null; named: SessionInfo[] };
    monitors: (Monitor & { name: string })[];
    busy: boolean;
    onload: (name: string | null) => void;
    ondelete: (name: string) => void;
    onclose: () => void;
  }

  let { saved, monitors, busy, onload, ondelete, onclose }: Props = $props();

  /** the save whose bin was clicked, waiting for "Delete" */
  let confirming = $state<string | null>(null);

  const pad = (n: number) => String(n).padStart(2, "0");

  /** "today 14:03", "yesterday 09:12", "Mon 21:40" (this week), "3 Nov 21:40", "3 Nov 2025" */
  function when(ms: number): string {
    const d = new Date(ms);
    const now = new Date();
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day(now) - day(d)) / 86400000);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (days === 0) return `today ${time}`;
    if (days === 1) return `yesterday ${time}`;
    if (days > 1 && days < 7) return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${time}`;
    const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return d.getFullYear() === now.getFullYear() ? `${date} ${time}` : `${date} ${d.getFullYear()}`;
  }

  function displayIndex(name: string): number {
    return monitors.findIndex((m) => m.name === name);
  }

  /** the walls of a session left to right as the displays are placed now */
  function ordered(x: SessionInfo): WallRow[] {
    const pos = (w: WallRow) => {
      const m = monitors.find((m) => m.name === w.monitor);
      return m ? m.position.x * 1e-4 + m.position.y * 1e-9 : 1e9;
    };
    return [...x.walls].sort((a, b) => pos(a) - pos(b));
  }

  /** the mode's numbers: "7 tiles", "Grid 3×3 · 7 tiles", "4 rows · left" */
  function detail(w: WallRow): string {
    const l = w.layout;
    if (!l) return `${w.count} items`;
    switch (w.mode as Mode) {
      case "mosaic":
      case "dynamic":
        return `${l.tiles} ${l.tiles === 1 ? "tile" : "tiles"}${l.centered && l.center ? " around the center" : ""}`;
      case "ribbon":
        return `${l.rows} ${l.rows === 1 ? "row" : "rows"} · ${l.ribbonDir}`;
      case "cascade":
        return `${l.columns} ${l.columns === 1 ? "column" : "columns"} · ${l.cascadeDir}`;
      case "stack":
        return `${l.stackPanes} ${l.stackPanes === 1 ? "pane" : "panes"}${l.stackTurn ? ` · ${l.stackTurn}°` : ""}${l.stackSource === "one" ? " · one file or link" : ""}`;
      case "grid":
        return `${gridLabel(l.gridCols, l.gridRows, l.gridSpans ?? [])}${l.gridFit === "contain" ? " · whole" : ""}`;
      default:
        return `${w.count} items`;
    }
  }

  function leaf(p: string): string {
    const n = p.replace(/[\\/]+$/, "");
    return n.slice(Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\")) + 1) || n;
  }

  /** filters and the centered media, as short labels */
  function tags(l: Layout | null): string[] {
    if (!l) return [];
    const out: string[] = [];
    if (l.type === "videos") out.push("videos only");
    if (l.type === "images") out.push("images only");
    if (l.shape !== "any") out.push(`${l.shape} only`);
    return out;
  }

  /** every distinct source of the session's walls */
  function sources(x: SessionInfo): string[] {
    return [...new Set(x.walls.flatMap((w) => w.sources ?? []))];
  }

  function pieces(t: Thumb) {
    return t.items.map(([x, y, w, h, f]) => ({ x, y, w, h, image: !!(f & 1), pinned: !!(f & 2), center: !!(f & 4) }));
  }

  function key(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (confirming) confirming = null;
    else onclose();
  }

  onMount(() => {
    // capture: before the setup page's own keys (Enter starts the wall)
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") key(e);
      else if (e.key === "Enter") e.stopPropagation();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  });
</script>

{#snippet screen(w: WallRow)}
  {@const t = w.thumb}
  {#if t && t.w > 0 && t.h > 0}
    <svg class="thumb" viewBox="0 0 {t.w} {t.h}" style:aspect-ratio="{t.w} / {t.h}" aria-hidden="true">
      <rect class="bg" x="0" y="0" width={t.w} height={t.h} />
      {#each pieces(t) as p, i (i)}
        <rect class="piece" class:image={p.image} class:pinned={p.pinned} class:mid={p.center} x={p.x + t.w * 0.004} y={p.y + t.w * 0.004} width={Math.max(0, p.w - t.w * 0.008)} height={Math.max(0, p.h - t.w * 0.008)} rx={t.w * 0.006} />
      {/each}
    </svg>
  {:else}
    <div class="thumb none"><span class="nf">{MODE_ICON[w.mode as Mode] ?? I.th}</span></div>
  {/if}
{/snippet}

{#snippet card(x: SessionInfo, last: boolean)}
  {@const walls = ordered(x)}
  {@const src = sources(x)}
  <li class="card" class:last>
    <div class="c-head">
      <span class="c-name">{#if last}<span class="nf">{I.history}</span> Last wall{:else}{x.name}{/if}</span>
      <span class="c-time" title={new Date(x.savedAt).toLocaleString()}>{when(x.savedAt)}</span>
    </div>

    <div class="walls" class:many={walls.length > 1}>
      {#each walls as w (w.monitor)}
        <div class="wall">
          {@render screen(w)}
          <div class="w-line">
            {#if x.multi}<span class="w-disp" class:away={displayIndex(w.monitor) < 0} title={displayIndex(w.monitor) < 0 ? "Not connected now: left out when loaded" : ""}>{displayIndex(w.monitor) >= 0 ? displayIndex(w.monitor) + 1 : "?"}</span>{/if}
            <span class="nf w-icon">{MODE_ICON[w.mode as Mode] ?? ""}</span>
            <span class="w-mode">{MODE_NAMES[w.mode as Mode] ?? w.mode}</span>
          </div>
          <div class="w-detail">{detail(w)}</div>
          {#if tags(w.layout).length || (w.layout?.centered && w.layout.center)}
            <div class="w-tags">
              {#each tags(w.layout) as tag (tag)}<span class="tag">{tag}</span>{/each}
              {#if w.layout?.centered && w.layout.center}<span class="tag mid" title={w.layout.center}><span class="nf">{I.bullseye}</span> {leaf(w.layout.center)}</span>{/if}
              {#if w.own}<span class="tag" title={(w.sources ?? []).join("\n")}><span class="nf">{I.folder}</span> own folders</span>{/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <div class="c-foot">
      <span class="c-src" title={src.join("\n")}>
        {#if src.length}
          <span class="nf">{I.folder}</span>
          {src.slice(0, 2).map(leaf).join(", ")}{src.length > 2 ? ` +${src.length - 2}` : ""}
        {/if}
      </span>
      {#if !last && confirming === x.name}
        <span class="confirm">
          Delete "{x.name}"?
          <button class="danger" onclick={() => { confirming = null; ondelete(x.name); }}>Delete</button>
          <button class="plain" onclick={() => (confirming = null)}>Keep</button>
        </span>
      {:else}
        {#if !last}<button class="bin nf" title="Delete this save" onclick={() => (confirming = x.name)}>{I.trash}</button>{/if}
        <button class="load" disabled={busy} onclick={() => onload(last ? null : x.name)}>
          <span class="nf">{last ? I.history : I.play}</span>{last ? "Resume" : "Load"}
        </button>
      {/if}
    </div>
  </li>
{/snippet}

<div class="shade" role="presentation" onclick={onclose}></div>
<aside class="drawer" aria-label="Saved walls">
  <header>
    <span class="nf h-icon">{I.save}</span>
    <div class="h-text">
      <h2>Saved walls</h2>
      <p>On a wall, <kbd>Ctrl</kbd> <kbd>S</kbd> saves it here under a name.</p>
    </div>
    <button class="close nf" title="Close (Esc)" onclick={onclose}>{I.close}</button>
  </header>

  <div class="body">
    {#if saved.last}
      <ul class="list">{@render card(saved.last, true)}</ul>
    {/if}
    {#if saved.named.length}
      <div class="sub">Saved · {saved.named.length}</div>
      <ul class="list">
        {#each saved.named as x (x.name)}{@render card(x, false)}{/each}
      </ul>
    {:else}
      <div class="empty">
        <span class="nf">{I.save}</span>
        <p>Nothing saved yet.</p>
        <p class="sub2">Start a wall, set it up the way you like, and press <kbd>Ctrl</kbd> <kbd>S</kbd>.</p>
      </div>
    {/if}
  </div>
</aside>

<style>
  .shade {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.35);
    animation: fade 180ms ease both;
  }
  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 61;
    width: min(460px, 92vw);
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    box-shadow: -12px 0 40px rgba(0, 0, 0, 0.4);
    animation: slide 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  @keyframes slide {
    from { transform: translateX(100%); }
  }
  @keyframes fade {
    from { opacity: 0; }
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 18px 18px 14px 20px;
    border-bottom: 1px solid var(--border-muted);
  }
  .h-icon {
    font-size: 18px;
    color: var(--purple);
  }
  .h-text {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }
  header p {
    margin: 2px 0 0;
    font-size: 11.5px;
    color: var(--text-muted);
  }
  kbd {
    font-size: 10px;
  }
  .close {
    border: 0;
    background: none;
    color: var(--text-muted);
    font-size: 14px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .close:hover {
    color: var(--text-primary);
    background: var(--bg-chip);
  }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px 20px;
  }
  .sub {
    margin: 16px 4px 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .card {
    background: var(--bg-panel-alt);
    border: 1px solid var(--border-muted);
    border-radius: 10px;
    padding: 12px 12px 10px;
    transition: border-color 140ms ease;
  }
  .card:hover {
    border-color: var(--border);
  }
  .card.last {
    border-color: color-mix(in srgb, var(--purple) 35%, var(--border-muted));
  }
  .c-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 10px;
  }
  .c-name {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-name .nf {
    color: var(--purple);
    margin-right: 4px;
  }
  .c-time {
    font-size: 11.5px;
    color: var(--text-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .walls {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .walls.many {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  }
  .wall {
    min-width: 0;
  }
  .thumb {
    display: block;
    width: 100%;
    max-height: 150px;
    border-radius: 5px;
    background: #000;
    outline: 1px solid var(--border-muted);
  }
  /* one wall: its drawing on the left, what it was beside it */
  .walls:not(.many) .wall {
    display: grid;
    grid-template-columns: 180px 1fr;
    grid-template-rows: auto auto auto 1fr;
    column-gap: 12px;
    align-items: start;
  }
  .walls:not(.many) .thumb {
    grid-row: 1 / -1;
    max-height: 140px;
  }
  .walls:not(.many) .w-line {
    margin-top: 0;
  }
  .thumb.none {
    aspect-ratio: 16 / 10;
    max-height: 110px;
    display: grid;
    place-items: center;
    color: var(--text-muted);
    background: var(--bg-chip);
    font-size: 20px;
  }
  .thumb .bg {
    fill: #0b0d10;
  }
  .piece {
    fill: color-mix(in srgb, var(--purple) 42%, #1b1f27);
  }
  .piece.image {
    fill: color-mix(in srgb, var(--cyan) 40%, #1b1f27);
  }
  .piece.mid {
    fill: color-mix(in srgb, var(--orange) 55%, #1b1f27);
  }
  .piece.pinned {
    stroke: var(--yellow);
    stroke-width: 0.6%;
  }
  .w-line {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 7px;
    font-size: 12px;
    color: var(--text-primary);
  }
  .w-disp {
    display: inline-grid;
    place-items: center;
    min-width: 16px;
    height: 16px;
    padding: 0 3px;
    border-radius: 4px;
    background: var(--bg-chip);
    border: 1px solid var(--border);
    font-size: 10px;
    font-weight: 600;
    color: var(--text-secondary);
  }
  .w-disp.away {
    color: var(--orange);
    border-color: color-mix(in srgb, var(--orange) 50%, var(--border));
  }
  .w-icon {
    color: var(--purple);
    font-size: 11px;
  }
  .w-mode {
    font-weight: 600;
  }
  .w-detail {
    margin-top: 2px;
    font-size: 11.5px;
    color: var(--text-secondary);
  }
  .w-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 5px;
  }
  .tag {
    font-size: 10.5px;
    padding: 1px 6px;
    border-radius: 9px;
    background: var(--bg-chip);
    color: var(--text-secondary);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag.mid {
    color: var(--orange);
  }
  .tag .nf {
    font-size: 9px;
  }
  .c-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 11px;
    padding-top: 9px;
    border-top: 1px solid var(--border-muted);
    min-height: 30px;
  }
  .c-src {
    flex: 1;
    min-width: 0;
    font-size: 11.5px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-src .nf {
    font-size: 10px;
    margin-right: 3px;
  }
  .load {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 13px;
    border-radius: var(--radius);
    border: 1px solid color-mix(in srgb, var(--green) 55%, var(--border));
    background: color-mix(in srgb, var(--green) 14%, var(--bg-chip));
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .load:hover:not(:disabled) {
    background: color-mix(in srgb, var(--green) 24%, var(--bg-chip));
  }
  .load:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .load .nf {
    font-size: 10px;
    color: var(--green);
  }
  .bin {
    border: 0;
    background: none;
    color: var(--text-muted);
    padding: 5px 7px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12px;
  }
  .bin:hover {
    color: var(--red);
    background: var(--bg-chip);
  }
  .confirm {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .confirm button {
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    font-size: 11.5px;
    cursor: pointer;
  }
  .danger {
    border: 1px solid color-mix(in srgb, var(--red) 60%, var(--border));
    background: color-mix(in srgb, var(--red) 18%, var(--bg-chip));
    color: var(--text-primary);
  }
  .plain {
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-secondary);
  }
  .empty {
    text-align: center;
    padding: 40px 20px;
    color: var(--text-secondary);
  }
  .empty .nf {
    font-size: 28px;
    color: var(--text-muted);
  }
  .empty p {
    margin: 10px 0 0;
    font-size: 13px;
  }
  .empty .sub2 {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.6;
  }
</style>
