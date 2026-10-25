<script lang="ts">
  // Shown only while the pointer moves (or a key is pressed); the wall itself
  // has no interface. Top: what is playing and what is under the pointer.
  // Bottom: the keys, like comfysort's bottom bar.
  import { I } from "$lib/icons";
  import type { Media } from "$lib/queue.svelte";
  import type { Mode } from "$lib/settings.svelte";

  interface Props {
    visible: boolean;
    help: boolean;
    mode: Mode;
    count: number;
    countLabel: string;
    paused: boolean;
    rate: number;
    speed: number;
    dynamicSeconds: number;
    direction: string;
    hover: Media | null;
    queued: number;
    total: number;
    unplayable: number;
    dropped: string;
    /** many visible videos stuck waiting for frames: what to do about it */
    stall: string;
    last: { kind: string; moved: number; crop: number; ms: number } | null;
    debug: boolean;
    toast: string;
    onexit: () => void;
  }

  let p: Props = $props();

  const MODE_NAME: Record<Mode, string> = { mosaic: "Mosaic", ribbon: "Ribbon", cascade: "Cascade", dynamic: "Dynamic" };
  const MODE_ICON: Record<Mode, string> = { mosaic: I.th, ribbon: I.bars, cascade: I.columns, dynamic: I.random };

  function ext(name: string): string {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(i + 1).toLowerCase() : "";
  }

  const KEYS: [string, string][] = [
    ["Space", "pause"],
    ["+ −", "count"],
    ["1–4", "mode"],
    ["N", "next"],
    ["P", "pin"],
    ["M", "sound"],
    ["F", "view"],
    ["R", "retile"],
    ["?", "keys"],
    ["Esc", "back"],
  ];
</script>

