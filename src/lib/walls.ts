// Several walls at once, one fullscreen window per display (opened by
// src-tauri/src/walls.rs). Each window runs its own Wall; these events keep
// what is shared in step: Shift+Space pauses every wall (Space alone pauses
// one), only one item on any wall has sound, a file removed from one wall
// leaves all of them, T puts every wall above other windows or not, and
// "another window is active" means no wall has focus.
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
  /** a file was removed (or hidden for good) on some wall, this one included */
  remove: (path: string) => void;
  /** T on another wall: stay above other windows, or stop */
  onTop: (on: boolean) => void;
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
    listen<string>("cw-remove", (e) => h.remove(e.payload)),
    listen<{ from: string; on: boolean }>("cw-ontop", (e) => e.payload.from !== me && h.onTop(e.payload.on)),
    listen<{ label: string; focused: boolean }>("cw-focus", (e) => {
      focus.set(e.payload.label, e.payload.focused);
      report();
    }),
  ];
  return {
    pause: (paused: boolean) => emit("cw-pause", paused),
    sound: () => emit("cw-sound", me),
    remove: (path: string) => emit("cw-remove", path),
    onTop: (on: boolean) => emit("cw-ontop", { from: me, on }),
    focused: (focused: boolean) => emit("cw-focus", { label: me, focused }),
    destroy() {
      clearTimeout(blurTimer);
      offs.forEach((p) => p.then((off) => off()).catch(() => {}));
    },
  };
}
