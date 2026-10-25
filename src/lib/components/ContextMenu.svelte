<script lang="ts">
  // Right-click on a tile, a feed item or the open item: what to do with that
  // file. The wall decides what each action means; this only lays out the
  // menu, keeps it on screen, and closes it on a click elsewhere.
  import { onMount } from "svelte";
  import { isUrl } from "$lib/api";
  import type { Media } from "$lib/queue.svelte";
  import { I } from "$lib/icons";

  export type MenuAction = "reveal" | "open" | "remove" | "hide";

  interface Props {
    media: Media;
    x: number;
    y: number;
    onaction: (a: MenuAction) => void;
    onclose: () => void;
  }

  let { media, x, y, onaction, onclose }: Props = $props();

  let el = $state<HTMLDivElement>();
  let w = $state(0);
  let h = $state(0);
  // open toward the room there is, as native menus do
  const left = $derived(x + w > innerWidth - 6 ? Math.max(6, x - w) : x);
  const top = $derived(y + h > innerHeight - 6 ? Math.max(6, y - h) : y);
  const remote = $derived(isUrl(media.path));

  function pick(a: MenuAction) {
    onaction(a);
    onclose();
  }

  onMount(() => {
    const away = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) onclose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", onclose);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", onclose);
    };
  });
</script>

<div
  bind:this={el}
  bind:clientWidth={w}
  bind:clientHeight={h}
  class="menu"
  style:left="{left}px"
  style:top="{top}px"
  role="menu"
  tabindex="-1"
  oncontextmenu={(e) => e.preventDefault()}
>
  <div class="head" title={media.path}>
    <span class="name">{media.name}</span>
    <span class="dim">{media.w}×{media.h}</span>
  </div>
  <button role="menuitem" disabled={remote} onclick={() => pick("reveal")}>
    <span class="nf">{I.folderOpen}</span>Show in Explorer<kbd>O</kbd>
  </button>
  <button role="menuitem" onclick={() => pick("open")}>
    <span class="nf">{I.external}</span>Open in default app
  </button>
  <hr />
  <button role="menuitem" onclick={() => pick("remove")}>
    <span class="nf">{I.eyeSlash}</span>Remove from wall<span class="note">until you go back to setup</span>
  </button>
  <button role="menuitem" class="danger" onclick={() => pick("hide")}>
    <span class="nf">{I.ban}</span>Never show again<span class="note">undo in setup</span>
  </button>
</div>

<style>
  .menu {
    position: fixed;
    z-index: 60;
    min-width: 230px;
    max-width: 340px;
    padding: 5px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-panel);
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.4),
      0 10px 28px rgba(0, 0, 0, 0.45);
    font-size: 12.5px;
    color: var(--text-primary);
    animation: in 90ms ease-out both;
    outline: none;
  }
  @keyframes in {
    from { opacity: 0; transform: translateY(-3px); }
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 5px 8px 7px;
    margin-bottom: 3px;
    border-bottom: 1px solid var(--border-muted);
  }
  .name {
    font-family: var(--mono);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .dim {
    flex: none;
    color: var(--text-muted);
    font-family: var(--mono);
    font-size: 11px;
  }
  button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--bg-selected-active);
  }
  button:disabled {
    color: var(--text-muted);
    cursor: default;
  }
  button .nf {
    width: 14px;
    text-align: center;
    color: var(--text-secondary);
  }
  .danger .nf {
    color: var(--orange);
  }
  kbd,
  .note {
    margin-left: auto;
    padding-left: 12px;
    color: var(--text-muted);
    font-size: 11px;
  }
  hr {
    margin: 4px 2px;
    border: 0;
    border-top: 1px solid var(--border-muted);
  }
</style>