<div class="hud" class:visible={p.visible || p.help || !!p.toast}>
  <div class="top">
    <button class="back" onclick={p.onexit} title="Back to setup (Esc)"><span class="nf">{I.back}</span></button>
    <span class="brand">coomwall</span>
    <span class="chip mode"><span class="nf">{MODE_ICON[p.mode]}</span>{MODE_NAME[p.mode]}</span>
    <span class="chip">{p.count} {p.countLabel}</span>
    {#if p.mode === "ribbon" || p.mode === "cascade"}<span class="chip">{p.direction} · {Math.round(p.speed)} px/s</span>{/if}
    {#if p.mode === "dynamic"}<span class="chip">every {p.dynamicSeconds} s</span>{/if}
    {#if p.rate !== 1}<span class="chip">{p.rate.toFixed(2)}×</span>{/if}
    {#if p.paused}<span class="chip warn"><span class="nf">{I.pause}</span>paused</span>{/if}

    <span class="hover">
      {#if p.hover}
        <span class="ext ext-{ext(p.hover.name)}">{ext(p.hover.name) || p.hover.kind}</span>
        <span class="name">{p.hover.name}</span>
        <span class="dim">{p.hover.w}×{p.hover.h}</span>
      {/if}
    </span>

    <span class="stats">
      <span title="files in this wall">{p.total.toLocaleString()} files</span>
      {#if p.unplayable}<span class="bad" title="files the player could not decode">{p.unplayable} skipped</span>{/if}
      <span title="frames dropped by visible videos">{p.dropped}</span>
      {#if p.debug && p.last}
        <span class="dbg">{p.last.kind} · {p.last.moved} moved · crop {(p.last.crop * 100).toFixed(0)}% · {p.last.ms} ms</span>
      {/if}
    </span>
  </div>

  {#if p.toast}<div class="toast">{p.toast}</div>{/if}
  {#if p.stall}<div class="stall"><span class="nf">{I.warn}</span>{p.stall}</div>{/if}

  <div class="bottom">
    {#each KEYS as [k, label]}
      <span class="key"><kbd>{k}</kbd>{label}</span>
    {/each}
  </div>

  {#if p.help}
    <div class="help">
      <h2><span class="nf">{I.keyboard}</span> Keys</h2>
      <dl>
        <dt><kbd>Space</kbd></dt><dd>pause or resume everything</dd>
        <dt><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></dt><dd>Mosaic · Ribbon · Cascade · Dynamic, without leaving the wall</dd>
        <dt><kbd>+</kbd> <kbd>−</kbd></dt><dd>one more or one fewer tile, row or column</dd>
        <dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>feed speed · Dynamic: changes more or less often</dd>
        <dt><kbd>D</kbd></dt><dd>reverse the feed's direction</dd>
        <dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>playback speed by 5% · with <kbd>Shift</kbd>, by 25%</dd>
        <dt><kbd>N</kbd></dt><dd>next item in the tile under the pointer</dd>
        <dt><kbd>P</kbd></dt><dd>pin it: it keeps playing and nothing moves it</dd>
        <dt><kbd>M</kbd></dt><dd>sound on for the item under the pointer</dd>
        <dt><kbd>F</kbd> / double-click</dt><dd>view it whole</dd>
        <dt><kbd>O</kbd></dt><dd>show the file in Explorer</dd>
        <dt>right-click</dt><dd>show in Explorer, open in the default app, remove from the wall, never show again</dd>
        <dt><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd></dt><dd>move this wall to the display on that side; a wall there swaps with it</dd>
        <dt><kbd>R</kbd></dt><dd>Mosaic, Dynamic: lay the whole wall out again · feeds: refill</dd>
        <dt><kbd>G</kbd></dt><dd>show where each change happens</dd>
        <dt><kbd>Esc</kbd></dt><dd>back to setup</dd>
      </dl>
      <p>The tile under the pointer is never moved by other tiles' changes, and changes in place when it ends.</p>
    </div>
  {/if}
</div>

<style>
  .hud {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 20;
    opacity: 0;
    transition: opacity 260ms ease;
  }
  .hud.visible {
    opacity: 1;
  }
  .top,
  .bottom {
    position: absolute;
    left: 12px;
    right: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--bg-panel) 86%, transparent);
    border: 1px solid var(--border);
    backdrop-filter: blur(10px);
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
    font-size: 12px;
    color: var(--text-secondary);
  }
  .top {
    top: 12px;
  }
  .bottom {
    bottom: 12px;
    justify-content: center;
    gap: 16px;
    color: var(--text-muted);
  }
  .visible .top,
  .visible .back {
    pointer-events: auto;
  }
  .back {
    display: grid;
    place-items: center;
    width: 26px;
    height: 24px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .back:hover {
    border-color: var(--purple);
    color: var(--text-primary);
  }
  .brand {
    font-family: var(--mono);
    font-weight: 700;
    color: var(--purple);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 1px 8px;
    border-radius: var(--radius-sm);
    background: var(--bg-chip);
    border: 1px solid var(--border-muted);
    font-family: var(--mono);
    font-size: 11px;
    white-space: nowrap;
  }
  .chip.mode {
    color: var(--purple);
  }
  .chip.warn {
    color: var(--yellow);
  }
  .hover {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .name {
    color: var(--text-primary);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .dim {
    color: var(--text-muted);
  }
  .ext {
    font-size: 10px;
    font-weight: 700;
    padding: 0 5px;
    border: 1px solid currentColor;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
  }
  .ext-jpg, .ext-jpeg { color: var(--green); }
  .ext-png { color: var(--cyan); }
  .ext-webp, .ext-avif, .ext-webm { color: var(--purple); }
  .ext-gif, .ext-mkv { color: var(--yellow); }
  .ext-mp4, .ext-m4v { color: var(--blue); }
  .ext-mov { color: var(--cyan); }
  .stats {
    display: flex;
    gap: 12px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .bad {
    color: var(--orange);
  }
  .dbg {
    color: var(--purple);
  }
  .key {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
  .toast {
    position: absolute;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    padding: 6px 14px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
    border: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-primary);
  }
  .stall {
    position: absolute;
    top: 64px;
    right: 12px;
    max-width: 440px;
    display: flex;
    gap: 9px;
    padding: 9px 12px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--bg-panel) 94%, transparent);
    border: 1px solid color-mix(in srgb, var(--orange) 60%, var(--border));
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.35);
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--text-primary);
  }
  .stall .nf {
    color: var(--orange);
    padding-top: 2px;
  }
  .help {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 520px;
    padding: 20px 24px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-panel) 96%, transparent);
    border: 1px solid var(--border);
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  }
  .help h2 {
    margin: 0 0 12px;
    font-size: 14px;
    color: var(--purple);
    display: flex;
    gap: 8px;
    align-items: center;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 7px 16px;
    margin: 0;
  }
  dt {
    text-align: right;
    color: var(--text-muted);
    white-space: nowrap;
  }
  dd {
    margin: 0;
    color: var(--text-secondary);
  }
  .help p {
    margin: 14px 0 0;
    color: var(--text-muted);
    font-size: 12px;
  }
</style>
