<script lang="ts">
  // The one screen before the wall. Left: sources, a mode and the numbers
  // that mode needs, the center item, what to show. Right: every other
  // setting, always in view. The Start button stays at the bottom.
  // With a wall on each display, the mode section edits the display picked
  // in the display tabs, and a display can have its own folders.
  // Beside Start: Resume (the last wall as it was) and the walls saved with
  // Ctrl+S (session.ts).
  import { onMount } from "svelte";
  import { listen } from "@tauri-apps/api/event";
  import { open } from "@tauri-apps/plugin-dialog";
  import { availableMonitors, currentMonitor, type Monitor } from "@tauri-apps/api/window";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { getVersion } from "@tauri-apps/api/app";
  import { settings, DEFAULTS, LIMITS, MODE_NAMES, layoutOf, savedLayout, type Layout, type Mode, type WallLayout } from "$lib/settings.svelte";
  import { cropIn, fitTolerance, gridLabel, gridRects } from "$lib/grid";
  import { library } from "$lib/library.svelte";
  import { api, isUrl } from "$lib/api";
  import { fetchLink, heightFor, needsDownload } from "$lib/links";
  import { stamp, type SessionInfo } from "$lib/session";
  import { I } from "$lib/icons";
  import Range from "./Range.svelte";
  import Segmented from "./Segmented.svelte";
  import GridBuilder from "./GridBuilder.svelte";
  import Preferences from "./Preferences.svelte";
  import CenterIcon from "./CenterIcon.svelte";
  import SavedWalls from "./SavedWalls.svelte";
  import UpdateNotice from "./UpdateNotice.svelte";

  let { onstart }: { onstart: () => void } = $props();

  const s = settings.s;
  let dragging = $state(false);
  /** displays Windows names; one without a name cannot be addressed */
  let monitors = $state<(Monitor & { name: string })[]>([]);
  /** multi: the display the mode section edits */
  let sel = $state("");
  let wallError = $state("");
  let showHidden = $state(false);
  /** the preferences dialog (cog) is open */
  let prefs = $state(false);
  /** this build's version (tauri.conf.json), shown beside the name */
  let version = $state("");

  /** multi: displays whose own-folders editor is open while their list is still empty */
  let ownOpen = $state<Record<string, boolean>>({});
  /** multi: what a display's own folders hold */
  let wallScan = $state<Record<string, { images: number; videos: number; scanning: boolean }>>({});

  /** saved walls: `last` (written by the walls as they run) and the ones saved with Ctrl+S */
  let saved = $state.raw<{ last: SessionInfo | null; named: SessionInfo[] }>({ last: null, named: [] });
  let showSaved = $state(false);
  let resuming = $state(false);

  const MODES: { id: Mode; icon: string; line: string; key: string }[] = [
    { id: "mosaic", icon: I.th, line: "Even tiles; changes stay local.", key: "1" },
    { id: "ribbon", icon: I.bars, line: "Rows glide sideways.", key: "2" },
    { id: "cascade", icon: I.columns, line: "Columns drift up or down.", key: "3" },
    { id: "dynamic", icon: I.random, line: "The newest item gets the largest tile.", key: "4" },
    { id: "grid", icon: I.thLarge, line: "Fixed cells: 3×1, 2×2 or your own.", key: "5" },
    { id: "stack", icon: I.layers, line: "One item, side by side, in sync.", key: "6" },
  ];
  const MEDIA_EXTS = ["mp4", "m4v", "webm", "mov", "mkv", "ogv", "jpg", "jpeg", "jfif", "png", "webp", "gif", "avif", "bmp"];

  /** Max video length as read: 90 s, 2 min, 2 min 30 s */
  function videoLength(v: number): string {
    if (!v) return "no limit";
    if (v < 120) return `${v} s`;
    const m = Math.floor(v / 60);
    const sec = v % 60;
    return sec ? `${m} min ${sec} s` : `${m} min`;
  }

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

  /** `own`: into the selected display's own list instead of the shared one */
  async function addFolder(own = false) {
    const r = await open({ directory: true, multiple: true, title: own ? "Add folders for this display" : "Add folders to the wall" });
    if (r) addSources(Array.isArray(r) ? r : [r], own);
  }

  async function addPlaylist(own = false) {
    const r = await open({
      multiple: true,
      title: "Add playlists",
      filters: [{ name: "Playlists", extensions: ["m3u", "m3u8"] }],
    });
    if (r) addSources(Array.isArray(r) ? r : [r], own);
  }

  function addSources(paths: string[], own: boolean) {
    const wall = own ? s.walls[sel] : null;
    if (!wall) return library.add(paths);
    const have = new Set((wall.sources ?? []).map((p) => p.toLowerCase()));
    wall.sources = [...(wall.sources ?? []), ...paths.filter((p) => p && !have.has(p.toLowerCase()))];
    scanWall(sel);
  }

  function removeOwn(path: string) {
    const wall = s.walls[sel];
    if (!wall) return;
    wall.sources = (wall.sources ?? []).filter((p) => p !== path);
    scanWall(sel);
  }

  /** count what a display's own folders hold, for the summary beside them */
  async function scanWall(name: string) {
    const sources = [...(s.walls[name]?.sources ?? [])];
    if (!sources.length) {
      delete wallScan[name];
      return;
    }
    wallScan[name] = { images: wallScan[name]?.images ?? 0, videos: wallScan[name]?.videos ?? 0, scanning: true };
    try {
      const r = await api.scan(sources, s.recursive);
      // unless the list changed while this ran
      if (JSON.stringify(sources) === JSON.stringify(s.walls[name]?.sources ?? [])) wallScan[name] = { images: r.images, videos: r.videos, scanning: false };
    } catch {
      wallScan[name] = { images: 0, videos: 0, scanning: false };
    }
  }

  /** Stack, one file or link: what the link's download is doing */
  let linkState = $state<{ url: string; text: string; error: boolean; done: boolean } | null>(null);

  /** the link field takes the keys as soon as it shows, while it is empty */
  function focusWhenEmpty(el: HTMLInputElement) {
    if (!el.value.trim()) el.focus();
  }

  async function chooseStackFile() {
    const r = await open({ multiple: false, title: "Stack: the file to repeat", filters: [{ name: "Videos and images", extensions: MEDIA_EXTS }] });
    if (typeof r === "string") L.stackItem = r;
  }

  /** a link set to download first is fetched as soon as it is entered, so the wall can start at once */
  async function prefetch() {
    const url = L.stackItem.trim();
    if (L.stackLinkMode !== "download" || !needsDownload(url) || (linkState?.url === url && !linkState.error)) return;
    linkState = { url, text: "finding the video", error: false, done: false };
    const [mw, mh] = selMonitor ? [selMonitor.size.width / (window.devicePixelRatio || 1), selMonitor.size.height / (window.devicePixelRatio || 1)] : [1920, 1080];
    const px = Math.min(mw, mh, Math.max(mw, mh) / Math.max(1, L.stackPanes));
    try {
      await fetchLink(url, heightFor(px), s.ytdlCookies, (text) => {
        if (linkState?.url === url) linkState.text = text;
      });
      if (linkState?.url === url) linkState = { url, text: "downloaded · ready", error: false, done: true };
    } catch (e) {
      if (linkState?.url === url) linkState = { url, text: e instanceof Error ? e.message : String(e), error: true, done: false };
    }
  }

  async function chooseCenter() {
    const r = await open({ multiple: false, title: "Centered media: the file that plays in the middle", filters: [{ name: "Videos and images", extensions: MEDIA_EXTS }] });
    if (typeof r === "string") {
      L.center = r;
      L.centered = true;
    }
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
    for (const m of monitors) {
      const w = s.walls[m.name];
      if (!w) s.walls[m.name] = { ...layoutOf($state.snapshot(s) as Layout), on: true };
      // entries saved before a setting became per display (Show, Shape) lack it
      else for (const [k, v] of Object.entries(layoutOf($state.snapshot(s) as Layout))) if ((w as any)[k] === undefined) (w as any)[k] = v;
      if (s.walls[m.name].sources?.length && !wallScan[m.name]) scanWall(m.name);
    }
  }

  function wallSummary(w: WallLayout | undefined): string {
    if (!w?.on) return "off";
    const name = MODE_NAMES[w.mode] ?? w.mode;
    const own = w.sources?.length ? " · own folders" : "";
    const mid = w.centered && w.center ? " · center" : "";
    if (w.mode === "grid") return `${name} · ${gridLabel(w.gridCols, w.gridRows, w.gridSpans ?? [])}${mid}${own}`;
    if (w.mode === "stack") return `${name} · ${w.stackPanes} panes${w.stackSource === "one" ? " · one file or link" : ""}${own}`;
    const key = settings.countKey(w.mode);
    return `${name} · ${w[key]} ${key}${mid}${own}`;
  }

  /** what a type filter would play out of these counts */
  function playableOf(type: string, images: number, videos: number): number {
    return type === "images" ? images : type === "videos" ? videos : images + videos;
  }

  /** multi: files this display's wall would play, from its own folders or the shared ones */
  function wallPlayable(name: string): number {
    const w = s.walls[name];
    if (!w) return 0;
    const own = w.sources?.length ? wallScan[name] : null;
    return own ? playableOf(w.type, own.images, own.videos) : w.sources?.length ? 0 : playableOf(w.type, library.images, library.videos);
  }

  const selIndex = $derived(monitors.findIndex((m) => m.name === sel));

  /** Grid with "only media that fits": how many files in the shared
   * sources fit its tiles (by the sizes the scan already knows) */
  const gridFitInfo = $derived.by(() => {
    if (L.mode !== "grid" || !L.gridOnlyFits || L.gridFit !== "cover") return null;
    const rects = gridRects(L.gridCols, L.gridRows, L.gridSpans ?? [], { x: 0, y: 0, w: selAspect * 1000, h: 1000 });
    const shapes = [...new Set(rects.map((r) => r.w / r.h))];
    const tol = fitTolerance(s.gridFitCrop, selAspect);
    let fit = 0;
    let known = 0;
    let all = 0;
    for (const e of library.items) {
      if (L.type !== "mixed" && (L.type === "images") !== (e.kind === "image")) continue;
      all++;
      if (!e.w || !e.h) continue;
      known++;
      if (shapes.some((sh) => cropIn(sh, e.w! / e.h!) <= tol)) fit++;
    }
    return { fit, known, all, tol };
  });

  /** how the center item sits in the selected mode */
  const centerHow = $derived(
    L.mode === "mosaic" || L.mode === "dynamic"
      ? "The tiles are laid out around it."
      : L.mode === "grid"
        ? "It takes the block of middle cells nearest its shape."
        : `It stays still in the middle; the ${L.mode === "ribbon" ? "rows" : "columns"} around it keep moving and end at its edges.`,
  );

  const playable = $derived(library.playable());
  const scanningAny = $derived(library.scanning || (multi && wallsOn.some((m) => wallScan[m.name]?.scanning)));
  /** a wall plays one file or link in Stack, and needs no sources */
  const oneStack = (l: Layout | undefined) => !!l && l.mode === "stack" && l.stackSource === "one" && !!l.stackItem.trim();
  const canStart = $derived(!scanningAny && (multi ? wallsOn.some((m) => wallPlayable(m.name) > 0 || oneStack(s.walls[m.name])) : playable > 0 || oneStack(s)));
  /** some list has something in it: the shared one, or a display's own */
  const anySources = $derived(s.sources.length > 0 || (multi && wallsOn.some((m) => s.walls[m.name]?.sources?.length)));
  const selWall = $derived(multi ? s.walls[sel] : undefined);
  const selOwn = $derived(!!selWall && ((selWall.sources?.length ?? 0) > 0 || !!ownOpen[sel]));
  const selMonitor = $derived(monitors.find((m) => m.name === (multi ? sel : s.monitor)) ?? monitors.find((m) => m.name === sel));
  /** the shape the selected wall will have, for the grid drawing */
  const selAspect = $derived(selMonitor ? selMonitor.size.width / selMonitor.size.height : 16 / 10);


  // every display has its entry whenever there is a wall on each, however
  // that was turned on (the checkbox, or settings saved that way)
  $effect(() => {
    if (multi && monitors.some((m) => !s.walls[m.name])) ensureWalls();
  });

  async function start() {
    if (!canStart) return;
    // a fresh wall: nothing left over from a resume that did not open
    await api.setResume(null, []).catch(() => {});
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

  async function loadSessions() {
    try {
      saved = await api.listSessions();
    } catch (e) {
      console.warn("sessions:", e);
      saved = { last: null, named: [] };
    }
  }

  /** "Display 2", or for a display that is not connected now, its Windows name */
  function displayName(name: string): string {
    const i = monitors.findIndex((m) => m.name === name);
    return i >= 0 ? `Display ${i + 1}` : `${name.replace(/^\\\\\.\\/, "")} (not connected)`;
  }

  /** "Grid, 9 items" for each wall; with several, by display */
  function sessionSummary(x: SessionInfo): string {
    const line = (w: SessionInfo["walls"][number]) => `${MODE_NAMES[w.mode as Mode] ?? w.mode}, ${w.count} ${w.count === 1 ? "item" : "items"}`;
    if (!x.multi) return x.walls[0] ? line(x.walls[0]) : "";
    return [...x.walls]
      .sort((a, b) => displayName(a.monitor).localeCompare(displayName(b.monitor)))
      .map((w) => `${displayName(w.monitor)}: ${line(w)}`)
      .join(" · ");
  }

  /** Open a saved session's walls as they were: its layout and sources go
   * into the settings, then the walls start the usual way and each builds
   * from its snapshot (Wall.svelte). `name` null: the last session. */
  async function resume(name: string | null) {
    if (resuming) return;
    wallError = "";
    showSaved = false;
    resuming = true;
    try {
      const sess = await api.getSession(name);
      const entries = sess ? Object.entries(sess.walls) : [];
      if (!sess || !entries.length) {
        wallError = "That saved wall could not be read.";
        loadSessions();
        return;
      }
      const before = JSON.stringify([s.sources, s.recursive]);
      const rescan = async () => {
        if (JSON.stringify([s.sources, s.recursive]) !== before || library.scanning) await library.rescan();
      };
      s.recursive = sess.recursive;
      const connected = new Set(monitors.map((m) => m.name));
      const here = sess.multi ? entries.filter(([k]) => connected.has(k)) : [];
      const away = sess.multi ? entries.filter(([k]) => !connected.has(k)).map(([k]) => displayName(k)) : [];
      if (sess.multi && here.length && monitors.length > 1) {
        s.sources = [...sess.sources];
        for (const m of monitors) {
          const snap = sess.walls[m.name];
          if (snap) s.walls[m.name] = { ...savedLayout(snap.layout, (s.walls[m.name] ?? $state.snapshot(s)) as Layout), on: true, sources: snap.own ? [...snap.sources] : [] };
          else if (s.walls[m.name]) s.walls[m.name].on = false;
          else s.walls[m.name] = { ...layoutOf($state.snapshot(s) as Layout), on: false };
        }
        s.multiWall = true;
        const note = away.length ? `not connected, left out: ${away.join(", ")}` : "";
        // the wall windows read settings.json as they load
        await settings.saveNow();
        await rescan();
        await api.setResume(name, here.map(([k]) => [k, k]), note);
        await api.openWalls(here.map(([k]) => k));
        return;
      }
      // One wall, in this window: the session's own, or from a session of
      // several walls the first one whose display is connected, else its
      // first wall on this window's display.
      const [key, snap] = here[0] ?? entries[0];
      Object.assign(s, savedLayout(snap.layout, $state.snapshot(s) as Layout));
      s.sources = [...snap.sources];
      s.multiWall = false;
      const want = sess.multi ? key : snap.monitor;
      s.monitor = want && connected.has(want) ? want : "";
      const notes: string[] = [];
      if (want && !connected.has(want)) notes.push(`${displayName(want)}; its wall opened on this window's display`);
      const others = entries.filter(([k]) => k !== key).map(([k]) => displayName(k));
      if (others.length) notes.push(`one wall opens here; left out: ${others.join(", ")}`);
      await settings.saveNow();
      await rescan();
      await api.setResume(name, [[key, ""]], notes.join(" · "));
      onstart();
    } catch (e) {
      wallError = String(e);
    } finally {
      resuming = false;
    }
  }

  async function deleteSession(name: string) {
    try {
      await api.deleteSession(name);
    } catch (e) {
      wallError = String(e);
    }
    await loadSessions();
  }

  const resumeTip = $derived(saved.last ? `Open the last wall as it was at ${stamp(saved.last.savedAt)}: ${sessionSummary(saved.last)}. Start opens a fresh one.` : "");

  function keydown(e: KeyboardEvent) {
    if (prefs || showSaved) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT")) {
      if (e.key === "Enter" && t instanceof HTMLInputElement && t.type === "text") t.blur();
      else if (e.key === "Enter" && t.tagName !== "SELECT") start();
      return;
    }
    if (e.key === "Enter") start();
    else if (e.key === "1") L.mode = "mosaic";
    else if (e.key === "2") L.mode = "ribbon";
    else if (e.key === "3") L.mode = "cascade";
    else if (e.key === "4") L.mode = "dynamic";
    else if (e.key === "5") L.mode = "grid";
    else if (e.key === "6") L.mode = "stack";
  }

  onMount(() => {
    getVersion().then((v) => (version = v)).catch(() => {});
    Promise.all([availableMonitors(), currentMonitor()])
      .then(([all, here]) => {
        monitors = all.filter((m): m is Monitor & { name: string } => !!m.name);
        sel = here?.name ?? monitors[0]?.name ?? "";
        if (s.multiWall) ensureWalls();
      })
      .catch(() => {});
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") dragging = true;
        else if (p.type === "leave") dragging = false;
        else if (p.type === "drop") {
          dragging = false;
          // onto the selected display's own list while that is open, else the shared one
          addSources(p.paths, selOwn);
        }
      })
      .then((f) => (unlisten = f))
      .catch(() => {});
    window.addEventListener("keydown", keydown);
    loadSessions();
    // the walls saved themselves as they closed
    let alive = true;
    let unclosed: (() => void) | undefined;
    listen("walls-closed", loadSessions)
      .then((f) => (alive ? (unclosed = f) : f()))
      .catch(() => {});
    if (import.meta.env.DEV) (window as any).__cwSetup = { resume, loadSessions, saved: () => saved, deleteSession };
    return () => {
      alive = false;
      unlisten?.();
      unclosed?.();
      window.removeEventListener("keydown", keydown);
    };
  });

  $effect(() => {
    settings.s.theme;
    settings.applyTheme();
  });
