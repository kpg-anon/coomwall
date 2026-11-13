// Several walls at once, one fullscreen window per display (opened by
// src-tauri/src/walls.rs). Each window runs its own Wall; these events keep
// what is shared in step: Shift+Space pauses every wall (Space alone pauses
// one), Shift+M turns sound off on every wall, a file removed from one wall
// leaves all of them, T puts every wall above other windows or not, Ctrl+S
// saves every wall into one named session, and "another window is active"
// means no wall has focus.
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** In a wall window, the display it fills (set by walls.rs before the page loads). */
export const wallMonitor: string | null = (window as any).__CW_WALL__ ?? null;
/** In a wall window, the number all walls of this start share; their saves
 * into the `last` session go together (src-tauri/src/sessions.rs). */
export const wallRun: number | null = (window as any).__CW_RUN__ ?? null;

interface Handlers {
  pause: (paused: boolean) => void;
  /** Shift+M on another wall: every item there loses its sound */
  silence: () => void;
  /** whether any wall has focus */
  focusAny: (focused: boolean) => void;
  /** a file was removed (or hidden for good) on some wall, this one included */
  remove: (path: string) => void;
  /** T on another wall: stay above other windows, or stop */
  onTop: (on: boolean) => void;
  /** Ctrl+S on some wall, this one included: every wall saves itself into session `name` */
  save: (name: string, run: number) => void;
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
    listen<string>("cw-silence", (e) => e.payload !== me && h.silence()),
    listen<string>("cw-remove", (e) => h.remove(e.payload)),
    listen<{ from: string; on: boolean }>("cw-ontop", (e) => e.payload.from !== me && h.onTop(e.payload.on)),
    listen<{ name: string; run: number }>("cw-save", (e) => h.save(e.payload.name, e.payload.run)),
    listen<{ label: string; focused: boolean }>("cw-focus", (e) => {
      focus.set(e.payload.label, e.payload.focused);
      report();
    }),
  ];
  return {
    pause: (paused: boolean) => emit("cw-pause", paused),
    silence: () => emit("cw-silence", me),
    remove: (path: string) => emit("cw-remove", path),
    onTop: (on: boolean) => emit("cw-ontop", { from: me, on }),
    save: (name: string, run: number) => emit("cw-save", { name, run }),
    focused: (focused: boolean) => emit("cw-focus", { label: me, focused }),
    destroy() {
      clearTimeout(blurTimer);
      offs.forEach((p) => p.then((off) => off()).catch(() => {}));
    },
  };
}
