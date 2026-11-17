<script lang="ts">
  // Shown only while the pointer moves (or a key is pressed); the wall itself
  // has no interface. Top: what is playing and what is under the pointer.
  // Bottom: the keys, like comfysort's bottom bar.
  import { I, MODE_ICON } from "$lib/icons";
  import type { Media } from "$lib/queue.svelte";
  import { MODE_NAMES, settings, type Mode } from "$lib/settings.svelte";
  import { wallKeys } from "$lib/keys";
  import CenterIcon from "./CenterIcon.svelte";

  interface Props {
    visible: boolean;
    /** one item is open in the viewer: only messages show, above it */
    bare?: boolean;
    /** the top and bottom bars are off (Preferences); messages still show */
    noBars?: boolean;
    help: boolean;
    mode: Mode;
    count: number;
    countLabel: string;
    /** the mode's own numbers: direction and speed, grid size, ... */
    detail: string;
    /** the center item, when the center is on: its size and name */
    center?: string;
    paused: boolean;
    onTop: boolean;
    rate: number;
    hover: Media | null;
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


  function ext(name: string): string {
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(i + 1).toLowerCase() : "";
  }

  const KEYS: [string, string][] = [
    ["Space", "pause"],
    ["+ −", "count"],
    ["1–5", "mode"],
    ["N", "next"],
    ["P", "pin"],
    ["M", "sound"],
    ["F", "view"],
    ["C", "center"],
    ["[ ]", "speed"],
    ["R", "retile"],
    ["?", "keys"],
    ["Esc", "back"],
  ];
</script>

<div class="hud" class:visible={(p.visible && !p.bare) || p.help || !!p.toast} class:bare={p.bare} class:no-bars={p.noBars}>
  {#if !p.bare && !p.noBars}
    <div class="top">
      <button class="back" onclick={p.onexit} title="Back to setup (Esc)"><span class="nf">{I.back}</span></button>
      <span class="brand">coomwall</span>
      <span class="chip mode"><span class="nf">{MODE_ICON[p.mode]}</span>{MODE_NAMES[p.mode]}</span>
      {#if p.countLabel}<span class="chip">{p.count} {p.countLabel}</span>{/if}
      {#if p.detail}<span class="chip detail">{p.detail}</span>{/if}
      {#if p.center}<span class="chip detail" title="Centered media (C on it stops centering, Shift+↑↓ its size)"><span class="ci"><CenterIcon /></span>{p.center}</span>{/if}
      {#if p.rate !== 1}<span class="chip">{p.rate.toFixed(2)}×</span>{/if}
      {#if p.onTop}<span class="chip" title="Above every other window (T)"><span class="nf">{I.layers}</span>on top</span>{/if}
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
  {/if}

  {#if p.toast}<div class="toast">{p.toast}</div>{/if}
  {#if p.stall && !p.bare}<div class="stall"><span class="nf">{I.warn}</span>{p.stall}</div>{/if}

  {#if !p.bare && !p.noBars}
    <div class="bottom">
      {#each KEYS as [k, label]}
        <span class="key"><kbd>{k}</kbd>{label}</span>
      {/each}
    </div>
  {/if}

  {#if p.help}
    <div class="help">
      <h2><span class="nf">{I.keyboard}</span> Keys</h2>
      <dl>
        {#each wallKeys(settings.s.rateKeys, settings.s.rateList) as row}
          <dt>
            {#each row.keys as k}{#if k === "–"}–{:else}<kbd>{k}</kbd>{/if}{" "}{/each}{#if row.also}{row.keys.length ? "/ " : ""}{row.also}{/if}
          </dt>
          <dd>{row.does}</dd>
        {/each}
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
  /* above the viewer (z-index 30) */
  .hud.bare {
    z-index: 40;
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
  .chip.detail .ci {
    display: inline-flex;
    color: var(--purple);
    margin-right: 6px;
  }
  .chip.detail {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-block;
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
  /* no top bar to clear */
  .no-bars .toast,
  .no-bars .stall {
    top: 12px;
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
    width: 640px;
    max-height: calc(100% - 140px);
    overflow-y: auto;
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
