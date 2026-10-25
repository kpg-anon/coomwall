<script lang="ts" generics="T extends string">
  interface Option {
    value: T;
    label: string;
    icon?: string;
  }

  interface Props {
    value: T;
    options: Option[];
    label?: string;
  }

  let { value = $bindable(), options, label }: Props = $props();
</script>

<div class="seg-wrap">
  {#if label}<span class="label">{label}</span>{/if}
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
  button {
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
  button:hover {
    color: var(--text-primary);
  }
  button.on {
    background: var(--bg-selected-active);
    color: var(--text-primary);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--purple) 45%, transparent);
  }
  .nf {
    font-size: 11px;
  }
</style>
