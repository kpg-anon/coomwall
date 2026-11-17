<script lang="ts" module>
  type Tab = "general" | "behavior" | "keyboard" | "grid" | "system";
  /** the tab shown when the dialog opens: the one last used */
  let lastTab: Tab = "general";
</script>

<script lang="ts">
  // The cog on the setup screen: how the app behaves, as opposed to how a
  // wall is built. Theme, what happens under the pointer and when the wall
  // pauses, the window, the GPU and color, the speed keys, and every key.
  import { onMount } from "svelte";
  import { settings, DEFAULTS, parseRates } from "$lib/settings.svelte";
  import { api, type Adapter, type GpuInfo } from "$lib/api";
  import { wallKeys } from "$lib/keys";
  import { THEMES } from "$lib/themes";
  import { I } from "$lib/icons";
  import Range from "./Range.svelte";
  import Segmented from "./Segmented.svelte";

  let { onclose }: { onclose: () => void } = $props();

  const TABS: { id: Tab; name: string; icon: string; what: string }[] = [
    { id: "general", name: "General", icon: I.desktop, what: "Theme and the wall's window" },
    { id: "behavior", name: "Behavior", icon: I.th, what: "What the wall does under the pointer, when it pauses, its controls and sound" },
    { id: "keyboard", name: "Keyboard", icon: I.keyboard, what: "The playback speed keys, and every key on the wall" },
    { id: "grid", name: "Grid", icon: I.thLarge, what: "How closely media must fit Grid cells" },
    { id: "system", name: "System", icon: I.cog, what: "Graphics card, color handling, yt-dlp" },
  ];
  let tab = $state<Tab>(lastTab);

  /** what "Restore defaults" puts back: everything in this dialog */
  const PREF_KEYS = ["theme", "hoverPause", "hoverHold", "audioFollowsMouse", "audioAll", "pauseBehindViewer", "pauseUnfocused", "alwaysOnTop", "hudSeconds", "hideBars", "hideViewerBars", "hideViewerControls", "volume", "gpu", "color", "rateKeys", "rateList", "gridFitCrop", "ytdlCookies", "autoUpdateCheck"] as const;
  let winH = $state(800);
  const changedAny = $derived(PREF_KEYS.some((k) => JSON.stringify(s[k]) !== JSON.stringify(DEFAULTS[k])));

  function restoreDefaults() {
    for (const k of PREF_KEYS) (s as any)[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
    rateText = s.rateList.join(", ");
  }

  const s = settings.s;
  let gpu = $state.raw<GpuInfo | null>(null);
  /** System tab: the links cache, and the tools links need */
  let linksMB = $state<number | null>(null);
  let linksNote = $state("");
  let tools = $state.raw<{ ytdlp: string | null; ffmpeg: string | null; webview: string | null } | null>(null);

  async function clearLinks() {
    try {
      const freed = await api.clearLinks();
      linksNote = `${(freed / 1048576).toFixed(0)} MB freed`;
    } catch (e) {
      linksNote = String(e);
    }
    linksMB = (await api.linksSize().catch(() => 0)) / 1048576;
  }
  /** the color setting this launch started with; null until Rust answers */
  let launchColor = $state<string | null>(null);
  let restarting = $state(false);
  /** the speed list as typed; written to rateList when it parses */
  let rateText = $state(s.rateList.join(", "));

  function setRates() {
    const list = parseRates(rateText);
    s.rateList = list.length ? list : [...DEFAULTS.rateList];
    rateText = s.rateList.join(", ");
  }

  function shortGpu(a: Adapter): string {
    return a.name.replace(/\((R|TM)\)/g, "").replace(/\s+Graphics$/, "").replace(/\s+/g, " ").trim();
  }

  // The adapter the next launch would use, as gpu::resolve in Rust picks it.
  // When it differs from the one this launch renders on, the setting has not
  // taken effect yet.
  const wanted = $derived.by((): Adapter | null => {
    if (!gpu) return null;
    if (s.gpu === "high") return gpu.high;
    if (s.gpu === "low") return gpu.low;
    return null;
  });
  const stale = $derived(!!gpu && (wanted?.luid ?? null) !== (gpu.chosen?.luid ?? null));
  const staleColor = $derived(launchColor !== null && launchColor !== s.color);

  function restart() {
    restarting = true;
    // settings save on a 400 ms debounce; restart once that has written
    setTimeout(() => api.restart(), 700);
  }

  onMount(() => {
    api.gpuInfo().then((g) => (gpu = g)).catch(() => {});
    api.linksSize().then((b) => (linksMB = b / 1048576)).catch(() => (linksMB = 0));
    api.toolsInfo().then((t) => (tools = t)).catch(() => {});
    api.launchColor().then((c) => (launchColor = c)).catch(() => {});
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onclose();
    };
    // capture: before Setup's own keys, which this dialog covers
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
</script>

<svelte:window bind:innerHeight={winH} />

<div class="backdrop" onclick={(e) => e.target === e.currentTarget && onclose()} role="presentation">
  <!-- the height is set in px: a percentage of the backdrop resolved against
       the dialog's own content and let it run off the bottom of the window -->
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="prefs-title" style:height="{Math.min(600, winH - 40)}px">
    <header>
      <h2 id="prefs-title"><span class="nf">{I.cog}</span> Preferences</h2>
      <span class="spacer"></span>
      <button class="restore" disabled={!changedAny} onclick={restoreDefaults} title="Put every setting in this dialog back to how coomwall starts">
        <span class="nf">{I.undo}</span> Restore defaults
      </button>
      <button class="close nf" title="Close (Esc)" onclick={onclose}>{I.close}</button>
    </header>

    <div class="body">
      <nav class="tabs" aria-label="Preferences">
        {#each TABS as tb (tb.id)}
          <button class="tab" class:on={tab === tb.id} onclick={() => (tab = lastTab = tb.id)}>
            <span class="nf">{tb.icon}</span>{tb.name}
          </button>
        {/each}
      </nav>

      <div class="pane">
        {#if tab === "general"}
          <section>
            <span class="sec-title">Theme</span>
            <div class="themes">
              {#each THEMES as t (t.id)}
                <button class="theme" class:on={s.theme === t.id} onclick={() => (s.theme = t.id)}>
                  <span class="sw">{#each t.swatches as c}<i style:background={c}></i>{/each}</span>
                  <span class="t-name">{t.name}</span>
                </button>
              {/each}
            </div>
          </section>
          <section>
            <span class="sec-title">Window</span>
            <label class="check">
              <input type="checkbox" bind:checked={s.alwaysOnTop} /><span title="The wall stays above every other window, even one you click on. T on the wall turns it on or off.">Keep the wall above other windows <kbd>T</kbd></span>
            </label>
            <span class="note">Off: another program you bring to the front stays in front of the wall.</span>
          </section>
          <section>
            <span class="sec-title">Updates</span>
            <label class="check">
              <input type="checkbox" bind:checked={s.autoUpdateCheck} /><span title="When coomwall starts, it asks GitHub whether a newer release exists and offers it with its changelog. Nothing is downloaded until you choose Update now.">Check for updates when coomwall starts</span>
            </label>
            <span class="note">An update shows its changelog first; Update now downloads it, installs it and restarts.</span>
          </section>
        {:else if tab === "behavior"}
          <section>
            <span class="sec-title">Under the pointer</span>
            <div class="checks">
              <label class="check">
                <input type="checkbox" bind:checked={s.hoverPause} /><span title="Ribbon and Cascade: the row or column under the pointer slows to a stop, so you can watch an item, and moves on when the pointer leaves.">Ribbon, Cascade: the lane stops</span>
              </label>
              <label class="check">
                <input type="checkbox" bind:checked={s.hoverHold} /><span title="Mosaic, Dynamic and Grid: the tile under the pointer is never moved by other changes, and plays its item again instead of changing to the next.">Mosaic, Dynamic, Grid: the tile holds still and keeps its item</span>
              </label>
              <label class="check">
                <input type="checkbox" bind:checked={s.audioFollowsMouse} /><span title="The item under the pointer plays with sound, as well as the items you gave sound with M. Off: only the items you pick with M have sound.">Sound follows the pointer</span>
              </label>
              <label class="check">
                <input type="checkbox" bind:checked={s.audioAll} /><span title="Every video on the wall plays with sound at the same time. Off: only the items you pick with M (and the item under the pointer, if that is on) have sound.">Sound on every video</span>
              </label>
            </div>
          </section>
          <section>
            <span class="sec-title">Pause the wall</span>
            <div class="checks">
              <label class="check">
                <input type="checkbox" bind:checked={s.pauseBehindViewer} /><span title="While you view one item whole (F or a double-click), everything else on the wall pauses.">While one item is open whole <kbd>F</kbd></span>
              </label>
              <label class="check">
                <input type="checkbox" bind:checked={s.pauseUnfocused} /><span title="The wall pauses when you switch to another program, and plays again when you come back.">While another app is active</span>
              </label>
            </div>
          </section>
          <section>
            <span class="sec-title">Hide</span>
            <div class="checks">
              <label class="check">
                <input type="checkbox" bind:checked={s.hideBars} /><span title="The bars at the top and bottom of the wall never appear, also when the pointer moves. Messages, the ? key list and the pointer still show. Esc goes back to setup.">The wall's top and bottom bars</span>
              </label>
              <label class="check">
                <input type="checkbox" bind:checked={s.hideViewerBars} /><span title="While one item is open whole (F or a double-click), the bar with its name and tools and the key list at the bottom never appear. The video controls are a separate setting. Esc closes the viewer.">The viewer's top and bottom bars <kbd>F</kbd></span>
              </label>
              <label class="check">
                <input type="checkbox" bind:checked={s.hideViewerControls} /><span title="While a video is open whole (F or a double-click), its play, seek, time and sound controls never appear. The keys still work: Space plays, the arrows seek, M turns sound on or off.">The viewer's video controls</span>
              </label>
            </div>
            {#if s.hideBars || s.hideViewerBars || s.hideViewerControls}<span class="note">The keys still work: <kbd>Esc</kbd> goes back, <kbd>?</kbd> on the wall lists them.</span>{/if}
          </section>
          <section>
            <span class="sec-title">On the wall</span>
            <div class="pair">
              <Range
                label="Controls hide after"
                title={s.hideBars ? "How long the pointer stays after it stops moving." : "How long the bars at the top and bottom of the wall, and the pointer, stay after the pointer stops moving."}
                bind:value={s.hudSeconds}
                min={0.5}
                max={10}
                step={0.1}
                format={(v) => `${v.toFixed(1)} s`}
                def={DEFAULTS.hudSeconds}
              />
              <Range
                label="Volume"
                title="How loud the items with sound play (M on the wall picks them)."
                bind:value={s.volume}
                def={DEFAULTS.volume}
                min={0}
                max={100}
                step={5}
                format={(v) => `${v}%`}
              />
            </div>
          </section>
        {:else if tab === "keyboard"}
          <section>
            <span class="sec-title">Playback speed keys</span>
            <div class="speed-keys">
              <Segmented
                label="[ and ]"
                title="What [ and ] do on the wall: step through a list of speeds, or change the speed by 0.05 at a time."
                bind:value={s.rateKeys}
                def={DEFAULTS.rateKeys}
                options={[
                  { value: "list", label: "Step through a list" },
                  { value: "fine", label: "0.05 at a time" },
                ]}
              />
              {#if s.rateKeys === "list"}
                <input
                  class="text"
                  bind:value={rateText}
                  onchange={setRates}
                  onkeydown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  spellcheck="false"
                  aria-label="Speeds the keys step through"
                  title="The speeds, comma separated. [ steps to the next slower one, ] to the next faster."
                />
                <span class="note">The speeds <kbd>[</kbd> and <kbd>]</kbd> step through, comma separated. <kbd>Shift</kbd> moves by 0.05.</span>
              {:else}
                <span class="note"><kbd>Shift</kbd> moves by 0.25.</span>
              {/if}
            </div>
          </section>
          <section>
            <span class="sec-title">Keys on the wall</span>
            <dl class="keys">
              {#each wallKeys(s.rateKeys, s.rateList) as row}
                <dt>
                  {#each row.keys as k}{#if k === "–"}–{:else}<kbd>{k}</kbd>{/if}{" "}{/each}{#if row.also}{row.keys.length ? "/ " : ""}{row.also}{/if}
                </dt>
                <dd>{row.does}</dd>
              {/each}
            </dl>
          </section>
        {:else if tab === "grid"}
          <section>
            <span class="sec-title">Only media that fits the cells</span>
            <Segmented
              label="How close the shape must be"
              title="When a Grid has 'Only media that fits the cells' on: how much of a file may be cut off for it to count as fitting."
              bind:value={s.gridFitCrop}
              def={DEFAULTS.gridFitCrop}
              options={[
                { value: "auto", label: "Automatic" },
                { value: "exact", label: "Exact shape" },
                { value: "loose", label: "Up to 12% cut" },
              ]}
            />
            <span class="note fit-note">
              {#if s.gridFitCrop === "auto"}
                Exact shape on a 16:9 screen, up to 12% on any other.
              {:else if s.gridFitCrop === "exact"}
                Nothing is cut off. On a 16:9 screen, 16:9 video fits a 3×3 grid exactly; on a 16:10 screen it does not fit.
              {:else}
                On a 16:10 screen, 16:9 video loses about 10% in a 3×3 grid, so it still fits.
              {/if}
              Applies when a Grid has "Only media that fits the cells" on.
            </span>
          </section>
        {:else}
          <section class="system">
            <div class="select">
              <label class="select">
                <span title="The graphics card that decodes and draws the videos. Takes effect after a restart." class="label explained">Graphics</span>
                <select bind:value={s.gpu}>
                  <option value="auto">Windows default</option>
                  <option value="high">High performance{gpu?.high ? ` · ${shortGpu(gpu.high)}` : ""}</option>
                  <option value="low">Power saving{gpu?.low ? ` · ${shortGpu(gpu.low)}` : ""}</option>
                </select>
              </label>
              {#if gpu}
                {#if stale}
                  <span class="note warn">
                    Needs a restart to use {wanted ? shortGpu(wanted) : "the Windows default"}.
                    <button class="restart" onclick={restart} disabled={restarting}>
                      <span class="nf">{I.refresh}</span>{restarting ? "Restarting…" : "Restart"}
                    </button>
                  </span>
                {:else}
                  <span class="note">Running on {gpu.chosen ? shortGpu(gpu.chosen) : "the Windows default"}</span>
                {/if}
                {#if gpu.high && gpu.low && gpu.high.luid !== gpu.low.luid}
                  <span class="note">
                    On a laptop the built-in screen is wired to the integrated GPU, so with High performance every frame is copied
                    across. On a 4K built-in panel most videos can then stop on one frame; the wall says so when it happens. Windows
                    default avoids the copy.
                  </span>
                {/if}
              {/if}
            </div>
            <div class="select">
              <label class="select">
                <span title="Whether colors go to the display as they are in the file, or are converted to the display's color profile. Takes effect after a restart." class="label explained">Color</span>
                <select bind:value={s.color}>
                  <option value="direct">As in the file · like mpv and most viewers</option>
                  <option value="managed">Converted to the display's color profile</option>
                </select>
              </label>
              {#if staleColor}
                <span class="note warn">
                  Needs a restart.
                  <button class="restart" onclick={restart} disabled={restarting}>
                    <span class="nf">{I.refresh}</span>{restarting ? "Restarting…" : "Restart"}
                  </button>
                </span>
              {:else}
                <span class="note">On a wide-gamut display, converting makes ordinary (sRGB) media look less saturated than in other players.</span>
              {/if}
            </div>
            <div class="select">
              <label class="select">
                <span title="Stack mode plays page links with yt-dlp. For a video that needs a login (age-restricted, members only), yt-dlp can read that site's cookies from your browser. On Windows, Chrome, Edge and Brave lock or encrypt their cookies while they run, so From Firefox is the one that works reliably." class="label explained">yt-dlp cookies</span>
                <select bind:value={s.ytdlCookies}>
                  <option value="">None</option>
                  <option value="firefox">From Firefox</option>
                  <option value="chrome">From Chrome</option>
                  <option value="edge">From Edge</option>
                  <option value="brave">From Brave</option>
                </select>
              </label>
              <span class="note">
                Downloaded links: {linksMB === null ? "…" : `${linksMB.toFixed(linksMB < 10 ? 1 : 0)} MB`}
                <button class="restart" onclick={() => api.openLinksDir().catch(() => {})}><span class="nf">{I.folderOpen}</span>Open the folder</button>
                <button class="restart" disabled={!linksMB} onclick={clearLinks}><span class="nf">{I.trash}</span>Clear</button>
                {#if linksNote}<span class="warn">{linksNote}</span>{/if}
              </span>
              <span class="note" class:warn={tools && !tools.ytdlp}>
                {#if !tools}
                  Looking for yt-dlp and ffmpeg…
                {:else}
                  {tools.ytdlp ? `yt-dlp ${tools.ytdlp}` : "yt-dlp not found on PATH: links cannot play (winget install yt-dlp)"} ·
                  {tools.ffmpeg ? `ffmpeg ${tools.ffmpeg}` : "ffmpeg not found: downloads limited to one-file formats (360p on YouTube); streaming is not affected"}
                  {#if tools.webview} · WebView2 {tools.webview}{/if}
                {/if}
              </span>
            </div>
          </section>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(0, 0, 0, 0.55);
    animation: fade 140ms ease both;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .dialog {
    width: min(860px, 100%);
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
  }
  .spacer {
    flex: 1;
  }
  .restore {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-right: 10px;
    padding: 4px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }
  .restore:hover:not(:disabled) {
    border-color: var(--purple);
    color: var(--text-primary);
  }
  .restore:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .restore .nf {
    font-size: 11px;
  }
  header {
    display: flex;
    align-items: center;
    padding: 14px 18px 12px 22px;
    border-bottom: 1px solid var(--border-muted);
  }
  h2 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 15px;
    color: var(--text-primary);
  }
  h2 .nf {
    color: var(--purple);
  }
  .close {
    display: grid;
    place-items: center;
    width: 28px;
    height: 26px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-secondary);
    cursor: pointer;
  }
  .close:hover {
    border-color: var(--red);
    color: var(--red);
  }
  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
  }
  .tabs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 10px;
    border-right: 1px solid var(--border-muted);
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border: 0;
    border-radius: var(--radius);
    background: transparent;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }
  .tab .nf {
    width: 16px;
    color: var(--text-muted);
    font-size: 13px;
  }
  .tab:hover {
    background: var(--bg-chip);
    color: var(--text-primary);
  }
  .tab.on {
    background: var(--bg-selected-active);
    color: var(--text-primary);
    box-shadow: inset 2px 0 0 var(--purple);
  }
  .tab.on .nf {
    color: var(--purple);
  }
  /* the chosen tab's settings; long ones (the key list) scroll here */
  .pane {
    min-width: 0;
    overflow-y: auto;
    padding: 4px 24px 12px;
  }
  .checks {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  section {
    padding: 16px 0;
    border-top: 1px solid var(--border-muted);
  }
  section:first-child {
    border-top: 0;
  }
  .sec-title {
    display: block;
    margin-bottom: 12px;
    font-weight: 700;
    color: var(--text-secondary);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .label {
    color: var(--text-secondary);
    font-weight: 600;
    font-size: 12px;
  }
  .note {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 10px;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--text-muted);
  }
  .note.warn {
    color: var(--orange);
  }
  .note kbd,
  .check kbd,
  .keys kbd {
    font-size: 10px;
  }
  .themes {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .theme {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px 5px 5px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }
  .theme.on {
    border-color: var(--purple);
    box-shadow: 0 0 0 1px var(--purple);
    color: var(--text-primary);
  }
  .sw {
    display: flex;
  }
  .sw i {
    width: 9px;
    height: 16px;
  }
  .sw i:first-child {
    border-radius: 3px 0 0 3px;
  }
  .sw i:last-child {
    border-radius: 0 3px 3px 0;
  }
  .check {
    display: inline-flex;
    align-items: flex-start;
    gap: 8px;
    color: var(--text-secondary);
    font-size: 12.5px;
    cursor: pointer;
  }
  .check input {
    accent-color: var(--purple);
    width: 14px;
    height: 14px;
    margin: 2px 0 0;
    flex: none;
  }
  .fit-note {
    margin-top: 8px;
  }
  .pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 24px;
  }
  /* a dotted underline: hover for what it does */
  .label.explained,
  .check > span[title],
  .check > span:global([data-tip]) {
    text-decoration: underline dotted color-mix(in srgb, var(--text-muted) 70%, transparent);
    text-underline-offset: 3px;
  }
  .note {
    margin-top: 8px;
  }
  .system {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .select {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  select,
  .text {
    padding: 5px 8px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-primary);
    font-size: 12px;
  }
  .text {
    width: 180px;
    font-family: var(--mono);
  }
  .text:focus {
    outline: none;
    border-color: var(--purple);
  }
  .restart {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-primary);
    font-size: 11.5px;
    cursor: pointer;
  }
  .restart:hover:not(:disabled) {
    border-color: var(--purple);
  }
  .speed-keys {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 8px 10px;
  }
  .speed-keys .note {
    flex-basis: 100%;
  }
  .keys {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 6px 14px;
    margin: 0;
    font-size: 12px;
  }
  .keys dt {
    text-align: right;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .keys dd {
    margin: 0;
    color: var(--text-secondary);
  }
</style>
