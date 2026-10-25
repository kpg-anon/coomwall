// Several walls at once, one fullscreen window per display (opened by
// src-tauri/src/walls.rs). Each window runs its own Wall; these events keep
// what is shared in step: Space pauses every wall, only one item on any wall
// has sound, and "another window is active" means no wall has focus.
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** In a wall window, the display it fills (set by walls.rs before the page loads). */
export const wallMonitor: string | null = (window as any).__CW_WALL__ ?? null;

interface Handlers {
  pause: (paused: boolean) => void;
  /** another wall turned sound on */
  soundElsewhere: () => void;
  /** whether any wall has focus */
  focusAny: (focused: boolean) => void;
}

export function linkWalls(h: Handlers) {
  const me = getCurrentWindow().label;
  const focus = new Map<string, boolean>();
  let blurTimer: ReturnType<typeof setTimeout> | undefined;
  // moving focus from one wall to the next sends a blur before the focus;
  // wait a moment before deciding that no wall has it
  const report = () => {
    clearTimeout(blurTimer);
    if ([...focus.values()].some(Boolean)) h.focusAny(true);
    else blurTimer = setTimeout(() => h.focusAny(false), 200);
  };
  const offs = [
    listen<boolean>("cw-pause", (e) => h.pause(e.payload)),
    listen<string>("cw-sound", (e) => e.payload !== me && h.soundElsewhere()),
    listen<{ label: string; focused: boolean }>("cw-focus", (e) => {
      focus.set(e.payload.label, e.payload.focused);
      report();
    }),
  ];
  return {
    pause: (paused: boolean) => emit("cw-pause", paused),
    sound: () => emit("cw-sound", me),
    focused: (focused: boolean) => emit("cw-focus", { label: me, focused }),
    destroy() {
      clearTimeout(blurTimer);
      offs.forEach((p) => p.then((off) => off()).catch(() => {}));
    },
  };
}
