<script lang="ts">
  import "$lib/theme.css";
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { listen } from "@tauri-apps/api/event";
  import Setup from "$lib/components/Setup.svelte";
  import Wall from "$lib/components/Wall.svelte";
  import { settings } from "$lib/settings.svelte";
  import { library } from "$lib/library.svelte";
  import { api } from "$lib/api";
  import { wallMonitor } from "$lib/walls";

  let phase = $state<"setup" | "wall" | "loading">(wallMonitor ? "loading" : "setup");

  onMount(() => {
    let unlisten: (() => void) | undefined;
    let alive = true;
    (async () => {
      await settings.load();
      if (wallMonitor) {
        // one of several walls: walls.rs already showed it fullscreen
        settings.useWall(wallMonitor);
        await library.rescan();
        phase = "wall";
      } else {
        library.rescan();
        // the window starts hidden so it never shows before the theme is applied
        await getCurrentWindow().show();
        await getCurrentWindow().setFocus();
        // walls.rs shows this window again once the last wall closes; the
        // walls saved their own layouts meanwhile
        const off = await listen("walls-closed", async () => {
          await settings.load();
          // files hidden on the walls drop out of the counts
          library.rescan();
        });
        if (alive) unlisten = off;
        else off();
      }
      if (import.meta.env.DEV) {
        (window as any).__cw = {
          settings,
          library,
          start: () => (phase = "wall"),
          stop: () => (phase = "setup"),
        };
      }
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  });

  $effect(() => {
    JSON.stringify(settings.s);
    settings.saveSoon();
  });
</script>

{#if phase === "setup"}
  <Setup onstart={() => (phase = "wall")} />
{:else if phase === "wall"}
  <Wall
    multi={!!wallMonitor}
    onexit={() => {
      if (wallMonitor) return api.closeWalls();
      phase = "setup";
      library.rescan();
    }}
  />
{/if}
