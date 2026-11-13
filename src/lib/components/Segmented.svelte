<script lang="ts" generics="T extends string | number | boolean">
  import { I } from "$lib/icons";

  interface Option {
    value: T;
    label: string;
    icon?: string;
  }

  interface Props {
    value: T;
    options: Option[];
    label?: string;
    /** the default: a reset button shows beside the label while another is chosen */
    def?: T;
    /** tighter buttons, for two groups side by side */
    compact?: boolean;
    /** what the setting does, shown on hover */
    title?: string;
  }

  let { value = $bindable(), options, label, def, compact = false, title }: Props = $props();
</script>

<div class="seg-wrap" class:compact>
  {#if label}
    <span class="head">
      <span class="label" class:explained={!!title} {title}>{label}</span>
      {#if def !== undefined && value !== def}
        <button class="reset nf" title="Back to the default, {options.find((o) => o.value === def)?.label ?? def}" onclick={() => (value = def)}>{I.undo}</button>
      {/if}
    </span>
  {/if}
  <div class="seg" role="radiogroup">
    {#each options as o (o.value)}
      <button class:on={value === o.value} role="radio" aria-checked={value === o.value} onclick={() => (value = o.value)}>
        {#if o.icon}<span class="nf">{o.icon}</span>{/if}
        {o.label}
      </button>
    {/each}
  </div>
</div>

<style>
  .seg-wrap {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 15px;
  }
  .seg-wrap .reset {
    flex: none;
    padding: 0 3px;
    border: 0;
    background: none;
    color: var(--text-muted);
    font-size: 10px;
    line-height: 1;
    cursor: pointer;
  }
  .seg-wrap .reset:hover {
    color: var(--purple);
  }
  /* a dotted underline: hover for what it does */
  .label.explained {
    text-decoration: underline dotted color-mix(in srgb, var(--text-muted) 70%, transparent);
    text-underline-offset: 3px;
  }
  .label {
    color: var(--text-secondary);
    font-weight: 600;
    font-size: 12px;
  }
  .seg {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    border-radius: var(--radius);
    background: var(--bg-chip);
    border: 1px solid var(--border);
  }
  .seg button {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 5px 12px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }
  .compact .seg button {
    padding: 5px 9px;
  }
  .seg button:hover {
    color: var(--text-primary);
  }
  .seg button.on {
    background: var(--bg-selected-active);
    color: var(--text-primary);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--purple) 45%, transparent);
  }
  .nf {
    font-size: 11px;
  }
</style>
