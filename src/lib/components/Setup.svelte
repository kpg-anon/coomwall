<script lang="ts">
  // The one screen before the wall: sources, a mode, and the one or two
  // numbers that mode needs. Everything else sits under "More options".
  // With a wall on each display, the mode section edits the display picked
  // on the small map of displays.
  import { onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import { availableMonitors, currentMonitor, type Monitor } from "@tauri-apps/api/window";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { settings, LIMITS, layoutOf, type Layout, type Mode, type WallLayout } from "$lib/settings.svelte";
  import { library } from "$lib/library.svelte";
  import { api, isUrl, type Adapter, type GpuInfo } from "$lib/api";
  import { I } from "$lib/icons";
  import { THEMES } from "$lib/themes";
  import Range from "./Range.svelte";
  import Segmented from "./Segmented.svelte";

  let { onstart }: { onstart: () => void } = $props();

  const s = settings.s;
  let more = $state(false);
  let dragging = $state(false);
  /** displays Windows names; one without a name cannot be addressed */
  let monitors = $state<(Monitor & { name: string })[]>([]);
  let gpu = $state.raw<GpuInfo | null>(null);
  /** multi: the display the mode section edits */
  let sel = $state("");
  let wallError = $state("");

  const MODES: { id: Mode; name: string; icon: string; line: string; key: string }[] = [
    { id: "mosaic", name: "Mosaic", icon: I.th, line: "Fills the screen. Changes one block at a time, never the one you watch.", key: "1" },
    { id: "ribbon", name: "Ribbon", icon: I.bars, line: "Rows that glide sideways, every item at its own shape.", key: "2" },
    { id: "cascade", name: "Cascade", icon: I.columns, line: "Columns that drift up or down, like a slow feed.", key: "3" },
    { id: "dynamic", name: "Dynamic", icon: I.random, line: "New media every few seconds, and the whole grid rearranges around it.", key: "4" },
  ];

  function leaf(p: string): string {
    if (isUrl(p)) return p.replace(/^https?:\/\//, "");
    const n = p.replace(/[\\/]+$/, "");
    return n.slice(Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\")) + 1) || n;
  }

  function parent(p: string): string {
    const n = p.replace(/[\\/]+$/, "");
    return n.slice(0, Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\")));
  }

  function sourceIcon(p: string): string {
    if (isUrl(p)) return I.film;
    return /\.m3u8?$/i.test(p) ? I.list : I.folder;
  }

  async function addFolder() {
    const r = await open({ directory: true, multiple: true, title: "Add folders to the wall" });
    if (r) library.add(Array.isArray(r) ? r : [r]);
  }

  async function addPlaylist() {
    const r = await open({
      multiple: true,
      title: "Add playlists",
      filters: [{ name: "Playlists", extensions: ["m3u", "m3u8"] }],
    });
    if (r) library.add(Array.isArray(r) ? r : [r]);
  }

  function monitorLabel(m: Monitor, i: number): string {
    return `Display ${i + 1} · ${m.size.width}×${m.size.height}`;
  }

  const multi = $derived(s.multiWall && monitors.length > 1);
  /** what the mode section edits: one display's wall, or the single wall */
  const L = $derived<Layout>(multi && s.walls[sel] ? s.walls[sel] : s);
  const wallsOn = $derived(multi ? monitors.filter((m) => s.walls[m.name]?.on) : []);

  /** every connected display gets a layout, starting as a copy of the single wall's */
  function ensureWalls() {
    for (const m of monitors) if (m.name && !s.walls[m.name]) s.walls[m.name] = { ...layoutOf(s), on: true };
  }

  function wallSummary(w: WallLayout | undefined): string {
    if (!w?.on) return "off";
    const name = MODES.find((m) => m.id === w.mode)?.name ?? w.mode;
    const key = settings.countKey(w.mode);
    return `${name} · ${w[key]} ${key}`;
  }

  // the displays drawn where Windows has them, scaled into a small box
  const map = $derived.by(() => {
    if (monitors.length < 2) return null;
    const x0 = Math.min(...monitors.map((m) => m.position.x));
    const y0 = Math.min(...monitors.map((m) => m.position.y));
    const x1 = Math.max(...monitors.map((m) => m.position.x + m.size.width));
    const y1 = Math.max(...monitors.map((m) => m.position.y + m.size.height));
    const k = Math.min(260 / (x1 - x0), 120 / (y1 - y0));
    return {
      w: (x1 - x0) * k,
      h: (y1 - y0) * k,
      boxes: monitors.map((m, i) => ({
        m,
        i,
        x: (m.position.x - x0) * k,
        y: (m.position.y - y0) * k,
        w: m.size.width * k,
        h: m.size.height * k,
      })),
    };
  });
  const selIndex = $derived(monitors.findIndex((m) => m.name === sel));

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
  let restarting = $state(false);

  function restart() {
    restarting = true;
    // settings save on a 400 ms debounce; restart once that has written
    setTimeout(() => api.restart(), 700);
  }

  const playable = $derived(library.playable());
  const canStart = $derived(playable > 0 && !library.scanning && (!multi || wallsOn.length > 0));
  const countKey = $derived(settings.countKey(L.mode));

  async function start() {
    if (!canStart) return;
    if (!multi) return onstart();
    wallError = "";
    try {
      // the wall windows read settings.json as they load
      await settings.saveNow();
      await api.openWalls(wallsOn.map((m) => m.name));
    } catch (e) {
      wallError = String(e);
    }
  }

  function keydown(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT")) {
      if (e.key === "Enter" && t.tagName !== "SELECT") start();
      return;
    }
    if (e.key === "Enter") start();
    else if (e.key === "1") L.mode = "mosaic";
    else if (e.key === "2") L.mode = "ribbon";
    else if (e.key === "3") L.mode = "cascade";
    else if (e.key === "4") L.mode = "dynamic";
  }

  onMount(() => {
    Promise.all([availableMonitors(), currentMonitor()])
      .then(([all, here]) => {
        monitors = all.filter((m): m is Monitor & { name: string } => !!m.name);
        sel = here?.name ?? monitors[0]?.name ?? "";
        if (s.multiWall) ensureWalls();
      })
      .catch(() => {});
    api.gpuInfo().then((g) => (gpu = g)).catch(() => {});
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") dragging = true;
        else if (p.type === "leave") dragging = false;
        else if (p.type === "drop") {
          dragging = false;
          library.add(p.paths);
        }
      })
      .then((f) => (unlisten = f))
      .catch(() => {});
    window.addEventListener("keydown", keydown);
    return () => {
      unlisten?.();
      window.removeEventListener("keydown", keydown);
    };
  });

  $effect(() => {
    settings.s.theme;
    settings.applyTheme();
  });
</script>

{#snippet preview(mode: Mode)}
  <div class="pv pv-{mode}" aria-hidden="true">
    {#if mode === "mosaic"}
      <i class="m1"></i><i class="m2"></i><i class="m3"></i><i class="m4"></i><i class="m5"></i>
    {:else if mode === "dynamic"}
      <i class="d1"></i><i class="d2"></i><i class="d3"></i><i class="d4"></i><i class="d5"></i>
    {:else if mode === "ribbon"}
      {#each [0, 1] as row}
        <div class="row r{row}">
          {#each [0, 1] as _copy}
            <i style="width:22px"></i><i style="width:40px"></i><i style="width:14px"></i><i style="width:30px"></i><i style="width:22px"></i><i style="width:36px"></i>
          {/each}
        </div>
      {/each}
    {:else}
      {#each [0, 1, 2] as col}
        <div class="col c{col}">
          {#each [0, 1] as _copy}
            <i style="height:22px"></i><i style="height:12px"></i><i style="height:30px"></i><i style="height:16px"></i>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
{/snippet}

<div class="setup">
  <div class="card">
    <header>
      <img class="logo" src="/icon.png" alt="" />
      <div>
        <h1>coomwall</h1>
        <p class="tag">Point it at folders. Pick a mode. Everything plays at once.</p>
      </div>
    </header>

    <section>
      <div class="sec-head">
        <span class="sec-title">Sources</span>
        <span class="summary">
          {#if library.scanning}
            <span class="spin nf">{I.refresh}</span> scanning…
          {:else if s.sources.length}
            <b>{(library.images + library.videos).toLocaleString()}</b> files ·
            <span class="c-img">{library.images.toLocaleString()} images</span> ·
            <span class="c-vid">{library.videos.toLocaleString()} videos</span>
          {/if}
        </span>
      </div>

      {#if !s.sources.length}
        <button class="drop" class:dragging onclick={addFolder}>
          <span class="nf big">{I.folderOpen}</span>
          <span class="drop-main">Drop folders or <code>.m3u</code> playlists here</span>
          <span class="drop-sub">or click to choose a folder</span>
        </button>
      {:else}
        <div class="sources" class:dragging>
          {#each s.sources as src (src)}
            <span class="source" title={src}>
              <span class="nf s-icon">{sourceIcon(src)}</span>
              <span class="s-name">{leaf(src)}</span>
              {#if !isUrl(src)}<span class="s-path">{parent(src)}</span>{/if}
              <button class="x nf" title="Remove" onclick={() => library.remove(src)}>{I.close}</button>
            </span>
          {/each}
          <button class="add" onclick={addFolder}><span class="nf">{I.plus}</span> Folder</button>
          <button class="add" onclick={addPlaylist}><span class="nf">{I.plus}</span> Playlist</button>
        </div>
      {/if}

      <label class="check">
        <input type="checkbox" bind:checked={s.recursive} onchange={() => library.rescan()} />
        <span>Include subfolders</span>
      </label>
      {#if library.errors.length}
        <div class="err" title={library.errors.join("\n")}>
          <span class="nf">{I.warn}</span>
          {library.errors[0]}{library.errors.length > 1 ? ` (+${library.errors.length - 1} more)` : ""}
        </div>
      {/if}
    </section>

    <section>
      <div class="sec-head">
        <span class="sec-title">Mode</span>
        {#if monitors.length > 1}
          <label class="check head-check">
            <input type="checkbox" bind:checked={s.multiWall} onchange={ensureWalls} /><span>A wall on each display</span>
          </label>
        {/if}
      </div>
      {#if multi && map}
        <div class="displays">
          <div class="map" style:width="{map.w}px" style:height="{map.h}px">
            {#each map.boxes as b (b.m.name)}
              <button
                class="screen"
                class:sel={sel === b.m.name}
                class:off={!s.walls[b.m.name]?.on}
                style:left="{b.x}px"
                style:top="{b.y}px"
                style:width="{b.w}px"
                style:height="{b.h}px"
                title="{monitorLabel(b.m, b.i)}: {wallSummary(s.walls[b.m.name])}"
                onclick={() => (sel = b.m.name)}
              >
                <span class="sc-num">{b.i + 1}</span>
                {#if s.walls[b.m.name]?.on}<span class="nf sc-icon">{MODES.find((m) => m.id === s.walls[b.m.name].mode)?.icon}</span>{/if}
              </button>
            {/each}
          </div>
          {#if s.walls[sel] && selIndex >= 0}
            <div class="sel-info">
              <span class="sel-name">{monitorLabel(monitors[selIndex], selIndex)}</span>
              <label class="check"><input type="checkbox" bind:checked={s.walls[sel].on} /><span>Wall on this display</span></label>
              <span class="sel-hint">Pick a display on the map, then its mode below. Sources, filters and More options are shared.</span>
            </div>
          {/if}
        </div>
      {/if}
      <div class="modes" class:dim={multi && !s.walls[sel]?.on}>
        {#each MODES as m (m.id)}
          <button class="mode" class:on={L.mode === m.id} onclick={() => (L.mode = m.id)}>
            {@render preview(m.id)}
            <span class="m-name"><span class="nf">{m.icon}</span>{m.name}<kbd>{m.key}</kbd></span>
            <span class="m-line">{m.line}</span>
            {#if L.mode === m.id}<span class="m-check nf">{I.check}</span>{/if}
          </button>
        {/each}
      </div>

      <div class="params" class:dim={multi && !s.walls[sel]?.on}>
        {#if L.mode === "mosaic"}
          <Range label="Tiles" bind:value={L.tiles} min={LIMITS.tiles[0]} max={LIMITS.tiles[1]} />
          <Range
            label="Stillness"
            bind:value={L.stillness}
            min={0.2}
            max={3}
            step={0.1}
            format={(v) => v.toFixed(1)}
            ends={["rearranges freely", "barely moves"]}
          />
        {:else if L.mode === "dynamic"}
          <Range label="Tiles" bind:value={L.tiles} min={LIMITS.tiles[0]} max={LIMITS.tiles[1]} />
          <Range
            label="Change every"
            bind:value={L.dynamicSeconds}
            min={1.5}
            max={15}
            step={0.5}
            format={(v) => `${v} s`}
            ends={["restless", "unhurried"]}
          />
        {:else if L.mode === "ribbon"}
          <Range label="Rows" bind:value={L.rows} min={LIMITS.rows[0]} max={LIMITS.rows[1]} />
          <Segmented
            label="Direction"
            bind:value={L.ribbonDir}
            options={[
              { value: "left", label: "Left", icon: I.left },
              { value: "right", label: "Right", icon: I.right },
            ]}
          />
          <Range label="Speed" bind:value={L.speed} min={10} max={400} step={5} format={(v) => `${v} px/s`} />
        {:else}
          <Range label="Columns" bind:value={L.columns} min={LIMITS.columns[0]} max={LIMITS.columns[1]} />
          <Segmented
            label="Direction"
            bind:value={L.cascadeDir}
            options={[
              { value: "up", label: "Up", icon: I.up },
              { value: "down", label: "Down", icon: I.down },
            ]}
          />
          <Range label="Speed" bind:value={L.speed} min={10} max={400} step={5} format={(v) => `${v} px/s`} />
        {/if}
      </div>
    </section>

    <section class="show">
      <Segmented
        label="Show"
        bind:value={s.type}
        options={[
          { value: "mixed", label: "Everything" },
          { value: "videos", label: "Videos", icon: I.video },
          { value: "images", label: "Images", icon: I.image },
        ]}
      />
      <Segmented
        label="Shape"
        bind:value={s.shape}
        options={[
          { value: "any", label: "Any" },
          { value: "portrait", label: "Portrait" },
          { value: "landscape", label: "Landscape" },
        ]}
      />
    </section>

    <button class="more-toggle" onclick={() => (more = !more)} aria-expanded={more}>
      <span class="nf chev" class:open={more}>{I.chevronRight}</span> More options
    </button>
    {#if more}
      <section class="more">
        <Range label="Image time" bind:value={s.imageSeconds} min={2} max={30} format={(v) => `${v} s`} hint="Mosaic" />
        <Range
          label="Video cap"
          bind:value={s.maxVideoSeconds}
          min={0}
          max={120}
          step={5}
          format={(v) => (v ? `${v} s` : "full length")}
          hint="Mosaic: cut long videos"
        />
        <Range label="Loop short clips to" bind:value={s.minVideoSeconds} min={0} max={30} format={(v) => (v ? `${v} s` : "off")} hint="Mosaic" />
        <Range label="Playback speed" bind:value={s.rate} min={0.25} max={3} step={0.25} format={(v) => `${v.toFixed(2)}×`} />
        <Range label="Volume" bind:value={s.volume} min={0} max={100} step={5} format={(v) => `${v}%`} hint="for the one item with sound (M)" />
        <Range label="Gap" bind:value={s.gap} min={0} max={16} format={(v) => `${v} px`} />
        <Range
          label="Crop limit"
          bind:value={s.maxCrop}
          min={0.05}
          max={0.5}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          hint="Mosaic, Dynamic: most of any item that may be cut off"
        />
        <div class="group">
          <span class="label">Under the pointer</span>
          <label class="check"><input type="checkbox" bind:checked={s.hoverPause} /><span>Ribbon / Cascade: the row or column stops</span></label>
          <label class="check"><input type="checkbox" bind:checked={s.hoverHold} /><span>Mosaic / Dynamic: the tile holds still and keeps its item</span></label>
          <label class="check"><input type="checkbox" bind:checked={s.audioFollowsMouse} /><span>Sound follows the pointer</span></label>
        </div>
        <div class="group">
          <span class="label">Pause the wall</span>
          <label class="check"><input type="checkbox" bind:checked={s.pauseBehindViewer} /><span>While one item is open whole <kbd>F</kbd></span></label>
          <label class="check"><input type="checkbox" bind:checked={s.pauseUnfocused} /><span>While another window is active</span></label>
        </div>
        <div class="group">
          <span class="label">Order</span>
          <label class="check"><input type="checkbox" bind:checked={s.shuffle} /><span>Shuffle</span></label>
          <label class="check"><input type="checkbox" bind:checked={s.stagger} /><span>Feed lanes at varied speeds</span></label>
        </div>
        {#if !multi}
          <label class="select">
            <span class="label">Display</span>
          <select bind:value={s.monitor}>
            <option value="">This window's display</option>
            {#each monitors as m, i (m.name)}
              <option value={m.name}>{monitorLabel(m, i)}</option>
            {/each}
          </select>
          </label>
        {/if}
        <div class="select gpu">
          <label class="select">
            <span class="label">Graphics</span>
            <select bind:value={s.gpu}>
              <option value="auto">Windows default</option>
              <option value="high">High performance{gpu?.high ? ` · ${shortGpu(gpu.high)}` : ""}</option>
              <option value="low">Power saving{gpu?.low ? ` · ${shortGpu(gpu.low)}` : ""}</option>
            </select>
          </label>
          {#if gpu}
            {#if stale}
              <span class="gpu-note warn">
                Needs a restart to use {wanted ? shortGpu(wanted) : "the Windows default"}.
                <button class="restart" onclick={restart} disabled={restarting}>
                  <span class="nf">{I.refresh}</span>{restarting ? "Restarting…" : "Restart"}
                </button>
              </span>
            {:else}
              <span class="gpu-note">Running on {gpu.chosen ? shortGpu(gpu.chosen) : "the Windows default"}</span>
            {/if}
            {#if gpu.high && gpu.low && gpu.high.luid !== gpu.low.luid}
              <span class="gpu-note">
                On a laptop, the built-in screen is wired to the integrated GPU, so with High performance every frame is copied
                across. That is fine at 1920×1200 but can be slower than Power saving on a 4K panel.
              </span>
            {/if}
          {/if}
        </div>
        <div class="themes">
          <span class="label">Theme</span>
          <div class="swatches">
            {#each THEMES as t (t.id)}
              <button class="theme" class:on={s.theme === t.id} title={t.name} onclick={() => (s.theme = t.id)}>
                {#each t.swatches as c}<i style:background={c}></i>{/each}
              </button>
            {/each}
          </div>
        </div>
      </section>
    {/if}

    <button class="go" disabled={!canStart} onclick={start}>
      {#if library.scanning}
        Scanning…
      {:else if !s.sources.length}
        Add a folder to start
      {:else if playable === 0}
        Nothing to show with these filters
      {:else}
        <span class="nf">{I.play}</span>
        {multi ? `Start ${wallsOn.length} ${wallsOn.length === 1 ? "wall" : "walls"}` : "Start wall"}
        <kbd>Enter</kbd>
      {/if}
    </button>
    {#if wallError}
      <div class="err"><span class="nf">{I.warn}</span> {wallError}</div>
    {/if}
    <p class="foot">
      On the wall: <kbd>Space</kbd> pause · <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd> switch mode · <kbd>+</kbd><kbd>−</kbd> count ·
      <kbd>?</kbd> all keys · <kbd>Esc</kbd> back here
    </p>
  </div>
</div>

<style>
  .setup {
    height: 100%;
    overflow-y: auto;
    display: grid;
    place-items: center;
    padding: 28px 16px;
    background: var(--bg-app);
  }
  .card {
    width: min(780px, 100%);
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 26px 30px 22px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.04),
      0 1px 2px rgba(0, 0, 0, 0.4),
      0 10px 30px rgba(0, 0, 0, 0.34);
  }
  header {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 18px;
  }
  .logo {
    width: 58px;
    height: 58px;
    filter: drop-shadow(0 4px 14px rgba(0, 0, 0, 0.5));
  }
  h1 {
    margin: 0;
    font-family: var(--mono);
    font-size: 26px;
    color: var(--purple);
    letter-spacing: -0.01em;
  }
  .tag {
    margin: 2px 0 0;
    color: var(--text-muted);
    font-size: 12.5px;
  }
  section {
    padding: 14px 0;
    border-top: 1px solid var(--border-muted);
  }
  .sec-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 10px;
  }
  .sec-title {
    font-weight: 700;
    color: var(--text-secondary);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .summary {
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .summary b {
    color: var(--text-primary);
    font-weight: 600;
  }
  .c-img {
    color: var(--green);
  }
  .c-vid {
    color: var(--blue);
  }
  .spin {
    display: inline-block;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .drop {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 26px;
    border-radius: 10px;
    border: 1.5px dashed var(--border);
    background: var(--bg-panel-alt);
    color: var(--text-secondary);
    cursor: pointer;
    transition: border-color 150ms ease, background 150ms ease;
  }
  .drop:hover,
  .drop.dragging,
  .sources.dragging {
    border-color: var(--purple);
    background: color-mix(in srgb, var(--purple) 6%, var(--bg-panel-alt));
  }
  .big {
    font-size: 26px;
    color: var(--yellow);
  }
  .drop-main {
    font-weight: 600;
  }
  .drop-main code {
    font-family: var(--mono);
    color: var(--cyan);
  }
  .drop-sub {
    color: var(--text-muted);
    font-size: 12px;
  }
  .sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px;
    margin: -6px;
    border-radius: 10px;
    border: 1.5px dashed transparent;
  }
  .source {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    padding: 5px 6px 5px 10px;
    border-radius: var(--radius);
    background: var(--bg-chip);
    border: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 12px;
  }
  .s-icon {
    color: var(--yellow);
  }
  .s-name {
    color: var(--text-primary);
    white-space: nowrap;
  }
  .s-path {
    color: var(--text-muted);
    font-size: 11px;
    max-width: 220px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
  }
  .x {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 11px;
  }
  .x:hover {
    color: var(--red);
    background: color-mix(in srgb, var(--red) 12%, transparent);
  }
  .add {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: var(--radius);
    border: 1px dashed var(--border);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }
  .add:hover {
    border-color: var(--purple);
    color: var(--text-primary);
  }
  .add .nf {
    font-size: 10px;
    color: var(--green);
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    color: var(--text-secondary);
    font-size: 12.5px;
    cursor: pointer;
  }
  .check input {
    accent-color: var(--purple);
    width: 14px;
    height: 14px;
    margin: 0;
  }
  .err {
    margin-top: 8px;
    color: var(--orange);
    font-size: 12px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .modes {
    display: grid;
    /* minmax(0, ...) so the previews' max-content strips cannot widen a column */
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
  .mode {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    padding: 10px 12px 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-panel-alt);
    color: var(--text-secondary);
    text-align: left;
    cursor: pointer;
    transition: border-color 150ms ease, background 150ms ease;
  }
  .mode:hover {
    border-color: color-mix(in srgb, var(--purple) 50%, var(--border));
  }
  .mode.on {
    border-color: var(--purple);
    background: color-mix(in srgb, var(--purple) 7%, var(--bg-panel-alt));
  }
  .m-name {
    display: flex;
    align-items: center;
    gap: 7px;
    font-weight: 700;
    color: var(--text-primary);
    font-size: 13.5px;
  }
  .m-name .nf {
    color: var(--purple);
    font-size: 12px;
  }
  .m-name kbd {
    margin-left: 2px;
    font-size: 10px;
    color: var(--text-muted);
  }
  .m-line {
    font-size: 11.5px;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .m-check {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--purple);
    color: var(--text-inverse);
    font-size: 10px;
  }
  /* mode previews: small animated diagrams of each mode */
  .pv {
    position: relative;
    width: 100%;
    height: 66px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--bg-app);
    margin-bottom: 4px;
  }
  .pv i {
    display: block;
    border-radius: 2px;
    background: color-mix(in srgb, var(--c, var(--purple)) 55%, transparent);
  }
  .pv-mosaic i {
    position: absolute;
    animation: 9s var(--ease) infinite;
  }
  .m1 { --c: var(--purple); left: 3%; top: 5%; width: 28%; height: 90%; animation-name: m1 !important; }
  .m2 { --c: var(--cyan); left: 33%; top: 5%; width: 64%; height: 42%; animation-name: m2 !important; }
  .m3 { --c: var(--green); left: 33%; top: 51%; width: 30%; height: 44%; animation-name: m3 !important; }
  .m4 { --c: var(--yellow); left: 65%; top: 51%; width: 32%; height: 20%; }
  .m5 { --c: var(--blue); left: 65%; top: 75%; width: 32%; height: 20%; }
  @keyframes m1 {
    0%, 40% { width: 28%; }
    50%, 90% { width: 20%; }
  }
  @keyframes m2 {
    0%, 40% { left: 33%; width: 64%; }
    50%, 90% { left: 25%; width: 72%; }
  }
  @keyframes m3 {
    0%, 40% { left: 33%; width: 30%; }
    50%, 90% { left: 25%; width: 38%; }
  }
  /* Dynamic: the same five tiles cycle through three different layouts */
  .pv-dynamic i {
    position: absolute;
    animation: 7.5s var(--ease) infinite;
  }
  .d1 { --c: var(--purple); animation-name: d1 !important; }
  .d2 { --c: var(--cyan); animation-name: d2 !important; }
  .d3 { --c: var(--green); animation-name: d3 !important; }
  .d4 { --c: var(--yellow); animation-name: d4 !important; }
  .d5 { --c: var(--blue); animation-name: d5 !important; }
  @keyframes d1 {
    0%, 26%, 100% { left: 3%; top: 5%; width: 28%; height: 90%; }
    33%, 59% { left: 3%; top: 5%; width: 45%; height: 42%; }
    66%, 92% { left: 70%; top: 5%; width: 27%; height: 90%; }
  }
  @keyframes d2 {
    0%, 26%, 100% { left: 33%; top: 5%; width: 40%; height: 42%; }
    33%, 59% { left: 3%; top: 51%; width: 45%; height: 44%; }
    66%, 92% { left: 3%; top: 5%; width: 30%; height: 42%; }
  }
  @keyframes d3 {
    0%, 26%, 100% { left: 75%; top: 5%; width: 22%; height: 42%; }
    33%, 59% { left: 50%; top: 5%; width: 20%; height: 90%; }
    66%, 92% { left: 3%; top: 51%; width: 30%; height: 44%; }
  }
  @keyframes d4 {
    0%, 26%, 100% { left: 33%; top: 51%; width: 30%; height: 44%; }
    33%, 59% { left: 72%; top: 5%; width: 25%; height: 42%; }
    66%, 92% { left: 35%; top: 5%; width: 33%; height: 56%; }
  }
  @keyframes d5 {
    0%, 26%, 100% { left: 65%; top: 51%; width: 32%; height: 44%; }
    33%, 59% { left: 72%; top: 51%; width: 25%; height: 44%; }
    66%, 92% { left: 35%; top: 65%; width: 33%; height: 30%; }
  }
  .pv-ribbon,
  .pv-cascade {
    display: flex;
    gap: 3px;
    padding: 3px;
  }
  .pv-ribbon {
    flex-direction: column;
  }
  .row {
    flex: 1;
    display: flex;
    gap: 3px;
    width: max-content;
    animation: slide-x 7s linear infinite;
  }
  .row.r1 {
    animation-duration: 8s;
  }
  .row i,
  .col i {
    flex: none;
  }
  .row i {
    height: 100%;
  }
  .row i:nth-child(3n + 1), .col i:nth-child(3n + 1) { --c: var(--purple); }
  .row i:nth-child(3n + 2), .col i:nth-child(3n + 2) { --c: var(--cyan); }
  .row i:nth-child(3n), .col i:nth-child(3n) { --c: var(--green); }
  @keyframes slide-x {
    to { transform: translateX(-50%); }
  }
  .col {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 3px;
    height: max-content;
    animation: slide-y 7s linear infinite;
  }
  .col.c1 { animation-duration: 8.5s; }
  .col.c2 { animation-duration: 7.6s; }
  @keyframes slide-y {
    to { transform: translateY(-50%); }
  }
  .head-check {
    margin-top: 0;
  }
  .displays {
    display: flex;
    gap: 22px;
    align-items: center;
    margin-bottom: 14px;
  }
  .map {
    position: relative;
    flex: none;
  }
  .screen {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 0;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-panel-alt);
    color: var(--text-secondary);
    font-family: var(--mono);
    font-size: 12px;
    cursor: pointer;
    /* the boxes touch where the displays do */
    box-shadow: inset 0 0 0 1px var(--bg-panel);
  }
  .screen:hover {
    border-color: color-mix(in srgb, var(--purple) 50%, var(--border));
  }
  .screen.sel {
    border-color: var(--purple);
    background: color-mix(in srgb, var(--purple) 12%, var(--bg-panel-alt));
    color: var(--text-primary);
  }
  .screen.off {
    color: var(--text-muted);
    background: var(--bg-panel);
    border-style: dashed;
  }
  .sc-num {
    font-weight: 700;
  }
  .sc-icon {
    color: var(--purple);
  }
  .sel-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .sel-name {
    font-family: var(--mono);
    font-size: 12.5px;
    color: var(--text-primary);
  }
  .sel-info .check {
    margin-top: 6px;
  }
  .sel-hint {
    margin-top: 6px;
    color: var(--text-muted);
    font-size: 12px;
  }
  .dim {
    opacity: 0.45;
    pointer-events: none;
  }
  .params {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 18px;
    margin-top: 16px;
    align-items: start;
  }
  .show {
    display: flex;
    gap: 18px;
  }
  .more-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
    width: 100%;
    border: 0;
    border-top: 1px solid var(--border-muted);
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
  }
  .more-toggle:hover {
    color: var(--text-primary);
  }
  .chev {
    font-size: 9px;
    transition: transform 150ms ease;
  }
  .chev.open {
    transform: rotate(90deg);
  }
  .more {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px 18px;
    border-top: 0;
    padding-top: 2px;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-width: 0;
  }
  .group .label {
    margin-bottom: 1px;
  }
  .group .check {
    margin-top: 0;
    align-items: flex-start;
  }
  .group .check input {
    margin-top: 2px;
    flex: none;
  }
  .group kbd {
    font-size: 10px;
  }
  .gpu {
    grid-column: span 2;
  }
  .gpu-note {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 10px;
    font-size: 11.5px;
    color: var(--text-muted);
  }
  .gpu-note.warn {
    color: var(--orange);
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
  .restart .nf {
    font-size: 11px;
  }
  .label {
    color: var(--text-secondary);
    font-weight: 600;
    font-size: 12px;
  }
  .select {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  select {
    padding: 5px 8px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-primary);
    font-size: 12px;
  }
  .themes {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .swatches {
    display: flex;
    gap: 6px;
  }
  .theme {
    display: flex;
    gap: 0;
    padding: 3px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    cursor: pointer;
  }
  .theme i {
    width: 9px;
    height: 16px;
  }
  .theme i:first-child {
    border-radius: 3px 0 0 3px;
  }
  .theme i:last-child {
    border-radius: 0 3px 3px 0;
  }
  .theme.on {
    border-color: var(--purple);
    box-shadow: 0 0 0 1px var(--purple);
  }
  .go {
    width: 100%;
    margin-top: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 12px;
    border-radius: var(--radius);
    border: 1px solid transparent;
    background: var(--green);
    color: var(--text-inverse);
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    transition: filter 120ms ease;
  }
  .go:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .go:disabled {
    background: var(--bg-chip);
    color: var(--text-muted);
    border-color: var(--border);
    cursor: default;
  }
  .go kbd {
    background: color-mix(in srgb, var(--text-inverse) 15%, transparent);
    border-color: color-mix(in srgb, var(--text-inverse) 30%, transparent);
    color: var(--text-inverse);
    font-size: 10px;
  }
  .go .nf {
    font-size: 12px;
  }
  .foot {
    margin: 12px 0 0;
    text-align: center;
    color: var(--text-muted);
    font-size: 11.5px;
  }
  .foot kbd {
    font-size: 10px;
    margin: 0 1px;
  }
</style>