</script>

{#snippet preview(mode: Mode, mid: boolean)}
  <div class="pv pv-{mode}" aria-hidden="true">
    {#if mode === "mosaic"}
      <i class="m1"></i><i class="m2"></i><i class="m3"></i><i class="m4"></i><i class="m5"></i>
    {:else if mode === "dynamic"}
      <i class="d1"></i><i class="d2"></i><i class="d3"></i><i class="d4"></i><i class="d5"></i>
    {:else if mode === "grid"}
      <i class="g"></i><i class="g"></i><i class="g"></i><i class="g"></i><i class="g"></i><i class="g"></i>
    {:else if mode === "stack"}
      <i class="s"></i><i class="s"></i><i class="s"></i>
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
    {#if mid && mode !== "stack"}<b class="pv-mid"></b>{/if}
  </div>
{/snippet}

<div class="setup">
  <div class="page">
    <header class="head">
      <img class="logo" src="/icon.png" alt="" draggable="false" />
      <div class="title">
        <h1>coomwall{#if version}<span class="version">v{version}</span>{/if}</h1>
        <p class="tag">Point it at folders. Pick a mode. Everything plays at once.</p>
      </div>
      {#if multi}
        <!-- a wall on each display: pick one; everything about its wall on
             the page (mode, centered media, filters, folders) is that display's -->
        <div class="head-displays">
          <div class="disp-tabs">
            {#each monitors as m, i (m.name)}
              <button class="disp" class:sel={sel === m.name} class:off={!s.walls[m.name]?.on} title="{monitorLabel(m, i)}: {wallSummary(s.walls[m.name])}" onclick={() => (sel = m.name)}>
                <span class="d-num">{i + 1}</span>
                {#if s.walls[m.name]?.on}
                  <span class="nf">{MODES.find((x) => x.id === s.walls[m.name].mode)?.icon}</span>
                  <span class="d-mode">{MODE_NAMES[s.walls[m.name].mode]}</span>
                  {#if s.walls[m.name].centered && s.walls[m.name].center}<span class="d-mid" title="Centered media"><CenterIcon /></span>{/if}
                  {#if s.walls[m.name].sources?.length}<span class="nf d-own" title="Its own folders">{I.folder}</span>{/if}
                {:else}
                  <span class="d-mode">off</span>
                {/if}
              </button>
            {/each}
          </div>
          {#if s.walls[sel]}
            <label class="check"><input type="checkbox" bind:checked={s.walls[sel].on} /><span title="Off: no wall opens on this display when you start.">Wall on display {selIndex + 1}</span></label>
          {/if}
        </div>
      {/if}
      <button class="cog" title="Preferences: theme, keys, behavior, window, graphics" onclick={() => (prefs = true)}>
        <span class="nf">{I.cog}</span>
      </button>
    </header>

    <div class="cols">
      <div class="card main">
        <section class="src">
          <div class="sec-head">
            <span class="sec-title">Sources{#if selOwn}<span class="for">· display {selIndex + 1}'s own</span>{/if}</span>
            <span class="summary">
              {#if selOwn}
                {#if wallScan[sel]?.scanning}
                  <span class="spin nf">{I.refresh}</span> scanning…
                {:else if wallScan[sel]}
                  <span class="c-img">{wallScan[sel].images.toLocaleString()} images</span> ·
                  <span class="c-vid">{wallScan[sel].videos.toLocaleString()} videos</span>
                {:else}
                  until you add one, it plays the shared sources
                {/if}
              {:else if library.scanning}
                <span class="spin nf">{I.refresh}</span> scanning…
              {:else if s.sources.length}
                <b>{(library.images + library.videos).toLocaleString()}</b> files ·
                <span class="c-img">{library.images.toLocaleString()} images</span> ·
                <span class="c-vid">{library.videos.toLocaleString()} videos</span>
              {/if}
            </span>
          </div>

          <!-- one line, always the same height: many sources scroll sideways -->
          {#if selOwn}
            <div class="sources own" class:dragging>
              {#each s.walls[sel].sources ?? [] as src (src)}
                <span class="source" title={src}>
                  <span class="nf s-icon">{sourceIcon(src)}</span>
                  <span class="s-name">{leaf(src)}</span>
                  {#if !isUrl(src)}<span class="s-path">{parent(src)}</span>{/if}
                  <button class="x nf" title="Remove" onclick={() => removeOwn(src)}>{I.close}</button>
                </span>
              {/each}
              <button class="add" onclick={() => addFolder(true)}><span class="nf">{I.plus}</span> Folder</button>
              <button class="add" onclick={() => addPlaylist(true)}><span class="nf">{I.plus}</span> Playlist</button>
            </div>
          {:else if !s.sources.length}
            <button class="drop" class:dragging onclick={() => addFolder()}>
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
              <button class="add" onclick={() => addFolder()}><span class="nf">{I.plus}</span> Folder</button>
              <button class="add" onclick={() => addPlaylist()}><span class="nf">{I.plus}</span> Playlist</button>
            </div>
          {/if}

          <div class="src-row">
            <label class="check">
              <input
                type="checkbox"
                bind:checked={s.recursive}
                onchange={() => {
                  library.rescan();
                  for (const name of Object.keys(wallScan)) scanWall(name);
                }}
              />
              <span title="Also play files in the folders inside the ones you added.">Include subfolders</span>
            </label>
            {#if multi && s.walls[sel]}
              <label class="check">
                <input
                  type="checkbox"
                  checked={selOwn}
                  onchange={(e) => {
                    ownOpen[sel] = e.currentTarget.checked;
                    if (!e.currentTarget.checked) {
                      s.walls[sel].sources = [];
                      scanWall(sel);
                    }
                  }}
                /><span title="This display plays only the folders listed here instead of the shared sources. The other displays are not affected.">Display {selIndex + 1} has its own folders</span>
              </label>
            {/if}
            {#if library.hidden.length}
              <span class="hidden-wrap">
                <button class="link" onclick={() => (showHidden = !showHidden)} aria-expanded={showHidden}>
                  <span class="nf">{I.eyeSlash}</span>
                  {library.hidden.length} hidden {library.hidden.length === 1 ? "file" : "files"}
                  <span class="nf chev" class:open={showHidden}>{I.chevronRight}</span>
                </button>
                {#if showHidden}
                  <!-- over the page, so opening it moves nothing -->
                  <div class="hidden-pop">
                    <div class="pop-head">
                      <span>Never shown on the wall</span>
                      <button class="link" onclick={() => library.unhide(library.hidden)}>Unhide all</button>
                    </div>
                    <ul class="hidden-list">
                      {#each library.hidden as p (p)}
                        <li title={p}>
                          <span class="h-name">{leaf(p)}</span>
                          <span class="s-path">{parent(p)}</span>
                          <button class="x nf" title="Unhide" onclick={() => library.unhide([p])}>{I.close}</button>
                        </li>
                      {/each}
                    </ul>
                  </div>
                {/if}
              </span>
            {/if}
            {#if library.errors.length}
              <span class="err" title={library.errors.join("\n")}>
                <span class="nf">{I.warn}</span>
                {library.errors[0]}{library.errors.length > 1 ? ` (+${library.errors.length - 1} more)` : ""}
              </span>
            {/if}
          </div>
        </section>

        <section class="mode-sec">
          <div class="sec-head">
            <span class="sec-title">Mode</span>
            <span class="where">
              {#if !multi}
                <label class="inline-select">
                  <span title="The display the wall fills when you start.">On</span>
                  <select bind:value={s.monitor}>
                    <option value="">this window's display</option>
                    {#each monitors as m, i (m.name)}
                      <option value={m.name}>{monitorLabel(m, i)}</option>
                    {/each}
                  </select>
                </label>
              {/if}
              {#if monitors.length > 1}
                <label class="check head-check">
                  <input type="checkbox" bind:checked={s.multiWall} onchange={ensureWalls} /><span title="Open one wall on every display at once. Each display has its own mode, centered media and filters; pick a display with the tabs at the top.">A wall on each display</span>
                </label>
              {/if}
            </span>
          </div>


          <div class="modes" class:dim={multi && !s.walls[sel]?.on}>
            {#each MODES as m (m.id)}
              <button class="mode" class:on={L.mode === m.id} onclick={() => (L.mode = m.id)}>
                {@render preview(m.id, L.centered && !!L.center)}
                <span class="m-name"><span class="nf">{m.icon}</span>{MODE_NAMES[m.id]}<kbd>{m.key}</kbd></span>
                <span class="m-line">{m.line}</span>
                {#if L.mode === m.id}<span class="m-check nf">{I.check}</span>{/if}
              </button>
            {/each}
          </div>

          <!-- the same box for every mode, as tall as Grid needs: changing the
               mode changes what is in it, never where anything else is -->
          <div class="params" class:dim={multi && !s.walls[sel]?.on}>
            <span class="p-title">{MODE_NAMES[L.mode]}</span>
            {#if L.mode === "mosaic"}
              <div class="p-row">
                <Range label={L.centered ? "Tiles around it" : "Tiles"} title="How many tiles are on the wall at once (centered media not counted). + − on the wall." bind:value={L.tiles} def={DEFAULTS.tiles} min={LIMITS.tiles[0]} max={LIMITS.tiles[1]} />
                <Range
                  label="Stillness"
                  title="How hard the wall avoids moving tiles when an item changes. Low: tiles move freely so new items fit better. High: tiles stay put and new items are cropped more to fit."
                  bind:value={L.stillness}
                  def={DEFAULTS.stillness}
                  min={0.2}
                  max={3}
                  step={0.1}
                  format={(v) => v.toFixed(1)}
                  ends={["rearranges freely", "barely moves"]}
                />
              </div>
            {:else if L.mode === "dynamic"}
              <div class="p-row">
                <Range label={L.centered ? "Tiles around it" : "Tiles"} title="How many tiles are on the wall at once (centered media not counted). + − on the wall." bind:value={L.tiles} def={DEFAULTS.tiles} min={LIMITS.tiles[0]} max={LIMITS.tiles[1]} />
                <Range
                  label="Change every"
                  title="Seconds between changes. Each change brings in a new item and lays the whole wall out again. ↑ ↓ on the wall."
                  bind:value={L.dynamicSeconds}
                  def={DEFAULTS.dynamicSeconds}
                  min={1.5}
                  max={15}
                  step={0.5}
                  format={(v) => `${v} s`}
                  ends={["restless", "unhurried"]}
                />
                <Range
                  label="Focus"
                  title="How much larger the newest items are than the rest. Off: every tile about the same size. Full: the newest item about 4.5 times the size of an old one, the next few in between."
                  bind:value={L.dynamicFocus}
                  def={DEFAULTS.dynamicFocus}
                  min={0}
                  max={1}
                  step={0.1}
                  format={(v) => (v ? `newest ${(1 + 3.5 * v).toFixed(1)}×` : "off")}
                  ends={["all one size", "one large item"]}
                />
              </div>
            {:else if L.mode === "grid"}
              <GridBuilder bind:cols={L.gridCols} bind:rows={L.gridRows} bind:spans={L.gridSpans} bind:fit={L.gridFit} aspect={selAspect} />
              <div class="grid-fit">
                <label class="check" class:dim={L.gridFit !== "cover"}>
                  <input type="checkbox" bind:checked={L.gridOnlyFits} disabled={L.gridFit !== "cover"} /><span title="Use only files whose shape matches the cells, so nothing is cut off much. How close the match must be is in Preferences → Grid.">Only media that fits the cells</span>
                </label>
                {#if L.gridFit !== "cover"}
                  <span class="fit-count">Items are shown whole, so nothing is cut off.</span>
                {:else if gridFitInfo}
                  <span class="fit-count" class:warn={gridFitInfo.known > 0 && gridFitInfo.fit === 0}>
                    {gridFitInfo.fit.toLocaleString()} of {gridFitInfo.known.toLocaleString()} files fit, losing at most {Math.round(gridFitInfo.tol * 100)}%{gridFitInfo.known < gridFitInfo.all ? ` · ${(gridFitInfo.all - gridFitInfo.known).toLocaleString()} not measured yet` : ""}
                  </span>
                {:else}
                  <span class="fit-count">Off: every file is used and cropped to fill its cell.</span>
                {/if}
              </div>
            {:else if L.mode === "stack"}
              <div class="p-row">
                <Range label="Panes" title="How many copies of the item, side by side or one above the next. + − on the wall." bind:value={L.stackPanes} def={DEFAULTS.stackPanes} min={LIMITS.stackPanes[0]} max={LIMITS.stackPanes[1]} />
                <Segmented
                  label="Direction"
                  title="Side by side (a row) or one above the next (a column). Auto takes whichever shows the item larger on this display. D on the wall switches."
                  bind:value={L.stackDir}
                  def={DEFAULTS.stackDir}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "row", label: "Row", icon: I.columns },
                    { value: "column", label: "Column", icon: I.bars },
                  ]}
                />
                <Segmented
                  label="Turn"
                  title="Turn every pane a quarter, for a display on its side. R on the wall."
                  bind:value={L.stackTurn}
                  def={DEFAULTS.stackTurn}
                  options={[
                    { value: 0, label: "None" },
                    { value: 90, label: "90°" },
                    { value: 270, label: "270°" },
                  ]}
                />
              </div>
              <div class="p-row">
                <Segmented
                  label="Each pane"
                  title="Fills the screen: the panes share the whole screen with no bars, and each is cropped to fit (Shift+wheel and Shift+drag on the wall pick the crop). Shown whole: each pane has the item's shape and the stack sits in the middle."
                  bind:value={L.stackFill}
                  def={DEFAULTS.stackFill}
                  options={[
                    { value: true, label: "Fills the screen" },
                    { value: false, label: "Shown whole" },
                  ]}
                />
                <Segmented
                  label="Plays"
                  title="From the sources: one item after another, the best fit for this display first. One file or link: the same one, looping; a page link is downloaded with yt-dlp."
                  bind:value={L.stackSource}
                  def={DEFAULTS.stackSource}
                  options={[
                    { value: "one", label: "One file or link" },
                    { value: "queue", label: "From the sources" },
                  ]}
                />
              </div>
              {#if L.stackSource === "one"}
                <div class="stack-one">
                  <input
                    type="text"
                    class="link-in"
                    placeholder="Paste a link (YouTube and other sites yt-dlp knows) or a file path"
                    bind:value={L.stackItem}
                    onchange={prefetch}
                    use:focusWhenEmpty
                  />
                  <button class="add" onclick={chooseStackFile}><span class="nf">{I.plus}</span> Choose a file</button>
                </div>
                <span class="fit-count link-row" class:warn={linkState?.url === L.stackItem.trim() && linkState.error}>
                  {#if needsDownload(L.stackItem.trim())}
                    <Segmented
                      compact
                      bind:value={L.stackLinkMode}
                      def={DEFAULTS.stackLinkMode}
                      title="Stream: plays from the site at once (yt-dlp finds the streams; nothing is saved). Download first: saved once into the app's cache, then played from disk."
                      options={[
                        { value: "stream", label: "Stream" },
                        { value: "download", label: "Download first" },
                      ]}
                    />
                  {/if}
                  {#if !L.stackItem.trim()}
                    Nothing chosen yet: until then the wall plays the sources.
                  {:else if needsDownload(L.stackItem.trim()) && L.stackLinkMode === "stream"}
                    Played straight from the site; yt-dlp finds the streams as the wall starts.
                  {:else if needsDownload(L.stackItem.trim())}
                    {#if linkState?.url === L.stackItem.trim()}
                      {#if !linkState.done && !linkState.error}<span class="spin nf">{I.refresh}</span>{/if}
                      yt-dlp: {linkState.text}
                    {:else}
                      A page link: downloaded with yt-dlp, once, into the app's cache.
                    {/if}
                  {:else}
                    Played as it is, looping.
                  {/if}
                </span>
              {:else}
                <span class="fit-count">Each item fills the stack once (a video to its end, an image for the image time); <kbd>N</kbd> skips, <kbd>P</kbd> keeps one.</span>
              {/if}
            {:else if L.mode === "ribbon"}
              <div class="p-row">
                <Range label="Rows" title="How many rows of media move across the screen. + − on the wall." bind:value={L.rows} def={DEFAULTS.rows} min={LIMITS.rows[0]} max={LIMITS.rows[1]} />
                <Segmented
                  label="Direction"
                  title="Which way the rows move. D on the wall reverses it."
                  bind:value={L.ribbonDir}
                  def={DEFAULTS.ribbonDir}
                  options={[
                    { value: "left", label: "Left", icon: I.left },
                    { value: "right", label: "Right", icon: I.right },
                  ]}
                />
                <Range label="Speed" title="How fast the media moves, in pixels per second. ↑ ↓ on the wall." bind:value={L.speed} def={DEFAULTS.speed} min={10} max={400} step={5} format={(v) => `${v} px/s`} />
              </div>
            {:else}
              <div class="p-row">
                <Range label="Columns" title="How many columns of media move up or down the screen. + − on the wall." bind:value={L.columns} def={DEFAULTS.columns} min={LIMITS.columns[0]} max={LIMITS.columns[1]} />
                <Segmented
                  label="Direction"
                  title="Which way the columns move. D on the wall reverses it."
                  bind:value={L.cascadeDir}
                  def={DEFAULTS.cascadeDir}
                  options={[
                    { value: "up", label: "Up", icon: I.up },
                    { value: "down", label: "Down", icon: I.down },
                  ]}
                />
                <Range label="Speed" title="How fast the media moves, in pixels per second. ↑ ↓ on the wall." bind:value={L.speed} def={DEFAULTS.speed} min={10} max={400} step={5} format={(v) => `${v} px/s`} />
              </div>
            {/if}
          </div>
        </section>
      </div>

      <aside class="card side">
        <section class="filters" class:dim={multi && !s.walls[sel]?.on}>
          <Segmented
            label="Show"
            title="Which files the wall uses: all of them, only videos, or only images."
            bind:value={L.type}
            def={DEFAULTS.type}
            compact
            options={[
              { value: "mixed", label: "All" },
              { value: "videos", label: "Videos", icon: I.video },
              { value: "images", label: "Images", icon: I.image },
            ]}
          />
          <Segmented
            label="Shape"
            title="Use only tall (portrait) or only wide (landscape) files, or any shape."
            bind:value={L.shape}
            def={DEFAULTS.shape}
            compact
            options={[
              { value: "any", label: "Any" },
              { value: "portrait", label: "Portrait" },
              { value: "landscape", label: "Landscape" },
            ]}
          />
          <Segmented
            label="Size"
            title="Skip small files: only files whose shorter side is at least this many pixels (720 drops anything below 720p). Applies to images and videos."
            bind:value={L.minSide}
            def={DEFAULTS.minSide}
            compact
            options={[
              { value: 0, label: "Any" },
              { value: 480, label: "480+" },
              { value: 720, label: "720+" },
              { value: 1080, label: "1080+" },
            ]}
          />
          <Segmented
            label="Order"
            title="The order files play in: at random, newest first (by the file's date), or as the folders list them."
            bind:value={s.order}
            def={DEFAULTS.order}
            compact
            options={[
              { value: "shuffle", label: "Shuffle" },
              { value: "newest", label: "Newest" },
              { value: "folder", label: "Folder" },
            ]}
          />
        </section>

        <section class="center" class:dim={multi && !s.walls[sel]?.on}>
          <label class="check head-check">
            <input type="checkbox" bind:checked={L.centered} /><span title="Play one file in the middle of the wall, built into the layout with the rest around it. Works in every mode." class="sec-title"><span class="ci"><CenterIcon /></span> Centered media</span>
          </label>
          <div class="center-row">
            {#if L.center}
              <span class="source" class:off={!L.centered} title={L.center}>
                <span class="nf s-icon">{I.film}</span>
                <span class="s-name">{leaf(L.center)}</span>
                <span class="s-path">{parent(L.center)}</span>
                <button class="x nf" title="Clear" onclick={() => (L.center = "")}>{I.close}</button>
              </span>
            {/if}
            <button class="add" onclick={chooseCenter}><span class="nf">{I.plus}</span> {L.center ? "Another file" : "Choose a file"}</button>
          </div>
          <span class="center-hint">{centerHow} On the wall, <kbd>C</kbd> centers the item under the pointer.</span>
          <div class:dim={L.mode === "grid"}>
            <Range
              label="Its size"
              bind:value={L.centerSize}
              def={DEFAULTS.centerSize}
              min={0.3}
              max={1}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              title={L.mode === "grid" ? "In Grid the centered media takes the block of middle cells nearest its shape." : "Of the largest size that fits. Shift+↑↓ on the wall."}
            />
          </div>
        </section>

        <section>
          <span class="sec-title">Playback</span>
          <div class="pair">
            <Range label="Playback speed" title="How fast videos play: 1.00× is normal speed. [ ] on the wall." bind:value={s.rate} def={DEFAULTS.rate} min={0.1} max={4} step={0.05} format={(v) => `${v.toFixed(2)}×`} />
            <Range
              label="Image time"
              title="Mosaic and Grid. Elsewhere an image stays until it is replaced."
              bind:value={s.imageSeconds}
              def={DEFAULTS.imageSeconds}
              min={2}
              max={30}
              format={(v) => `${v} s`}
            />
            <Range
              label="Max video length"
              title="Videos longer than this are skipped, in every mode. Videos that are shown play to their end. 0: no limit."
              bind:value={s.maxVideoSeconds}
              def={DEFAULTS.maxVideoSeconds}
              min={0}
              max={600}
              step={5}
              format={videoLength}
            />
            <Range
              label="Loop short clips to"
              title="Mosaic and Grid: a clip shorter than this plays again until this much time has passed."
              bind:value={s.minVideoSeconds}
              def={DEFAULTS.minVideoSeconds}
              min={0}
              max={30}
              format={(v) => (v ? `${v} s` : "off")}
            />
          </div>
        </section>

        <section>
          <span class="sec-title">Layout</span>
          <div class="pair">
            <Range label="Gap" title="Space between tiles, in pixels. 0: tiles touch." bind:value={s.gap} def={DEFAULTS.gap} min={0} max={16} format={(v) => `${v} px`} />
            <Range
              label="Crop limit"
              title="Mosaic and Dynamic: the most of an item that may be cut off to fill a tile. Grid has its own: Only media that fits the cells."
              bind:value={s.maxCrop}
              def={DEFAULTS.maxCrop}
              min={0.05}
              max={0.5}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <label class="check"><input type="checkbox" bind:checked={s.stagger} /><span title="Ribbon and Cascade: neighboring rows or columns move at slightly different speeds, so their edges do not line up.">Lanes at varied speeds</span></label>
          </div>
        </section>
      </aside>
    </div>

    <footer class="foot">
      <span class="err-line">
        {#if wallError}<span class="err"><span class="nf">{I.warn}</span> {wallError}</span>{/if}
      </span>
      <!-- Resume and the saved walls sit either side of Start, outside the
           flow: Start stays centered whether they show or not -->
      <div class="go-wrap">
        {#if saved.last}
          <button class="resume" disabled={resuming} title={resumeTip} onclick={() => resume(null)}>
            <span class="nf">{I.history}</span> Resume
          </button>
        {/if}
        <button class="go" disabled={!canStart} onclick={start}>
          {#if scanningAny}
            Scanning…
          {:else if !anySources}
            Add a folder to start
          {:else if !canStart}
            Nothing to show with these filters
          {:else}
            <span class="nf">{I.play}</span>
            {multi ? `Start ${wallsOn.length} ${wallsOn.length === 1 ? "wall" : "walls"}` : "Start wall"}
            <kbd>Enter</kbd>
          {/if}
        </button>
        <span class="saved-wrap">
          <button
            class="link"
            onclick={() => {
              showSaved = !showSaved;
              // a wall window may have saved since setup last looked
              if (showSaved) loadSessions();
            }}
            aria-expanded={showSaved}
          >
            <span class="nf">{I.save}</span>
            Saved walls{#if saved.named.length}<span class="count">{saved.named.length}</span>{/if}
            <span class="nf chev">{I.chevronRight}</span>
          </button>
        </span>
      </div>
    </footer>
  </div>

  {#if prefs}<Preferences onclose={() => (prefs = false)} />{/if}
  <UpdateNotice />
  {#if showSaved}
    <SavedWalls {saved} {monitors} busy={resuming} onload={resume} ondelete={deleteSession} onclose={() => (showSaved = false)} />
  {/if}
</div>

<style>
  .setup {
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    background: var(--bg-app);
  }
  /* Natural size, no scaling. Every area has a fixed height except the mode
     settings box and the cards, which take what the window has left; so
     changing the mode or a setting never moves anything else. A window
     smaller than the minimum scrolls. */
  /* header, the two columns, and the Start bar; the page scrolls only when
     the window is too short for it, and the Start bar stays in view */
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(330px, 1fr);
    gap: 14px;
    /* both cards reach down to the Start button */
    align-items: stretch;
  }

  .card {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 2px 22px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.04),
      0 1px 2px rgba(0, 0, 0, 0.4),
      0 10px 30px rgba(0, 0, 0, 0.34);
  }
  /* the Mode section takes the card's spare height, for the settings box */
  .mode-sec {
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .side > section:last-child {
    flex: 1;
  }
  .page {
    max-width: 1480px;
    min-height: 100%;
    margin: 0 auto;
    padding: 14px 20px 18px;
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 4px;
  }
  .title {
    min-width: 0;
  }
  .version {
    margin-left: 9px;
    padding: 1px 7px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-muted);
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0;
    vertical-align: 4px;
  }
  .logo {
    width: 38px;
    height: 38px;
    filter: drop-shadow(0 4px 14px rgba(0, 0, 0, 0.5));
  }
  h1 {
    margin: 0;
    font-family: var(--mono);
    font-size: 21px;
    line-height: 1.15;
    color: var(--purple);
    letter-spacing: -0.01em;
  }
  .tag {
    margin: 1px 0 0;
    color: var(--text-muted);
    font-size: 12.5px;
  }
  section {
    padding: 14px 0;
    border-top: 1px solid var(--border-muted);
  }
  section:first-child {
    border-top: 0;
  }
  .sec-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 10px;
  }
  .sec-title {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-weight: 700;
    color: var(--text-secondary);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .sec-title .nf {
    color: var(--purple);
    letter-spacing: 0;
  }
  .ci {
    display: inline-flex;
    color: var(--purple);
    font-size: 16px;
    letter-spacing: 0;
  }
  .side .sec-title {
    display: block;
    margin-bottom: 12px;
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
    height: 36px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border-radius: var(--radius);
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
    font-size: 16px;
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
    flex-wrap: nowrap;
    align-items: center;
    gap: 6px;
    height: 36px;
    overflow-x: auto;
    overflow-y: hidden;
    border-radius: var(--radius);
  }
  .sources::-webkit-scrollbar {
    height: 5px;
  }
  .sources > * {
    flex: none;
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
  .src-row {
    display: flex;
    align-items: center;
    gap: 6px 18px;
    height: 22px;
    margin-top: 8px;
  }
  .src-row .err {
    min-width: 0;
  }
  .hidden-wrap {
    position: relative;
  }
  .hidden-pop {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 10;
    width: 460px;
    padding: 8px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-panel);
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5);
  }
  .pop-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 4px 6px;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
  }
  .src-row .check {
    margin-top: 0;
  }
  .filters {
    display: grid;
    grid-template-columns: auto auto;
    justify-content: space-between;
    gap: 4px 14px;
  }
  .span {
    grid-column: 1 / -1;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .link:hover {
    color: var(--text-primary);
  }
  .hidden-list {
    list-style: none;
    margin: 0;
    padding: 4px;
    max-height: 220px;
    overflow-y: auto;
    border-radius: var(--radius);
    border: 1px solid var(--border-muted);
    background: var(--bg-panel-alt);
  }
  .hidden-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 2px 2px 8px;
    font-family: var(--mono);
    font-size: 12px;
  }
  .hidden-list .s-path {
    max-width: none;
    flex: 1;
    min-width: 0;
  }
  .h-name {
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .err {
    color: var(--orange);
    font-size: 12px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .modes {
    display: grid;
    /* minmax(0, ...) so the previews' max-content strips cannot widen a column */
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 10px;
  }
  .mode {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
    /* the key badge hides on a card too narrow for it (six cards at 1180 px) */
    container-type: inline-size;
    padding: 9px 10px 11px;
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
  @container (max-width: 112px) {
    .m-name kbd {
      display: none;
    }
  }
  .m-line {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .m-check {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 1;
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
    height: 56px;
    border-radius: 6px;
    overflow: hidden;
    background: var(--bg-app);
    margin-bottom: 2px;
  }
  /* the center item, over any mode's diagram */
  .pv-mid {
    position: absolute;
    left: 35%;
    top: 20%;
    width: 30%;
    height: 60%;
    border-radius: 3px;
    background: var(--purple);
    box-shadow: 0 0 0 3px var(--bg-app);
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
  /* Grid: six equal cells that take turns changing color, never position */
  .pv-stack {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 3px;
    padding: 8px 6px;
  }
  .pv-stack .s {
    --c: var(--purple);
    animation: g 4s ease-in-out infinite;
  }
  .stack-one {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .link-in {
    flex: 1;
    min-width: 0;
    padding: 6px 9px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-chip);
    color: var(--text-primary);
    font-family: var(--mono);
    font-size: 12px;
  }
  .link-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .link-in:focus {
    border-color: var(--purple);
  }
  .pv-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-template-rows: repeat(2, 1fr);
    gap: 3px;
    padding: 3px;
  }
  .pv-grid .g {
    animation: g 6s ease-in-out infinite;
  }
  .pv-grid .g:nth-child(1) { --c: var(--purple); }
  .pv-grid .g:nth-child(2) { --c: var(--cyan); animation-delay: -1s; }
  .pv-grid .g:nth-child(3) { --c: var(--green); animation-delay: -2s; }
  .pv-grid .g:nth-child(4) { --c: var(--yellow); animation-delay: -3s; }
  .pv-grid .g:nth-child(5) { --c: var(--blue); animation-delay: -4s; }
  .pv-grid .g:nth-child(6) { --c: var(--purple); animation-delay: -5s; }
  @keyframes g {
    0%, 80%, 100% { opacity: 1; }
    88% { opacity: 0.35; }
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
  /* a dotted underline: hover for what it does (as on slider labels) */
  .check > span[title]:not(.sec-title),
  .check > span:global([data-tip]):not(.sec-title),
  .inline-select > span[title],
  .inline-select > span:global([data-tip]) {
    text-decoration: underline dotted color-mix(in srgb, var(--text-muted) 70%, transparent);
    text-underline-offset: 3px;
  }
  .head-check {
    margin-top: 0;
  }
  .where {
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .inline-select {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--text-secondary);
    font-size: 12.5px;
  }
  .head-displays {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    min-width: 0;
  }
  .head-displays .check {
    margin-top: 0;
  }
  .displays .check {
    margin-top: 0;
  }
  .disp-tabs {
    display: flex;
    gap: 6px;
  }
  .disp {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 10px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-panel-alt);
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }
  .disp:hover {
    border-color: color-mix(in srgb, var(--purple) 50%, var(--border));
  }
  .disp.sel {
    border-color: var(--purple);
    background: color-mix(in srgb, var(--purple) 12%, var(--bg-panel-alt));
    color: var(--text-primary);
  }
  .disp.off {
    border-style: dashed;
    color: var(--text-muted);
  }
  .disp .nf {
    color: var(--purple);
    font-size: 11px;
  }
  .d-num {
    font-family: var(--mono);
    font-weight: 700;
  }
  .d-mid {
    display: inline-flex;
    color: var(--cyan);
  }
  .d-own {
    color: var(--yellow) !important;
  }
  .sec-title .for {
    margin-left: 6px;
    color: var(--purple);
    letter-spacing: 0.04em;
  }
  .center {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .grid-fit {
    display: flex;
    align-items: center;
    gap: 6px 16px;
    min-height: 20px;
  }
  .grid-fit .check {
    margin-top: 0;
  }
  .fit-count {
    color: var(--text-muted);
    font-size: 12px;
  }
  .fit-count.warn {
    color: var(--orange);
  }
  .center .head-check {
    margin-top: 0;
  }
  .source.off {
    opacity: 0.55;
  }
  .center-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .center-hint {
    color: var(--text-muted);
    font-size: 12px;
    line-height: 1.45;
    /* two lines whatever the mode says, so the slider below never moves */
    min-height: calc(2 * 1.45em);
  }
  .center-hint kbd {
    font-size: 10px;
  }
  .dim {
    opacity: 0.45;
    pointer-events: none;
  }
  /* one box for every mode's settings: the height Grid needs, or more when
     the window has it */
  .params {
    flex: 1;
    min-height: 280px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 14px;
    padding: 12px 16px 14px;
    border-radius: 10px;
    border: 1px solid var(--border-muted);
    background: var(--bg-panel-alt);
  }
  .p-title {
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .p-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 22px;
    align-items: start;
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
  /* two settings side by side in the right column */
  .pair {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 18px;
    align-items: start;
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
  .cog {
    flex: none;
    margin-left: auto;
    display: grid;
    place-items: center;
    width: 38px;
    height: 36px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--text-secondary);
    font-size: 16px;
    cursor: pointer;
    transition: border-color 120ms ease, color 120ms ease;
  }
  .cog:hover {
    border-color: var(--purple);
    color: var(--text-primary);
  }
  /* the Start bar: always in view at the bottom of the window */
  .foot {
    position: relative;
    display: flex;
    justify-content: center;
  }
  .err-line {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 4px);
    display: flex;
    justify-content: center;
    pointer-events: none;
  }
  .foot .err {
    margin-top: 0;
  }
  .go {
    flex: none;
    min-width: 280px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 12px 22px;
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
  .go-wrap {
    position: relative;
    display: flex;
  }
  .resume {
    position: absolute;
    top: 0;
    bottom: 0;
    right: calc(100% + 10px);
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px;
    border-radius: var(--radius);
    border: 1px solid var(--green);
    background: transparent;
    color: var(--green);
    font-weight: 700;
    font-size: 13px;
    white-space: nowrap;
    cursor: pointer;
    transition: background 120ms ease;
  }
  .resume:hover:not(:disabled) {
    background: color-mix(in srgb, var(--green) 12%, transparent);
  }
  .resume:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .resume .nf {
    font-size: 12px;
  }
  .saved-wrap {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(100% + 16px);
    display: flex;
    align-items: center;
    white-space: nowrap;
  }
  .saved-wrap .count {
    margin-left: 2px;
    padding: 0 6px;
    border-radius: var(--radius-sm);
    background: var(--bg-chip);
    border: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 11px;
  }
</style>
