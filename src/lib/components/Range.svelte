<script lang="ts">
  interface Props {
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    hint?: string;
    format?: (v: number) => string;
    /** labels under the two ends of the track */
    ends?: [string, string];
  }

  let { label, value = $bindable(), min, max, step = 1, hint = "", format = (v) => String(v), ends }: Props = $props();

  const pct = $derived(((value - min) / (max - min)) * 100);
</script>

<label class="range">
  <span class="head">
    <span class="label">{label}</span>
    <span class="value">{format(value)}</span>
  </span>
  <input type="range" {min} {max} {step} bind:value style:--pct="{pct}%" />
  {#if ends}
    <span class="ends"><span>{ends[0]}</span><span>{ends[1]}</span></span>
  {:else if hint}
    <span class="hint">{hint}</span>
  {/if}
</label>

<style>
  .range {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
  }
  .label {
    color: var(--text-secondary);
    font-weight: 600;
    font-size: 12px;
  }
  .value {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-primary);
  }
  .hint,
  .ends {
    color: var(--text-muted);
    font-size: 11px;
  }
  .ends {
    display: flex;
    justify-content: space-between;
  }
  input[type="range"] {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 18px;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }
  input[type="range"]::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--purple) var(--pct), var(--border) var(--pct));
  }
  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -5px;
    border-radius: 50%;
    background: var(--text-primary);
    border: 2px solid var(--purple);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  }
  input[type="range"]:focus-visible {
    outline: none;
  }
  input[type="range"]:focus-visible::-webkit-slider-thumb {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--purple) 40%, transparent);
  }
</style>
