// What makes the window behave like an app and not a web page. WebView2's
// own context menu (Back, Refresh, Print, More tools), its browser keys
// (Find, Print, Reload, history) and Tab moving focus between controls are
// all page behaviour here; Tauri 2.12 has no switch for the context menu or
// the browser keys, so they are stopped in the page.
//
// Text fields keep their normal keys and menu (cut, copy, paste).

/** Browser keys with no use in this app. Ctrl/Alt combinations, by
 * KeyboardEvent.key in lower case. */
const CTRL = new Set(["f", "g", "p", "r", "s", "u", "o", "j", "h", "n", "t", "w", "d", "e", "k", "l", "=", "+", "-", "0"]);
const PLAIN = new Set(["F3", "F5", "F7", "BrowserBack", "BrowserForward", "BrowserRefresh", "BrowserSearch", "BrowserHome"]);

function typing(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === "TEXTAREA") return true;
  return t instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit"].includes(t.type);
}

export function installAppFeel(): () => void {
  const dev = import.meta.env.DEV;

  const menu = (e: MouseEvent) => {
    // the wall opens its own menu and has already called preventDefault
    if (!typing(e.target)) e.preventDefault();
  };

  const key = (e: KeyboardEvent) => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // Tab walks focus through every button on the page; nothing here uses it
    if (k === "Tab") return e.preventDefault();
    // reload stays in a dev build (Vite sometimes needs it)
    if (dev && (k === "F5" || (e.ctrlKey && k === "r"))) return;
    if (PLAIN.has(k)) return e.preventDefault();
    // Alt+Left / Alt+Right: back and forward in history
    if (e.altKey && (k === "ArrowLeft" || k === "ArrowRight" || k === "Home")) return e.preventDefault();
    if (e.ctrlKey && !e.altKey) {
      // DevTools stay reachable in a dev build
      if (dev && e.shiftKey && (k === "i" || k === "j" || k === "c")) return;
      if (CTRL.has(k)) return e.preventDefault();
      // select all, outside text fields
      if (k === "a" && !typing(e.target)) return e.preventDefault();
    }
    if (dev && k === "F12") return;
  };

  // a button keeps focus after a click, and Space or Enter then presses it
  // again; a pressed button does not take focus here
  const down = (e: PointerEvent) => {
    if (e.button === 1) e.preventDefault(); // middle click: autoscroll
    const b = (e.target as Element | null)?.closest?.("button");
    if (b) e.preventDefault();
  };

  // dragging an image or link out of the window
  const drag = (e: DragEvent) => {
    if (!typing(e.target)) e.preventDefault();
  };

  // no spelling underline or autofill list on text fields
  const focus = (e: FocusEvent) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
      t.spellcheck = false;
      t.autocomplete = "off";
    }
  };

  window.addEventListener("contextmenu", menu);
  window.addEventListener("keydown", key, true);
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("dragstart", drag, true);
  window.addEventListener("focusin", focus, true);
  return () => {
    window.removeEventListener("contextmenu", menu);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("dragstart", drag, true);
    window.removeEventListener("focusin", focus, true);
  };
}
